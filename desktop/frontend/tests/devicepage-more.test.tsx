import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi, type Device } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MemoryTransport } from "../src/bridge/memory";
import { DevicePage } from "../src/components/DevicePage";

const info = { name: "emu", model: "m", brand: "google", android: "17", sdk: 37, width: 1080, height: 2337, density: 420, ip: "10.0.2.16", version: "0.2.6",
  deviceId: "id", running: false, accessibility: false, root: false, capture: true, channel: "none", cloud: "", project: "" };
const dev = (over: Partial<Device> = {}): Device => ({ id: "adb:emulator-5554", transport: "adb", address: "127.0.0.1:41000", serial: "emulator-5554", forwardPort: 41000,
  state: "online", error: "", warning: "", lastSeen: 1, info, status: {}, ...over });
const adbOne = { adbPath: "/x/adb", devices: [{ serial: "emulator-5554", state: "device", model: "m", product: "", device: "", transportId: "1", isEmulator: true }] };

function setup(handlers: ConstructorParameters<typeof MemoryTransport>[0], latency = 0) {
  const t = new MemoryTransport({ "device.list": () => ({ devices: [] }), "device.adb.list": () => adbOne, ...handlers }, latency);
  const rpc = new RpcClient(t);
  render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <DevicePage />
    </ServicesContext.Provider>,
  );
  return { t, rpc };
}

