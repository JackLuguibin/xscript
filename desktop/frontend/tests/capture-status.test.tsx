import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi, type Device } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { captureState } from "../src/components/CaptureStatus";
import { MirrorPage } from "../src/components/MirrorPage";
import { createDemoTransport } from "../src/demo";
import { resetMirrorSession } from "../src/mirror";

afterEach(() => {
  window.localStorage.clear();
  resetMirrorSession();
});

describe("captureState", () => {
  it("maps capture_via / capture_lost; older apps without capture_via say nothing unless capture is false", () => {
    expect(captureState(undefined)).toBeNull();
    expect(captureState({ capture: true })).toBeNull();
    expect(captureState({ capture: false })).toEqual({ kind: "none" });
    expect(captureState({ captureVia: null, capture: true })).toBeNull();
    expect(captureState({ captureVia: "projection", captureLost: false })).toEqual({ kind: "ok", via: "projection", lost: false });
    expect(captureState({ captureVia: "accessibility", captureLost: true })).toEqual({ kind: "ok", via: "accessibility", lost: true });
    expect(captureState({ captureVia: "", captureLost: true })).toEqual({ kind: "lost" });
    expect(captureState({ captureVia: "", captureLost: false })).toEqual({ kind: "none" });
  });
});

async function setup(info: Partial<Device["info"]>) {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  const d = await api.connectAdb("emulator-5554");
  const withInfo = (extra: Partial<Device["info"]>): Device => ({ ...d, info: { ...d.info, ...extra } });
  const start = withInfo(info);
  transport.setHandler("device.list", () => ({ devices: [start] }));
  transport.setHandler("device.refresh", () => start);
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <MirrorPage />
    </ServicesContext.Provider>,
  );
  await act(async () => transport.push({ event: true, topic: "device.state", data: start }));
  return { transport, withInfo };
}

describe("screen page capture card", () => {
  it("lost grant: explains what happened and how to restore it; 重新检查 refreshes and the card goes away", async () => {
    const { transport, withInfo } = await setup({ captureVia: "", captureLost: true });
    const card = await screen.findByRole("region", { name: "截图状态" });
    expect(card.textContent).toContain("截图权限已失效");
    expect(card.textContent).toContain("图色权限");
    expect(card.textContent).toContain("无障碍");
    const fixed = withInfo({ captureVia: "accessibility", captureLost: true });
    transport.setHandler("device.refresh", () => {
      transport.push({ event: true, topic: "device.state", data: fixed });
      return fixed;
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新检查" })));
    await vi.waitFor(() => expect(transport.sent.some((m) => m.method === "device.refresh")).toBe(true));
    await vi.waitFor(() => expect(screen.queryByRole("region", { name: "截图状态" })).toBeNull());
    const chip = screen.getByText("截图：无障碍截图");
    expect(chip.getAttribute("title")).toContain("系统录屏授权已失效");
  });

  it("在手机上授权 asks the phone for the grant and says what to do there; an old app says it cannot be asked", async () => {
    const { transport } = await setup({ captureVia: "", captureLost: true });
    await screen.findByRole("region", { name: "截图状态" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "在手机上授权" })));
    await vi.waitFor(() => expect(transport.sent.some((m) => m.method === "device.requestCapture")).toBe(true));
    const card = screen.getByRole("region", { name: "截图状态" });
    await vi.waitFor(() => expect(card.textContent).toContain("立即开始」（Android 14"));
    transport.setHandler("device.requestCapture", () => ({ ok: false, unsupported: true }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "在手机上授权" })));
    await vi.waitFor(() => expect(card.textContent).toContain("版本较旧"));
  });

  it("nothing can capture: a different title and steps", async () => {
    await setup({ captureVia: "", captureLost: false });
    const card = await screen.findByRole("region", { name: "截图状态" });
    expect(card.textContent).toContain("设备还不能截图");
    expect(card.textContent).not.toContain("已失效");
  });

  it("working capture shows only the source in the toolbar", async () => {
    await setup({ captureVia: "projection", captureLost: false });
    await screen.findByText("截图：系统录屏");
    await vi.waitFor(() => expect(screen.queryByRole("region", { name: "截图状态" })).toBeNull());
  });
});
