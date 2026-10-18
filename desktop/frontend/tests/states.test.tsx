import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi, type Device } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MemoryTransport } from "../src/bridge/memory";
import { Badge } from "../src/components/Badge";
import { DevicePage } from "../src/components/DevicePage";
import { EmptyState } from "../src/components/EmptyState";

const info = { name: "emu", model: "m", brand: "g", android: "17", sdk: 37, width: 1080, height: 2337, density: 420, ip: "1.2.3.4", version: "0.2.6", deviceId: "id",
  running: false, accessibility: false, root: false, capture: true, channel: "none", cloud: "", project: "" };
const dev = (o: Partial<Device> = {}): Device => ({ id: "adb:e", transport: "adb", address: "127.0.0.1:1", serial: "e", forwardPort: 1, state: "online", error: "", warning: "", lastSeen: 1, info, status: {}, ...o });

function setup(h: ConstructorParameters<typeof MemoryTransport>[0], latency = 0) {
  const t = new MemoryTransport({ "device.list": () => ({ devices: [] }), "device.adb.list": () => ({ adbPath: "/x", devices: [] }), ...h }, latency);
  const rpc = new RpcClient(t);
  render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <DevicePage />
    </ServicesContext.Provider>,
  );
  return t;
}

describe("empty / loading / error states", () => {
  it("no connected device: explanatory empty state announced as status", async () => {
    setup({});
    const e = await screen.findByText("还没有连接设备");
    expect(e.closest("[role=status]")).toBeTruthy();
    expect(screen.getByText(/第一次使用请先在手机上打开 XScript/)).toBeTruthy();
  });

  it("adb list loading: skeleton is exposed as busy and the refresh button is disabled until it resolves", async () => {
    setup({ "device.adb.list": () => new Promise((r) => setTimeout(() => r({ adbPath: "/x", devices: [] }), 60)) });
    const busy = document.querySelector('[aria-busy="true"]');
    expect(busy).toBeTruthy();
    expect((screen.getByRole("button", { name: "刷新" }) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText("未发现 USB 设备");
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("adb missing: error state (alert) with a retry that re-queries", async () => {
    const user = userEvent.setup();
    let n = 0;
    const t = setup({ "device.adb.list": () => { n++; if (n === 1) throw { code: "adb.not_found", message: "x" }; return { adbPath: "/x", devices: [] }; } });
    const alert = await screen.findByRole("alert", { name: "" }).catch(() => null);
    expect(alert ?? screen.getByText("未检测到 adb")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("未发现 USB 设备");
    expect(t.sent.filter((m) => m.method === "device.adb.list")).toHaveLength(2);
  });

  it("adb generic failure shows the code and a retry", async () => {
    setup({ "device.adb.list": () => { throw { code: "adb.timeout", message: "adb 超时" }; } });
    expect(await screen.findByText("查询 ADB 设备失败")).toBeTruthy();
    expect(screen.getByText("adb 命令超时")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.getByText(/adb 超时 \[adb\.timeout\]/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("unauthorized / offline adb devices explain what to do, in words not just colour", async () => {
    setup({ "device.adb.list": () => ({ adbPath: "/x", devices: [
      { serial: "R5", state: "unauthorized", model: "", product: "", device: "", transportId: "1", isEmulator: false },
      { serial: "emulator-5556", state: "offline", model: "", product: "", device: "", transportId: "2", isEmulator: true }] }) });
    expect(await screen.findByText(/允许这台电脑的 USB 调试/)).toBeTruthy();
    expect(screen.getByText(/adb 报告设备无响应/)).toBeTruthy();
    expect(screen.getByText("unauthorized")).toBeTruthy();
  });

  it("screenshot states: idle placeholder → loading skeleton (button disabled) → loaded", async () => {
    const user = userEvent.setup();
    setup({ "device.list": () => ({ devices: [dev()] }) });
    const card = await screen.findByRole("article");
    expect(within(card).getByText("点击下方按钮获取截图")).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "刷新截图" }));
    expect(within(card).getByRole("status", { name: "正在截图…" })).toBeTruthy();
    expect((within(card).getByRole("button", { name: "刷新截图" }) as HTMLButtonElement).disabled).toBe(true);
    expect(card.querySelector(".shot")!.getAttribute("aria-busy")).toBe("true");
    const img = within(card).getByAltText("截图");
    img.dispatchEvent(new Event("load"));
    await waitFor(() => expect(within(card).queryByRole("status", { name: "正在截图…" })).toBeNull());
    expect(card.querySelector(".shot")!.getAttribute("aria-busy")).toBe("false");
    expect((within(card).getByRole("button", { name: "刷新截图" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("screenshot keeps the device aspect ratio so the frame does not jump", async () => {
    setup({ "device.list": () => ({ devices: [dev()] }) });
    const frame = (await screen.findByRole("article")).querySelector(".shot-frame") as HTMLElement;
    expect(frame.style.aspectRatio.replace(/\s/g, "")).toBe("1080/2337");
  });

  it("connecting devices get a warn badge, offline a bad one; the text is always present", async () => {
    setup({ "device.list": () => ({ devices: [dev({ id: "adb:a", state: "connecting" }), dev({ id: "adb:b", state: "offline" })] }) });
    await screen.findAllByRole("article");
    expect(screen.getByText("连接中").className).toContain("warn");
    expect(screen.getByText("连接中").className).toContain("busy");
    expect(screen.getByText("离线").className).toContain("bad");
  });
});

describe("primitives", () => {
  it("Badge keeps its decorative dot out of the accessibility tree", () => {
    render(<Badge tone="ok">在线</Badge>);
    expect(screen.getByText("在线").querySelector(".dot")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("EmptyState renders title, body, actions and the error tone", () => {
    render(<EmptyState icon={<i />} title="T" tone="error" role="alert" actions={<button>Go</button>}>body</EmptyState>);
    const a = screen.getByRole("alert");
    expect(a.className).toContain("error");
    expect(within(a).getByText("T")).toBeTruthy();
    expect(within(a).getByText("body")).toBeTruthy();
    expect(within(a).getByRole("button", { name: "Go" })).toBeTruthy();
  });
});
