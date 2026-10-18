import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { ServicesContext } from "../src/app-context";
import { createApi, type Device } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MemoryTransport } from "../src/bridge/memory";
import { DevicePage } from "../src/components/DevicePage";
import { createDemoTransport } from "../src/demo";
import { DEVICE_KEY, DeviceProvider, pickDevice, useCurrentDevice } from "../src/device-context";

const info = { name: "emu", model: "m", brand: "g", android: "17", sdk: 37, width: 1080, height: 2337, density: 420, ip: "1.2.3.4", version: "0.2.6", deviceId: "id",
  running: false, accessibility: false, root: false, capture: true, channel: "none", cloud: "", project: "" };
const dev = (o: Partial<Device> = {}): Device => ({ id: "adb:e", transport: "adb", address: "127.0.0.1:1", serial: "e", forwardPort: 1, state: "online", error: "", warning: "",
  lastSeen: 1, info, status: {}, saved: true, name: "", group: "", note: "", autoConnect: true, ...o });

type Handlers = ConstructorParameters<typeof MemoryTransport>[0];

function page(h: Handlers, { unsaved = false, adbPollMs = 0 } = {}) {
  const t = new MemoryTransport({ "device.list": () => ({ devices: [] }), "device.adb.list": () => ({ adbPath: "/x", devices: [] }), "app.settings.get": () => ({ adbPath: null, autoReconnect: true }), ...h });
  const rpc = new RpcClient(t);
  const view = render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <DeviceProvider unsaved={unsaved}>
        <Current />
        <DevicePage adbPollMs={adbPollMs} />
      </DeviceProvider>
    </ServicesContext.Provider>,
  );
  return { t, ...view };
}

/** what the provider currently holds, plus a way to switch from the test */
function Current() {
  const { devId, select } = useCurrentDevice();
  return (
    <p>
      <span data-testid="current">{devId}</span>
      <button onClick={() => void select("adb:b")}>switch-b</button>
    </p>
  );
}

function app() {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const view = render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <App />
    </ServicesContext.Provider>,
  );
  return { transport, ...view };
}

const setVisibility = (v: DocumentVisibilityState) => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
afterEach(() => setVisibility("visible"));

