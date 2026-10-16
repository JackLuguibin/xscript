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
    scan: (cidr?: string) => rpc.call<{ found: ScanHit[] }>("device.scan", cidr ? { cidr } : {}, { timeoutMs: 60_000 }),
  };
}

export type Api = ReturnType<typeof createApi>;
