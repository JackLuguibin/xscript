import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { createQueryClient } from "../src/queryClient";
import { DeviceRuns, fmtDuration, fmtStats } from "../src/pages/devices/DeviceRuns";

const runs = [
  { project: "签到", start: 1_760_000_000_000, duration_ms: 4200, exit: "1", user_stop: false, outcome: "出错退出（退出码 1）", failed: true, log_from: 10, log_to: 12,
    stats: { captures: 12, capture_avg_ms: 41, peak_mb: 180 } },
  { project: "签到", start: 1_759_999_000_000, duration_ms: 61_000, exit: "0", user_stop: false, outcome: "正常结束", failed: false, log_from: 2, log_to: 5 },
];
let relayed: string[] = [];

function stub(runsStatus = 200) {
  relayed = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const path = JSON.parse(String(init?.body ?? "{}")).path as string;
      relayed.push(path);
      if (path === "/logs")
        return Response.json({ entries: [
          { seq: 10, ts: 0, stream: "stdout", line: "before this run\n" },
          { seq: 11, ts: 0, stream: "stdout", line: "第 12 轮：收菜\n" },
          { seq: 12, ts: 0, stream: "stderr", line: "TimeoutError: 找不到「收获」按钮\n" },
          { seq: 13, ts: 0, stream: "stdout", line: "next run\n" },
        ], next: 13 });
      if (path === "/projects") return Response.json({ projects: [{ name: "其他" }, { name: "签到" }] });
      if (runsStatus !== 200) return Response.json({ detail: "missing project" }, { status: runsStatus });
      return Response.json({ runs });
    }),
  );
}

function mount(online = true) {
  return render(
    <AntApp>
      <QueryClientProvider client={createQueryClient()}>
        <DeviceRuns id="dev1" online={online} defaultProject="签到" />
      </QueryClientProvider>
    </AntApp>,
  );
}

describe("DeviceRuns (云控 设备 → 最近运行)", () => {
  beforeEach(() => stub());

  it("reads the device's last project runs through the relay and shows outcome, duration and stats", async () => {
    mount();
    expect(await screen.findByText("出错退出（退出码 1）")).toBeTruthy();
    expect(screen.getByText("正常结束")).toBeTruthy();
    expect(screen.getByText("截图 12 次 · 均 41ms · 180MB")).toBeTruthy();
    expect(screen.getByText("1 分 1 秒")).toBeTruthy();
    expect(relayed).toContain("/projects/%E7%AD%BE%E5%88%B0/runs");
  });

  it("filters to failed runs", async () => {
    mount();
    await screen.findByText("正常结束");
    fireEvent.click(screen.getByRole("switch", { name: "只看出错" }));
    expect(screen.queryByText("正常结束")).toBeNull();
    expect(screen.getByText("出错退出（退出码 1）")).toBeTruthy();
  });

  it("explains a 404 (old app or deleted project) and an offline device", async () => {
    stub(404);
    mount();
    expect(await screen.findByText(/早于 v0\.5\.0/)).toBeTruthy();
    stub();
    mount(false);
    expect(screen.getByText(/上线后才能查看/)).toBeTruthy();
  });

  it("expands a run into its own log lines (log_from < seq <= log_to) and explains a rolled-out log", async () => {
    mount();
    fireEvent.click(await screen.findByText("出错退出（退出码 1）"));
    expect(await screen.findByText("TimeoutError: 找不到「收获」按钮")).toBeTruthy();
    expect(screen.getByText("第 12 轮：收菜")).toBeTruthy();
    expect(screen.queryByText("before this run")).toBeNull();
    expect(screen.queryByText("next run")).toBeNull();
    fireEvent.click(screen.getByText("正常结束"));
    expect(await screen.findByText(/已不在手机的日志缓冲区里/)).toBeTruthy();
  });

  it("formats", () => {
    expect(fmtDuration(4200)).toBe("4.2 秒");
    expect(fmtStats(null)).toBe("-");
    expect(fmtStats({ captures: 0, capture_avg_ms: 0, peak_mb: 119 })).toBe("未截图 · 119MB");
  });
});
