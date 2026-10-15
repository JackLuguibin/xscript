// Saved devices and device discovery (ADB + local network). Free of `vscode` so it runs under node --test.
import * as os from "os";
import { DeviceClient, DEFAULT_PORT, parseTarget } from "./client";

export interface SavedDevice {
  name: string;
  /** "host:port", the 开发者地址 shown in the app */
  address: string;
}

export interface FoundDevice extends SavedDevice {
  via: "adb" | "lan";
  serial?: string;
  model?: string;
}

/** The small part of a vscode.Memento the store needs. */
export interface Memory {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export function normalizeAddress(value: string): string {
  const t = parseTarget(value);
  return (t.host.includes(":") ? "[" + t.host + "]" : t.host) + ":" + t.port;
}

const KEY = "xscript.devices";

export class DeviceStore {
  constructor(private mem: Memory) {}

  list(): SavedDevice[] {
    return this.mem.get<SavedDevice[]>(KEY, []).filter((d) => d && typeof d.address === "string");
  }

  async add(d: SavedDevice): Promise<SavedDevice[]> {
    const address = normalizeAddress(d.address);
    const rest = this.list().filter((x) => x.address !== address);
    const next = [...rest, { name: d.name.trim() || address, address }];
    await this.mem.update(KEY, next);
    return next;
  }

  async edit(oldAddress: string, d: SavedDevice): Promise<SavedDevice[]> {
    const old = normalizeAddress(oldAddress);
    const address = normalizeAddress(d.address);
    const next = this.list().map((x) => (x.address === old ? { name: d.name.trim() || address, address } : x)).filter(
      (x, i, all) => all.findIndex((y) => y.address === x.address) === i,
    );
    await this.mem.update(KEY, next);
    return next;
  }

  async remove(address: string): Promise<SavedDevice[]> {
    const a = normalizeAddress(address);
    const next = this.list().filter((x) => x.address !== a);
    await this.mem.update(KEY, next);
    return next;
  }

  /** Adds devices that are not saved yet (by address); returns how many were new. */
  async merge(found: SavedDevice[]): Promise<number> {
    const have = new Set(this.list().map((d) => d.address));
    let n = 0;
    for (const f of found) {
      if (have.has(f.address)) continue;
      await this.add(f);
      have.add(f.address);
      n++;
    }
    return n;
  }
}

// ---------------------------------------------------------------- probing

export type Probe = (host: string, port: number) => Promise<{ model?: string; name?: string } | undefined>;

/** Asks GET /status; only a reply shaped like XScript's status counts as a device. */
export const httpProbe = (timeoutMs: number): Probe => async (host, port) => {
  try {
    const s = await new DeviceClient({ host, port }, timeoutMs).status(timeoutMs);
    if (typeof s.sdk !== "number" || typeof s.running !== "boolean") return undefined;
    return { model: s.model ? String(s.model) : undefined, name: s.name ? String(s.name) : undefined };
  } catch {
    return undefined;
  }
};

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- local network

/** Every other host of each private-range /24 this machine is on. */
export function lanCandidates(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      const p = i.address.split(".").map(Number);
      const priv = p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
      if (!priv) continue;
      for (let h = 1; h <= 254; h++) if (h !== p[3]) out.add(p[0] + "." + p[1] + "." + p[2] + "." + h);
    }
  }
  return [...out];
}

export async function scanLan(
  hosts: string[],
  probe: Probe,
  opts: { port?: number; concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<FoundDevice[]> {
  const port = opts.port ?? DEFAULT_PORT;
  let done = 0;
  const res = await mapLimit(hosts, opts.concurrency ?? 64, async (host) => {
    const r = await probe(host, port);
    opts.onProgress?.(++done, hosts.length);
    return r ? ({ name: r.model || r.name || host, address: host + ":" + port, via: "lan", model: r.model } as FoundDevice) : undefined;
  });
  return res.filter((x): x is FoundDevice => !!x);
}

// ---------------------------------------------------------------- ADB

export type Run = (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

/** Serials in the `device` state of `adb devices` output. */
export function parseAdbDevices(text: string): string[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === "device")
    .map((p) => p[0]);
}

/** serial -> local port of an existing `adb forward tcp:<local> tcp:<devicePort>`. */
export function parseForwardList(text: string, devicePort: number): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of text.split(/\r?\n/)) {
    const p = l.trim().split(/\s+/);
    if (p.length === 3 && p[2] === "tcp:" + devicePort && /^tcp:\d+$/.test(p[1]) && !m.has(p[0])) m.set(p[0], Number(p[1].slice(4)));
  }
  return m;
}

/** Forwards the device port of every USB / emulator device (reusing forwards that already exist) and probes it. */
export async function scanAdb(adb: string, run: Run, probe: Probe, devicePort = DEFAULT_PORT): Promise<FoundDevice[]> {
  const list = await run(adb, ["devices"]);
  if (list.code !== 0) return [];
  const serials = parseAdbDevices(list.stdout);
  const existing = parseForwardList((await run(adb, ["forward", "--list"])).stdout, devicePort);
  const out: FoundDevice[] = [];
  for (const serial of serials) {
    let port = existing.get(serial);
    if (!port) {
      const f = await run(adb, ["-s", serial, "forward", "tcp:0", "tcp:" + devicePort]);
      const n = Number(f.stdout.trim());
      if (f.code !== 0 || !Number.isInteger(n) || n <= 0) continue;
      port = n;
    }
    const r = await probe("127.0.0.1", port);
    if (r) out.push({ name: (r.model || r.name || serial) + " (" + serial + ")", address: "127.0.0.1:" + port, via: "adb", serial, model: r.model });
  }
  return out;
}
