import { fireEvent, render, screen } from "@testing-library/react";
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
    fireEvent.click(screen.getByRole("button", { name: "刷新控件树" }));
    const row = await screen.findByRole("treeitem", { name: "Search" });
    fireEvent.click(row);
    const snip = screen.getByRole("textbox", { name: "查找代码" }) as HTMLTextAreaElement;
    expect(snip.value).toContain("com.android.settings:id/search");
    expect(snip.value).toContain("node.Selector()");
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
