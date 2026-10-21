import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { RecentRuns } from "../src/components/RecentRuns";
import { createDemoTransport } from "../src/demo";

function mount(onError = vi.fn()) {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <RecentRuns devId="adb:e" project="demo" refresh={false} onError={onError} />
    </ServicesContext.Provider>,
  );
  return { transport, onError };
}

describe("RecentRuns", () => {
  it("lists the phone's runs with outcome, duration and capture stats", async () => {
    const { transport } = mount();
    expect(await screen.findByText("出错退出（退出码 1）")).toBeTruthy();
    expect(screen.getByText("正常结束")).toBeTruthy();
    expect(screen.getByText("截图 12 次 · 均 41ms · 180MB")).toBeTruthy();
    expect(screen.getByText("4.2 秒")).toBeTruthy();
    expect(screen.getByText("1 分 1 秒")).toBeTruthy();
    expect(transport.sent.find((m) => m.method === "project.runs")?.params).toMatchObject({ id: "adb:e", project: "demo" });
  });

  it("opens one run's log slice (by seq range) and says so when it has rolled out of the buffer", async () => {
    const { transport } = mount();
    await screen.findByText("正常结束");
    transport.setHandler("device.logs", () => ({
      entries: [
        { seq: 1, ts: 0, stream: "stdout", line: "first" },
        { seq: 2, ts: 0, stream: "stderr", line: "boom" },
        { seq: 3, ts: 0, stream: "stdout", line: "later run" },
      ],
      next: 3,
    }));
    const [failedBtn, okBtn] = screen.getAllByRole("button", { name: "日志" });
    fireEvent.click(failedBtn);
    expect(await screen.findByText("boom")).toBeTruthy();
    expect(screen.queryByText("later run")).toBeNull();
    expect(failedBtn.getAttribute("aria-expanded")).toBe("true");
    transport.setHandler("device.logs", () => ({ entries: [], next: 9 }));
    fireEvent.click(okBtn);
    expect(await screen.findByText("这段日志已不在手机的日志缓冲区里")).toBeTruthy();
  });

  it("explains an old app without the route, and an empty history", async () => {
    const { transport } = mount();
    await screen.findByText("正常结束");
    transport.setHandler("project.runs", () => ({ runs: [], unsupported: true }));
    render(
      <ServicesContext.Provider value={{ rpc: new RpcClient(transport), api: createApi(new RpcClient(transport)), inShell: true }}>
        <RecentRuns devId="adb:e" project="demo" refresh={false} onError={vi.fn()} />
      </ServicesContext.Provider>,
    );
    expect(await screen.findByText("手机端 XScript 版本较旧，不提供运行历史")).toBeTruthy();
  });
  it("filters to failed runs with the checkbox", async () => {
    mount();
    await screen.findByText("正常结束");
    fireEvent.click(screen.getByRole("checkbox", { name: "只看出错" }));
    expect(screen.queryByText("正常结束")).toBeNull();
    expect(screen.getByText("出错退出（退出码 1）")).toBeTruthy();
  });
});
