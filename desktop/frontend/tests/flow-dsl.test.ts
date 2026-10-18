import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diagnose } from "../src/flow/diagnostics";
import { compile, createDslSync, danglingEdges, fillStmt, foldGraph, mergeFlow, parse, printFlow, promoteFunction, pyIdent, pyRepr, semanticKey, snippetFlow, unfoldGraph, type FlowGraph, type NodeSpec } from "../src/flow/dsl";
import { insertGet, runPayload, variableRows } from "../src/flow/variables";

function loadSpecs(): Map<string, NodeSpec> {
  const specs = new Map<string, NodeSpec>();
  for (const name of readdirSync("../nodes/builtin")) {
    if (!name.endsWith(".json")) continue;
    const spec = JSON.parse(readFileSync("../nodes/builtin/" + name, "utf8")) as NodeSpec;
    specs.set(spec.type, spec);
  }
  return specs;
}

const specs = loadSpecs();

const goldenText = readFileSync("../schema/golden/daily_signin.xflow", "utf8");
const goldenPy = readFileSync("../schema/golden/daily_signin.py", "utf8");
const goldenGraph = JSON.parse(readFileSync("../schema/examples/daily_signin.xflow.json", "utf8")) as FlowGraph;

function compileAll(sources: string[]): void {
  execFileSync("python3", ["-c", "import ast,sys\nfor part in sys.stdin.read().split('\\n# ---SPLIT---\\n'):\n    ast.parse(part)\n"], {
    input: sources.join("\n# ---SPLIT---\n"),
  });
}

describe("flow DSL golden", () => {
  it("prints the sign-in graph as the design's DSL and parses it back", () => {
    expect(printFlow(goldenGraph)).toBe(goldenText);
    expect(semanticKey(parse(goldenText))).toBe(semanticKey(goldenGraph));
    expect(printFlow(parse(goldenText))).toBe(goldenText);
  });

  it("compiles the sign-in graph to the design's Python and a matching source map", () => {
    const out = compile(goldenGraph, specs);
    expect(out.python).toBe(goldenPy);
    expect(out.lines).toEqual({
      "4": "open",
      "5": "warm",
      "6": "attempt",
      "7": "btn",
      "8": "ok",
      "9": "tap",
      "10": "msg",
      "11": "msg(break)",
      "12": "ok(else)",
      "13": "retry",
      "14": "done",
    });
    compileAll([out.python]);
  });

  it("round-trips the same graph after the else branch is removed", () => {
    const graph: FlowGraph = {
      ...goldenGraph,
      nodes: goldenGraph.nodes.filter((n) => n.id !== "retry"),
      edges: goldenGraph.edges.filter((e) => e.from !== "ok.else" && !e.from.startsWith("retry.")),
    };
    const text = printFlow(graph);
    expect(text).not.toContain("else:");
    expect(semanticKey(parse(text))).toBe(semanticKey(graph));
    expect(printFlow(parse(text))).toBe(text);
    compileAll([compile(graph, specs).python]);
  });

  it("keeps an unconnected node under floating", () => {
    const graph: FlowGraph = {
      ...goldenGraph,
      nodes: [...goldenGraph.nodes, { id: "note", type: "debug.log", inputs: { message: "旁路" } }],
    };
    const text = printFlow(graph);
    expect(text).toContain("floating:\n  note: log(message=\"旁路\")\n");
    expect(semanticKey(parse(text))).toBe(semanticKey(graph));
  });
});

