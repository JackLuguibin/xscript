import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { FlowPage } from "../src/components/FlowPage";
import { MirrorPage } from "../src/components/MirrorPage";
import { createDemoTransport } from "../src/demo";
import { clearDraft, keepDraft, readDraft } from "../src/flow/draft";
import { compile, parse, printFlow, type FlowGraph } from "../src/flow/dsl";
import { onCanvasPick, sendToCanvas, takeCanvasPicks } from "../src/flow/inbox";
import { layoutFromGraph } from "../src/flow/layout";
import { SAMPLE_FLOW } from "../src/flow/sample";
import { builtinSpecs } from "../src/flow/specs";
import { chainTail, dropTreeNode } from "../src/flow/tree-drop";
import { selectorChain, selectorCode } from "../src/ui-tree";
import { runFlowPython } from "./py-run";

const specs = builtinSpecs();
const SEARCH = { path: "0/0", id: "com.android.settings:id/search", text: "Search", desc: "Search settings", type: "android.widget.TextView", clickable: true };
const flowText = () => (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;

describe("where a dropped control attaches", () => {
  it("follows then/completed from start to the free end of the main line", () => {
    expect(chainTail(parse(SAMPLE_FLOW), specs)).toBe("done.then");
    expect(chainTail(parse("flow e  # xflow 1\non start:\n"), specs)).toBe("start.then");
    const loopEnd = parse(["flow l  # xflow 1", "on start:", "  for loop in range(0, 2):", '    a: log(message="x")', ""].join("\n"));
    expect(chainTail(loopEnd, specs)).toBe("loop.completed");
  });

  it("stops at a branch, a multi-exit node, a goto loop or a dangling wire", () => {
    const branch = parse(["flow b  # xflow 1", "on start:", '  btn: node.find(text="x", timeout=1)', "  ok: if btn.found:", '    a: log(message="a")', ""].join("\n"));
    expect(chainTail(branch, specs)).toBeNull();
    const retry = parse(["flow r  # xflow 1", "on start:", "  retry times=2:", '    a: log(message="a")', ""].join("\n"));
    expect(chainTail(retry, specs)).toBeNull();
    const cycle: FlowGraph = {
      xflow: 1,
      name: "c",
      nodes: [{ id: "start", type: "event.start" }, { id: "a", type: "debug.log", inputs: { message: "a" } }],
      edges: [{ from: "start.then", to: "a.exec" }, { from: "a.then", to: "a.exec" }],
    };
    expect(chainTail(cycle, specs)).toBeNull();
    const odd: FlowGraph = { ...cycle, edges: [{ from: "start.then", to: "loop.break" }] };
    expect(chainTail(odd, specs)).toBeNull();
    const missing: FlowGraph = { ...cycle, edges: [{ from: "start.then", to: "ghost.exec" }] };
    expect(chainTail(missing, specs)).toBeNull();
  });
});

describe("dropping a control onto the flow", () => {
  it("adds find → if found → click by text after the main line, and the flow runs", () => {
    const drop = dropTreeNode(parse(SAMPLE_FLOW), SEARCH, specs);
    expect(drop.ids).toEqual(["find", "found", "tap_2"]);
    expect(drop.attached).toBe("done.then");
    expect(drop.label).toBe("Search");
    const text = printFlow(drop.graph);
    expect(text).toContain('find: node.find(text="Search", timeout=5)');
    expect(text).toContain("found: if find.found:");
    expect(text).toContain("tap_2: click(target=find.node)");
    const py = compile(drop.graph, specs).python;
    expect(runFlowPython(py, ["签到", "Search"])).toEqual(["open com.example.shop", "click 签到", "已签到", "流程结束", "click Search"]);
    expect(runFlowPython(py, ["签到"]).at(-1)).toBe("流程结束");
  });

  it("uses the full selector in a code node when the control has no text", () => {
    const pick = { id: "com.x:id/ok", desc: "OK", clickable: true };
    expect(selectorChain(pick, "xs")).toBe("xs.Selector().id('com.x:id/ok').clickable()");
    expect(selectorCode(pick)).toBe("from xscript.android import node\nnode.Selector().id('com.x:id/ok').clickable().find(timeout=5)");
    const drop = dropTreeNode(parse("flow e  # xflow 1\non start:\n"), pick, specs);
    const find = drop.graph.nodes.find((node) => node.id === "find");
    expect(find?.type).toBe("code.python");
    expect(String(find?.config?.source)).toContain("xs_node.Selector().id('com.x:id/ok').clickable().find(timeout=5)");
    expect(drop.label).toBe("OK");
    const py = compile(drop.graph, specs).python;
    expect(py).toContain("if find[1]:");
    expect(runFlowPython(py, ["com.x:id/ok"])).toEqual(["click com.x:id/ok"]);
    expect(runFlowPython(py)).toEqual([]);
  });

  it("gives a second drop fresh ids and leaves it floating after the branch", () => {
    const first = dropTreeNode(parse(SAMPLE_FLOW), SEARCH, specs);
    const second = dropTreeNode(first.graph, { text: "  Next  " }, specs);
    expect(second.ids).toEqual(["find_2", "found_2", "tap_3"]);
    expect(second.attached).toBeNull();
    expect(second.graph.edges.some((edge) => edge.to === "find_2.exec")).toBe(false);
    expect(second.graph.nodes.find((node) => node.id === "find_2")?.inputs?.text).toBe("Next");
  });
});

describe("canvas inbox and draft", () => {
  it("queues picks without their tree baggage and notifies listeners until they leave", () => {
    const seen = vi.fn();
    const stop = onCanvasPick(seen);
    sendToCanvas({ ...SEARCH, rect: { l: 0, t: 0, r: 1, b: 1 }, children: [{ text: "child" }] } as never);
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    sendToCanvas({ text: "B" });
    expect(seen).toHaveBeenCalledTimes(1);
    const picks = takeCanvasPicks();
    expect(picks.map((pick) => pick.text)).toEqual(["Search", "B"]);
    expect(picks[0]).not.toHaveProperty("children");
    expect(picks[0]).not.toHaveProperty("rect");
    expect(takeCanvasPicks()).toEqual([]);
  });

  it("keeps the flow across page visits and falls back to the sample when the kept text is broken", () => {
    const first = render(<FlowPage />);
    const edited = ["flow mine  # xflow 1", "on start:", '  hello: log(message="hi")', ""].join("\n");
    fireEvent.change(screen.getByRole("textbox", { name: "流程文本" }), { target: { value: edited } });
    expect(readDraft()?.text).toContain('hello: log(message="hi")');
    first.unmount();
    const second = render(<FlowPage />);
    expect(flowText()).toContain('hello: log(message="hi")');
    second.unmount();
    keepDraft({ text: "half typed (", valid: edited, layout: layoutFromGraph(parse(edited)) });
    const third = render(<FlowPage />);
    expect(flowText()).toContain('hello: log(message="hi")');
    third.unmount();
    keepDraft({ text: "this is not a flow", valid: "nor this", layout: layoutFromGraph(parse(SAMPLE_FLOW)) });
    render(<FlowPage />);
    expect(flowText()).toContain("flow daily_signin");
    clearDraft();
    expect(readDraft()).toBeNull();
  });

  it("drains picks queued before and after the flow page mounts", () => {
    sendToCanvas(SEARCH);
    render(<FlowPage />);
    expect(flowText()).toContain('find: node.find(text="Search", timeout=5)');
    expect(screen.getByText("已把「Search」的查找和点击接到流程末尾")).toBeTruthy();
    act(() => sendToCanvas({ id: "com.x:id/next" }));
    expect(flowText()).toContain("find_2: code(");
    expect(screen.getByText("已把「com.x:id/next」的查找和点击放到画布上，还没接进流程")).toBeTruthy();
  });
});

describe("screen page → flow page", () => {
  it("sends the selected control from the control tree and the shell opens the flow page", async () => {
    const rpc = new RpcClient(createDemoTransport());
    const api = createApi(rpc);
    render(
      <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
        <App />
      </ServicesContext.Provider>,
    );
    await screen.findByText("emulator-5554");
    await act(async () => {
      await api.connectAdb("emulator-5554");
    });
    fireEvent.click(within(screen.getByRole("navigation", { name: "main" })).getByRole("button", { name: "屏幕" }));
    fireEvent.click(await screen.findByRole("radio", { name: "选控件" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新控件树" }));
    fireEvent.click(await screen.findByRole("treeitem", { name: "Search" }));
    expect(screen.getByText(/放到流程画布」会加一组/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "放到流程画布" }));
    expect(await screen.findByRole("heading", { level: 1, name: "流程" })).toBeTruthy();
    expect(flowText()).toContain('find: node.find(text="Search", timeout=5)');
  });

  it("queues the pick with a toast when the screen page stands alone", async () => {
    const transport = createDemoTransport();
    const rpc = new RpcClient(transport);
    const api = createApi(rpc);
    await api.connectAdb("emulator-5554");
    render(
      <ServicesContext.Provider value={{ rpc, api, inShell: true }}>
        <MirrorPage />
      </ServicesContext.Provider>,
    );
    fireEvent.click(await screen.findByRole("radio", { name: "选控件" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新控件树" }));
    fireEvent.click(await screen.findByRole("treeitem", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "放到流程画布" }));
    await screen.findByText("已放到流程画布");
    expect(takeCanvasPicks()).toEqual([{ ...SEARCH }]);
  });
});
