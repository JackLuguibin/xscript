import type { RpcClient } from "./bridge/client";

export interface AdbDevice {
  serial: string;
  state: string;
  model: string;
  product: string;
  device: string;
  transportId: string;
  isEmulator: boolean;
}

export interface DeviceInfo {
  name: string;
  model: string;
  brand: string;
  android: string;
  sdk: number | null;
  width: number | null;
  height: number | null;
  density: number | null;
  ip: string;
  port: number | null;
  version: string;
  deviceId: string;
  appId: string;
  running: boolean;
  project: string;
  accessibility: boolean;
  root: boolean;
  capture: boolean;
  channel: string;
  cloud: string;
}

export interface Device {
  id: string;
  transport: "adb" | "lan";
  address: string;
  serial: string;
  forwardPort: number;
  state: "connecting" | "online" | "offline";
  error: string;
  warning: string;
  lastSeen: number;
  info: Partial<DeviceInfo>;
  status: Record<string, unknown>;
}

export interface Hello {
  version: string;
  platform: string;
  adbPath: string | null;
  methods: string[];
}

export interface ScanHit {
  address: string;
  host: string;
  port: number;
  info: Partial<DeviceInfo>;
}

export interface ProjectSummary {
  name: string;
  [k: string]: unknown;
}

export interface ProjectFiles {
  project: string;
  files: Array<{ path: string; size: number }>;
  dirs: string[];
}

export interface FileContent {
  path: string;
  encoding: "utf-8" | "base64";
  content: string;
}

export interface LogEntry {
  seq: number;
  ts: number;
  stream: string;
  line: string;
}

export interface RunResult {
  ok?: boolean;
  running?: boolean;
  project?: string;
  error?: string;
}

/** Typed wrappers over the JSON-RPC methods (names match xscript_desktop/context.py). */
export function createApi(rpc: RpcClient) {
  return {
    ping: (echo: string) => rpc.call<{ pong: string; version: string; python: string; platform: string }>("app.ping", { echo }),
    hello: (pingOk: boolean) => rpc.call<Hello>("app.hello", { pingOk }),
    setAdbPath: (adbPath: string) => rpc.call<{ adbPath: string | null }>("app.settings.set", { adbPath }),
    adbList: () => rpc.call<{ adbPath: string | null; devices: AdbDevice[] }>("device.adb.list", {}, { timeoutMs: 20_000 }),
    connectAdb: (serial: string) => rpc.call<Device>("device.connect", { transport: "adb", serial }, { timeoutMs: 30_000 }),
    connectLan: (address: string) => rpc.call<Device>("device.connect", { transport: "lan", address }, { timeoutMs: 30_000 }),
    listDevices: () => rpc.call<{ devices: Device[] }>("device.list"),
    refresh: (id: string) => rpc.call<Device>("device.refresh", { id }),
    disconnect: (id: string) => rpc.call<{ removed: boolean }>("device.disconnect", { id }),
    projects: (id: string) => rpc.call<{ projects: ProjectSummary[] }>("project.list", { id }),
    createProject: (id: string, project: string) => rpc.call<{ ok: boolean }>("project.create", { id, project }),
    files: (id: string, project: string) => rpc.call<ProjectFiles>("project.files", { id, project }),
    readFile: (id: string, project: string, path: string) => rpc.call<FileContent>("project.read", { id, project, path }),
    writeFile: (id: string, project: string, path: string, content: string, create = false) =>
      rpc.call<{ ok: boolean }>("project.write", { id, project, path, content, create }, { timeoutMs: 60_000 }),
    run: (id: string, project: string) => rpc.call<RunResult>("project.run", { id, project }),
    stop: (id: string, project: string) => rpc.call<RunResult>("project.stop", { id, project }),
    logs: (id: string, since: number) => rpc.call<{ entries: LogEntry[]; next: number }>("device.logs", { id, since }),
    key: (id: string, name: string) => rpc.call<{ ok: boolean }>("device.action", { id, type: "key", name }),
    scan: (cidr?: string) => rpc.call<{ found: ScanHit[] }>("device.scan", cidr ? { cidr } : {}, { timeoutMs: 60_000 }),
  };
}

export type Api = ReturnType<typeof createApi>;
