import { MemoryTransport } from "./bridge/memory";
import type { Device } from "./api";

// Demo backend for `npm run dev` in a plain browser. Shapes mirror the real /status of an emulator.
const status = {
  name: "demo-phone", model: "sdk_gphone64_arm64", brand: "google", sdk: 34, release: "14", width: 1080, height: 2209, density: 420,
  ip: "10.0.2.17", port: 9860, accessibility: false, root: false, channel: "none", capture: false, running: false,
  version: "0.2.6", device_id: "demo0123456789", app_id: "com.xscript.app", cloud: "未连接",
};

export function createDemoTransport(): MemoryTransport {
  const devices = new Map<string, Device>();
  const projects = new Map<string, Map<string, string>>([["demo", new Map([["__init__.py", "print('hello from demo')\n"]])]]);
  const logs: Array<{ seq: number; ts: number; stream: string; line: string }> = [];
  let running = "";
  const log = (line: string) => logs.push({ seq: logs.length + 1, ts: Date.now(), stream: "stdout", line });
  const proj = (p: Record<string, unknown>) => {
    const m = projects.get(String(p.project));
    if (!m) throw { code: "device.http", message: "missing project" };
    return m;
  };
  return new MemoryTransport(
    {
      "app.ping": (p) => ({ pong: p.echo, version: "demo", python: "-", platform: "browser" }),
      "app.hello": () => ({ version: "demo", platform: "browser", adbPath: null, methods: [] }),
      "device.adb.list": () => ({
        adbPath: "/demo/adb",
        devices: [{ serial: "emulator-5554", state: "device", model: "sdk_gphone64_arm64", product: "", device: "", transportId: "1", isEmulator: true }],
      }),
      "device.connect": (p) => {
        const serial = String(p.serial ?? p.address);
        const d: Device = {
          id: `${p.transport}:${serial}`, transport: p.transport as "adb" | "lan", address: "127.0.0.1:41000", serial: p.transport === "adb" ? serial : "",
          forwardPort: 41000, state: "online", error: "", warning: p.transport === "lan" ? "demo warning" : "", lastSeen: Date.now() / 1000,
          info: { name: status.name, model: status.model, brand: status.brand, android: status.release, sdk: status.sdk, width: status.width, height: status.height,
            density: status.density, ip: status.ip, port: 9860, version: status.version, deviceId: status.device_id, appId: status.app_id, running: false,
            project: "", accessibility: false, root: false, capture: false, channel: "none", cloud: "未连接" },
          status,
        };
        devices.set(d.id, d);
        return d;
      },
      "device.list": () => ({ devices: [...devices.values()] }),
      "device.refresh": (p) => devices.get(String(p.id)),
      "device.disconnect": (p) => ({ removed: devices.delete(String(p.id)) }),
      "device.scan": () => ({ found: [] }),
      "project.list": () => ({ projects: [...projects.keys()].map((name) => ({ name })) }),
      "project.create": (p) => {
        const name = String(p.project);
        if (projects.has(name)) throw { code: "device.http", message: "工程已存在: " + name };
        projects.set(name, new Map([["__init__.py", "print('hello')\n"]]));
        return { ok: true };
      },
      "project.files": (p) => {
        const m = proj(p);
        return { project: p.project, files: [...m.entries()].sort().map(([path, c]) => ({ path, size: c.length })), dirs: [] };
      },
      "project.read": (p) => {
        const c = proj(p).get(String(p.path));
        if (c === undefined) throw { code: "device.http", message: "missing file" };
        return { path: p.path, encoding: "utf-8", content: c };
      },
      "project.write": (p) => {
        proj(p).set(String(p.path), String(p.content));
        return { ok: true };
      },
      "project.deleteFile": (p) => {
        if (p.path === "__init__.py") throw { code: "device.http", message: "entry point cannot be deleted" };
        if (!proj(p).delete(String(p.path))) throw { code: "device.http", message: "missing file" };
        return { ok: true };
      },
      "project.move": (p) => {
        const m = proj(p);
        const c = m.get(String(p.from));
        if (c === undefined) throw { code: "device.http", message: "missing file" };
        if (m.has(String(p.to))) throw { code: "device.http", message: "target exists" };
        m.delete(String(p.from));
        m.set(String(p.to), c);
        return { ok: true, from: p.from, to: p.to };
      },
      "project.run": (p) => {
        if (running) return { error: "already running", project: running };
        proj(p);
        running = String(p.project);
        log(`[demo] running ${running}\n`);
        return { ok: true, running: true, project: running };
      },
      "project.stop": () => {
        if (running) log(`[demo] stopped ${running}\n`);
        running = "";
        return { ok: true, running: false };
      },
      "device.logs": (p) => {
        const since = Number(p.since ?? 0);
        const entries = logs.filter((e) => e.seq > since);
        return { entries, next: logs.length ? logs[logs.length - 1].seq : since };
      },
      "device.action": () => ({ ok: true }),
      "app.pickDirectory": () => ({ path: "/demo/projects/demo" }),
      "sync.preview": () => ({ upload: ["__init__.py"], skipped: [], bytes: 24 }),
      "sync.upload": () => ({ upload: ["__init__.py"], skipped: [], bytes: 24, uploaded: 1 }),
      "sync.pull": () => ({ added: [], changed: ["__init__.py"], unchanged: [], written: 1 }),
    },
    30,
  );
}
