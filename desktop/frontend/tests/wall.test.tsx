import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { WallPage } from "../src/components/WallPage";
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
