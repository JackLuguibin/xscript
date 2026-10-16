import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { MirrorPage } from "../src/components/MirrorPage";
import { createDemoTransport } from "../src/demo";
import { frameUrl, streamScale } from "../src/mirror";

describe("stream scale and frame url", () => {
  it("steps scale into the device's 0.2–1 range and defaults to 0.5 until both sizes are known", () => {
    expect(streamScale(0, 1080)).toBe(0.5);
    expect(streamScale(400, 0)).toBe(0.5);
    expect(streamScale(1080, 1080)).toBe(1);
    expect(streamScale(540, 1080)).toBe(0.5);
    expect(streamScale(200, 1080)).toBe(0.2);
    expect(streamScale(700, 1080)).toBe(0.6);
    expect(frameUrl("adb:emulator-5554", 3, 2)).toBe("/_frame/adb%3Aemulator-5554?seq=3&n=2");
  });
});

async function page() {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  await api.connectAdb("emulator-5554");
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <MirrorPage />
    </ServicesContext.Provider>,
  );
  const img = await screen.findByAltText("设备屏幕");
  return { transport, img };
}

describe("mirror stream page", () => {
  it("drops seqs that arrive while a frame is still loading and jumps to the latest", async () => {
    const { transport, img } = await page();
    const first = img.getAttribute("src");
    await act(async () => {
      transport.push({ event: true, topic: "mirror.frame", data: { id: "adb:emulator-5554", seq: 2, w: 1080, h: 2209 } });
      transport.push({ event: true, topic: "mirror.frame", data: { id: "adb:emulator-5554", seq: 3, w: 1080, h: 1920 } });
    });
    expect(img.getAttribute("src")).toBe(first);
    fireEvent.load(img);
    expect(screen.getByAltText("设备屏幕").getAttribute("src")).toMatch(/seq=3/);
  });

  it("shows the viewer-full banner and the no-capture state, and retry goes through the bridge", async () => {
    const { transport } = await page();
    await act(async () => {
      transport.push({ event: true, topic: "mirror.state", data: { id: "adb:emulator-5554", state: "busy", reason: "viewers_full" } });
    });
    expect(screen.getByText(/观看者已满/)).toBeTruthy();
    await act(async () => {
      transport.push({ event: true, topic: "mirror.state", data: { id: "adb:emulator-5554", state: "blocked", reason: "no_capture" } });
    });
    expect(screen.getByText("设备尚未授予录屏（图色）权限")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(transport.sent.some((m) => m.method === "mirror.retry")).toBe(true);
  });

  it("a stalled stream offers retry and does not keep the live badge", async () => {
    const { transport } = await page();
    expect(screen.getByText("直播")).toBeTruthy();
    await act(async () => {
      transport.push({ event: true, topic: "mirror.state", data: { id: "adb:emulator-5554", state: "stalled", reason: "no_frames" } });
    });
    expect(screen.getByText(/已断开投屏/)).toBeTruthy();
    expect(screen.queryByText("直播")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(transport.sent.some((m) => m.method === "mirror.retry")).toBe(true);
  });
});
