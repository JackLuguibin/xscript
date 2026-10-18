import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { FlowPage } from "../src/components/FlowPage";
import { placeNodes } from "../src/flow/place";
import { SAMPLE_FLOW } from "../src/flow/sample";
import { connectPins, connectionHint, diagnose } from "../src/flow/diagnostics";
import { builtinSpecs, listedInMenu, menuSpecs, nodeBadge, overlayCount } from "../src/flow/specs";
import { addConnectedNode, findInGraph, jumpTargets, menuTree, searchNodes, specsForSource } from "../src/flow/search";
import { cycleBreakpoint, toggleBreakpoints } from "../src/flow/breakpoints";
import { applyNodeStatement, compile, deleteNodes, duplicateNodes, mergeFlow, nodeStatement, parse, printFlow, promoteFunction, renameInput } from "../src/flow/dsl";
import { mapGraph } from "../src/flow/map";
import { addComment, addGroup, clampDock, clipOffscreen, insertReroute, layoutFromGraph, moveNode, nudgeSelection, renameNodeTitle, retainLayout, shiftGroup, toggleCollapsed, visualEdges } from "../src/flow/layout";
import { mergeBoxSelection } from "../src/flow/select";
import { enterableScope, scopeNodeIds } from "../src/flow/scope";
import { pinColor, pinMarks, pinTone } from "../src/flow/pins";
import { dropVariable } from "../src/flow/variables";

beforeAll(() => {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, "ResizeObserver", { configurable: true, writable: true, value: Observer });
  Object.defineProperty(window, "DOMMatrixReadOnly", {
    configurable: true,
    writable: true,
    value: class {
      m22 = 1;
    },
  });
});

