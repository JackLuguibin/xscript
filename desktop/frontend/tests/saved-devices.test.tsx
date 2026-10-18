import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi, type Device } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MemoryTransport } from "../src/bridge/memory";
import { DevicePage } from "../src/components/DevicePage";

const info = {
  name: "emu", model: "sdk", brand: "google", android: "14", sdk: 34, width: 1080, height: 2400, density: 420,
  ip: "10.0.2.16", version: "0.2.6", deviceId: "abc", running: false, accessibility: false, root: false, capture: true,
  channel: "none", cloud: "", project: "",
};

function saved(over: Partial<Device> = {}): Device {
  return {
    id: "adb:emulator-5554", transport: "adb", address: "emulator-5554", serial: "emulator-5554", forwardPort: 0,
    state: "offline", error: "", warning: "", lastSeen: 1, info, status: {}, saved: true, name: "实验室", group: "甲",
    note: "门口", autoConnect: false, ...over,
  };
}

function setup(handlers: ConstructorParameters<typeof MemoryTransport>[0]) {
  const t = new MemoryTransport({
    "device.list": () => ({ devices: [] }),
    "device.adb.list": () => ({ adbPath: "/x/adb", devices: [] }),
    ...handlers,
  });
  const rpc = new RpcClient(t);
  render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <DevicePage />
    </ServicesContext.Provider>,
  );
  return t;
}

describe("saved devices", () => {
  it("shows an offline saved card with name, group and transport, and no capture nag", async () => {
    setup({ "device.list": () => ({ devices: [saved()] }) });
    const card = await screen.findByRole("article", { name: "device adb:emulator-5554" });
    expect(within(card).getByRole("heading", { name: "实验室" })).toBeTruthy();
    expect(within(card).getByText("甲")).toBeTruthy();
    expect(within(card).getByText("离线")).toBeTruthy();
    expect(within(card).getByText("adb emulator-5554")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "重试 emulator-5554" })).toBeTruthy();
    // compact card: the saved-meta form and 忘记 fold under 详情
    expect(within(card).queryByRole("button", { name: "忘记 adb:emulator-5554" })).toBeNull();
    const toggle = within(card).getByRole("button", { name: "adb:emulator-5554 的详情" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(card).getByRole("button", { name: "忘记 adb:emulator-5554" })).toBeTruthy();
    expect(within(card).queryByText(/录屏（图色）权限/)).toBeNull();
  });

  it("saves name, group, note and auto-connect through device.update", async () => {
    const user = userEvent.setup();
    const t = setup({
      "device.list": () => ({ devices: [saved()] }),
      "device.update": (p) => saved({ name: String(p.name), group: String(p.group), note: String(p.note), autoConnect: Boolean(p.autoConnect), state: "offline" }),
    });
    const card = await screen.findByRole("article");
    await user.click(within(card).getByRole("button", { name: "adb:emulator-5554 的详情" }));
    await user.clear(within(card).getByLabelText("名称 adb:emulator-5554"));
    await user.type(within(card).getByLabelText("名称 adb:emulator-5554"), "新名字");
    await user.click(within(card).getByLabelText("自动重连 adb:emulator-5554"));
    await user.click(within(card).getByRole("button", { name: "保存 adb:emulator-5554" }));
    await waitFor(() => expect(t.sent.some((m) => m.method === "device.update")).toBe(true));
    const params = t.sent.find((m) => m.method === "device.update")?.params;
    expect(params).toMatchObject({ id: "adb:emulator-5554", name: "新名字", group: "甲", note: "门口", autoConnect: true });
    expect(await screen.findByRole("heading", { name: "新名字" })).toBeTruthy();
  });

  it("disconnect keeps the saved card offline; forget removes it", async () => {
    const user = userEvent.setup();
    const online = saved({ state: "online", address: "127.0.0.1:41000", forwardPort: 41000 });
    const t = setup({
      "device.list": () => ({ devices: [online] }),
      "device.disconnect": () => ({ removed: true, device: saved() }),
      "device.forget": () => ({ forgotten: true }),
    });
    const card = await screen.findByRole("article");
    await user.click(within(card).getByRole("button", { name: "断开" }));
    expect(await within(card).findByText("离线")).toBeTruthy();
    expect(t.sent.some((m) => m.method === "device.disconnect")).toBe(true);
    await user.click(within(card).getByRole("button", { name: "adb:emulator-5554 的详情" }));
    await user.click(within(card).getByRole("button", { name: "忘记 adb:emulator-5554" }));
    await waitFor(() => expect(screen.queryByRole("article")).toBeNull());
    expect(t.sent.some((m) => m.method === "device.forget")).toBe(true);
  });

  it("retry of an offline card calls device.connect with the serial", async () => {
    const user = userEvent.setup();
    const t = setup({
      "device.list": () => ({ devices: [saved()] }),
      "device.connect": () => saved({ state: "online", address: "127.0.0.1:41000", forwardPort: 41000 }),
    });
    await user.click(await screen.findByRole("button", { name: "重试 emulator-5554" }));
    await waitFor(() => expect(t.sent.find((m) => m.method === "device.connect")?.params).toEqual({ transport: "adb", serial: "emulator-5554" }));
    expect(await screen.findByText("在线")).toBeTruthy();
  });

  it("shows the read-only database notice", async () => {
    setup({ "device.list": () => ({ devices: [], notice: "db.newer" }) });
    expect(await screen.findByText(/来自更新的版本/)).toBeTruthy();
  });

  it("names the quarantined file when the database was rebuilt", async () => {
    setup({ "device.list": () => ({ devices: [], notice: "db.corrupt", noticeDetail: "desktop.db.corrupt-20261016" }) });
    expect(await screen.findByText(/desktop\.db\.corrupt-20261016/)).toBeTruthy();
  });
});
