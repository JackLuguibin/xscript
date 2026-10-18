import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { REFRESH_MS, RETRY_MS, WallPage } from "../src/components/WallPage";
import { createDemoTransport } from "../src/demo";
import { onlineSelected, pointOnDevice, relativePoint, thumbUrl } from "../src/wall";
import type { Device } from "../src/api";

describe("wall math", () => {
  it("maps a thumbnail fraction onto each device and never uses the mirror stream", () => {
    expect(relativePoint(135, 276, { w: 270, h: 552 })).toEqual({ fx: 0.5, fy: 0.5 });
    expect(pointOnDevice(0.5, 0.5, { w: 1080, h: 2209 })).toEqual({ x: 540, y: 1105 });
    expect(pointOnDevice(0.5, 0.5, { w: 0, h: 10 })).toBeNull();
    expect(thumbUrl("adb:emulator-5554", 3)).toBe("/_shot/adb%3Aemulator-5554.jpg?max=480&t=3");
    expect(thumbUrl("a", 1)).not.toContain("/_frame/");
    const devices = [
      { id: "a", state: "online" },
      { id: "b", state: "offline" },
    ] as Device[];
    expect(onlineSelected(devices, new Set(["a", "b"])).map((d) => d.id)).toEqual(["a"]);
  });
});

describe("WallPage", () => {
  it("broadcasts a key to the checked devices and a click to the same relative point", async () => {
    const transport = createDemoTransport();
    const rpc = new RpcClient(transport);
    const api = createApi(rpc);
    await api.connectAdb("emulator-5554");
    await api.connectLan("10.0.0.8:9860");
    await new Promise((r) => setTimeout(r, 0)); // let the demo's device.state pushes for those connects go by first
    render(
      <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
        <WallPage />
      </ServicesContext.Provider>,
    );
    expect(transport.sent.some((m) => m.method === "mirror.subscribe")).toBe(false);
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "主页" }));
    const keys = () => transport.sent.filter((m) => m.method === "device.action" && m.params?.type === "key");
    await screen.findByText("已发给 2 台设备");
    expect(keys()).toHaveLength(2);
    expect(keys().every((m) => m.params?.name === "home")).toBe(true);

    const img = screen.getAllByRole("img")[0];
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerUp(img, { clientX: 100, clientY: 200 });
    const clicks = () => transport.sent.filter((m) => m.method === "device.action" && m.params?.type === "click");
    await waitFor(() => expect(clicks()).toHaveLength(2));
    expect(clicks().every((m) => m.params?.x === 540)).toBe(true);
    expect(transport.sent.some((m) => m.method === "mirror.subscribe")).toBe(false);
  });
});

describe("WallPage thumbnails", () => {
  const setVisibility = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };

  afterEach(() => {
    setVisibility("visible");
    vi.useRealTimers();
  });

  async function renderWall() {
    const transport = createDemoTransport();
    const rpc = new RpcClient(transport);
    const api = createApi(rpc);
    await api.connectAdb("emulator-5554");
    await api.connectLan("10.0.0.8:9860");
    await new Promise((r) => setTimeout(r, 0)); // let the demo's device.state pushes for those connects go by first
    render(
      <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
        <WallPage />
      </ServicesContext.Provider>,
    );
    const imgs = (await screen.findAllByRole("img")) as HTMLImageElement[];
    vi.useFakeTimers();
    return imgs;
  }

  const t = (img: HTMLImageElement) => new URL(img.src, "http://x").searchParams.get("t");
  const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  it("asks for the next picture only after the previous one finished, per device", async () => {
    const [a, b] = await renderWall();
    expect([t(a), t(b)]).toEqual(["1", "1"]);
    wait(10_000); // nothing arrived yet: no new requests piling up
    expect([t(a), t(b)]).toEqual(["1", "1"]);

    fireEvent.load(a);
    wait(REFRESH_MS - 1);
    expect(t(a)).toBe("1");
    wait(1);
    expect([t(a), t(b)]).toEqual(["2", "1"]); // the slow device does not hold up the other

    fireEvent.error(b); // a failed picture is retried, a little later
    wait(REFRESH_MS);
    expect(t(b)).toBe("1");
    wait(RETRY_MS - REFRESH_MS);
    expect(t(b)).toBe("2");
  });

  it("pauses while the window is hidden and resumes when shown", async () => {
    const [a] = await renderWall();
    setVisibility("hidden");
    fireEvent.load(a);
    wait(60_000);
    expect(t(a)).toBe("1");
    setVisibility("visible");
    wait(REFRESH_MS);
    expect(t(a)).toBe("2");
  });
});
