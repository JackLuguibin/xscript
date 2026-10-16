import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MirrorPage } from "../src/components/MirrorPage";
import { createDemoTransport } from "../src/demo";
import { classify, toDevice } from "../src/mirror";

describe("mirror math", () => {
  it("maps shown pixels to device pixels through a downscaled frame", () => {
    // shown 270x585, frame 540x1170 (max=1170), device 1080x2340
    expect(toDevice(135, 292.5, { w: 270, h: 585 }, { w: 540, h: 1170 }, { w: 1080, h: 2340 })).toEqual({ x: 540, y: 1170 });
    expect(toDevice(0, 0, { w: 270, h: 585 }, { w: 540, h: 1170 }, { w: 1080, h: 2340 })).toEqual({ x: 0, y: 0 });
    expect(toDevice(999, 999, { w: 270, h: 585 }, { w: 540, h: 1170 }, { w: 1080, h: 2340 })).toEqual({ x: 1079, y: 2339 });
    expect(toDevice(-5, -5, { w: 270, h: 585 }, { w: 540, h: 1170 }, null)).toEqual({ x: 0, y: 0 });
  });

  it("handles a landscape frame of a portrait device (rotation) by scaling the long side", () => {
    expect(toDevice(585, 270, { w: 1170, h: 540 }, { w: 1170, h: 540 }, { w: 1080, h: 2340 })).toEqual({ x: 1170, y: 540 });
  });

  it("without device size the frame pixels are used, and a zero-size element does not divide by zero", () => {
    expect(toDevice(10, 10, { w: 0, h: 0 }, { w: 100, h: 200 }, null)).toEqual({ x: 99, y: 199 });
  });

  it("classifies click, long press and swipe with clamped durations", () => {
    const d = { ex: 10, ey: 10, t: 0, x: 100, y: 100 };
    expect(classify(d, { ex: 12, ey: 13, t: 80, x: 120, y: 130 })).toEqual({ type: "click", x: 100, y: 100, dur: 20 });
    expect(classify(d, { ex: 10, ey: 10, t: 700, x: 100, y: 100 })).toEqual({ type: "click", x: 100, y: 100, dur: 700 });
    expect(classify(d, { ex: 10, ey: 10, t: 9000, x: 100, y: 100 })).toMatchObject({ dur: 3000 });
    expect(classify(d, { ex: 60, ey: 10, t: 10, x: 600, y: 100 })).toEqual({ type: "swipe", x1: 100, y1: 100, x2: 600, y2: 100, dur: 50 });
    expect(classify(d, { ex: 60, ey: 10, t: 9999, x: 600, y: 100 })).toMatchObject({ dur: 3000 });
  });
});

async function setup(connect = true) {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  if (connect) await api.connectAdb("emulator-5554");
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <MirrorPage />
    </ServicesContext.Provider>,
  );
  return { transport };
}

afterEach(() => vi.useRealTimers());

function frame(): HTMLImageElement {
  const img = screen.getByAltText("设备屏幕") as HTMLImageElement;
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 270, height: 552, right: 270, bottom: 552, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(img, "naturalWidth", { value: 540, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 1104, configurable: true });
  return img;
}

describe("MirrorPage", () => {
  it("empty state without a device", async () => {
    await setup(false);
    expect(await screen.findByText("还没有在线设备")).toBeTruthy();
  });

  it("requests frames over xsapp:// (never through the bridge) and chains the next one after load", async () => {
    await setup();
    const img = await screen.findByAltText("设备屏幕");
    const first = img.getAttribute("src")!;
    expect(first).toMatch(/^\/_shot\/adb%3Aemulator-5554\.jpg\?max=1080&t=\d+$/);
    expect(screen.getByText("等待第一帧…")).toBeTruthy();
    vi.useFakeTimers();
    fireEvent.load(img);
    expect(screen.queryByText("等待第一帧…")).toBeNull();
    await act(async () => vi.advanceTimersByTime(600));
    expect(screen.getByAltText("设备屏幕").getAttribute("src")).not.toBe(first);
  });

  it("pause stops the chain; failures show the permission hint", async () => {
    await setup();
    const img = await screen.findByAltText("设备屏幕");
    vi.useFakeTimers();
    fireEvent.error(img);
    expect(screen.getByText(/取不到截图/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(screen.getByText("已暂停")).toBeTruthy();
    const src = img.getAttribute("src");
    await act(async () => vi.advanceTimersByTime(5000));
    expect(screen.getByAltText("设备屏幕").getAttribute("src")).toBe(src);
    fireEvent.change(screen.getByRole("combobox", { name: "帧率" }), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await act(async () => vi.advanceTimersByTime(150));
    expect(screen.getByAltText("设备屏幕").getAttribute("src")).not.toBe(src);
  });

  it("a tap becomes a click and a drag becomes a swipe in device pixels; keys and text go through device.action", async () => {
    const { transport } = await setup();
    await screen.findByAltText("设备屏幕");
    const img = frame();
    fireEvent.pointerDown(img, { clientX: 135, clientY: 276, pointerId: 1 });
    fireEvent.pointerUp(img, { clientX: 136, clientY: 277, pointerId: 1 });
    const actions = () => transport.sent.filter((m) => m.method === "device.action").map((m) => m.params);
    await vi.waitFor(() => expect(actions()[0]).toMatchObject({ type: "click", x: 540, y: 1105 }));
    fireEvent.pointerDown(img, { clientX: 135, clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(img, { clientX: 135, clientY: 100, pointerId: 1 });
    await vi.waitFor(() => expect(actions()[1]).toMatchObject({ type: "swipe", x1: 540, y1: 2001, x2: 540, y2: 400 }));
    fireEvent.pointerUp(img, { clientX: 1, clientY: 1 }); // no matching down: ignored
    fireEvent.pointerDown(img, { clientX: 1, clientY: 1 });
    fireEvent.pointerCancel(img);
    fireEvent.pointerUp(img, { clientX: 1, clientY: 1 });
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await vi.waitFor(() => expect(actions()[2]).toMatchObject({ type: "key", name: "back" }));
    fireEvent.change(screen.getByRole("textbox", { name: "发送文字" }), { target: { value: "你好" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("已发送：你好")).toBeTruthy();
    expect(actions()[3]).toMatchObject({ type: "input", text: "你好" });
    expect(actions()).toHaveLength(4);
  });

  it("action errors are shown", async () => {
    const { transport } = await setup();
    transport.setHandler("device.action", () => {
      throw { code: "device.http", message: "no accessibility" };
    });
    fireEvent.click(await screen.findByRole("button", { name: "主页" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no accessibility/);
  });
});