describe("flow page", () => {
  it("places the sign-in chain on one row and keeps defs off it", () => {
    const graph = parse(SAMPLE_FLOW);
    const pos = placeNodes(graph);
    expect(pos.open.y).toBe(0);
    expect(pos.warm.x).toBeGreaterThan(pos.open.x);
    expect(pos.done.y).toBeGreaterThan(pos.attempt.y);
    expect(pos.done.x).toBeLessThan(pos.msg.x);
    expect(pos.retry.y).toBeGreaterThan(pos.ok.y);
    expect(pos.retry.x).toBeGreaterThan(pos.ok.x);
  });

  it("keeps a dragged position and flags a dangling pin", () => {
    const graph = parse(SAMPLE_FLOW);
    const moved = moveNode(layoutFromGraph(graph), "open", 40, 50);
    const next = mergeFlow(graph, parse('flow extra  # xflow 1\non start:\n  more: log(message="x")\n'));
    const kept = retainLayout(moved, next);
    expect(kept.xflowLayout).toBe(1);
    expect(kept.nodes.open).toEqual({ x: 40, y: 50 });
    expect(kept.nodes.more.x).toBeTypeOf("number");
    const dangling = diagnose({
      xflow: 1,
      name: "part",
      nodes: [
        { id: "start", type: "event.start" },
        { id: "tap", type: "action.click" },
      ],
      edges: [{ from: "missing.node", to: "tap.target" }],
    });
    expect(dangling.map((item) => item.code)).toContain("W300");
    expect(diagnose({ xflow: 1, name: "empty", nodes: [], edges: [] }).map((item) => item.code)).toContain("E301");
    const specs = builtinSpecs();
    expect(diagnose(parse(SAMPLE_FLOW), undefined, specs).some((item) => item.code.startsWith("E11"))).toBe(false);
    const mismatch = parse(SAMPLE_FLOW);
    mismatch.edges.push({ from: "btn.found", to: "tap.target" });
    mismatch.edges.push({ from: "open.then", to: "warm.ms" });
    const codes = diagnose(mismatch, undefined, specs).map((item) => item.code);
    expect(codes).toContain("E112");
    expect(codes).toContain("E111");
    const linked = connectPins(parse(SAMPLE_FLOW), "done", "then", "warm", "exec", specs);
    expect(linked.ok).toBe(true);
    const secondExec = connectPins(parse(SAMPLE_FLOW), "open", "then", "done", "exec", specs);
    expect(secondExec.ok).toBe(false);
    const refused = connectPins(parse(SAMPLE_FLOW), "btn", "found", "tap", "target", specs);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("E112");
  });

  it("matches the golden sign-in text", () => {
    expect(readFileSync("../schema/golden/daily_signin.xflow", "utf8")).toBe(SAMPLE_FLOW);
  });

  it("folds the first two nodes into code and unfolds them again", () => {
    render(<FlowPage />);
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain("daily_signin");
    fireEvent.click(screen.getByRole("checkbox", { name: "open" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "warm" }));
    fireEvent.click(screen.getByRole("button", { name: "折叠为代码" }));
    expect(screen.getByRole("status").textContent).toContain("已折成代码节点");
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain("code(source=");
    fireEvent.click(screen.getByRole("checkbox", { name: "box" }));
    fireEvent.click(screen.getByRole("button", { name: "展开代码" }));
    expect(screen.getByRole("checkbox", { name: "open" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "box" })).toBeNull();
  });

  it("filters the node menu and wires a dropped exec pin", () => {
    const specs = builtinSpecs();
    const entries = menuSpecs();
    expect(searchNodes("点", entries, [])[0]?.type).toBe("action.click");
    expect(searchNodes("", entries, ["debug.log"])[0]?.type).toBe("debug.log");
    const execOnly = specsForSource(specs.get("action.app.open"), "then", entries);
    expect(execOnly.some((spec) => spec.type === "math.add")).toBe(false);
    expect(execOnly.some((spec) => spec.type === "debug.log")).toBe(true);
    expect(menuSpecs().length).toBeGreaterThan(300);
    expect(menuSpecs().some((spec) => spec.type === "action.sleep" && spec.title === "休眠")).toBe(true);
    expect(overlayCount()).toBeGreaterThanOrEqual(60);
    const sleep = builtinSpecs().get("action.sleep");
    expect(sleep?.inputs.find((pin) => pin.name === "seconds")?.type).toBe("float");
    expect(listedInMenu("stub")).toBe(false);
    expect(listedInMenu("hidden")).toBe(false);
    expect(listedInMenu("partial")).toBe(true);
    expect(nodeBadge("partial")).toBe("partial");
    expect(nodeBadge("ok")).toBeNull();
    const nap = parse(["flow nap  # xflow 1", "on start:", "  nap: action.sleep(seconds=1)", ""].join("\n"));
    expect(printFlow(nap)).toContain("action.sleep(seconds=1)");
    expect(compile(nap, specs).python).toContain("nap = action.sleep(");
    const shot = parse(["flow shot  # xflow 1", "on start:", '  c: screen.get_color(x=1, y=2, image="shot")', ""].join("\n"));
    expect(compile(shot, specs).python).toContain("from xscript.android import screen");
    const busy = addConnectedNode(parse(SAMPLE_FLOW), "debug.log", specs, { from: "open", pin: "then" });
    expect(busy.graph.edges.some((edge) => edge.to === "n1.exec")).toBe(false);
    const added = addConnectedNode(parse(SAMPLE_FLOW), "debug.log", specs, { from: "done", pin: "then" });
    expect(added.graph.edges).toContainEqual({ from: "done.then", to: "n1.exec" });

    render(<FlowPage />);
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索节点" }), { target: { value: "打印" } });
    fireEvent.click(screen.getByRole("button", { name: /打印/ }));
    expect(screen.getByRole("checkbox", { name: "n1" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain("log(");
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索节点" }), { target: { value: "休眠" } });
    fireEvent.click(screen.getByRole("button", { name: /休眠/ }));
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain("action.sleep(");
    expect((document.querySelector('.react-flow__node[data-id="n2"] .xflow-title') as HTMLInputElement).value).toBe("休眠");
  });

  it("browses the node menu by category and lists a recent node", () => {
    const tree = menuTree(menuSpecs(), ["debug.log"]);
    expect(tree.recent[0]?.type).toBe("debug.log");
    expect(tree.groups.some((group) => group.category === "data" && group.specs.some((spec) => spec.type === "debug.log"))).toBe(true);
    const names = tree.groups.map((group) => group.category);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

    render(<FlowPage />);
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    expect(screen.queryByRole("button", { name: "打印" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "分类 数据" }));
    fireEvent.click(screen.getByRole("button", { name: "打印" }));
    expect(screen.getByRole("checkbox", { name: "n1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    expect(screen.getByRole("region", { name: "最近使用" }).textContent).toContain("打印");
    fireEvent.change(screen.getByRole("textbox", { name: "搜索节点" }), { target: { value: "休眠" } });
    expect(screen.queryByRole("button", { name: "分类 数据" })).toBeNull();
    expect(screen.getByRole("button", { name: /休眠/ })).toBeTruthy();
  });

  it("opens the node menu from space and leaves the text field alone", () => {
    render(<FlowPage />);
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByRole("dialog", { name: "添加节点" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "添加节点" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "流程文本" }), { key: " " });
    expect(screen.queryByRole("dialog", { name: "添加节点" })).toBeNull();
  });

  it("deletes the selected node and leaves its neighbors unjoined", () => {
    const next = deleteNodes(parse(SAMPLE_FLOW), ["warm"]);
    expect(next.nodes.some((node) => node.id === "warm")).toBe(false);
    expect(next.nodes.some((node) => node.id === "attempt")).toBe(true);
    expect(next.edges.some((edge) => edge.from.startsWith("open.") && edge.to.startsWith("attempt."))).toBe(false);

    render(<FlowPage />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "流程文本" }), { key: "Backspace" });
    expect(screen.getByRole("checkbox", { name: "warm" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "warm" }));
    fireEvent.keyDown(window, { key: "Delete" });
    expect(screen.queryByRole("checkbox", { name: "warm" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "attempt" })).toBeTruthy();
    const text = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    expect(text).not.toContain("warm:");
    expect(text).toContain("for attempt");
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByRole("checkbox", { name: "warm" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(screen.queryByRole("checkbox", { name: "warm" })).toBeNull();
  });

  it("undo restores the flow text from before the edit", () => {
    render(<FlowPage />);
    const box = screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: box.value.replace("签到", "打卡") } });
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain("打卡");
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    const restored = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    expect(restored).toContain("签到");
    expect(restored).not.toContain("打卡");
  });

  it("bends one edge in the layout and keeps the flow text", () => {
    const graph = parse(SAMPLE_FLOW);
    const edge = "btn.node->tap.target";
    const layout = insertReroute(layoutFromGraph(graph), edge, 600, 120);
    expect(layout.reroutes).toEqual([{ id: "r1", at: [600, 120], edge }]);
    expect(printFlow(graph)).not.toContain("r1");
    expect(visualEdges(graph, layout).filter((item) => item.semantic === edge).map((item) => [item.source, item.target])).toEqual([
      ["btn", "r1"],
      ["r1", "tap"],
    ]);
    expect(retainLayout(layout, deleteNodes(graph, ["tap"])).reroutes).toEqual([]);

    render(<FlowPage initialLayout={layout} />);
    const text = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    expect(text).not.toContain("r1");
    expect(text).toContain("tap:");
    fireEvent.click(screen.getByRole("checkbox", { name: "r1" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.queryByRole("checkbox", { name: "r1" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toBe(text);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByRole("checkbox", { name: "r1" })).toBeTruthy();
  });

  it("boxes the selected nodes without writing the box into the flow text", () => {
    const graph = parse(SAMPLE_FLOW);
    const layout = layoutFromGraph(graph);
    layout.nodes.open = { x: 0, y: 0 };
    layout.nodes.warm = { x: 160, y: 0 };
    const boxed = addGroup(layout, ["open", "warm"]);
    expect(boxed.groups?.[0]?.id).toBe("g1");
    expect(boxed.groups?.[0]?.title).toBe("注释");
    expect(boxed.groups?.[0]?.rect[2]).toBeGreaterThan(160);
    const shifted = shiftGroup(boxed, "g1", (boxed.groups?.[0]?.rect[0] ?? 0) + 32, boxed.groups?.[0]?.rect[1] ?? 0, ["open", "warm"]);
    expect(shifted.nodes.open?.x).toBe(32);
    expect(shifted.nodes.warm?.x).toBe(192);
    expect(printFlow(graph)).not.toContain("g1");

    render(<FlowPage />);
    const before = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole("checkbox", { name: "open" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "warm" }));
    fireEvent.click(screen.getByRole("button", { name: "注释框" }));
    expect(screen.getByRole("checkbox", { name: "g1" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toBe(before);
    fireEvent.click(screen.getByRole("checkbox", { name: "open" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "warm" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "g1" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.queryByRole("checkbox", { name: "g1" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "open" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByRole("checkbox", { name: "g1" })).toBeTruthy();
  });

  it("adds a flow variable and a get node from the variable panel", () => {
    render(<FlowPage />);
    expect(screen.getByText(/loop attempt/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建变量" }));
    fireEvent.change(screen.getByRole("textbox", { name: "变量名" }), { target: { value: "score" } });
    fireEvent.change(screen.getByRole("combobox", { name: "变量类型" }), { target: { value: "int" } });
    fireEvent.change(screen.getByRole("textbox", { name: "默认值" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "添加变量" }));
    const text = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    expect(text).toContain("var score: int = 1");
    fireEvent.click(screen.getAllByRole("button", { name: "读取" })[0]);
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain('get(name="score")');
    expect(document.querySelector(".react-flow__minimap")).toBeTruthy();
  });

  it("drops a variable row onto the canvas as a get", () => {
    const graph = parse(SAMPLE_FLOW);
    const read = dropVariable(graph, { name: "attempt", writable: false }, true);
    expect(read.graph.nodes.find((node) => node.id === read.id)?.type).toBe("data.get");
    const withScore = parse('flow demo  # xflow 1\nvar score: int = 1\non start:\n  log(message="x")\n');
    const write = dropVariable(withScore, { name: "score", writable: true }, true);
    expect(write.graph.nodes.find((node) => node.id === write.id)?.type).toBe("data.set");

    render(<FlowPage />);
    const store = new Map<string, string>();
    const data = {
      setData: (type: string, value: string) => {
        store.set(type, value);
      },
      getData: (type: string) => store.get(type) ?? "",
      types: ["application/x-xflow-var"],
      effectAllowed: "copy",
      dropEffect: "copy",
    };
    data.setData("application/x-xflow-var", JSON.stringify({ name: "attempt", writable: false }));
    const pane = document.querySelector(".react-flow");
    expect(pane).toBeTruthy();
    if (!pane) return;
    fireEvent.dragOver(pane, { dataTransfer: data });
    fireEvent.drop(pane, { dataTransfer: data, clientX: 48, clientY: 64 });
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain('get(name="attempt")');
  });

  it("adds a project parameter to the flow text", () => {
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("button", { name: "新建工程参数" }));
    fireEvent.change(screen.getByRole("textbox", { name: "参数名" }), { target: { value: "retries" } });
    fireEvent.change(screen.getByRole("combobox", { name: "参数类型" }), { target: { value: "int" } });
    fireEvent.change(screen.getByRole("textbox", { name: "参数默认值" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "添加工程参数" }));
    const text = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    expect(text).toContain("param retries: int = 3");
    expect(screen.queryAllByRole("button", { name: "写入" })).toHaveLength(0);
  });

  it("duplicates the selected node beside the original", () => {
    const copied = duplicateNodes(parse(SAMPLE_FLOW), ["warm"]);
    expect(copied.copies).toEqual([{ id: "warm_2", from: "warm" }]);
    expect(copied.graph.nodes.some((node) => node.id === "warm_2" && node.type === "flow.wait")).toBe(true);
    expect(copied.graph.edges.some((edge) => edge.from.startsWith("open.") && edge.to.startsWith("warm_2."))).toBe(false);

    render(<FlowPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "warm" }));
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect(screen.getByRole("checkbox", { name: "warm_2" })).toBeTruthy();
    const text = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    expect(text).toContain("warm_2:");
    expect(text).toContain("floating:");
  });

  it("collapses a selected node and leaves the flow text alone", () => {
    const graph = parse(SAMPLE_FLOW);
    const collapsed = toggleCollapsed(layoutFromGraph(graph), ["warm"]);
    expect(collapsed.nodes.warm.collapsed).toBe(true);
    const moved = moveNode(collapsed, "warm", 48, 64);
    expect(moved.nodes.warm).toEqual({ x: 48, y: 64, collapsed: true });
    expect(toggleCollapsed(moved, ["warm"]).nodes.warm).toEqual({ x: 48, y: 64 });

    render(<FlowPage />);
    const before = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole("checkbox", { name: "warm" }));
    fireEvent.keyDown(window, { key: "m" });
    expect(screen.getByRole("checkbox", { name: "warm" }).closest("label")?.getAttribute("data-collapsed")).toBe("true");
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toBe(before);
    const card = document.querySelector(".xflow-node.is-collapsed");
    expect((card?.querySelector(".xflow-title") as HTMLInputElement | null)?.value).toBe("延时");
    expect(card?.querySelector(".xflow-title")?.getAttribute("title")).toContain("warm");
    expect(card?.querySelector(".handle-data")).toBeNull();
    expect(card?.querySelector(".handle-exec")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByRole("checkbox", { name: "warm" }).closest("label")?.getAttribute("data-collapsed")).toBeNull();
  });

  it("nudges the selected node by one grid and five with shift", () => {
    const base = layoutFromGraph(parse(SAMPLE_FLOW));
    const once = nudgeSelection(base, ["open"], 16, 0);
    expect(once.nodes.open).toEqual({ x: base.nodes.open.x + 16, y: base.nodes.open.y });
    const boxed = addGroup(base, ["open"]);
    const withBox = nudgeSelection(boxed, [boxed.groups?.[0]?.id ?? ""], 0, 16);
    const box = withBox.groups?.[0];
    expect(box?.rect[1]).toBe((boxed.groups?.[0]?.rect[1] ?? 0) + 16);
    expect(withBox.nodes.open.y).toBe(boxed.nodes.open.y + 16);

    render(<FlowPage />);
    const node = () => document.querySelector('.react-flow__node[data-id="open"]') as HTMLElement;
    const readX = () => Number(/translate\(([-\d.]+)px/.exec(node().style.transform)?.[1]);
    fireEvent.click(screen.getByRole("checkbox", { name: "open" }));
    const start = readX();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(readX()).toBe(start + 16 + 80);
    fireEvent.keyUp(window, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(readX()).toBe(start);
  });

  it("finds a node from a literal and steps to the next match", () => {
    const graph = parse(SAMPLE_FLOW);
    expect(findInGraph(graph, "shop")).toEqual(["open"]);
    expect(findInGraph(graph, "wait")).toEqual(["warm", "retry"]);

    render(<FlowPage />);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const box = screen.getByRole("textbox", { name: "查找" });
    fireEvent.change(box, { target: { value: "wait" } });
    expect((screen.getByRole("checkbox", { name: "warm" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.keyDown(box, { key: "Enter" });
    expect((screen.getByRole("checkbox", { name: "retry" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "warm" }) as HTMLInputElement).checked).toBe(false);
  });

  it("lists the flow name in the jump menu", () => {
    const source = ["flow demo  # xflow 1", "def greet(name):", "  local n: int = 0", "on start:", '  log(message="x")', ""].join("\n");
    expect(jumpTargets(parse(source)).map((item) => item.id)).toEqual(["demo", "greet"]);

    render(<FlowPage />);
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(screen.getByRole("button", { name: "流程 daily_signin" })).toBeTruthy();
  });

  it("fits the selection and the whole graph", () => {
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "open" }));
    fireEvent.keyDown(window, { key: "f" });
    expect(screen.getByText("已聚焦选中")).toBeTruthy();
    fireEvent.keyDown(window, { key: "F", shiftKey: true });
    expect(screen.getByText("已适应全部")).toBeTruthy();
  });

  it("tabs between nodes and edits an unwired pin", () => {
    render(<FlowPage />);
    const open = document.querySelector('.react-flow__node[data-id="open"]') as HTMLElement;
    expect(open.getAttribute("aria-label")).toContain("执行引脚 2");
    expect(open.getAttribute("aria-label")).toContain("空闲");
    open.focus();
    fireEvent.keyDown(open, { key: "Tab" });
    const warm = document.querySelector('.react-flow__node[data-id="warm"]') as HTMLElement;
    expect(document.activeElement).toBe(warm);
    fireEvent.keyDown(warm, { key: "Enter" });
    const field = warm.querySelector(".xflow-field input") as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "2500" } });
    const text = () => (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    expect(text()).toContain("ms=2500");
    fireEvent.change(field, { target: { value: "2600" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.activeElement).toBe(warm);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(text()).toContain("ms=2000");
    expect(text()).not.toContain("ms=2600");
  });

  it("toggles a local breakpoint without changing the flow text", () => {
    expect(toggleBreakpoints([], ["warm"])).toEqual([{ node: "warm", enabled: true }]);
    expect(toggleBreakpoints([{ node: "warm", enabled: false }], ["warm"])).toEqual([]);
    expect(cycleBreakpoint([{ node: "warm", enabled: true }], "warm")).toEqual([{ node: "warm", enabled: false }]);

    localStorage.removeItem("xscript.flow.breakpoints");
    render(<FlowPage />);
    const before = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole("checkbox", { name: "warm" }));
    fireEvent.keyDown(window, { key: "F9" });
    const badge = screen.getByRole("button", { name: "warm 断点" });
    expect(badge.getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toBe(before);
    expect(localStorage.getItem("xscript.flow.breakpoints")).toContain("warm");
    fireEvent.click(badge);
    expect(screen.getByRole("button", { name: "warm 断点" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("tab", { name: /^断点/ }));
    expect(screen.getByRole("button", { name: "停用" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "F9" });
    expect(screen.queryByRole("button", { name: "停用" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "流程文本" }));
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toBe(before);
  });

  it("jumps to the node named in a problem", async () => {
    const bad = 'flow part  # xflow 1\non start:\n  btn: node.find(text="签到")\n  tap: click(target=btn.found)\n';
    const hit = diagnose(parse(bad), undefined, builtinSpecs()).find((item) => item.code === "E112");
    expect(hit?.node).toBe("tap");

    render(<FlowPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "流程文本" }), { target: { value: bad } });
    fireEvent.click(screen.getByRole("tab", { name: /^问题/ }));
    const item = await screen.findByRole("button", { name: /E112/ }, { timeout: 1000 });
    fireEvent.click(item);
    expect((screen.getByRole("checkbox", { name: "tap" }) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector('.react-flow__node[data-id="tap"] .xflow-bang')?.textContent).toBe("!");
    expect((document.querySelector('.react-flow__node[data-id="tap"]') as HTMLElement).style.outline).toContain("#d23b3b");
  });

  it("drops grid snap while alt is held and shows the zoom percent", () => {
    render(<FlowPage />);
    expect(screen.getByLabelText("缩放").textContent).toBe("100%");
    expect(document.querySelector(".flow-canvas")?.getAttribute("data-snap")).toBe("on");
    fireEvent.keyDown(window, { key: "Alt" });
    expect(document.querySelector(".flow-canvas")?.getAttribute("data-snap")).toBe("off");
    fireEvent.keyUp(window, { key: "Alt" });
    expect(document.querySelector(".flow-canvas")?.getAttribute("data-snap")).toBe("on");
  });

  it("adds with shift and subtracts with alt when boxing nodes", () => {
    expect(mergeBoxSelection(["open"], ["warm"], "add")).toEqual(["open", "warm"]);
    expect(mergeBoxSelection(["open", "warm"], ["warm"], "sub")).toEqual(["open"]);
    expect(mergeBoxSelection(["open"], ["warm"], "replace")).toEqual(["warm"]);
  });

  it("copies the selection as flow text and pastes a renamed copy", async () => {
    let slot = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          slot = text;
        },
        readText: async () => slot,
      },
    });
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "warm" }));
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    expect(slot).toContain("warm:");
    expect(screen.getByRole("checkbox", { name: "warm" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });
    expect(await screen.findByRole("checkbox", { name: "warm_2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "warm_2" }));
    fireEvent.keyDown(window, { key: "x", ctrlKey: true });
    expect(screen.queryByRole("checkbox", { name: "warm_2" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "warm" })).toBeTruthy();
  });

  it("drops a layout note that stays out of the flow text", () => {
    const laid = addComment(layoutFromGraph(parse(SAMPLE_FLOW)), 880, -60, "最多重试 3 次");
    expect(laid.comments).toEqual([{ id: "c1", text: "最多重试 3 次", at: [880, -60] }]);
    expect(retainLayout(laid, parse(SAMPLE_FLOW)).comments).toEqual(laid.comments);

    render(<FlowPage />);
    const before = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    fireEvent.keyDown(window, { key: "n" });
    const field = screen.getByRole("textbox", { name: "c1" }) as HTMLTextAreaElement;
    expect(field.value).toBe("备注");
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toBe(before);
    fireEvent.change(field, { target: { value: "最多重试 3 次" } });
    expect((screen.getByRole("textbox", { name: "c1" }) as HTMLTextAreaElement).value).toBe("最多重试 3 次");
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.queryByRole("textbox", { name: "c1" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toBe(before);
  });

  it("shows the sign-in example on an empty canvas", async () => {
    render(<FlowPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "流程文本" }), { target: { value: "flow empty  # xflow 1\non start:\n" } });
    expect(await screen.findByText("双击或按空格添加第一个节点")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "签到示例" }));
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain("daily_signin");
    expect(screen.queryByText("双击或按空格添加第一个节点")).toBeNull();
  });

  it("enters a function and returns from the breadcrumb", async () => {
    const source = ['flow demo  # xflow 1', "def greet(name):", '  hi: log(message="hi")', "on start:", '  use: call greet(name="a")', ""].join("\n");
    const graph = parse(source);
    expect(scopeNodeIds(graph, null).sort()).toEqual(["greet", "use"]);
    expect(scopeNodeIds(graph, "greet").sort()).toEqual(["greet", "hi"]);
    expect(enterableScope(graph, "use")).toBe("greet");

    render(<FlowPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "流程文本" }), { target: { value: source } });
    expect(await screen.findByRole("checkbox", { name: "use" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "hi" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "use" }));
    fireEvent.click(screen.getByRole("button", { name: "进入" }));
    expect(await screen.findByRole("checkbox", { name: "hi" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "use" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "demo" }));
    expect(await screen.findByRole("checkbox", { name: "use" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "hi" })).toBeNull();
  });

  it("paints an open string pin and a wired exec pin", () => {
    expect(pinTone("node?")).toBe("node");
    expect(pinTone("list<int>")).toBe("int");
    expect(pinMarks("node?")).toEqual({ list: false, optional: true });
    expect(pinMarks("list<node?>")).toEqual({ list: true, optional: true });
    expect(pinColor("string")).toBe("#d24b9a");
    const named = renameNodeTitle(layoutFromGraph(parse(SAMPLE_FLOW)), "open", "开门");
    expect(moveNode(named, "open", 8, 8).nodes.open).toMatchObject({ x: 8, y: 8, title: "开门" });
    expect(toggleCollapsed(named, ["open"]).nodes.open).toMatchObject({ collapsed: true, title: "开门" });
    expect(renameNodeTitle(named, "open", null).nodes.open.title).toBeUndefined();
    render(<FlowPage />);
    const openCard = document.querySelector('.react-flow__node[data-id="open"] .xflow-node');
    expect(openCard?.classList.contains("cat-action")).toBe(true);
    expect(openCard?.querySelector(".xflow-icon")).toBeTruthy();
    const pkg = openCard?.querySelector(".handle-data");
    expect(pkg?.classList.contains("tone-string")).toBe(true);
    expect(pkg?.classList.contains("is-open")).toBe(true);
    expect(pkg?.getAttribute("aria-label")).toBe("package string");
    const nodePin = document.querySelector('.react-flow__node[data-id="btn"] .handle-data.is-optional');
    expect(nodePin?.getAttribute("aria-label")).toBe("node node?");
    expect(nodePin?.getAttribute("title")).toBe("node node?");
    expect(document.querySelector('.react-flow__node[data-id="btn"] .xflow-node')?.classList.contains("cat-find")).toBe(true);
    expect(document.querySelector('.react-flow__node[data-id="warm"] .handle-exec.is-wired')).toBeTruthy();
    const title = openCard?.querySelector(".xflow-title") as HTMLInputElement;
    expect(title.value).toBe("打开应用");
    expect(title.getAttribute("title")).toBe("open 打开应用 action");
    const before = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    fireEvent.change(title, { target: { value: "开门" } });
    expect((document.querySelector('.react-flow__node[data-id="open"] .xflow-title') as HTMLInputElement).value).toBe("开门");
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect((document.querySelector('.react-flow__node[data-id="open"] .xflow-title') as HTMLInputElement).value).toBe("打开应用");
  });

  it("names a refused wire and accepts a compatible one", () => {
    const specs = builtinSpecs();
    const graph = parse(SAMPLE_FLOW);
    expect(connectionHint(graph, "done", "then", "warm", "exec", specs)).toBe("✓");
    expect(connectionHint(graph, "open", "then", "done", "exec", specs)).toMatch(/^E113 /);
    const shared = parse(["flow shared  # xflow 1", "on start:", '  a: node.find(text="a")', '  b: node.find(text="b")', "  tap: click(target=a.node)", ""].join("\n"));
    expect(connectionHint(shared, "b", "node", "tap", "target", specs)).toMatch(/^E114 /);
    const cycle = parse(['flow loop  # xflow 1', "on start:", "  a: add(a=b.result, b=1)", "  b: add(a=a.result, b=1)", ""].join("\n"));
    expect(diagnose(cycle, undefined, specs).some((item) => item.code === "E115")).toBe(true);
    expect(connectionHint(graph, "btn", "found", "tap", "target", specs)).toMatch(/^E112 /);
    expect(connectPins(graph, "btn", "found", "tap", "target", specs).ok).toBe(false);
    const castGraph = {
      xflow: 1 as const,
      name: "cast",
      nodes: [
        { id: "start", type: "event.start" },
        { id: "loop", type: "flow.for_range", inputs: { start: 0, end: 3 } },
        { id: "nap", type: "action.sleep" },
      ],
      edges: [
        { from: "start.then", to: "loop.exec" },
        { from: "loop.completed", to: "nap.exec" },
      ],
    };
    expect(connectionHint(castGraph, "loop", "index", "nap", "seconds", specs)).toBe("✓ float()");
    const cast = connectPins(castGraph, "loop", "index", "nap", "seconds", specs);
    expect(cast.ok).toBe(true);
    if (cast.ok) {
      expect(cast.graph.nodes.some((node) => node.type === "math.float")).toBe(true);
      expect(compile(cast.graph, specs).python).toContain("float(");
      expect(printFlow(cast.graph)).toContain("float(");
    }
    const looseSpecs = builtinSpecs();
    looseSpecs.set("probe", { type: "probe", dsl: { alias: "probe" }, exec: { in: ["exec"], out: ["then"] }, inputs: [{ name: "item", type: "node" }], outputs: [] });
    const loose = parse(SAMPLE_FLOW);
    loose.nodes.push({ id: "p", type: "probe" });
    loose.edges.push({ from: "btn.node", to: "p.item" });
    expect(diagnose(loose, undefined, looseSpecs).some((item) => item.code === "W116")).toBe(true);
    const guarded = parse(SAMPLE_FLOW);
    guarded.nodes.push({ id: "p", type: "probe" }, { id: "keep", type: "data.must" });
    guarded.edges.push({ from: "btn.node", to: "keep.value" }, { from: "keep.result", to: "p.item" });
    expect(diagnose(guarded, undefined, looseSpecs).some((item) => item.code === "W116")).toBe(false);
  });

  it("jumps from a generated line to its node", () => {
    const mapped = mapGraph(parse(SAMPLE_FLOW), builtinSpecs());
    expect(mapped.version).toBe(1);
    expect(mapped.file).toBe("main.py");
    expect(mapped.nodes.open?.length).toBeGreaterThan(0);
    for (const line of mapped.nodes.open ?? []) expect(mapped.lines[line].startsWith("open")).toBe(true);
    expect(compile(parse(SAMPLE_FLOW), builtinSpecs()).python).toContain("system.open");

    render(<FlowPage />);
    fireEvent.click(screen.getByRole("tab", { name: "生成代码" }));
    const line = screen.getAllByRole("button").find((button) => /^\d+ open$/.test(button.textContent ?? ""));
    expect(line).toBeTruthy();
    fireEvent.click(line as HTMLButtonElement);
    expect((screen.getByRole("checkbox", { name: "open" }) as HTMLInputElement).checked).toBe(true);
  });

  it("shows a promoted function as its own flow", async () => {
    const source = ["flow demo  # xflow 1", "def greet(name) -> text:", "  msg: log(message=name)", "  return text=name", "on start:", '  c: call greet(name="Ada")', ""].join("\n");
    expect(promoteFunction(parse(source), "greet")).toContain("flow greet");
    render(<FlowPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "流程文本" }), { target: { value: source } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "greet" }));
    fireEvent.click(screen.getByRole("button", { name: "提升为文件" }));
    const file = (await screen.findByRole("textbox", { name: "独立流程" })) as HTMLTextAreaElement;
    expect(file.value).toContain("def greet(name) -> text:");
    expect(file.value).toContain('call greet(name="")');
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain('name="Ada"');
  });

  it("clips off-screen nodes only after the large-graph line", () => {
    expect(clipOffscreen(300)).toBe(false);
    expect(clipOffscreen(301)).toBe(true);
  });

  it("marks the running node from a pasted trace log", () => {
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("tab", { name: "轨迹" }));
    fireEvent.change(screen.getByRole("textbox", { name: "追踪日志" }), {
      target: { value: "\x1fXF\tenter\twarm\t1\nprint('hi')" },
    });
    expect(document.querySelector('.react-flow__node[data-id="warm"] .xflow-node')?.className).toContain("is-run-running");
    expect(screen.getByRole("list", { name: "轨迹" }).textContent).toContain("运行");
    expect(document.querySelector(".flow-canvas")?.getAttribute("data-flowing")).toBe("warm");
    fireEvent.change(screen.getByRole("textbox", { name: "追踪日志" }), {
      target: { value: "# seq 1\n\x1fXF\tspan\twarm\tTrue\n# seq 4" },
    });
    expect(screen.getByText("追踪数据被截断（设备日志窗口约 2 000 行）")).toBeTruthy();
    expect(document.querySelector('.react-flow__node[data-id="warm"] .xflow-node')?.className).toContain("is-run-success");
    expect(document.querySelector(".flow-canvas")?.getAttribute("data-flowing")).toBe("");
  });

  it("marks the node named by a traceback line", () => {
    const map = mapGraph(parse(SAMPLE_FLOW), builtinSpecs());
    const line = Object.entries(map.lines).find(([, mark]) => mark.split("(")[0] === "tap")?.[0];
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("tab", { name: "轨迹" }));
    fireEvent.change(screen.getByRole("textbox", { name: "追踪日志" }), {
      target: {
        value: [
          "Traceback (most recent call last):",
          `  File "/sdcard/projects/demo/main.py", line ${line}, in <module>`,
          "    btn.click()",
          "AttributeError: 'NoneType' object has no attribute 'click'",
        ].join("\n"),
      },
    });
    expect(document.querySelector('.react-flow__node[data-id="tap"] .xflow-node')?.className).toContain("is-fault");
    expect(document.querySelector('.react-flow__node[data-id="tap"] .xflow-bang')?.getAttribute("aria-label")).toContain("运行错误");
    const alert = screen.getByRole("alert", { name: "运行错误" });
    expect(alert.textContent).toContain("tap");
    expect(alert.textContent).toContain("AttributeError");
    fireEvent.click(alert.querySelector("button") as HTMLButtonElement);
    expect(document.querySelector('.react-flow__node[data-id="tap"]')?.className).toContain("selected");
    expect(document.querySelector('.react-flow__node[data-id="tap"]')?.getAttribute("aria-label")).toContain("运行错误");
  });

  it("runs the whole flow and pauses at a breakpoint", () => {
    localStorage.removeItem("xscript.flow.breakpoints");
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    expect(screen.getByRole("status", { name: "调试" }).textContent).toContain("跑完");
    expect(screen.getByRole("list", { name: "用户日志" }).textContent).toContain("流程结束");
    expect(document.querySelector('.react-flow__node[data-id="done"] .xflow-node')?.className).toContain("is-run-success");
    expect(document.querySelector('.react-flow__node[data-id="tap"] .xflow-node')?.className ?? "").not.toContain("is-run-");

    fireEvent.click(screen.getByRole("checkbox", { name: "warm" }));
    fireEvent.keyDown(window, { key: "F9" });
    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    expect(screen.getByRole("status", { name: "调试" }).textContent).toContain("warm");
    expect(document.querySelector('.react-flow__node[data-id="warm"] .xflow-node')?.className).toContain("is-run-paused");
    fireEvent.keyDown(window, { key: "F10" });
    expect(document.querySelector('.react-flow__node[data-id="attempt"] .xflow-node')?.className).toContain("is-run-paused");
    fireEvent.keyDown(window, { key: "F5", shiftKey: true });
    expect(screen.getByRole("status", { name: "调试" }).textContent).toContain("已停止");
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a step run for a literal add", async () => {
    render(<FlowPage />);
    const box = screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: ["flow calc  # xflow 1", "on start:", "  sum: add(a=1, b=2)", ""].join("\n") } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    fireEvent.click(screen.getByRole("checkbox", { name: "sum" }));
    fireEvent.click(screen.getByRole("button", { name: "试跑" }));
    const panel = screen.getByRole("region", { name: "试跑" });
    expect(panel.textContent).toContain("_result = (1 + 2)");
    expect(panel.textContent).toContain("结果 3");
  });

  it("suggests the real pin when a literal uses an unknown name", async () => {
    const specs = builtinSpecs();
    const bad = parse(["flow typo  # xflow 1", "on start:", '  btn: node.find(timeout=1, txt="签到")', "  warm: wait(ms=-1)", ""].join("\n"));
    const codes = diagnose(bad, undefined, specs);
    const unknown = codes.find((item) => item.code === "E200");
    expect(unknown?.message).toContain("txt");
    expect(unknown?.message).toContain("text");
    expect(unknown?.fix).toEqual({ from: "txt", to: "text" });
    const renamed = renameInput(bad, "btn", "txt", "text");
    expect(diagnose(renamed, undefined, specs).some((item) => item.code === "E200")).toBe(false);
    expect(renamed.nodes.find((node) => node.id === "btn")?.inputs?.text).toBe("签到");
    expect(codes.some((item) => item.code === "E202" && item.node === "warm")).toBe(true);
    const typed = parse(["flow typo  # xflow 1", "on start:", '  warm: wait(ms="1")', ""].join("\n"));
    expect(diagnose(typed, undefined, specs).some((item) => item.code === "E201")).toBe(true);
    expect(diagnose(parse(SAMPLE_FLOW), undefined, specs).some((item) => item.code.startsWith("E20"))).toBe(false);

    render(<FlowPage />);
    const box = screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: ["flow typo  # xflow 1", "on start:", '  btn: node.find(timeout=1, txt="签到")', ""].join("\n") } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    fireEvent.click(screen.getByRole("tab", { name: /^问题/ }));
    fireEvent.click(screen.getByRole("button", { name: "改成 text" }));
    fireEvent.click(screen.getByRole("tab", { name: "流程文本" }));
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain('text="签到"');
    expect(screen.queryByRole("button", { name: "改成 text" })).toBeNull();
  });

  it("edits one node statement from the inspector", async () => {
    const graph = parse(SAMPLE_FLOW);
    expect(nodeStatement(graph, "btn")).toBe('btn: node.find(text="签到", timeout=3)');
    expect(nodeStatement(graph, "attempt")).toBe("for attempt in range(0, 3):");
    expect(nodeStatement(graph, "ok")).toBe("ok: if btn.found:");
    expect(nodeStatement(graph, "warm")).toBe("warm: wait(ms=2000)");
    const widened = applyNodeStatement(graph, "attempt", "for attempt in range(1, 4):");
    expect(widened?.nodes.find((node) => node.id === "attempt")?.inputs).toEqual({ start: 1, end: 4 });
    expect(widened?.edges.some((edge) => edge.to === "attempt.break")).toBe(true);
    const next = applyNodeStatement(graph, "btn", 'btn: node.find(text="打卡", timeout=3)');
    expect(next?.nodes.find((node) => node.id === "btn")?.inputs?.text).toBe("打卡");
    expect(next?.edges.some((edge) => edge.from === "btn.found" && edge.to === "ok.cond")).toBe(true);
    expect(next?.edges.some((edge) => edge.from === "btn.node" && edge.to === "tap.target")).toBe(true);
    const renamed = applyNodeStatement(graph, "btn", 'card: node.find(text="签到", timeout=3)');
    expect(renamed?.nodes.some((node) => node.id === "card")).toBe(true);
    expect(renamed?.edges.some((edge) => edge.from === "card.found" && edge.to === "ok.cond")).toBe(true);
    expect(applyNodeStatement(graph, "btn", "btn: nope(a=1)")).toBeNull();

    render(<FlowPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "btn" }));
    const line = screen.getByRole("textbox", { name: "节点文本" }) as HTMLTextAreaElement;
    expect(line.value).toContain("签到");
    fireEvent.change(line, { target: { value: 'btn: node.find(text="打卡", timeout=3)' } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain('text="打卡"');
  });

  it("shows the selected node and edits its properties", () => {
    render(<FlowPage />);
    const flowText = () => (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    expect(screen.getByText("选择一个节点，在这里查看并修改它的属性。")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "warm" }));
    expect(screen.queryByText("选择一个节点，在这里查看并修改它的属性。")).toBeNull();
    expect(document.querySelector(".flow-inspect-id")?.textContent).toContain("warm");
    expect(document.querySelector(".flow-inspect-id")?.textContent).toContain("flow.wait");
    const ms = screen.getByRole("spinbutton", { name: "属性 ms" }) as HTMLInputElement;
    expect(ms.value).toBe("2000");
    fireEvent.change(ms, { target: { value: "2500" } });
    expect(flowText()).toContain("ms=2500");
    expect((document.querySelector('.react-flow__node[data-id="warm"] .xflow-field input') as HTMLInputElement).value).toBe("2500");

    const title = screen.getByRole("textbox", { name: (name) => name === "显示名" }) as HTMLInputElement;
    expect(title.value).toBe("延时");
    fireEvent.change(title, { target: { value: "等一下" } });
    expect((document.querySelector('.react-flow__node[data-id="warm"] .xflow-title') as HTMLInputElement).value).toBe("等一下");
    expect(document.querySelector(".flow-inspect-title")?.textContent).toBe("等一下");
    expect(flowText()).not.toContain("等一下");

    fireEvent.click(screen.getByRole("checkbox", { name: "warm" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "tap" }));
    const target = screen.getByRole("textbox", { name: "属性 target" }) as HTMLInputElement;
    expect(target.value).toBe("btn.node");
    expect(target.readOnly).toBe(true);
    const before = flowText();
    fireEvent.change(target, { target: { value: "other" } });
    expect(target.value).toBe("btn.node");
    expect(flowText()).toBe(before);

    fireEvent.click(screen.getByRole("checkbox", { name: "tap" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "btn" }));
    const text = screen.getByRole("textbox", { name: "属性 text" }) as HTMLInputElement;
    expect(text.value).toBe("签到");
    fireEvent.change(text, { target: { value: "打卡" } });
    expect(flowText()).toContain('text="打卡"');
    expect(screen.getByRole("list", { name: "输出" }).textContent).toContain("node");
    expect(screen.getByRole("list", { name: "输出" }).textContent).toContain("found");
  });

  it("jumps from a pin reference to that node", () => {
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "tap" }));
    fireEvent.click(screen.getByRole("button", { name: "转到 btn" }));
    expect((screen.getByRole("textbox", { name: "节点文本" }) as HTMLTextAreaElement).value).toContain("node.find");
    expect((screen.getByRole("checkbox", { name: "btn" }) as HTMLInputElement).checked).toBe(true);
  });

  it("toggles the library and resizes the bottom dock", () => {
    expect(clampDock(10)).toBe(120);
    expect(clampDock(900)).toBe(480);
    expect(clampDock(240)).toBe(240);
    render(<FlowPage />);
    const page = document.querySelector(".flow-page");
    expect(page?.getAttribute("data-library")).toBe("auto");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(page?.getAttribute("data-library")).toBe("closed");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(page?.getAttribute("data-library")).toBe("open");
    fireEvent.keyDown(screen.getByRole("button", { name: "底栏" }), { key: "ArrowUp" });
    expect((document.querySelector(".flow-bottom") as HTMLElement).style.height).toBe("256px");
    fireEvent.keyDown(screen.getByRole("button", { name: "底栏" }), { key: "ArrowDown" });
    expect((document.querySelector(".flow-bottom") as HTMLElement).style.height).toBe("240px");
  });

  it("asks for a device before following logs", () => {
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("tab", { name: "轨迹" }));
    fireEvent.click(screen.getByRole("button", { name: "跟随日志" }));
    expect(screen.getByText("还没有连接设备")).toBeTruthy();
  });

  it("keeps an edited cache value for the selected node", () => {
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "btn" }));
    const field = screen.getByRole("textbox", { name: "缓存 btn" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "kept" } });
    expect((screen.getByRole("textbox", { name: "缓存 btn" }) as HTMLInputElement).value).toBe("kept");
  });

  it("records a run from the trace log", () => {
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("tab", { name: "轨迹" }));
    fireEvent.change(screen.getByRole("textbox", { name: "追踪日志" }), {
      target: { value: "\x1fXF\tenter\twarm\t10\n\x1fXF\tspan\twarm\tTrue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "记下运行" }));
    const history = screen.getByRole("list", { name: "运行历史" });
    expect(history.textContent).toContain("warm");
    expect(history.textContent).toContain("success");
  });

  it("edits declared pins on a code node", async () => {
    render(<FlowPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "流程文本" }), {
      target: { value: ["flow box  # xflow 1", "on start:", '  box: code(inPins="name:string", outPins="value:string", source="value = name")', ""].join("\n") },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    fireEvent.click(screen.getByRole("checkbox", { name: "box" }));
    expect((screen.getByRole("textbox", { name: "输入引脚" }) as HTMLInputElement).value).toBe("name:string");
    fireEvent.change(screen.getByRole("textbox", { name: "输出引脚" }), { target: { value: "value:int" } });
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain('outPins="value:int"');
  });

  it("records a description category and run argument on a variable", () => {
    render(<FlowPage />);
    fireEvent.click(screen.getByRole("button", { name: "新建变量" }));
    fireEvent.change(screen.getByRole("textbox", { name: "变量名" }), { target: { value: "score" } });
    fireEvent.change(screen.getByRole("combobox", { name: "变量类型" }), { target: { value: "int" } });
    fireEvent.change(screen.getByRole("textbox", { name: "默认值" }), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("textbox", { name: "说明" }), { target: { value: "当前分数" } });
    fireEvent.change(screen.getByRole("textbox", { name: "分类" }), { target: { value: "计数" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "实例可编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "添加变量" }));
    const text = (screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value;
    expect(text).toContain('var score: int = 1 doc="当前分数" category="计数" editable');
    expect((screen.getByRole("textbox", { name: "运行 score" }) as HTMLInputElement).value).toBe("1");
    fireEvent.change(screen.getByRole("textbox", { name: "运行 score" }), { target: { value: "4" } });
    expect(screen.getByLabelText("本次参数").textContent).toContain('"score":4');
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain("var score: int = 1");
  });

  it("drops a catalog node from the component tree and saves a custom function", () => {
    localStorage.removeItem("xscript.customNodes");
    render(<FlowPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索组件" }), { target: { value: "休眠" } });
    const leaf = screen.getByRole("button", { name: "休眠" });
    const store = new Map<string, string>();
    const data = {
      setData: (type: string, value: string) => {
        store.set(type, value);
      },
      getData: (type: string) => store.get(type) ?? "",
      types: ["application/x-xflow-node"],
      effectAllowed: "copy",
      dropEffect: "copy",
    };
    fireEvent.dragStart(leaf, { dataTransfer: data });
    const pane = document.querySelector(".react-flow");
    expect(pane).toBeTruthy();
    if (!pane) return;
    fireEvent.dragOver(pane, { dataTransfer: data });
    fireEvent.drop(pane, { dataTransfer: data, clientX: 80, clientY: 40 });
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain("action.sleep(");
    fireEvent.change(screen.getByRole("textbox", { name: "组件名" }), { target: { value: "greet" } });
    fireEvent.click(screen.getByRole("button", { name: "自定义函数" }));
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain("def greet():");
    fireEvent.change(screen.getByRole("textbox", { name: "组件名" }), { target: { value: "ping" } });
    fireEvent.click(screen.getByRole("button", { name: "自定义节点" }));
    expect(screen.getByRole("button", { name: "ping" })).toBeTruthy();
  });

  it("inserts a catalog node when its row is clicked", () => {
    render(<FlowPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索组件" }), { target: { value: "休眠" } });
    fireEvent.click(screen.getByRole("button", { name: "休眠" }));
    expect((screen.getByRole("textbox", { name: "流程文本" }) as HTMLTextAreaElement).value).toContain("action.sleep(");
  });
});