describe("DevicePage — states and error paths", () => {
  it("shows the no-adb-devices empty state with the how-to hint", async () => {
    setup({ "device.adb.list": () => ({ adbPath: "/x", devices: [] }) });
    expect(await screen.findByText(/没有发现 ADB 设备/)).toBeTruthy();
  });

  it("a generic adb error is shown as a warning with its code, and the empty text is not shown with it", async () => {
    setup({ "device.adb.list": () => { throw { code: "adb.timeout", message: "adb devices 超时（15s）" }; } });
    expect(await screen.findByText(/adb devices 超时.*adb\.timeout/)).toBeTruthy();
    expect(screen.queryByText(/没有发现 ADB 设备/)).toBeNull();
  });

  it("refresh re-queries adb", async () => {
    const user = userEvent.setup();
    let n = 0;
    const { t } = setup({ "device.adb.list": () => (++n, adbOne) });
    await screen.findByText("emulator-5554");
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(t.sent.filter((m) => m.method === "device.adb.list")).toHaveLength(2));
  });

  it("restores already-connected devices (device.list) on mount", async () => {
    setup({ "device.list": () => ({ devices: [dev()] }) });
    expect(await screen.findByRole("article", { name: "device adb:emulator-5554" })).toBeTruthy();
  });

  it("a connected device cannot be connected twice, and connect is disabled while another action is busy", async () => {
    const user = userEvent.setup();
    setup({ "device.connect": () => new Promise((r) => setTimeout(() => r(dev()), 40)) });
    const btn = await screen.findByRole("button", { name: "连接 emulator-5554" });
    await user.click(btn);
    expect((screen.getByRole("button", { name: "连接 emulator-5554" }) as HTMLButtonElement).disabled).toBe(true); // busy
    await screen.findByRole("article");
    expect((screen.getByRole("button", { name: "连接 emulator-5554" }) as HTMLButtonElement).disabled).toBe(true); // already connected
  });

  it("the LAN connect button stays disabled for an empty/blank address, and Enter submits", async () => {
    const user = userEvent.setup();
    const { t } = setup({ "device.connect": (p) => dev({ id: "lan:" + p.address, transport: "lan", serial: "", address: String(p.address) }) });
    const btn = screen.getByRole("button", { name: "连接地址" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await user.type(screen.getByLabelText("device address"), "   ");
    expect(btn.disabled).toBe(true);
    await user.clear(screen.getByLabelText("device address"));
    await user.type(screen.getByLabelText("device address"), " 10.0.0.5{Enter}");
    await waitFor(() => expect(t.sent.find((m) => m.method === "device.connect")?.params).toEqual({ transport: "lan", address: "10.0.0.5" }));
  });

  it("scan with no result says so; a failing scan shows the error and re-enables the buttons", async () => {
    const user = userEvent.setup();
    let fail = false;
    setup({ "device.scan": () => { if (fail) throw { code: "rpc.bad_params", message: "scan range too large" }; return { found: [] }; } });
    await user.click(await screen.findByRole("button", { name: /扫描/ }));
    expect(await screen.findByText("没有发现设备")).toBeTruthy();
    fail = true;
    await user.click(screen.getByRole("button", { name: /扫描/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("scan range too large");
    expect((screen.getByRole("button", { name: /扫描/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an error banner is cleared by the next successful action", async () => {
    const user = userEvent.setup();
    let ok = false;
    setup({ "device.connect": () => { if (!ok) throw { code: "device.timeout", message: "timed out", retryable: true }; return dev(); } });
    await user.click(await screen.findByRole("button", { name: "连接 emulator-5554" }));
    await screen.findByRole("alert");
    ok = true;
    await user.click(screen.getByRole("button", { name: "连接 emulator-5554" }));
    await screen.findByRole("article");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a rejected non-RpcError (plain Error) is still shown", async () => {
    const user = userEvent.setup();
    setup({ "device.connect": () => { throw new Error("kaboom"); } });
    await user.click(await screen.findByRole("button", { name: "连接 emulator-5554" }));
    expect((await screen.findByRole("alert")).textContent).toContain("kaboom");
  });

  it("device card: capture hint only without capture permission, warning/error banners, offline pill", async () => {
    setup({ "device.list": () => ({ devices: [dev({ state: "offline", error: "cannot reach", warning: "无鉴权", info: { ...info, capture: false } })] }) });
    const card = await screen.findByRole("article");
    expect(within(card).getByText("离线")).toBeTruthy();
    expect(within(card).getByText("cannot reach")).toBeTruthy();
    expect(within(card).getByText("无鉴权")).toBeTruthy();
    expect(within(card).getByText(/尚未授予录屏|尚未授予|录屏（图色）权限/)).toBeTruthy();
  });

  it("device card: no capture hint when capture is granted; unknown values render as an em dash", async () => {
    setup({ "device.list": () => ({ devices: [dev({ info: { ...info, ip: "", version: "" } })] }) });
    const card = await screen.findByRole("article");
    expect(within(card).queryByText(/录屏（图色）权限/)).toBeNull();
    expect(within(card).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("screenshot: a failed image load shows the failure text and a retry works with a new URL", async () => {
    const user = userEvent.setup();
    setup({ "device.list": () => ({ devices: [dev()] }) });
    await screen.findByRole("article");
    await user.click(screen.getByRole("button", { name: "刷新截图" }));
    const img = (await screen.findByAltText("截图")) as HTMLImageElement;
    const first = img.getAttribute("src");
    fireEvent.error(img);
    expect(await screen.findByText("截图失败")).toBeTruthy();
    expect(screen.queryByAltText("截图")).toBeNull();
    await new Promise((r) => setTimeout(r, 3));
    await user.click(screen.getByRole("button", { name: "刷新截图" }));
    const again = (await screen.findByAltText("截图")) as HTMLImageElement;
    expect(again.getAttribute("src")).not.toBe(first); // a fresh nonce: never the cached (or cached-failed) URL
    expect(screen.queryByText("截图失败")).toBeNull();
  });

  it("device ids with special characters are URL-encoded in the screenshot path", async () => {
    const user = userEvent.setup();
    setup({ "device.list": () => ({ devices: [dev({ id: "lan:[::1]:9860/x y" })] }) });
    await user.click(await screen.findByRole("button", { name: "刷新截图" }));
    expect(((await screen.findByAltText("截图")) as HTMLImageElement).getAttribute("src")).toContain(encodeURIComponent("lan:[::1]:9860/x y"));
  });
});
