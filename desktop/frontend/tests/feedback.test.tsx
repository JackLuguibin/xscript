import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi, type Device } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MemoryTransport } from "../src/bridge/memory";
import { RpcError } from "../src/bridge/types";
import { DevicePage } from "../src/components/DevicePage";
import { ErrorBanner } from "../src/components/ErrorBanner";
import { MirrorPage } from "../src/components/MirrorPage";
import { ProjectsPage } from "../src/components/ProjectsPage";
import { ACTION_TOAST_MS, TOAST_MS, useToast } from "../src/components/Toast";
import { createDemoTransport } from "../src/demo";
import { describeCode, describeError, errorLine } from "../src/errors";
import { setLanguage, t } from "../src/strings";

afterEach(() => {
  setLanguage("zh");
  vi.useRealTimers();
});

describe("error mapping (H6)", () => {
  it("maps device / adb / rpc codes to an actionable zh title + hint and keeps the raw detail", () => {
    const u = describeError(new RpcError({ code: "device.unreachable", message: "cannot reach 127.0.0.1:41000: refused", retryable: true }));
    expect(u.title).toBe("连不上设备");
    expect(u.hint).toMatch(/前台/);
    expect(u.hint).toMatch(/端口转发/);
    expect(u.detail).toBe("cannot reach 127.0.0.1:41000: refused [device.unreachable]");
    expect(describeCode("device.timeout", "device GET /status timed out").title).toBe("设备响应超时");
    expect(describeCode("rpc.timeout", "timed out").title).toBe("操作超时");
    expect(describeCode("adb.not_found", "找不到 adb").hint).toMatch(/platform-tools/);
    expect(describeCode("device.protocol", "invalid port in device address: host:99999").title).toBe("设备地址格式不对");
    expect(describeCode("device.protocol", "unexpected /status response").title).toBe("对方不像 XScript 设备");
  });

  it("device.http picks the hint by HTTP status: 409 already running, 401, 5xx; unknown status keeps the message", () => {
    const busy = describeCode("device.http", "device POST /run -> 409: already running", { status: 409, detail: "already running" });
    expect(busy.title).toMatch(/已有脚本在运行/);
    expect(busy.hint).toMatch(/停止/);
    expect(busy.detail).toContain('"status":409');
    expect(describeCode("device.http", "device POST /x -> 409").title).toMatch(/已有脚本在运行/); // status parsed from the message
    expect(describeCode("device.http", "x", { status: 401 }).hint).toMatch(/配对码/);
    expect(describeCode("device.http", "x", { status: 503 }).title).toBe("设备内部出错");
    const other = describeCode("device.http", "device GET /x -> 418 teapot", { status: 418 });
    expect(other.title).toBe("设备返回了错误");
    expect(other.hint).toBe("device GET /x -> 418 teapot");
  });

  it("adb.not_ready with an unauthorized device gets the USB-debugging hint", () => {
    const d = describeCode("adb.not_ready", "设备 X 状态为 unauthorized（需要 device；unauthorized 请在手机上允许 USB 调试）");
    expect(d.title).toBe("手机未授权 USB 调试");
    expect(d.hint).toMatch(/允许/);
    expect(describeCode("adb.not_ready", "设备 X 状态为 offline").title).toBe("设备暂时不能通过 adb 使用");
  });

  it("codes without a hint of their own show the backend message; unknown codes and plain errors fall back to the message", () => {
    expect(describeCode("rpc.bad_params", "project name is empty")).toMatchObject({ title: "参数不正确", hint: "project name is empty" });
    expect(describeCode("rpc.cancelled", "cancelled").hint).toBe("");
    expect(describeCode("weird.code", "boom")).toMatchObject({ title: "boom", hint: "", detail: "boom [weird.code]" });
    expect(describeError(new Error("kaboom"))).toMatchObject({ title: "kaboom", detail: "kaboom" });
    expect(describeError({ code: "device.timeout", message: "slow" }).title).toBe("设备响应超时");
    expect(describeError(undefined).title).toBe("操作失败");
    expect(errorLine(new RpcError({ code: "tools.offline", message: "x", retryable: false }))).toBe("设备不在线：先连接设备，再打开工具页。");
  });

  it("follows the UI language", () => {
    setLanguage("en");
    expect(describeCode("device.unreachable", "x").title).toBe("Can't reach the device");
    expect(describeCode("device.http", "x", { status: 409 }).title).toMatch(/already running/);
    expect(Object.keys(t.errors.codes).length).toBeGreaterThan(30);
  });
});

function withServices(ui: React.ReactNode, handlers: ConstructorParameters<typeof MemoryTransport>[0] = {}) {
  const transport = new MemoryTransport({ "app.copyText": () => ({ ok: true }), ...handlers });
  const rpc = new RpcClient(transport);
  render(<ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>{ui}</ServicesContext.Provider>);
  return transport;
}

