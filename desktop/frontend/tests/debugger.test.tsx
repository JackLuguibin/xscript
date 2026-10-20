import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { ProjectsPage } from "../src/components/ProjectsPage";
import { createDemoTransport } from "../src/demo";
import { setLanguage } from "../src/strings";

afterEach(() => setLanguage("zh"));

async function setup(source = "a = 1\nb = 2\nc = 3\nd = 4\n") {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  await api.connectAdb("emulator-5554");
  const id = (await api.listDevices()).devices[0].id;
  await api.writeFile(id, "demo", "__init__.py", source);
  render(
    <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
      <ProjectsPage pollMs={50} />
    </ServicesContext.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /^demo/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^__init__\.py/ }));
  const editor = (await screen.findByRole("textbox", { name: "编辑器" })) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain("a = 1"));
  return { transport, api, id, editor };
}

function f9(editor: HTMLTextAreaElement, line: number) {
  const pos = editor.value.split("\n").slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
  editor.setSelectionRange(pos, pos);
  fireEvent.keyDown(editor, { key: "F9" });
}

describe("debugger UI", () => {
  it("F9 breakpoints, start, pause at breakpoint, stack/variables, step, continue to the end", async () => {
    const { transport, editor } = await setup();
    f9(editor, 2);
    f9(editor, 4);
    const bpList = await screen.findByRole("list", { name: "断点" });
    expect(within(bpList).getByText("● __init__.py:2")).toBeTruthy();
    f9(editor, 4); // toggle off
    await waitFor(() => expect(within(bpList).queryByText("● __init__.py:4")).toBeNull());
    f9(editor, 3);

    fireEvent.click(screen.getByRole("button", { name: "调试" }));
    expect(await screen.findByText("暂停于 __init__.py:2")).toBeTruthy();
    const start = transport.sent.find((m) => m.method === "debug.start")!;
    expect(start.params!.breakpoints).toEqual({ "__init__.py": [2, 3] });
    expect(screen.getByTestId("current-line").textContent).toContain("2: b = 2");

    const stack = screen.getByRole("list", { name: "调用栈" });
    expect(within(stack).getByText("<module>")).toBeTruthy();
    expect(within(stack).getByText(/runpy\.py \(工程外\):1/)).toBeTruthy();
    const tree = await screen.findByRole("tree", { name: "变量" });
    expect(within(tree).getByText("line")).toBeTruthy();
    expect(within(tree).getByText("= 2")).toBeTruthy();
    fireEvent.click(within(tree).getByRole("button", { name: "展开 cfg" }));
    expect(await within(tree).findByText("'a'")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "展开 Globals" }));
    expect(await screen.findByText("__name__")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "求值" }), { target: { value: "a + b" } });
    fireEvent.click(screen.getByRole("button", { name: "求值" }));
    expect(await screen.findByText("a + b → repr(a + b)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(await screen.findByText("暂停于 __init__.py:3")).toBeTruthy();
    fireEvent.keyDown(editor, { key: "F10" });
    expect(await screen.findByText("暂停于 __init__.py:4")).toBeTruthy();
    // a breakpoint toggled mid-session is sent to the debugger right away
    f9(editor, 1);
    await waitFor(() => expect(transport.sent.some((m) => m.method === "debug.setBreakpoints")).toBe(true));
    fireEvent.keyDown(editor, { key: "F5" });
    expect(await screen.findByText("脚本已结束", { exact: false })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "调试" })).toBeTruthy());
    expect(screen.queryByTestId("current-line")).toBeNull();
    expect(screen.getByLabelText("调试控制台").textContent).toContain("[demo] debugging demo");
  });

  it("stop button and Shift+F5 end the session; step keys are sent only while paused", async () => {
    const { transport, editor } = await setup();
    f9(editor, 1);
    fireEvent.keyDown(editor, { key: "F5" }); // F5 starts too
    await screen.findByText("暂停于 __init__.py:1");
    fireEvent.click(screen.getByRole("button", { name: "单步进入" }));
    await screen.findByText("暂停于 __init__.py:2");
    fireEvent.keyDown(editor, { key: "F11", shiftKey: true });
    await screen.findByText("暂停于 __init__.py:3");
    expect(transport.sent.filter((m) => m.method === "debug.step").map((m) => m.params!.command)).toEqual(["stepIn", "stepOut"]);
    fireEvent.keyDown(editor, { key: "F5", shiftKey: true });
    expect(await screen.findByText("已停止")).toBeTruthy();
    expect(transport.sent.find((m) => m.method === "debug.stop")!.params!.terminate).toBe(true);
    fireEvent.keyDown(editor, { key: "F10" }); // not paused: nothing sent
    expect(transport.sent.filter((m) => m.method === "debug.step")).toHaveLength(2);
  });

  it("removes a breakpoint from the list, detaches, and shows start errors", async () => {
    const { transport, editor } = await setup();
    f9(editor, 2);
    fireEvent.click(await screen.findByRole("button", { name: "删除断点 __init__.py:2" }));
    expect(await screen.findByText("在编辑器行号左侧点击，或按 F9 添加断点")).toBeTruthy();
    f9(editor, 3);
    fireEvent.click(screen.getByRole("button", { name: "调试" }));
    await screen.findByText("暂停于 __init__.py:3");
    fireEvent.click(screen.getByRole("button", { name: "分离" }));
    expect(await screen.findByText("已分离")).toBeTruthy();
    transport.setHandler("debug.start", () => {
      throw { code: "debug.busy", message: "already running" };
    });
    fireEvent.click(screen.getByRole("button", { name: "调试" }));
    // an unmapped code: the message is the title, the raw `message [code]` sits behind 详情
    const alert = (await screen.findByText("already running")).closest("[role=alert]") as HTMLElement;
    fireEvent.click(within(alert).getByRole("button", { name: "详情" }));
    expect(within(alert).getByText(/already running \[debug\.busy\]/)).toBeTruthy();
  });

  it("zh/en debugger strings line up", async () => {
    await setup();
    await act(async () => setLanguage("en"));
    // remount happens through App in production; here just check the dictionary keys line up
    const { DICTS } = await import("../src/strings");
    expect(Object.keys(DICTS.en.debug).sort()).toEqual(Object.keys(DICTS.zh.debug).sort());
    expect(DICTS.en.debug.pausedAt("a.py", 3)).toBe("Paused at a.py:3");
  });

  it("conditional breakpoints, hit counts and logpoints are edited in the list and sent as DAP options", async () => {
    const { transport, editor } = await setup("a = 1\nb = 2\nc = 3\nd = 4\ne = 5\n");
    f9(editor, 1);
    f9(editor, 2);
    f9(editor, 4);
    // line 1: logpoint (prints, never pauses)
    fireEvent.click(await screen.findByRole("button", { name: "编辑断点 __init__.py:1" }));
    const form1 = screen.getByRole("form", { name: "编辑断点 __init__.py:1" });
    fireEvent.change(within(form1).getByRole("combobox", { name: "断点类型" }), { target: { value: "logMessage" } });
    fireEvent.change(within(form1).getByRole("textbox", { name: "日志消息" }), { target: { value: "at {line}" } });
    fireEvent.click(within(form1).getByRole("button", { name: "保存" }));
    const bpList = screen.getByRole("list", { name: "断点" });
    expect(within(bpList).getByText("◆ __init__.py:1")).toBeTruthy();
    expect(within(bpList).getByText("日志消息: at {line}")).toBeTruthy();
    // line 2: condition that never holds; Esc cancels an edit without changes
    fireEvent.click(screen.getByRole("button", { name: "编辑断点 __init__.py:2" }));
    let form2 = screen.getByRole("form", { name: "编辑断点 __init__.py:2" });
    fireEvent.change(within(form2).getByRole("textbox", { name: "条件" }), { target: { value: "nope" } });
    fireEvent.keyDown(within(form2).getByRole("textbox", { name: "条件" }), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "编辑断点 __init__.py:2" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "编辑断点 __init__.py:2" }));
    form2 = screen.getByRole("form", { name: "编辑断点 __init__.py:2" });
    expect((within(form2).getByRole("textbox", { name: "条件" }) as HTMLInputElement).value).toBe("");
    fireEvent.change(within(form2).getByRole("textbox", { name: "条件" }), { target: { value: "False" } });
    fireEvent.submit(form2);
    expect(within(bpList).getByText("条件: False")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "调试" }));
    expect(await screen.findByText("暂停于 __init__.py:4")).toBeTruthy();
    const start = transport.sent.find((m) => m.method === "debug.start")!;
    expect(start.params!.breakpoints).toEqual({ "__init__.py": [{ line: 1, logMessage: "at {line}" }, { line: 2, condition: "False" }, 4] });
    expect(screen.getByLabelText("调试控制台").textContent).toContain("at 1");

    // editing mid-session re-sends the file's breakpoints; clearing the value turns it back into a plain breakpoint
    fireEvent.click(screen.getByRole("button", { name: "编辑断点 __init__.py:4" }));
    const form4 = screen.getByRole("form", { name: "编辑断点 __init__.py:4" });
    fireEvent.change(within(form4).getByRole("combobox", { name: "断点类型" }), { target: { value: "hitCondition" } });
    fireEvent.change(within(form4).getByRole("textbox", { name: "命中次数" }), { target: { value: "2" } });
    fireEvent.submit(form4);
    await waitFor(() => {
      const last = transport.sent.filter((m) => m.method === "debug.setBreakpoints").at(-1);
      expect(last?.params!.lines).toEqual([{ line: 1, logMessage: "at {line}" }, { line: 2, condition: "False" }, { line: 4, hitCondition: "2" }]);
    });
    // removing a breakpoint drops its options too
    fireEvent.click(screen.getByRole("button", { name: "删除断点 __init__.py:1" }));
    f9(editor, 1);
    await waitFor(() => expect(within(bpList).getByText("● __init__.py:1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "停止调试" }));
  });

  it("watch expressions are evaluated (context watch) on every pause and kept per project", async () => {
    localStorage.removeItem("xscript.watch.demo");
    const { transport, editor } = await setup();
    expect(screen.getByText("添加表达式，每次暂停时在当前栈帧求值")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "添加监视" }), { target: { value: "a * 2" } });
    fireEvent.click(screen.getByRole("button", { name: "添加监视" }));
    fireEvent.change(screen.getByRole("textbox", { name: "添加监视" }), { target: { value: "a * 2" } });
    fireEvent.click(screen.getByRole("button", { name: "添加监视" })); // duplicates are ignored
    const list = screen.getByRole("list", { name: "监视" });
    expect(within(list).getAllByText("a * 2")).toHaveLength(1);
    expect(within(list).getByText("（暂停时求值）", { exact: false })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("xscript.watch.demo")!)).toEqual(["a * 2"]);

    transport.setHandler("debug.evaluate", (p) => {
      if (p.expression === "boom") throw { code: "debug.failed", message: "NameError: boom" };
      return { result: `v(${String(p.expression)})`, type: "int", ref: 0 };
    });
    f9(editor, 2);
    f9(editor, 3);
    fireEvent.click(screen.getByRole("button", { name: "调试" }));
    expect(await within(list).findByText("= v(a * 2)")).toBeTruthy();
    const ev = transport.sent.filter((m) => m.method === "debug.evaluate");
    expect(ev.at(-1)!.params).toMatchObject({ expression: "a * 2", context: "watch", frameId: 1 });
    fireEvent.change(screen.getByRole("textbox", { name: "添加监视" }), { target: { value: "boom" } });
    fireEvent.click(screen.getByRole("button", { name: "添加监视" }));
    expect(await within(list).findByText(/NameError: boom/)).toBeTruthy();
    const before = transport.sent.filter((m) => m.method === "debug.evaluate").length;
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await screen.findByText("暂停于 __init__.py:3");
    await waitFor(() => expect(transport.sent.filter((m) => m.method === "debug.evaluate").length).toBeGreaterThanOrEqual(before + 2));
    fireEvent.click(within(list).getByRole("button", { name: "删除监视 boom" }));
    expect(JSON.parse(localStorage.getItem("xscript.watch.demo")!)).toEqual(["a * 2"]);
    fireEvent.click(screen.getByRole("button", { name: "停止调试" }));
    localStorage.removeItem("xscript.watch.demo");
  });
});
