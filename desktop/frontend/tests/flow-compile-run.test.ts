import { describe, expect, it } from "vitest";
import { compile, parse, type FlowGraph } from "../src/flow/dsl";
import { builtinSpecs } from "../src/flow/specs";
import { runFlowPython as run } from "./py-run";

const specs = builtinSpecs();

/** Join two exec chains on a new `done` log, which forces the label/goto state machine. */
function joined(text: string, from: string[]): FlowGraph {
  const graph = parse(text);
  return {
    ...graph,
    nodes: [...graph.nodes, { id: "done", type: "debug.log", inputs: { message: "结束" } }],
    edges: [...graph.edges, ...from.map((id) => ({ from: id + ".then", to: "done.exec" }))],
  };
}

const SIGN_IN = [
  "flow sm  # xflow 1",
  "def greet(name) -> text:",
  "  hl: log(message=name)",
  "  return text=name",
  "on start:",
  '  open: app.open(package="com.x")',
  "  for loop in range(0, 2):",
  "    lp: log(message=loop)",
  '  g: call greet(name="Ada")',
  "  gl: log(message=g)",
  '  btn: node.find(text="签到", timeout=1)',
  "  ok: if btn.found:",
  "    tap: click(target=btn.node)",
  "  else:",
  '    miss: log(message="没找到")',
  "",
].join("\n");

