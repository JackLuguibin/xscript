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
    expect(await screen.findByText(/already running \[debug\.busy\]/)).toBeTruthy();
  });

  it("zh/en debugger strings line up", async () => {
    await setup();
    await act(async () => setLanguage("en"));
    // remount happens through App in production; here just check the dictionary keys line up
    const { DICTS } = await import("../src/strings");
    expect(Object.keys(DICTS.en.debug).sort()).toEqual(Object.keys(DICTS.zh.debug).sort());
    expect(DICTS.en.debug.pausedAt("a.py", 3)).toBe("Paused at a.py:3");
  });
});