describe("control flow added from the design", () => {
  it("round-trips variables, a secret env name, and a node comment", () => {
    const text = ['flow c  # xflow 1', "var tries: int = 3", "env token secret", "on start:", '  msg: log(message="hi")  # 打招呼', ""].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    expect(py).toContain("tries = 3");
    expect(py).toContain("__import__('os').environ['token']");
    expect(py).not.toContain("secret-value");
    compileAll([py]);
  });

  it("round-trips an iteration and compiles it as a for statement", () => {
    const text = ["flow walk  # xflow 1", "on start:", '  btn: node.find(text="行", timeout=1)', "  for item in btn.node:", '    msg: log(message="x")', ""].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    expect(py).toContain("for item in btn:");
    compileAll([py]);
  });

  it("round-trips try and except and compiles them", () => {
    const text = [
      "flow guard  # xflow 1",
      "on start:",
      '  btn: node.find(text="签到", timeout=1)',
      "  guard: try:",
      "    tap: click(target=btn.node)",
      "  except err:",
      '    msg: log(message="失败")',
      '  done: log(message="继续")',
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    expect(py).toContain("try:");
    expect(py).toContain("except Exception as err:");
    expect(py).toContain("print('继续')");
    compileAll([py]);
  });

  it("round-trips parallel branches and compiles a thread join", () => {
    const text = [
      "flow p  # xflow 1",
      "on start:",
      "  par: parallel:",
      "    branch:",
      '      a: log(message="a")',
      "    branch:",
      '      b: log(message="b")',
      '  done: log(message="done")',
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    expect(py).toContain("import threading");
    expect(py).toContain("_t.start()");
    expect(py).toContain("_t.join()");
    expect(py).toContain("print('done')");
    compileAll([py]);
  });

  it("round-trips a sequence and runs the steps in order", () => {
    const text = [
      "flow s  # xflow 1",
      "on start:",
      "  order: seq:",
      "    step:",
      '      a: log(message="a")',
      "    step:",
      '      b: log(message="b")',
      '  done: log(message="done")',
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    expect(py).not.toContain("threading");
    const first = py.indexOf("print('a')");
    const second = py.indexOf("print('b')");
    const after = py.indexOf("print('done')");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(after);
    compileAll([py]);
  });

  it("asserts a nullable value and substitutes a default", () => {
    const mustText = [
      "flow guard  # xflow 1",
      "on start:",
      '  btn: node.find(text="a")',
      "  keep: must(value=btn.node)",
      '  use: log(message=keep)',
      "",
    ].join("\n");
    expect(printFlow(parse(mustText))).toBe(mustText);
    const mustPy = compile(parse(mustText), specs).python;
    expect(mustPy).toContain("assert keep is not None");
    compileAll([mustPy]);
    const defaultText = [
      "flow fill  # xflow 1",
      "on start:",
      '  btn: node.find(text="a")',
      '  keep: default(fallback="none", value=btn.node)',
      '  use: log(message=keep)',
      "",
    ].join("\n");
    expect(printFlow(parse(defaultText))).toBe(defaultText);
    const defaultPy = compile(parse(defaultText), specs).python;
    expect(defaultPy).toContain("if btn is not None else 'none'");
    compileAll([defaultPy]);
  });

  it("inlines arithmetic, logic, and string joins", () => {
    const calc = ["flow calc  # xflow 1", "on start:", "  msg: log(message=sub(a=5, b=3))", ""].join("\n");
    expect(printFlow(parse(calc))).toBe(calc);
    expect(compile(parse(calc), specs).python).toContain("(5 - 3)");
    const bits = ["flow bits  # xflow 1", "on start:", "  msg: log(message=and(a=1, b=not(a=0)))", ""].join("\n");
    expect(printFlow(parse(bits))).toBe(bits);
    expect(compile(parse(bits), specs).python).toContain("(1 and (not 0))");
    const words = ["flow words  # xflow 1", "on start:", '  msg: log(message=concat(a="a", b="b"))', ""].join("\n");
    expect(printFlow(parse(words))).toBe(words);
    expect(compile(parse(words), specs).python).toContain("str('a') + str('b')");
    compileAll([compile(parse(calc), specs).python, compile(parse(bits), specs).python, compile(parse(words), specs).python]);
  });

  it("inlines floor, random, clamp, and string tools", () => {
    const floorText = ["flow cut  # xflow 1", "on start:", "  msg: log(message=floor(a=3.7))", ""].join("\n");
    expect(printFlow(parse(floorText))).toBe(floorText);
    const floorPy = compile(parse(floorText), specs).python;
    expect(floorPy).toContain("import math");
    expect(floorPy).toContain("math.floor(3.7)");
    const roll = ["flow roll  # xflow 1", "on start:", "  msg: log(message=random())", ""].join("\n");
    expect(printFlow(parse(roll))).toBe(roll);
    const rollPy = compile(parse(roll), specs).python;
    expect(rollPy).toContain("import random");
    expect(rollPy).toContain("random.random()");
    const tools = ["flow tools  # xflow 1", "on start:", '  msg: log(message=contains(a="abc", part="b"))', ""].join("\n");
    expect(printFlow(parse(tools))).toBe(tools);
    expect(compile(parse(tools), specs).python).toContain("('b' in str('abc'))");
    const sliced = ["flow part  # xflow 1", "on start:", '  msg: log(message=slice(a="abcd", end=3, start=1))', ""].join("\n");
    expect(printFlow(parse(sliced))).toBe(sliced);
    expect(compile(parse(sliced), specs).python).toContain("str('abcd')[1:3]");
    const bounded = ["flow bound  # xflow 1", "on start:", "  msg: log(message=clamp(a=1, high=9, low=0))", ""].join("\n");
    expect(printFlow(parse(bounded))).toBe(bounded);
    expect(compile(parse(bounded), specs).python).toContain("min(max(1, 0), 9)");
    const swapped = ["flow swap  # xflow 1", "on start:", '  msg: log(message=replace(a="ab", new="c", old="a"))', ""].join("\n");
    expect(printFlow(parse(swapped))).toBe(swapped);
    expect(compile(parse(swapped), specs).python).toContain("str('ab').replace(str('a'), str('c'))");
    const sized = ["flow sized  # xflow 1", "on start:", '  msg: log(message=len(a="ab"))', ""].join("\n");
    expect(printFlow(parse(sized))).toBe(sized);
    expect(compile(parse(sized), specs).python).toContain("len('ab')");
    const matched = ["flow pat  # xflow 1", "on start:", '  msg: log(message=regex(a="abc", pattern="a."))', ""].join("\n");
    expect(printFlow(parse(matched))).toBe(matched);
    const matchedPy = compile(parse(matched), specs).python;
    expect(matchedPy).toContain("import re");
    expect(matchedPy).toContain("re.search('a.', str('abc'))");
    compileAll([floorPy, rollPy, compile(parse(tools), specs).python, compile(parse(sliced), specs).python, compile(parse(bounded), specs).python, compile(parse(swapped), specs).python, compile(parse(sized), specs).python, matchedPy]);
  });

  it("inlines list, dict, json, and time values", () => {
    const item = ["flow item  # xflow 1", "on start:", '  msg: log(message=at(a="ab", index=0))', ""].join("\n");
    expect(printFlow(parse(item))).toBe(item);
    expect(compile(parse(item), specs).python).toContain("list('ab')[0]");
    const added = ["flow added  # xflow 1", "on start:", '  msg: log(message=push(a="ab", item="c"))', ""].join("\n");
    expect(printFlow(parse(added))).toBe(added);
    expect(compile(parse(added), specs).python).toContain("list('ab') + ['c']");
    const ordered = ["flow ordered  # xflow 1", "on start:", '  msg: log(message=sort(a="bac"))', ""].join("\n");
    expect(printFlow(parse(ordered))).toBe(ordered);
    expect(compile(parse(ordered), specs).python).toContain("sorted(list('bac'))");
    const parsed = ["flow parsed  # xflow 1", "on start:", '  msg: log(message=parse(a="{}"))', ""].join("\n");
    expect(printFlow(parse(parsed))).toBe(parsed);
    const parsedPy = compile(parse(parsed), specs).python;
    expect(parsedPy).toContain("import json");
    expect(parsedPy).toContain("json.loads('{}')");
    const clock = ["flow clock  # xflow 1", "on start:", "  msg: log(message=now())", ""].join("\n");
    expect(printFlow(parse(clock))).toBe(clock);
    const clockPy = compile(parse(clock), specs).python;
    expect(clockPy).toContain("import time");
    expect(clockPy).toContain("time.time()");
    const gap = ["flow gap  # xflow 1", "on start:", "  msg: log(message=elapsed(a=5, b=2))", ""].join("\n");
    expect(printFlow(parse(gap))).toBe(gap);
    expect(compile(parse(gap), specs).python).toContain("(5 - 2)");
    compileAll([compile(parse(item), specs).python, compile(parse(added), specs).python, compile(parse(ordered), specs).python, parsedPy, clockPy, compile(parse(gap), specs).python]);
  });

  it("inlines a list filter and a list map", () => {
    const kept = ["flow kept  # xflow 1", "on start:", '  msg: log(message=filter(a="ab", item="a"))', ""].join("\n");
    expect(printFlow(parse(kept))).toBe(kept);
    expect(compile(parse(kept), specs).python).toContain("if x == 'a'");
    const mapped = ["flow mapped  # xflow 1", "on start:", '  msg: log(message=map(a="ab", op="str"))', ""].join("\n");
    expect(printFlow(parse(mapped))).toBe(mapped);
    const mappedPy = compile(parse(mapped), specs).python;
    expect(mappedPy).toContain("['str'](x)");
    expect(mappedPy).toContain("list('ab')");
    compileAll([compile(parse(kept), specs).python, mappedPy]);
  });

  it("prints a back edge as label and goto and compiles a state machine", () => {
    const graph: FlowGraph = {
      xflow: 1,
      name: "loop",
      nodes: [
        { id: "start", type: "event.start" },
        { id: "a", type: "debug.log", inputs: { message: "a" } },
        { id: "b", type: "debug.log", inputs: { message: "b" } },
      ],
      edges: [
        { from: "start.then", to: "a.exec" },
        { from: "a.then", to: "b.exec" },
        { from: "b.then", to: "a.exec" },
      ],
    };
    const text = printFlow(graph);
    expect(text).toContain("label a:");
    expect(text).toContain("goto a");
    expect(semanticKey(parse(text))).toBe(semanticKey(graph));
    const py = compile(graph, specs).python;
    expect(py).toContain("while True:");
    expect(py).toContain("pc = 'a'");
    compileAll([py]);
  });

  it("folds two nodes into code and unfolds them when the source is unchanged", () => {
    const text = ["flow f  # xflow 1", "on start:", '  a: log(message="a")', '  b: log(message="b")', '  done: log(message="done")', ""].join("\n");
    const graph = parse(text);
    const folded = foldGraph(graph, ["a", "b"], "box", specs);
    expect(folded.nodes.map((node) => node.id).sort()).toEqual(["box", "done", "start"]);
    const box = folded.nodes.find((node) => node.id === "box");
    expect(box?.config?.source).toBe("print('a')\nprint('b')");
    const restored = unfoldGraph(folded, "box", specs);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(semanticKey(restored.graph)).toBe(semanticKey(graph));
    const edited = {
      ...folded,
      nodes: folded.nodes.map((node) => (node.id === "box" ? { ...node, config: { source: "print('changed')" } } : node)),
    };
    expect(unfoldGraph(edited, "box", specs)).toEqual({ ok: false, reason: "edited" });
    const py = compile(folded, specs).python;
    expect(py).toContain("def _code_box():");
    expect(py).toContain("print('a')");
    expect(py).toContain("print('done')");
    compileAll([py]);
  });

  it("inlines a nested add and hoists a let", () => {
    const nested = ["flow f  # xflow 1", "on start:", "  msg: log(message=add(a=1, b=2))", ""].join("\n");
    expect(printFlow(parse(nested))).toBe(nested);
    expect(compile(parse(nested), specs).python).toContain("print((1 + 2))");
    const named = [
      "flow f  # xflow 1",
      "on start:",
      "  let total = add(a=1, b=2)",
      "  msg: log(message=total)",
      "  msg2: log(message=total)",
      "",
    ].join("\n");
    expect(printFlow(parse(named))).toBe(named);
    const py = compile(parse(named), specs).python;
    expect(py).toContain("total = (1 + 2)");
    expect(py.match(/total = /g)?.length).toBe(1);
    compileAll([compile(parse(nested), specs).python, py]);
  });

  it("inlines a macro at the call", () => {
    const text = [
      "flow f  # xflow 1",
      "macro greet(name) -> text:",
      "  msg: log(message=name)",
      "  return text=name",
      "on start:",
      '  c: call greet(name="Ada")',
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    expect(py).not.toContain("def greet");
    expect(py).toContain("print('Ada')");
    expect(py).toContain("c = 'Ada'");
    compileAll([py]);
  });

  it("round-trips a subflow and compiles it as a function", () => {
    const text = [
      "flow f  # xflow 1",
      "def greet(name) -> text:",
      "  msg: log(message=name)",
      "  return text=name",
      "on start:",
      '  c: call greet(name="Ada")',
      '  done: log(message="ok")',
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    expect(py).toContain("def greet(name):");
    expect(py).toContain("print(name)");
    expect(py).toContain("return name");
    expect(py).toContain("c = greet('Ada')");
    compileAll([py]);
    const file = promoteFunction(parse(text), "greet");
    expect(file).toContain("flow greet  # xflow 1");
    expect(file).toContain("def greet(name) -> text:");
    expect(file).toContain('call greet(name="")');
    expect(file).not.toContain('name="Ada"');
    const promoted = compile(parse(file ?? ""), specs).python;
    expect(promoted).toContain("def greet(name):");
    expect(promoted).toContain("greet('')");
    compileAll([promoted]);
  });

  it("round-trips a match and compiles if elif else", () => {
    const text = [
      "flow f  # xflow 1",
      "on start:",
      '  btn: node.find(text="签到", timeout=1)',
      "  pick: match btn.text:",
      '    "签到":',
      "      tap: click(target=btn.node)",
      '    "关闭":',
      '      msg: log(message="关")',
      "    _:",
      '      other: log(message="其它")',
      '  done: log(message="结束")',
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    expect(py).toContain("pick_v = btn.text");
    expect(py).toContain("if pick_v == '签到':");
    expect(py).toContain("elif pick_v == '关闭':");
    expect(py).toContain("else:");
    expect(py).toContain("print('结束')");
    compileAll([py]);
  });

  it("prints a join after a branch as label and goto", () => {
    const graph: FlowGraph = {
      xflow: 1,
      name: "join",
      nodes: [
        { id: "start", type: "event.start" },
        { id: "btn", type: "node.find", inputs: { text: "签到", timeout: 1 } },
        { id: "ok", type: "flow.branch" },
        { id: "a", type: "debug.log", inputs: { message: "a" } },
        { id: "b", type: "debug.log", inputs: { message: "b" } },
        { id: "done", type: "debug.log", inputs: { message: "done" } },
      ],
      edges: [
        { from: "start.then", to: "btn.exec" },
        { from: "btn.then", to: "ok.exec" },
        { from: "btn.found", to: "ok.cond" },
        { from: "ok.then", to: "a.exec" },
        { from: "ok.else", to: "b.exec" },
        { from: "a.then", to: "done.exec" },
        { from: "b.then", to: "done.exec" },
      ],
    };
    const text = printFlow(graph);
    expect(text).toContain("label done:");
    expect(semanticKey(parse(text))).toBe(semanticKey(graph));
    compileAll([compile(graph, specs).python]);
  });

  it("picks the first present branch value", () => {
    const text = [
      "flow pick  # xflow 1",
      "on start:",
      "  yes: node.find(text=\"签到\", timeout=1)",
      "  pick: merge(a=yes.node)",
      "  done: log(message=pick.value)",
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const straight = compile(parse(text), specs).python;
    expect(straight).toContain("yes = node.Selector().text('签到').find(timeout=1)");
    expect(straight).toContain("pick = _xf_pick(lambda: yes)");
    expect(straight).toContain("print(pick)");
    const graph: FlowGraph = {
      xflow: 1,
      name: "join",
      nodes: [
        { id: "start", type: "event.start" },
        { id: "btn", type: "node.find", inputs: { text: "签到", timeout: 1 } },
        { id: "ok", type: "flow.branch" },
        { id: "yes", type: "node.find", inputs: { text: "有", timeout: 1 } },
        { id: "no", type: "node.find", inputs: { text: "无", timeout: 1 } },
        { id: "pick", type: "flow.merge" },
        { id: "done", type: "debug.log" },
      ],
      edges: [
        { from: "start.then", to: "btn.exec" },
        { from: "btn.then", to: "ok.exec" },
        { from: "btn.found", to: "ok.cond" },
        { from: "ok.then", to: "yes.exec" },
        { from: "ok.else", to: "no.exec" },
        { from: "yes.then", to: "pick.exec" },
        { from: "no.then", to: "pick.exec" },
        { from: "yes.node", to: "pick.a" },
        { from: "no.node", to: "pick.b" },
        { from: "pick.then", to: "done.exec" },
        { from: "pick.value", to: "done.message" },
      ],
    };
    const printed = printFlow(graph);
    expect(printed).toContain("merge(a=yes.node, b=no.node)");
    expect(semanticKey(parse(printed))).toBe(semanticKey(graph));
    const joined = compile(graph, specs).python;
    expect(joined).toContain("pick = _xf_pick(lambda: yes, lambda: no)");
    expect(joined).toContain("print(pick)");
    const fn = straight.slice(straight.indexOf("def _xf_pick"), straight.indexOf("return None", straight.indexOf("def _xf_pick")) + "return None".length);
    execFileSync("python3", ["-c", fn + `
assert _xf_pick(lambda: 0, lambda: 1) == 0
assert _xf_pick(lambda: None, lambda: "b") == "b"
assert _xf_pick(lambda: False, lambda: True) is False
def missing():
    raise NameError("yes")
assert _xf_pick(missing, lambda: "no") == "no"
assert _xf_pick(missing, lambda: None) is None
`]);
    compileAll([straight, joined]);
  });
});

describe("edit sync and trace budget", () => {
  it("omits automatic labels in export and keeps them while editing", () => {
    const text = ["flow f  # xflow 1", "on start:", '  log(message="a")', ""].join("\n");
    const graph = parse(text);
    expect(printFlow(graph)).toBe(text);
    const edit = printFlow(graph, { mode: "edit" });
    expect(edit).toContain('n1: log(message="a")');
    expect(semanticKey(parse(edit))).toBe(semanticKey(graph));
    const sync = createDslSync(graph);
    const printed = sync.fromCanvas(graph);
    expect(printed.applied).toBe(true);
    expect(sync.fromText(printed.text).applied).toBe(false);
    const bad = sync.fromText("not a flow");
    expect(bad.applied).toBe(false);
    expect(bad.error).toContain("flow header");
    expect(semanticKey(bad.graph)).toBe(semanticKey(graph));
  });

  it("emits a token bucket and keeps the deploy compile unchanged", () => {
    expect(compile(goldenGraph, specs).python).toBe(goldenPy);
    const py = compile(goldenGraph, specs, { trace: true }).python;
    expect(py).toContain("def __xf_trace(kind, nid, value=\"\"):");
    expect(py).toContain('    __xf_trace("enter", "btn")\n    btn = node.Selector().text(\'签到\').find(timeout=3)\n    __xf_trace("span", "btn", btn is not None)');
    const start = py.indexOf("import time as _xf_time");
    const end = py.indexOf("\n\n", py.indexOf("def __xf_trace"));
    const driver = py.slice(start, end) + `
lines = []
def print(*args, **kwargs):
    lines.append(args[0])
_xf_time.monotonic = lambda: 0.0
for i in range(1000):
    __xf_trace("span", "id%d" % i, "x")
if len(lines) != 200:
    raise SystemExit("burst %s" % len(lines))
lines[:] = []
_xf_tokens = 200.0
_xf_loops.clear()
for i in range(30):
    __xf_trace("span", "same", "x" * 100)
if len(lines) != 3:
    raise SystemExit("loop %s" % len(lines))
if len(lines[0].split("\\t")[-1]) > 80:
    raise SystemExit("width")
`;
    execFileSync("python3", ["-c", driver]);
    compileAll([py]);
  });
});

describe("paste merge", () => {
  it("renames ids that already exist and marks refs from outside the snippet", () => {
    const base = parse(goldenText);
    const incoming = parse('flow extra  # xflow 1\non start:\n  open: log(message="又一次")\n');
    const merged = mergeFlow(base, incoming);
    expect(merged.nodes.some((node) => node.id === "open_2")).toBe(true);
    expect(printFlow(merged)).toContain('open_2: log(message="又一次")');
    const fragment: FlowGraph = {
      xflow: 1,
      name: "part",
      nodes: [
        { id: "start", type: "event.start" },
        { id: "tap", type: "action.click" },
      ],
      edges: [
        { from: "start.then", to: "tap.exec" },
        { from: "btn.node", to: "tap.target" },
      ],
    };
    const host = parse('flow host  # xflow 1\non start:\n  done: log(message="ok")\n');
    const pasted = mergeFlow(host, fragment);
    expect(danglingEdges(pasted).map((edge) => edge.from)).toContain("dangling__btn.node");
    const snippet = snippetFlow(base, ["open", "warm"]);
    expect(printFlow(snippet)).toContain("open: app.open");
    expect(printFlow(snippet)).toContain("warm: wait");
    expect(printFlow(snippet)).not.toContain("done:");
  });
});

describe("while loops", () => {
  it("round-trips a capped while and compiles it to a bounded Python loop", () => {
    const text = [
      "flow keep  # xflow 1",
      "on start:",
      "  btn: node.find(text=\"签到\", timeout=3)",
      "  loop: while btn.found max=5:",
      "    tap: click(target=btn.node)",
      "    break",
      "  done: log(message=\"结束\")",
      "",
    ].join("\n");
    const graph = parse(text);
    expect(printFlow(graph)).toBe(text);
    const py = compile(graph, specs).python;
    expect(py).toContain("loop_i = 0");
    expect(py).toContain("while loop_i < 5:");
    expect(py).toContain("if btn is None:");
    expect(py).toContain("btn.click()");
    expect(py).toContain("break");
    expect(py).toContain("print('结束')");
    compileAll([py]);
  });

  it("continues a counted loop and skips the rest of the body", () => {
    const text = [
      "flow skip  # xflow 1",
      "on start:",
      "  for i in range(0, 3):",
      '    a: log(message="a")',
      "    continue",
      '  done: log(message="done")',
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    const loop = py.indexOf("for i in range(0, 3):");
    const again = py.indexOf("continue");
    const after = py.indexOf("print('done')");
    expect(loop).toBeGreaterThanOrEqual(0);
    expect(loop).toBeLessThan(again);
    expect(again).toBeLessThan(after);
    compileAll([py]);
  });

  it("polls until a condition holds and takes the timeout branch", () => {
    const text = [
      "flow hold  # xflow 1",
      "on start:",
      "  btn: node.find(text=\"签到\", timeout=3)",
      "  hold: until btn.found timeout=3000 interval=200:",
      "    ready: log(message=\"ready\")",
      "  timeout:",
      "    late: log(message=\"late\")",
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    expect(py).toContain("while hold_i < 15:");
    expect(py).toContain("if (btn is not None):");
    expect(py).toContain("action.sleep(0.2)");
    const ready = py.indexOf("print('ready')");
    const late = py.indexOf("print('late')");
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(ready).toBeLessThan(late);
    compileAll([py]);
  });

  it("retries a body until it finishes without fail", () => {
    const text = [
      "flow again  # xflow 1",
      "on start:",
      "  r: retry times=3:",
      "    a: log(message=\"try\")",
      "    fail",
      "  ok:",
      "    ready: log(message=\"ok\")",
      "  failed:",
      "    late: log(message=\"late\")",
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    expect(py).toContain("for r_i in range(3):");
    expect(py).toContain("continue");
    const tried = py.indexOf("print('try')");
    const ready = py.indexOf("print('ok')");
    const late = py.indexOf("print('late')");
    expect(tried).toBeGreaterThanOrEqual(0);
    expect(tried).toBeLessThan(ready);
    expect(ready).toBeLessThan(late);
    compileAll([py]);
  });

  it("stops the script at an end node", () => {
    const text = [
      "flow stop  # xflow 1",
      "on start:",
      "  a: log(message=\"bye\")",
      "  done: end(code=0)",
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    const said = py.indexOf("print('bye')");
    const stopped = py.indexOf("raise SystemExit(0)");
    expect(said).toBeGreaterThanOrEqual(0);
    expect(said).toBeLessThan(stopped);
    const bare = ["flow stop  # xflow 1", "on start:", "  done: end()", ""].join("\n");
    expect(printFlow(parse(bare))).toBe(bare);
    expect(compile(parse(bare), specs).python).toContain("raise SystemExit(0)");
    compileAll([py, compile(parse(bare), specs).python]);
  });

  it("compiles a code node from declared pins", () => {
    const text = [
      "flow box  # xflow 1",
      "on start:",
      "  box: code(inPins=\"name:string\", name=\"Ada\", outPins=\"value:string\", source=\"value = name\")",
      "  msg: log(message=box.value)",
      "",
    ].join("\n");
    expect(printFlow(parse(text))).toBe(text);
    const py = compile(parse(text), specs).python;
    expect(py).toContain("def _code_box(name):");
    expect(py).toContain("value = name");
    expect(py).toContain("return value");
    expect(py).toContain("box = _code_box('Ada')");
    expect(py).toContain("print(box)");
    compileAll([py]);
    expect(diagnose(parse(text), undefined, specs).some((item) => item.code.startsWith("E20"))).toBe(false);
    const wrong = text.replace('name="Ada"', "name=1");
    expect(diagnose(parse(wrong), undefined, specs).some((item) => item.code === "E201")).toBe(true);
  });
});

describe("generated call templates", () => {
  it("fills a generated swipe call and a pin named node", () => {
    const swipe = JSON.parse(readFileSync("../nodes/generated/action.swipe.json", "utf8")) as NodeSpec;
    const empty: FlowGraph = { xflow: 1, name: "g", nodes: [], edges: [] };
    expect(
      fillStmt(swipe.py!.stmt, { id: "sw", type: "action.swipe", inputs: { x1: 1, y1: 2, x2: 3, y2: 4 } }, empty, { dur: 300 }),
    ).toBe("sw = action.swipe(1, y1=2, x2=3, y2=4, dur=300)");
    const within = JSON.parse(readFileSync("../nodes/generated/node.Selector.within.json", "utf8")) as NodeSpec;
    const linked: FlowGraph = {
      xflow: 1,
      name: "g",
      nodes: [
        { id: "box", type: "node.find" },
        { id: "hit", type: "node.Selector.within" },
      ],
      edges: [{ from: "box.node", to: "hit.node" }],
    };
    expect(fillStmt(within.py!.stmt, { id: "hit", type: "node.Selector.within" }, linked)).toBe("hit = node.Selector.within(box)");
  });
});

describe("variables", () => {
  it("compiles a flow variable read and write and keeps the env value out", () => {
    const specs = loadSpecs();
    const graph = parse('flow demo  # xflow 1\nvar score: int = 1\nenv TOKEN secret\non start:\n  log(message=get(name="score"))\n  set(name="score", value=2)\n');
    const python = compile(graph, specs).python;
    expect(python).toContain("score = 1");
    expect(python).toContain("TOKEN = __import__('os').environ['TOKEN']");
    expect(python).toContain("print(score)");
    expect(python).toContain("score = 2");
    expect(python).not.toContain("secret");
    expect(printFlow(graph)).toContain("env TOKEN secret");
  });

  it("compiles a project parameter and a function local", () => {
    const source = ["flow demo  # xflow 1", "param retries: int = 3", "def greet(name):", "  local n: int = 0", "on start:", '  log(message="x")', ""].join("\n");
    const graph = parse(source);
    expect(printFlow(graph)).toBe(source);
    const python = compile(graph, loadSpecs()).python;
    expect(python).toContain("retries = system.params().get('retries', 3)");
    expect(python).toContain("def greet(name):");
    expect(python).toContain("    n = 0");
    expect(variableRows(graph).some((row) => row.kind === "param" && row.name === "retries" && !row.writable)).toBe(true);
    expect(variableRows(graph).some((row) => row.kind === "local" && row.name === "n" && row.detail === "greet")).toBe(true);
    expect(variableRows(graph).some((row) => row.kind === "local" && row.name === "name")).toBe(true);
  });

  it("keeps a variable description category and run argument", () => {
    const source = [
      "flow demo  # xflow 1",
      'var score: int = 1 doc="当前分数" category="计数" editable',
      "on start:",
      '  log(message="x")',
      "",
    ].join("\n");
    const graph = parse(source);
    expect(printFlow(graph)).toBe(source);
    expect(graph.variables?.[0]?.doc).toBe("当前分数");
    expect(graph.variables?.[0]?.category).toBe("计数");
    expect(compile(graph, loadSpecs()).python).toContain("score = system.params().get('score', 1)");
    expect(runPayload(graph, { score: "4" }).score).toBe(4);
    expect(runPayload(graph, {}).score).toBe(1);
    expect(variableRows(graph).some((row) => row.editable && row.category === "计数" && row.doc === "当前分数")).toBe(true);
  });

  it("prints a get node added onto the sign-in graph", () => {
    const base = parse(readFileSync("../schema/golden/daily_signin.xflow", "utf8"));
    const next = insertGet(base, "score");
    expect(printFlow(next, { mode: "edit" })).toContain("get(");
  });
});

describe("flow DSL structured random graphs", () => {
  it("round-trips 3000 nested if/for flows and their Python parses", () => {
    const sources: string[] = [];
    let seed = 0x5f3759df;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const texts: string[] = [];
    for (let n = 0; n < 3000; n++) texts.push(randomFlow(rnd, n));
    for (const text of texts) {
      const graph = parse(text);
      expect(printFlow(graph)).toBe(text);
      expect(semanticKey(parse(printFlow(graph)))).toBe(semanticKey(graph));
      sources.push(compile(graph, specs).python);
    }
    compileAll(sources);
    expect(pyRepr("a'b")).toBe("'a\\'b'");
    expect(pyIdent("try")).toBe("try_");
    const log = specs.get("debug.log");
    expect(fillStmt(log!.py!.stmt, { id: "msg", type: "debug.log", inputs: { message: "a'b" } }, goldenGraph)).toBe("print('a\\'b')");
  });
});

function randomFlow(rnd: () => number, n: number): string {
  const lines = ["flow f" + n + "  # xflow 1", "on start:"];
  let k = 0;
  const call = (indent: number) => {
    const pad = "  ".repeat(indent);
    const id = "s" + k++;
    if (rnd() < 0.5) lines.push(pad + id + ": wait(ms=" + (100 + Math.floor(rnd() * 4) * 100) + ")");
    else lines.push(pad + id + ": log(message=\"m" + n + "\")");
  };
  const block = (indent: number, depth: number) => {
    const pad = "  ".repeat(indent);
    call(indent);
    if (depth >= 3) return;
    const roll = rnd();
    if (roll < 0.34) {
      const id = "a" + k++;
      lines.push(pad + "for " + id + " in range(0, " + (1 + Math.floor(rnd() * 3)) + "):");
      call(indent + 1);
      if (rnd() < 0.5) lines.push(pad + "  break");
    } else if (roll < 0.67) {
      const cond = "c" + k++;
      const id = "b" + k++;
      lines.push(pad + cond + ": node.find(text=\"t" + n + "\", timeout=1)");
      lines.push(pad + id + ": if " + cond + ".found:");
      call(indent + 1);
      if (rnd() < 0.7) {
        lines.push(pad + "else:");
        call(indent + 1);
      }
    } else {
      call(indent);
    }
  };
  block(1, 1);
  return lines.join("\n") + "\n";
}

describe("compile stability", () => {
  it("compiles the same graph the same way no matter what was compiled or printed before", () => {
    const plain = parse(["flow f  # xflow 1", "on start:", "  for i in range(0, 3):", "    log(message=i)", ""].join("\n"));
    const withDef = parse(["flow f  # xflow 1", "def tick(n):", "  log(message=n)", "on start:", "  for i in range(0, 3):", "    log(message=i)", ""].join("\n"));
    expect(compile(plain, specs).python).toContain("print(i)");
    const alone = compile(withDef, specs).python;
    expect(alone).toContain("for i in range(0, 3):");
    printFlow(plain);
    expect(compile(withDef, specs).python).toBe(alone);
    expect(compile(withDef, specs).python).toBe(alone);
    expect(printFlow(withDef)).toBe(printFlow(withDef));
    compileAll([alone]);
  });
});
