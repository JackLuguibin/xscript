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
    },
    30,
  );
}
