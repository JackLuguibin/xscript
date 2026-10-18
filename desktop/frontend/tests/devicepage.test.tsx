import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi, type Device } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MemoryTransport } from "../src/bridge/memory";
import { DevicePage } from "../src/components/DevicePage";

const info = { name: "emu64a16k", model: "sdk_gphone16k_arm64", brand: "google", android: "17", sdk: 37, width: 1080, height: 2337, density: 420, ip: "10.0.2.16",
  version: "0.2.6", deviceId: "ae10e6ed9b09580c", running: false, accessibility: false, root: false, capture: false, channel: "none", cloud: "未连接", project: "" };

function dev(over: Partial<Device> = {}): Device {
  return { id: "adb:emulator-5554", transport: "adb", address: "127.0.0.1:41000", serial: "emulator-5554", forwardPort: 41000, state: "online", error: "", warning: "",
    lastSeen: 1, info, status: {}, ...over };
}

function setup(handlers: ConstructorParameters<typeof MemoryTransport>[0]) {
  const t = new MemoryTransport({
    "device.list": () => ({ devices: [] }),
    "device.adb.list": () => ({ adbPath: "/x/adb", devices: [{ serial: "emulator-5554", state: "device", model: "sdk_gphone16k_arm64", product: "", device: "", transportId: "1", isEmulator: true }] }),
    ...handlers,
  });
  const rpc = new RpcClient(t);
  render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <DevicePage />
    </ServicesContext.Provider>,
  );
  return { t, rpc };
}

describe("DevicePage", () => {
  it("lists adb devices, connects, and shows the device info from /status", async () => {
    const user = userEvent.setup();
    const { t } = setup({ "device.connect": () => dev() });
    expect(await screen.findByText("emulator-5554")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "连接 emulator-5554" }));
    const card = await screen.findByRole("article", { name: "device adb:emulator-5554" });
    expect(within(card).getByText("emu64a16k", { exact: false })).toBeTruthy();
    expect(within(card).getByText("1080×2337")).toBeTruthy();
    expect(within(card).getByText("0.2.6")).toBeTruthy();
    expect(within(card).getByText("在线")).toBeTruthy();
    expect(within(card).getByText(/41000/)).toBeTruthy();
    expect(t.sent.find((m) => m.method === "device.connect")?.params).toEqual({ transport: "adb", serial: "emulator-5554" });
  });

  it("shows a hint when adb is missing", async () => {
    setup({ "device.adb.list": () => { throw { code: "adb.not_found", message: "x" }; } });
    expect(await screen.findByText(/找不到 adb/)).toBeTruthy();
  });

  it("shows the empty state, and disables connect for non-ready devices", async () => {
    setup({ "device.adb.list": () => ({ adbPath: "/x", devices: [{ serial: "R5", state: "unauthorized", model: "", product: "", device: "", transportId: "3", isEmulator: false }] }) });
    await screen.findByText("R5");
    expect((screen.getByRole("button", { name: "连接 R5" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces connect errors from Python without crashing", async () => {
    const user = userEvent.setup();
    setup({ "device.connect": () => { throw { code: "device.unreachable", message: "cannot reach 127.0.0.1:41000", retryable: true }; } });
    await user.click(await screen.findByRole("button", { name: "连接 emulator-5554" }));
    const alert = await screen.findByRole("alert");
    // mapped, actionable text first; the raw message and code only behind 详情
    expect(alert.textContent).toContain("连不上设备");
    expect(alert.textContent).toContain("前台");
    expect(alert.textContent).not.toContain("cannot reach");
    await user.click(within(alert).getByRole("button", { name: "详情" }));
    expect(alert.textContent).toContain("cannot reach 127.0.0.1:41000 [device.unreachable]");
  });

  it("connects a LAN address, showing the no-auth warning from Python", async () => {
    const user = userEvent.setup();
    const { t } = setup({ "device.connect": (p) => dev({ id: "lan:" + p.address, transport: "lan", serial: "", address: String(p.address), warning: "设备 API 没有鉴权" }) });
    await user.type(screen.getByLabelText("device address"), "192.168.1.20:9860");
    await user.click(screen.getByRole("button", { name: "连接地址" }));
    expect(await screen.findByText(/没有鉴权/, { selector: ".banner span" })).toBeTruthy();
    expect(t.sent.find((m) => m.method === "device.connect")?.params).toEqual({ transport: "lan", address: "192.168.1.20:9860" });
  });

  it("applies pushed device.state events (health polling) and device.removed", async () => {
    const user = userEvent.setup();
    const { t } = setup({ "device.connect": () => dev() });
    await user.click(await screen.findByRole("button", { name: "连接 emulator-5554" }));
    await screen.findByText("在线");
    t.push({ event: true, topic: "device.state", data: dev({ state: "offline", error: "cannot reach" }) });
    expect(await screen.findByText("离线")).toBeTruthy();
    t.push({ event: true, topic: "device.removed", data: { id: "adb:emulator-5554" } });
    await waitFor(() => expect(screen.queryByRole("article")).toBeNull());
  });

  it("disconnect calls device.disconnect and removes the card", async () => {
    const user = userEvent.setup();
    const { t } = setup({ "device.connect": () => dev(), "device.disconnect": () => ({ removed: true }) });
    await user.click(await screen.findByRole("button", { name: "连接 emulator-5554" }));
    await screen.findByRole("article");
    await user.click(screen.getByRole("button", { name: "断开" }));
    await waitFor(() => expect(screen.queryByRole("article")).toBeNull());
    expect(t.sent.some((m) => m.method === "device.disconnect")).toBe(true);
  });

  it("screenshot button requests it over the xsapp scheme path, not the bridge", async () => {
    const user = userEvent.setup();
    const { t } = setup({ "device.connect": () => dev() });
    await user.click(await screen.findByRole("button", { name: "连接 emulator-5554" }));
    await user.click(await screen.findByRole("button", { name: "刷新截图" }));
    const img = (await screen.findByAltText("截图")) as HTMLImageElement;
    expect(img.getAttribute("src")).toMatch(/^\/_shot\/adb%3Aemulator-5554\.jpg\?max=360&t=\d+$/);
    expect(t.sent.some((m) => m.method.includes("screen"))).toBe(false);
  });

  it("scan lists hits and connects one", async () => {
    const user = userEvent.setup();
    setup({
      "device.scan": () => ({ found: [{ address: "192.168.1.20:9860", host: "192.168.1.20", port: 9860, info: { name: "pixel" } }] }),
      "device.connect": (p) => dev({ id: "lan:" + p.address, transport: "lan", address: String(p.address), serial: "" }),
    });
    await user.click(await screen.findByRole("button", { name: /扫描/ }));
    expect(await screen.findByText("192.168.1.20:9860", { selector: "strong" })).toBeTruthy();
  });
});