describe("ErrorBanner", () => {
  it("shows title + hint, hides the raw detail until 详情, copies it, and can be dismissed", async () => {
    const onDismiss = vi.fn();
    const transport = withServices(
      <ErrorBanner error={new RpcError({ code: "device.unreachable", message: "cannot reach 1.2.3.4:9860", retryable: true })} onDismiss={onDismiss} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("连不上设备");
    expect(alert.textContent).not.toContain("cannot reach");
    const toggle = within(alert).getByRole("button", { name: "详情" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(alert).getByText("cannot reach 1.2.3.4:9860 [device.unreachable]")).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "复制" }));
    await within(alert).findByRole("button", { name: "已复制" });
    expect(transport.sent.find((m) => m.method === "app.copyText")?.params).toEqual({ text: "cannot reach 1.2.3.4:9860 [device.unreachable]" });
    fireEvent.click(within(alert).getByRole("button", { name: "关闭提示" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

function ToastProbe({ onUndo = () => {} }: { onUndo?: () => void } = {}) {
  const { toast, toasts } = useToast();
  return (
    <>
      <button onClick={() => toast("已发送")}>go</button>
      <button onClick={() => toast("已删除 a.py", { label: "撤销", run: onUndo })}>del</button>
      {toasts}
    </>
  );
}

describe("toasts", () => {
  it("auto-dismiss after TOAST_MS and can be closed early", () => {
    vi.useFakeTimers();
    render(<ToastProbe />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.getByRole("status").textContent).toContain("已发送");
    act(() => vi.advanceTimersByTime(TOAST_MS - 10));
    expect(screen.getByRole("status").textContent).toContain("已发送");
    act(() => vi.advanceTimersByTime(20));
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "关闭提示" }));
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("action toasts", () => {
  it("show the action, run it once and close; stay up for ACTION_TOAST_MS", () => {
    vi.useFakeTimers();
    const onUndo = vi.fn();
    render(<ToastProbe onUndo={onUndo} />);
    fireEvent.click(screen.getByRole("button", { name: "del" }));
    act(() => vi.advanceTimersByTime(TOAST_MS + 10));
    expect(screen.getByRole("status").textContent).toContain("已删除 a.py");
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "撤销" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "del" }));
    act(() => vi.advanceTimersByTime(ACTION_TOAST_MS + 10));
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

// ---- per-item busy (H7) -------------------------------------------------------------------------------------------------------

const info = { name: "emu", model: "m", brand: "google", android: "17", sdk: 37, width: 1080, height: 2337, density: 420, ip: "10.0.2.16", version: "0.2.6",
  deviceId: "id", running: false, accessibility: false, root: false, capture: true, channel: "none", cloud: "", project: "" };
const dev = (over: Partial<Device> = {}): Device => ({ id: "adb:emulator-5554", transport: "adb", address: "127.0.0.1:41000", serial: "emulator-5554", forwardPort: 41000,
  state: "online", error: "", warning: "", lastSeen: 1, info, status: {}, ...over });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("DevicePage feedback", () => {
  it("connecting one adb device does not disable LAN connect or scan; errors are dismissable", async () => {
    const gate = deferred<unknown>();
    withServices(<DevicePage />, {
      "device.list": () => ({ devices: [] }),
      "device.adb.list": () => ({ adbPath: "/x/adb", devices: [
        { serial: "A", state: "device", model: "a", product: "", device: "", transportId: "1", isEmulator: false },
        { serial: "B", state: "device", model: "b", product: "", device: "", transportId: "2", isEmulator: false },
      ] }),
      "device.connect": async (p) => {
        if (p.serial === "A") {
          await gate.promise;
          throw { code: "device.timeout", message: "device GET /status timed out" };
        }
        return dev({ id: "adb:B", serial: "B" });
      },
      "device.scan": () => ({ found: [] }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "连接 A" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "连接 A" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "连接 B" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: t.scan }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: "device address" }), { target: { value: "10.0.0.9:9860" } });
    expect((screen.getByRole("button", { name: t.addressConnect }) as HTMLButtonElement).disabled).toBe(false);
    gate.resolve(null);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("设备响应超时");
    fireEvent.click(within(alert).getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a device card's raw error goes through the same mapping (errorCode) and can be hidden until it changes", async () => {
    const transport = withServices(<DevicePage />, {
      "device.list": () => ({ devices: [dev({ state: "offline", error: "cannot reach 127.0.0.1:41000: refused", errorCode: "device.unreachable" })] }),
      "device.adb.list": () => ({ adbPath: "/x/adb", devices: [] }),
    });
    const card = await screen.findByRole("article");
    const banner = within(card).getByRole("status", { name: /adb:emulator-5554/ });
    expect(banner.textContent).toContain("连不上设备");
    expect(banner.textContent).toMatch(/前台/);
    fireEvent.click(within(banner).getByRole("button", { name: "详情" }));
    expect(banner.textContent).toContain("cannot reach 127.0.0.1:41000: refused [device.unreachable]");
    fireEvent.click(within(banner).getByRole("button", { name: "关闭提示" }));
    expect(within(card).queryByText("连不上设备")).toBeNull();
    // a new error text shows again
    act(() => transport.push({ event: true, topic: "device.state", data: dev({ state: "offline", error: "device GET /status timed out", errorCode: "device.timeout" }) }));
    expect(await within(screen.getByRole("article")).findByText("设备响应超时")).toBeTruthy();
  });
});

async function projectsSetup() {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  const d = await api.connectAdb("emulator-5554");
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <ProjectsPage pollMs={20} />
    </ServicesContext.Provider>,
  );
  return { transport, api, d };
}

describe("ProjectsPage feedback", () => {
  it("toasts 「已启动 demo」 after a run starts", async () => {
    await projectsSetup();
    fireEvent.click(await screen.findByRole("button", { name: /^demo/ }));
    await screen.findByRole("button", { name: /^__init__\.py/ });
    fireEvent.click(screen.getByRole("button", { name: "保存并运行" }));
    expect(await screen.findByText("已启动 demo")).toBeTruthy();
  });

  it("「停止」 stays clickable while a save is in flight and while a run is starting; keys stay usable too", async () => {
    const { transport, d } = await projectsSetup();
    fireEvent.click(await screen.findByRole("button", { name: /^demo/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^__init__\.py/ }));
    const editor = (await screen.findByRole("textbox", { name: "编辑器" }, { timeout: 3000 })) as HTMLTextAreaElement;
    act(() => transport.push({ event: true, topic: "device.state", data: { ...d, info: { ...d.info, running: true, project: "demo" } } }));
    const stop = () => screen.getByRole("button", { name: "停止" }) as HTMLButtonElement;
    await waitFor(() => expect(stop().disabled).toBe(false));

    const write = deferred<unknown>();
    transport.setHandler("project.write", () => write.promise);
    fireEvent.change(editor, { target: { value: "print(2)\n" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "保存并运行" }) as HTMLButtonElement).disabled).toBe(true));
    expect(stop().disabled).toBe(false);
    expect((screen.getByRole("button", { name: "主页" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stop());
    await waitFor(() => expect(transport.sent.some((m) => m.method === "project.stop")).toBe(true));
    write.resolve({ ok: true });
    await screen.findByText("已保存");

    // not running, but a run is in flight (e.g. a slow device): 停止 is enabled for it
    act(() => transport.push({ event: true, topic: "device.state", data: { ...d, info: { ...d.info, running: false } } }));
    const run = deferred<unknown>();
    transport.setHandler("project.run", () => run.promise);
    await waitFor(() => expect(stop().disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "保存并运行" }));
    await waitFor(() => expect(stop().disabled).toBe(false));
    run.resolve({ ok: true, running: true, project: "demo" });
    expect(await screen.findByText("已启动 demo")).toBeTruthy();
  });

  it("a 409 from the device is explained, not shown as raw text", async () => {
    const { transport } = await projectsSetup();
    fireEvent.click(await screen.findByRole("button", { name: /^demo/ }));
    await screen.findByRole("button", { name: /^__init__\.py/ });
    transport.setHandler("project.run", () => {
      throw { code: "device.http", message: "device POST /projects/demo/run -> 409: busy", details: { status: 409, detail: "busy" } };
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并运行" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("设备正忙：已有脚本在运行");
    expect(alert.textContent).not.toContain("409");
    expect(screen.queryByText(/已启动/)).toBeNull();
  });
});

describe("MirrorPage feedback", () => {
  it("a failed text send shows the mapped error and no 「已发送」 toast; a good one toasts", async () => {
    const transport = createDemoTransport();
    const rpc = new RpcClient(transport);
    const api = createApi(rpc);
    await api.connectAdb("emulator-5554");
    render(
      <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
        <MirrorPage />
      </ServicesContext.Provider>,
    );
    transport.setHandler("device.action", () => {
      throw { code: "device.unreachable", message: "cannot reach" };
    });
    const box = (await screen.findByRole("textbox", { name: t.mirror.text })) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: t.mirror.send }));
    expect((await screen.findByRole("alert")).textContent).toContain("连不上设备");
    expect(screen.queryByText(t.mirror.sent("hi"))).toBeNull();
    expect(box.value).toBe("hi");
    transport.setHandler("device.action", () => ({ ok: true }));
    fireEvent.click(screen.getByRole("button", { name: t.mirror.send }));
    expect(await screen.findByText(t.mirror.sent("hi"))).toBeTruthy();
  });
});
