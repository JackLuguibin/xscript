import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DeviceStore, Memory, lanCandidates, normalizeAddress, parseAdbDevices, parseForwardList, scanAdb, scanLan, mapLimit } from "../devices";

function memory(): Memory & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, get: <T>(k: string, f: T) => (k in data ? (data[k] as T) : f), update: async (k, v) => void (data[k] = v) };
}

test("normalizeAddress", () => {
  assert.equal(normalizeAddress("192.168.1.5"), "192.168.1.5:9860");
  assert.equal(normalizeAddress("http://10.0.0.2:9861/"), "10.0.0.2:9861");
  assert.throws(() => normalizeAddress("h:abc"));
});

test("DeviceStore adds, dedupes by address, edits, removes and merges", async () => {
  const s = new DeviceStore(memory());
  await s.add({ name: "Pixel", address: "192.168.1.5" });
  await s.add({ name: "Pixel 2", address: "192.168.1.5:9860" });
  assert.deepEqual(s.list(), [{ name: "Pixel 2", address: "192.168.1.5:9860" }]);
  await s.add({ name: "", address: "10.0.0.2:9861" });
  assert.equal(s.list()[1].name, "10.0.0.2:9861", "blank name falls back to the address");
  await s.edit("10.0.0.2:9861", { name: "Tablet", address: "10.0.0.3" });
  assert.deepEqual(s.list().map((d) => d.address), ["192.168.1.5:9860", "10.0.0.3:9860"]);
  assert.equal(await s.merge([{ name: "x", address: "10.0.0.3:9860" }, { name: "new", address: "127.0.0.1:41000" }]), 1);
  await s.remove("192.168.1.5");
  assert.deepEqual(s.list().map((d) => d.name), ["Tablet", "new"]);
});

test("adb output parsing", () => {
  const out = "List of devices attached\nemulator-5554\tdevice\nR58M\tunauthorized\nABC\toffline\n0123\tdevice usb:1-1\n\n";
  assert.deepEqual(parseAdbDevices(out), ["emulator-5554", "0123"]);
  const fw = "emulator-5554 tcp:19860 tcp:9860\nemulator-5554 tcp:9222 localabstract:chrome\nR58M tcp:20000 tcp:9860\n";
  assert.deepEqual([...parseForwardList(fw, 9860)], [["emulator-5554", 19860], ["R58M", 20000]]);
});

test("lanCandidates covers private /24s only and skips this host", () => {
  const c = lanCandidates({
    en0: [{ address: "192.168.7.20", family: "IPv4", internal: false } as any],
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as any],
    utun: [{ address: "8.8.8.8", family: "IPv4", internal: false } as any, { address: "fe80::1", family: "IPv6", internal: false } as any],
  });
  assert.equal(c.length, 253);
  assert.ok(c.includes("192.168.7.1") && c.includes("192.168.7.254") && !c.includes("192.168.7.20"));
});

test("scanLan keeps hosts the probe recognises and reports progress", async () => {
  const hosts = ["10.0.0.1", "10.0.0.2", "10.0.0.3"];
  let last = 0;
  const found = await scanLan(hosts, async (h, p) => (h === "10.0.0.2" && p === 9860 ? { model: "Pixel" } : undefined), { onProgress: (d) => (last = d) });
  assert.deepEqual(found, [{ name: "Pixel", address: "10.0.0.2:9860", via: "lan", model: "Pixel" }]);
  assert.equal(last, 3);
});

test("scanAdb reuses an existing forward, creates a missing one, skips non-devices", async () => {
  const calls: string[] = [];
  const run = async (_cmd: string, args: string[]) => {
    calls.push(args.join(" "));
    if (args[0] === "devices") return { code: 0, stdout: "List of devices attached\nemu\tdevice\nusb1\tdevice\nbad\tdevice\n" };
    if (args[0] === "forward" && args[1] === "--list") return { code: 0, stdout: "emu tcp:19860 tcp:9860\n" };
    if (args.join(" ") === "-s usb1 forward tcp:0 tcp:9860") return { code: 0, stdout: "41234\n" };
    return { code: 1, stdout: "" };
  };
  const probe = async (_h: string, port: number) => (port === 19860 ? { model: "Emu" } : port === 41234 ? { name: "Phone" } : undefined);
  const found = await scanAdb("adb", run, probe);
  assert.deepEqual(found.map((f) => [f.address, f.serial, f.name]), [
    ["127.0.0.1:19860", "emu", "Emu (emu)"],
    ["127.0.0.1:41234", "usb1", "Phone (usb1)"],
  ]);
  assert.ok(!calls.includes("-s emu forward tcp:0 tcp:9860"), "no new forward for a device that already has one");
});

test("mapLimit caps concurrency", async () => {
  let live = 0, peak = 0;
  await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => { peak = Math.max(peak, ++live); await new Promise((r) => setTimeout(r, 5)); live--; });
  assert.ok(peak <= 4 && peak > 1, "peak " + peak);
});