describe("current device (H4)", () => {
  it("pickDevice: sticky while listed (even offline), else the remembered one, else the first online", () => {
    const list = [dev({ id: "a", state: "offline" }), dev({ id: "b" }), dev({ id: "c" })];
    expect(pickDevice(list, "a", "c")).toBe("a");
    expect(pickDevice(list, "gone", "c")).toBe("c");
    expect(pickDevice(list, "", "gone")).toBe("b");
    expect(pickDevice([dev({ id: "a", state: "offline" })], "", "")).toBe("");
    // a fallback pick (not the user's) yields to the remembered device once it is listed
    expect(pickDevice(list, "b", "c", false)).toBe("c");
    expect(pickDevice(list, "b", "gone", false)).toBe("b");
  });

  it("the top-bar switcher lists devices, marks offline ones, and its pick survives a restart", async () => {
    const first = app();
    await act(async () => {
      await createApi(new RpcClient(first.transport)).connectAdb("emulator-5554");
      await createApi(new RpcClient(first.transport)).connectLan("10.0.0.8:9860");
    });
    const sw = (await screen.findByRole("combobox", { name: "当前设备" })) as HTMLSelectElement;
    await waitFor(() => expect(sw.options.length).toBe(2));
    expect(sw.value).toBe("adb:emulator-5554"); // nothing remembered: the first online one
    fireEvent.change(sw, { target: { value: "lan:10.0.0.8:9860" } });
    await waitFor(() => expect(sw.value).toBe("lan:10.0.0.8:9860"));
    expect(localStorage.getItem(DEVICE_KEY)).toBe("lan:10.0.0.8:9860");
    first.transport.push({ event: true, topic: "device.state", data: { ...dev({ id: "adb:emulator-5554" }), state: "offline", info: { ...info, name: "备用机" } } });
    const opt = await screen.findByRole("option", { name: /备用机/ });
    expect(opt.textContent).toBe("备用机（离线）");
    expect((opt as HTMLOptionElement).disabled).toBe(true);
    first.unmount();

    // a fresh start (new transport, same storage): the remembered device wins over the first online one
    const second = app();
    await act(async () => {
      const api = createApi(new RpcClient(second.transport));
      await api.connectAdb("emulator-5554");
      await api.connectLan("10.0.0.8:9860");
    });
    const sw2 = (await screen.findByRole("combobox", { name: "当前设备" })) as HTMLSelectElement;
    await waitFor(() => expect(sw2.value).toBe("lan:10.0.0.8:9860"));
  });

  it("「屏幕」/「工程」 on a card make it current and open that page; mirror and projects follow the switcher", async () => {
    const user = userEvent.setup();
    const { transport } = app();
    await act(async () => {
      const api = createApi(new RpcClient(transport));
      await api.connectAdb("emulator-5554");
      await api.connectLan("10.0.0.8:9860");
    });
    const cards = await screen.findAllByRole("article");
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    expect(cards[0].getAttribute("aria-current")).toBe("true");
    const lan = screen.getByRole("article", { name: "device lan:10.0.0.8:9860" });
    await user.click(within(lan).getByRole("button", { name: /的屏幕$/ }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("屏幕");
    expect((screen.getByRole("combobox", { name: "当前设备" }) as HTMLSelectElement).value).toBe("lan:10.0.0.8:9860");
    await waitFor(() => expect(transport.sent.some((m) => m.method === "mirror.subscribe" && m.params?.id === "lan:10.0.0.8:9860")).toBe(true));
    // the mirror page has no device picker of its own any more
    expect(screen.queryByRole("combobox", { name: "设备" })).toBeNull();

    await user.click(within(screen.getByRole("navigation", { name: "main" })).getByRole("button", { name: "设备" }));
    const adb = await screen.findByRole("article", { name: "device adb:emulator-5554" });
    await user.click(within(adb).getByRole("button", { name: /的工程$/ }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("工程");
    await waitFor(() => expect(transport.sent.some((m) => m.method === "project.list" && m.params?.id === "adb:emulator-5554")).toBe(true));
  });

  it("an offline card has no shortcuts, only 重试", async () => {
    page({ "device.list": () => ({ devices: [dev({ state: "offline", forwardPort: 0 })] }) });
    const card = await screen.findByRole("article");
    expect(within(card).queryByRole("button", { name: /的屏幕$/ })).toBeNull();
    expect(within(card).getByRole("button", { name: /^重试/ })).toBeTruthy();
  });
});

describe("unsaved edits guard the current device", () => {
  it("switching away asks first; declining keeps the device", async () => {
    const user = userEvent.setup();
    page({ "device.list": () => ({ devices: [dev({ id: "adb:a" }), dev({ id: "adb:b" })] }) }, { unsaved: true });
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("adb:a"));
    await user.click(screen.getByRole("button", { name: "switch-b" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("切换设备会关闭当前文件");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByTestId("current").textContent).toBe("adb:a");
    await user.click(screen.getByRole("button", { name: "switch-b" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("adb:b"));
  });

  it("忘记 on the current device goes through the in-app confirm (other devices do not ask)", async () => {
    const user = userEvent.setup();
    const { t } = page({ "device.list": () => ({ devices: [dev({ id: "adb:a" }), dev({ id: "adb:b" })] }), "device.forget": () => ({ forgotten: true }) }, { unsaved: true });
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("adb:a"));
    const a = screen.getByRole("article", { name: "device adb:a" });
    await user.click(within(a).getByRole("button", { name: "adb:a 的详情" }));
    await user.click(within(a).getByRole("button", { name: "忘记 adb:a" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("忘记它会关闭当前文件");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(t.sent.some((m) => m.method === "device.forget")).toBe(false);
    await user.click(within(a).getByRole("button", { name: "忘记 adb:a" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(t.sent.filter((m) => m.method === "device.forget")).toHaveLength(1));

    const b = screen.getByRole("article", { name: "device adb:b" });
    await user.click(within(b).getByRole("button", { name: "adb:b 的详情" }));
    await user.click(within(b).getByRole("button", { name: "忘记 adb:b" }));
    await waitFor(() => expect(t.sent.filter((m) => m.method === "device.forget")).toHaveLength(2));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("device page layout (M4)", () => {
  it("添加设备 is open when nothing is saved, folded when devices exist, and toggles", async () => {
    const user = userEvent.setup();
    page({});
    const toggle = await screen.findByRole("button", { name: "添加设备" });
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    expect(screen.getByRole("textbox", { name: "device address" })).toBeTruthy();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("textbox", { name: "device address" })).toBeNull();
  });

  it("with saved devices the panel starts folded; the cards come first", async () => {
    page({ "device.list": () => ({ devices: [dev()] }) });
    await screen.findByRole("article");
    const toggle = screen.getByRole("button", { name: "添加设备" });
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
    expect(screen.queryByRole("region", { name: "添加设备" })).toBeNull();
  });

  it("the global auto-reconnect switch reads and writes app settings", async () => {
    const user = userEvent.setup();
    const { t } = page({ "app.settings.set": (p) => ({ adbPath: null, autoReconnect: Boolean(p.autoReconnect) }) });
    const box = (await screen.findByRole("checkbox", { name: "自动重连设备" })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await user.click(box);
    await waitFor(() => expect(box.checked).toBe(false));
    expect(t.sent.find((m) => m.method === "app.settings.set")?.params).toEqual({ autoReconnect: false });
  });
});

describe("ADB hotplug polling (H5)", () => {
  it("re-lists ADB devices while visible, pauses when hidden, stops on unmount; a new device shows up", async () => {
    let n = 0;
    const devices = [{ serial: "emulator-5554", state: "device", model: "m", product: "", device: "", transportId: "1", isEmulator: true }];
    const { t, unmount } = page({ "device.adb.list": () => (++n, { adbPath: "/x", devices: n >= 3 ? devices : [] }) }, { adbPollMs: 20 });
    expect(await screen.findByText("emulator-5554")).toBeTruthy();
    expect(screen.queryByRole("status", { name: /加载/ })).toBeNull(); // silent: no skeleton on a tick
    setVisibility("hidden");
    await new Promise((r) => setTimeout(r, 30));
    const hidden = t.sent.filter((m) => m.method === "device.adb.list").length;
    await new Promise((r) => setTimeout(r, 80));
    expect(t.sent.filter((m) => m.method === "device.adb.list").length).toBe(hidden);
    setVisibility("visible");
    await waitFor(() => expect(t.sent.filter((m) => m.method === "device.adb.list").length).toBeGreaterThan(hidden));
    unmount();
    const after = t.sent.filter((m) => m.method === "device.adb.list").length;
    await new Promise((r) => setTimeout(r, 80));
    expect(t.sent.filter((m) => m.method === "device.adb.list").length).toBe(after);
  });

  it("a failing tick keeps the last good list", async () => {
    let n = 0;
    page({ "device.adb.list": () => { if (++n > 1) throw { code: "adb.timeout", message: "slow" }; return { adbPath: "/x", devices: [{ serial: "R5", state: "device", model: "", product: "", device: "", transportId: "1", isEmulator: false }] }; } }, { adbPollMs: 20 });
    expect(await screen.findByText("R5")).toBeTruthy();
    await screen.findByText("查询 ADB 设备失败");
    expect(screen.getByText("R5")).toBeTruthy();
  });
});

describe("LAN scan progress (M7)", () => {
  it("streams found devices and progress, and 取消扫描 stops it", async () => {
    const user = userEvent.setup();
    let finish: (v: unknown) => void = () => undefined;
    let id = "";
    const { t } = page({
      "device.scan": (p) => {
        id = String(p.scanId);
        return new Promise((r) => (finish = r));
      },
      "device.scan.cancel": (p) => {
        finish({ found: [{ address: "10.0.0.7:9860", host: "10.0.0.7", port: 9860, info: { name: "pixel" } }], cancelled: true, total: 508 });
        return { cancelled: p.scanId === id };
      },
    });
    await user.click(await screen.findByRole("button", { name: /扫描本机/ }));
    await waitFor(() => expect(id).toMatch(/^scan-/));
    await act(async () => {
      t.push({ event: true, topic: "device.scan.progress", data: { scanId: id, done: 127, total: 508 } });
      t.push({ event: true, topic: "device.scan.found", data: { scanId: id, device: { address: "10.0.0.7:9860", host: "10.0.0.7", port: 9860, info: { name: "pixel" } } } });
      t.push({ event: true, topic: "device.scan.found", data: { scanId: "someone-else", device: { address: "10.0.0.9:9860", host: "10.0.0.9", port: 9860, info: {} } } });
    });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText(/已探测 127 \/ 508 · 已发现 1 台/)).toBeTruthy();
    expect(screen.getByText("10.0.0.7:9860", { selector: "strong" })).toBeTruthy();
    expect(screen.queryByText("10.0.0.9:9860")).toBeNull();
    await user.click(screen.getByRole("button", { name: "取消扫描" }));
    expect(t.sent.find((m) => m.method === "device.scan.cancel")?.params).toEqual({ scanId: id });
    expect(await screen.findByText("已取消扫描，发现 1 台")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("button", { name: "连接 10.0.0.7:9860" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /扫描本机/ })).toBeTruthy();
  });
});