describe("state machine fallback", () => {
  it("lowers calls, defs and closed loops when a join forces it, and runs both paths", () => {
    const graph = joined(SIGN_IN, ["tap", "miss"]);
    const out = compile(graph, specs);
    expect(out.python).toContain("while True:");
    expect(out.python).toContain("def greet(name):");
    expect(out.python).toContain("for loop in range(0, 2):");
    expect(out.python).not.toContain("pc == 'lp'");
    expect(run(out.python, ["签到"])).toEqual(["open com.x", "0", "1", "Ada", "Ada", "click 签到", "结束"]);
    expect(run(out.python)).toEqual(["open com.x", "0", "1", "Ada", "Ada", "没找到", "结束"]);
    const marked = new Set(Object.values(out.lines));
    for (const id of ["open", "loop", "lp", "g", "gl", "btn", "ok", "tap", "miss", "done", "hl"]) expect(marked.has(id)).toBe(true);
  });

  it("emits the same behaviour with trace on", () => {
    const out = compile(joined(SIGN_IN, ["tap", "miss"]), specs, { trace: true });
    const lines = run(out.python, ["签到"]).filter((line) => !line.startsWith("__xf"));
    expect(lines.filter((line) => !line.includes("\t"))).toEqual(["open com.x", "0", "1", "Ada", "Ada", "click 签到", "结束"]);
  });

  it("keeps break inside a lowered loop body", () => {
    const text = [
      "flow brk  # xflow 1",
      "on start:",
      "  for loop in range(0, 5):",
      "    lp: log(message=loop)",
      '    btn: node.find(text="ok", timeout=0)',
      "    hit: if btn.found:",
      "      break",
      "  a: log(message=\"a\")",
      "  hit2: if btn.found:",
      '    b: log(message="b")',
      "  else:",
      '    c: log(message="c")',
      "",
    ].join("\n");
    const out = compile(joined(text, ["b", "c"]), specs);
    expect(out.python).toContain("while True:");
    expect(run(out.python, ["ok"])).toEqual(["0", "a", "b", "结束"]);
    expect(run(out.python)).toEqual(["0", "1", "2", "3", "4", "a", "c", "结束"]);
  });

  it("holds a closed match whole and jumps on completed", () => {
    const text = (mode: string) => [
      "flow m  # xflow 1",
      'var mode: str = "' + mode + '"',
      "on start:",
      "  pick: match mode:",
      '    "签到":',
      '      tap: log(message="签到了")',
      "    _:",
      '      other: log(message="其它")',
      '  after: log(message="after")',
      '  btn: node.find(text="ok", timeout=0)',
      "  hit: if btn.found:",
      '    y: log(message="y")',
      "  else:",
      '    n: log(message="n")',
      "",
    ].join("\n");
    const out = compile(joined(text("签到"), ["y", "n"]), specs);
    expect(out.python).toContain("while True:");
    expect(out.python).toContain("if pick_v == '签到':");
    expect(out.python).not.toContain("pc == 'tap'");
    expect(run(out.python, ["ok"])).toEqual(["签到了", "after", "y", "结束"]);
    expect(run(compile(joined(text("别的"), ["y", "n"]), specs).python)).toEqual(["其它", "after", "n", "结束"]);
  });

  it("holds a closed sequence whole and runs its steps in order before next", () => {
    const text = [
      "flow s  # xflow 1",
      "on start:",
      "  order: seq:",
      "    step:",
      '      a: log(message="a")',
      "    step:",
      '      b: log(message="b")',
      '  btn: node.find(text="ok", timeout=0)',
      "  hit: if btn.found:",
      '    y: log(message="y")',
      "  else:",
      '    n: log(message="n")',
      "",
    ].join("\n");
    const out = compile(joined(text, ["y", "n"]), specs);
    expect(out.python).toContain("while True:");
    expect(out.python).not.toContain("pc == 'b'");
    expect(run(out.python, ["ok"])).toEqual(["a", "b", "y", "结束"]);
    expect(run(out.python)).toEqual(["a", "b", "n", "结束"]);
  });

  it("lowers wait_until: polls, then jumps to then or timeout", () => {
    const text = [
      "flow w  # xflow 1",
      "on start:",
      '  btn: node.find(text="ok", timeout=0)',
      "  hold: until btn.found timeout=600 interval=200:",
      '    y: log(message="ready")',
      "  timeout:",
      '    n: log(message="late")',
      "",
    ].join("\n");
    const out = compile(joined(text, ["y", "n"]), specs);
    expect(out.python).toContain("while True:");
    expect(out.python).toContain("while hold_i < 3:");
    expect(out.python).not.toMatch(/if hold_ok:\n\s+pass/);
    expect(run(out.python, ["ok"])).toEqual(["ready", "结束"]);
    expect(run(out.python)).toEqual(["late", "结束"]);
  });

  it("lowers retry with its closed body: ok after a clean pass, failed after every attempt fails", () => {
    const text = (times: number) => [
      "flow r  # xflow 1",
      "on start:",
      "  r: retry times=" + times + ":",
      '    a: log(message="try")',
      '    btn: node.find(text="ok", timeout=0)',
      "    miss: if btn.found:",
      '      hit: log(message="hit")',
      "    else:",
      "      fail",
      "  ok:",
      '    y: log(message="ok")',
      "  failed:",
      '    n: log(message="failed")',
      "",
    ].join("\n");
    const out = compile(joined(text(2), ["y", "n"]), specs);
    expect(out.python).toContain("while True:");
    expect(out.python).toContain("for r_i in range(2):");
    expect(out.python).not.toContain("pc == 'a'");
    expect(run(out.python, ["ok"])).toEqual(["try", "hit", "ok", "结束"]);
    expect(run(out.python)).toEqual(["try", "try", "failed", "结束"]);
    // a missing outcome ends the flow instead of spinning on the same state
    const one = joined(text(1), ["y"]);
    const bare: FlowGraph = { ...one, edges: one.edges.filter((edge) => edge.from !== "r.failed") };
    expect(run(compile(bare, specs).python)).toEqual(["try"]);
  });

  it("lowers a closed try: the handler catches, then completed", () => {
    const text = [
      "flow t  # xflow 1",
      "on start:",
      '  btn: node.find(text="签到", timeout=0)',
      "  guard: try:",
      "    tap: click(target=btn.node)",
      "  except err:",
      '    msg: log(message="失败")',
      '  after: log(message="继续")',
      "  hit: if btn.found:",
      '    y: log(message="y")',
      "  else:",
      '    n: log(message="n")',
      "",
    ].join("\n");
    const out = compile(joined(text, ["y", "n"]), specs);
    expect(out.python).toContain("while True:");
    expect(out.python).toContain("except Exception as err:");
    expect(out.python).not.toContain("pc == 'msg'");
    expect(run(out.python, ["签到"])).toEqual(["click 签到", "继续", "y", "结束"]);
    expect(run(out.python)).toEqual(["失败", "继续", "n", "结束"]);
  });

  it("lowers closed parallel branches: both run, then joined", () => {
    const text = [
      "flow p  # xflow 1",
      "on start:",
      "  par: parallel:",
      "    branch:",
      '      a: log(message="a")',
      "    branch:",
      '      b: log(message="b")',
      '  btn: node.find(text="ok", timeout=0)',
      "  hit: if btn.found:",
      '    y: log(message="y")',
      "  else:",
      '    n: log(message="n")',
      "",
    ].join("\n");
    const out = compile(joined(text, ["y", "n"]), specs);
    expect(out.python).toContain("while True:");
    expect(out.python).toContain("import threading");
    expect(out.python).toContain("_t.join()");
    const lines = run(out.python, ["ok"]);
    expect(lines.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(lines.slice(2)).toEqual(["y", "结束"]);
  });

  it("refuses a try or parallel branch that jumps out", () => {
    const tryText = ["flow t2  # xflow 1", "on start:", '  a: log(message="a")', "  guard: try:", '    b: log(message="b")', "  except err:", '    c: log(message="c")', ""].join("\n");
    const tryGraph = parse(tryText);
    expect(() => compile({ ...tryGraph, edges: [...tryGraph.edges, { from: "c.then", to: "a.exec" }] }, specs)).toThrow("state machine cannot lower flow.try guard: a branch jumps out of it");
    const parText = ["flow p2  # xflow 1", "on start:", '  a: log(message="a")', "  par: parallel:", "    branch:", '      b: log(message="b")', ""].join("\n");
    const parGraph = parse(parText);
    expect(() => compile({ ...parGraph, edges: [...parGraph.edges, { from: "b.then", to: "a.exec" }] }, specs)).toThrow("state machine cannot lower flow.parallel par: a branch jumps out of it");
  });

  it("refuses a match whose branch jumps back out of it", () => {
    const text = ["flow mo  # xflow 1", 'var mode: str = "x"', "on start:", '  a: log(message="a")', "  pick: match mode:", '    "x":', '      b: log(message="b")', '  z: log(message="z")', ""].join("\n");
    const graph = parse(text);
    const back: FlowGraph = { ...graph, edges: [...graph.edges, { from: "b.then", to: "a.exec" }] };
    expect(() => compile(back, specs)).toThrow("a branch jumps out of it");
  });

  it("refuses a loop whose body jumps out, and a container it cannot hold", () => {
    const text = ["flow out  # xflow 1", "on start:", '  a: log(message="a")', "  for loop in range(0, 2):", '    lp: log(message="x")', '  z: log(message="z")', ""].join("\n");
    const graph = parse(text);
    const back: FlowGraph = { ...graph, edges: [...graph.edges, { from: "lp.then", to: "a.exec" }] };
    expect(() => compile(back, specs)).toThrow("its body jumps out of the loop");
    const retry = parse(["flow r  # xflow 1", "on start:", '  a: log(message="a")', "  retry times=2:", '    b: log(message="b")', ""].join("\n"));
    const looped: FlowGraph = { ...retry, edges: [...retry.edges, { from: "b.then", to: "a.exec" }] };
    expect(() => compile(looped, specs)).toThrow(/state machine cannot lower flow\.retry \w+: its body jumps out of it/);
  });

  it("runs a code node, data.set and a back edge through the state machine", () => {
    const text = [
      "flow c  # xflow 1",
      "var n: int = 0",
      "on start:",
      '  box: code(inPins="v:int", v=get(name="n"), outPins="next:int, more:bool", source="next = v + 1\\nmore = next < 3")',
      "  s: set(name=\"n\", value=box.next)",
      '  show: log(message=get(name="n"))',
      "  again: if box.more:",
      '    noop: log(message="loop")',
      "",
    ].join("\n");
    const graph = parse(text);
    const back: FlowGraph = { ...graph, edges: [...graph.edges, { from: "noop.then", to: "box.exec" }] };
    const out = compile(back, specs);
    expect(out.python).toContain("while True:");
    expect(out.python).toContain("if box[1]:");
    expect(run(out.python)).toEqual(["1", "loop", "2", "loop", "3"]);
  });
});

describe("condition expressions", () => {
  it("reads a multi-output code pin and a variable as conditions", () => {
    const code = parse([
      "flow c  # xflow 1",
      "on start:",
      '  box: code(outPins="hit:node?, found:bool", source="hit = None\\nfound = True")',
      "  ok: if box.found:",
      '    y: log(message="yes")',
      "",
    ].join("\n"));
    const py = compile(code, specs).python;
    expect(py).toContain("if box[1]:");
    expect(run(py)).toEqual(["yes"]);

    const variable: FlowGraph = {
      xflow: 1,
      name: "v",
      variables: [{ name: "flag", type: "bool", default: true }],
      nodes: [
        { id: "start", type: "event.start" },
        { id: "f", type: "data.get", inputs: { name: "flag" } },
        { id: "ok", type: "flow.branch" },
        { id: "y", type: "debug.log", inputs: { message: "on" } },
      ],
      edges: [
        { from: "start.then", to: "ok.exec" },
        { from: "f.value", to: "ok.cond" },
        { from: "ok.then", to: "y.exec" },
      ],
    };
    const vpy = compile(variable, specs).python;
    expect(vpy).toContain("if flag:");
    expect(run(vpy)).toEqual(["on"]);
  });

  it("names a loop variable after its node when wired from the spec pin", () => {
    const graph = parse(["flow l  # xflow 1", "on start:", "  for loop in range(0, 2):", "    lp: log(message=loop)", '  items: code(outPins="xs:list", source="xs = [5, 6]")', "  for each in items.xs:", "    le: log(message=each)", ""].join("\n"));
    const respec: FlowGraph = {
      ...graph,
      edges: graph.edges.map((edge) => (edge.from === "loop.result" ? { ...edge, from: "loop.index" } : edge.from === "each.result" ? { ...edge, from: "each.item" } : edge)),
    };
    expect(respec.edges.some((edge) => edge.from === "loop.index")).toBe(true);
    expect(respec.edges.some((edge) => edge.from === "each.item")).toBe(true);
    const py = compile(respec, specs).python;
    expect(py).not.toContain("loop.index");
    expect(run(py)).toEqual(["0", "1", "5", "6"]);
  });

  it("writes pass for an empty arm and runs the other one", () => {
    const graph: FlowGraph = {
      xflow: 1,
      name: "arm",
      nodes: [
        { id: "start", type: "event.start" },
        { id: "btn", type: "node.find", inputs: { text: "x", timeout: 0 } },
        { id: "ok", type: "flow.branch" },
        { id: "no", type: "debug.log", inputs: { message: "none" } },
      ],
      edges: [
        { from: "start.then", to: "btn.exec" },
        { from: "btn.then", to: "ok.exec" },
        { from: "btn.found", to: "ok.cond" },
        { from: "ok.else", to: "no.exec" },
      ],
    };
    const py = compile(graph, specs).python;
    expect(py).toContain("    pass");
    expect(run(py)).toEqual(["none"]);
    expect(run(py, ["x"])).toEqual([]);
  });
});
