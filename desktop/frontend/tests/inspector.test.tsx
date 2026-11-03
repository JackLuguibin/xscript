import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MirrorPage } from "../src/components/MirrorPage";
import { createDemoTransport } from "../src/demo";

async function setup() {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  await api.connectAdb("emulator-5554");
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <MirrorPage />
    </ServicesContext.Provider>,
  );
  return transport;
}

function frame(): HTMLImageElement {
  const img = screen.getByAltText("设备屏幕") as HTMLImageElement;
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 270, height: 552, right: 270, bottom: 552, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(img, "naturalWidth", { value: 540, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 1104, configurable: true });
  return img;
}

describe("screen tools", () => {
  it("shows the control tree, copies a find snippet, samples a color, and opens the device tool page", async () => {
    const transport = await setup();
    fireEvent.click(await screen.findByRole("radio", { name: "选控件" }));
    fireEvent.click(await screen.findByRole("button", { name: "刷新控件树" }));
    const row = await screen.findByRole("treeitem", { name: "Search" });
    fireEvent.click(row);
    const snip = screen.getByRole("textbox", { name: "查找代码" }) as HTMLTextAreaElement;
    expect(snip.value).toContain("com.android.settings:id/search");
    expect(snip.value).toContain("node.Selector(mode=1)");
    fireEvent.click(screen.getByRole("button", { name: "复制查找代码" }));
    await screen.findByText("已复制到剪贴板");
    const copied = transport.sent.filter((m) => m.method === "app.copyText").at(-1);
    expect(copied?.params?.text).toBe(snip.value);

    fireEvent.click(screen.getByRole("radio", { name: "取色" }));
    const img = frame();
    fireEvent.pointerDown(img, { clientX: 25, clientY: 25, pointerId: 1 });
    fireEvent.pointerUp(img, { clientX: 25, clientY: 25, pointerId: 1 });
    await screen.findByText(/#336699/);
    expect(transport.sent.some((m) => m.method === "device.pixel")).toBe(true);
    expect(transport.sent.filter((m) => m.method === "device.action")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "保存截图" }));
    await screen.findByText("已保存 /demo/screen.png");
    fireEvent.click(screen.getByRole("button", { name: "图色工具" }));
    await screen.findByText("已打开图色工具");
    const opened = transport.sent.filter((m) => m.method === "tools.open").at(-1);
    expect(opened?.params).toMatchObject({ page: "color" });
    expect(opened?.params).not.toHaveProperty("url");
  });
});

it("can find nodes beyond the first 400 rows, inspect attributes and switch tree modes", async () => {
  const transport = await setup();
  transport.setHandler("device.uiTree", () => ({
    width: 540, height: 1104,
    roots: Array.from({ length: 650 }, (_, i) => ({ path: `0/${i}`, text: `layout ${i}`, type: "android.view.View", rect: { l: 0, t: i, r: 10, b: i + 1 } })),
  }));
  fireEvent.click(await screen.findByRole("button", { name: "刷新控件树" }));
  await screen.findByRole("button", { name: "加载更多（还有 250 个）" });
  expect(transport.sent.filter((m) => m.method === "device.uiTree").at(-1)?.params).toMatchObject({ mode: 1 });
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索文字 / id / 描述 / 类名 / 路径" }), { target: { value: "layout 649" } });
  fireEvent.click(await screen.findByRole("treeitem", { name: "layout 649" }));
  expect((screen.getByRole("textbox", { name: "查找代码" }) as HTMLTextAreaElement).value).toContain("node.Selector(mode=1)");
  expect(screen.getByText("节点属性")).toBeTruthy();
  expect(screen.getByText("0/649")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "选控件" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "排除系统 / 输入法" }));
  await screen.findByRole("treeitem", { name: "layout 649" });
  expect(transport.sent.filter((m) => m.method === "device.uiTree").at(-1)?.params).toMatchObject({ mode: 3 });
});

it("reports accessibility errors instead of showing them as an empty tree", async () => {
  const transport = await setup();
  transport.setHandler("device.uiTree", () => ({ roots: [], error: "accessibility_off" }));
  fireEvent.click(await screen.findByRole("button", { name: "刷新控件树" }));
  await screen.findByText(/节点读取失败：accessibility_off/);
});

it("ignores a previous device's delayed node tree after switching devices", async () => {
  const { ScreenTools } = await import("../src/components/ScreenTools");
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  let finishOld!: (data: unknown) => void;
  transport.setHandler("device.uiTree", ({ id }) => id === "old"
    ? new Promise((resolve) => { finishOld = resolve; })
    : { roots: [{ path: "0", text: "new device node" }] });
  const device = (id: string) => ({ id } as import("../src/api").Device);
  const view = (id: string) => (
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <ScreenTools device={device(id)} mode="control" onMode={() => {}} hover={null} picked={null} onHit={() => {}} />
    </ServicesContext.Provider>
  );
  const mounted = render(view("old"));
  fireEvent.click(screen.getByRole("button", { name: "刷新控件树" }));
  await act(async () => { await Promise.resolve(); });
  mounted.rerender(view("new"));
  fireEvent.click(screen.getByRole("button", { name: "刷新控件树" }));
  await screen.findByRole("treeitem", { name: "new device node" });
  await act(async () => finishOld({ roots: [{ path: "0", text: "stale device node" }] }));
  expect(screen.queryByRole("treeitem", { name: "stale device node" })).toBeNull();
  expect(screen.getByRole("treeitem", { name: "new device node" })).toBeTruthy();
  rpc.dispose();
});
