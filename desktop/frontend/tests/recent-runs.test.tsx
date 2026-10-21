import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { ProjectsPage } from "../src/components/ProjectsPage";
import { RecentRuns } from "../src/components/RecentRuns";
import { createDemoTransport } from "../src/demo";

function mount(onError = vi.fn(), onOpenLine?: (path: string, line: number) => void, prep?: (t: ReturnType<typeof createDemoTransport>) => void) {
  const transport = createDemoTransport();
  prep?.(transport);
  const rpc = new RpcClient(transport);
  render(
    <ServicesContext.Provider value={{ rpc, api: createApi(rpc), inShell: true }}>
      <RecentRuns devId="adb:e" project="demo" refresh={false} onError={onError} onOpenLine={onOpenLine} />
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

  it("copies a run's log and jumps from a failed run to the line in the project that raised", async () => {
    const onOpenLine = vi.fn();
    const now = Date.now();
    const { transport } = mount(vi.fn(), onOpenLine, (tr) =>
      tr.setHandler("project.runs", () => ({
        runs: [
          { project: "demo", start: now - 1000, duration_ms: 900, exit: "1", user_stop: false, log_from: 0, log_to: 5, outcome: "出错退出（退出码 1）", failed: true, stats: null },
          { project: "demo", start: now - 9000, duration_ms: 900, exit: "0", user_stop: false, log_from: 0, log_to: 5, outcome: "正常结束", failed: false, stats: null },
        ],
      })),
    );
    await screen.findByText("正常结束");
    const P = "/storage/emulated/0/Android/data/com.xscript.app/files/projects/demo";
    transport.setHandler("device.logs", () => ({
      entries: [
        { seq: 1, ts: 0, stream: "stdout", line: "start" },
        { seq: 2, ts: 0, stream: "stderr", line: "Traceback (most recent call last):" },
        { seq: 3, ts: 0, stream: "stderr", line: `  File "${P}/__init__.py", line 2, in <module>` },
        { seq: 4, ts: 0, stream: "stderr", line: `  File "${P}/utils/net.py", line 9, in get` },
        { seq: 5, ts: 0, stream: "stderr", line: "ZeroDivisionError: division by zero" },
      ],
      next: 5,
    }));
    const [failedBtn, okBtn] = screen.getAllByRole("button", { name: "日志" });
    fireEvent.click(failedBtn);
    const go = await screen.findByRole("button", { name: "跳到出错行 utils/net.py:9" });
    expect(go.getAttribute("title")).toBe("ZeroDivisionError: division by zero");
    fireEvent.click(go);
    expect(onOpenLine).toHaveBeenCalledWith("utils/net.py", 9);
    fireEvent.click(screen.getByRole("button", { name: "复制日志" }));
    expect(await screen.findByRole("button", { name: "已复制" })).toBeTruthy();
    const sent = transport.sent.find((m) => m.method === "app.copyText")?.params as { text: string };
    expect(sent.text.startsWith("start\nTraceback")).toBe(true);
    expect(sent.text.endsWith("division by zero\n")).toBe(true);
    // a run that ended normally has no jump, even with a traceback it printed itself
    fireEvent.click(okBtn);
    await screen.findByRole("button", { name: "复制日志" });
    expect(screen.queryByRole("button", { name: /跳到出错行/ })).toBeNull();
  });

  it("on the projects page, 跳到出错行 opens that file in the editor", async () => {
    const transport = createDemoTransport();
    const rpc = new RpcClient(transport);
    const api = createApi(rpc);
    await api.connectAdb("emulator-5554");
    const id = (await api.listDevices()).devices[0].id;
    await api.writeFile(id, "demo", "lib/calc.py", "a = 1\nb = a / 0\n", true);
    transport.setHandler("project.runs", () => ({
      runs: [{ project: "demo", start: Date.now(), duration_ms: 10, exit: "1", user_stop: false, log_from: 0, log_to: 3, outcome: "出错退出（退出码 1）", failed: true, stats: null }],
    }));
    transport.setHandler("device.logs", () => ({
      entries: [
        { seq: 1, ts: 0, stream: "stderr", line: "Traceback (most recent call last):" },
        { seq: 2, ts: 0, stream: "stderr", line: '  File "/x/files/projects/demo/lib/calc.py", line 2, in <module>' },
        { seq: 3, ts: 0, stream: "stderr", line: "ZeroDivisionError: division by zero" },
      ],
      next: 3,
    }));
    render(
      <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
        <ProjectsPage pollMs={20} />
      </ServicesContext.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^demo/ }));
    fireEvent.click(await screen.findByRole("button", { name: "日志" }, { timeout: 3000 }));
    fireEvent.click(await screen.findByRole("button", { name: "跳到出错行 lib/calc.py:2" }));
    const editor = (await screen.findByRole("textbox", { name: "编辑器" }, { timeout: 3000 })) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("a = 1\nb = a / 0\n"));
    await waitFor(() => expect(editor.selectionStart).toBe(6));
  });
});
