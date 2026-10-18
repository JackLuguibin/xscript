import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi, type Api } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { FlowPage } from "../src/components/FlowPage";
import { createDemoTransport } from "../src/demo";

async function mount(patch?: (api: Api) => Partial<Api>) {
  const rpc = new RpcClient(createDemoTransport());
  const base = createApi(rpc);
  await base.connectAdb("emulator-5554");
  const api = { ...base, ...(patch ? patch(base) : {}) } as Api;
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <FlowPage />
    </ServicesContext.Provider>,
  );
  // FlowPage picks the first online device on its own when the top bar does not share one.
  await waitFor(async () => expect((await api.listDevices()).devices.some((item) => item.state === "online")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return api;
}

function stepRun(id: string) {
  fireEvent.click(screen.getByRole("checkbox", { name: id }));
  fireEvent.click(screen.getByRole("button", { name: "试跑" }));
  return screen.getByRole("region", { name: "试跑" });
}

describe("step-run on the device", () => {
  it("says a device snippet needs a device when none is connected", () => {
    render(<FlowPage />);
    const panel = stepRun("btn");
    expect(panel.textContent).toContain("node.Selector()");
    expect(panel.textContent).toContain("要在设备上执行 · 还没有连接设备");
  });

  it("sends the snippet to the current device and shows its answer", async () => {
    const seen: Array<[string, string, number]> = [];
    await mount((base) => ({
      evalCode: (id: string, code: string, timeoutMs: number) => {
        seen.push([id, code, timeoutMs]);
        return base.evalCode(id, code, timeoutMs);
      },
    }));
    const panel = stepRun("btn");
    await waitFor(() => expect(panel.textContent).toContain("结果 None"));
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe("adb:emulator-5554");
    expect(seen[0][1]).toContain("_result = btn");
    expect(seen[0][2]).toBe(8000);
    expect(panel.getAttribute("aria-busy")).toBeNull();
  });

  it("shows the device error or a failed call", async () => {
    let answer: Promise<{ ok: boolean; result: string; error: string }> = Promise.resolve({ ok: false, result: "", error: "NameError: btn" });
    await mount(() => ({ evalCode: () => answer }));
    const panel = stepRun("btn");
    await waitFor(() => expect(panel.textContent).toContain("执行失败 NameError: btn"));
    answer = Promise.reject(new Error("device.timeout"));
    fireEvent.click(screen.getByRole("button", { name: "试跑" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "试跑" }).textContent).toContain("执行失败 device.timeout"));
    answer = Promise.resolve({ ok: false, result: "", error: "" });
    fireEvent.click(screen.getByRole("button", { name: "试跑" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "试跑" }).textContent).toContain("执行失败 ?"));
  });

  it("drops a late answer when another step-run started after it", async () => {
    let release: (value: { ok: boolean; result: string; error: string }) => void = () => undefined;
    const evalCode = vi.fn(() => new Promise<{ ok: boolean; result: string; error: string }>((resolve) => { release = resolve; }));
    await mount(() => ({ evalCode }));
    const panel = stepRun("btn");
    expect(panel.textContent).toContain("正在设备上执行 adb:emulator-5554");
    expect(panel.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: "btn" }));
    stepRun("ok");
    release({ ok: true, result: "late", error: "" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const now = screen.getByRole("region", { name: "试跑" }).textContent ?? "";
    expect(now).toContain("这个节点不能试跑");
    expect(now).not.toContain("late");
  });
});
