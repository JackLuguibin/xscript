import { describe, expect, it } from "vitest";
import { builtinSpecs } from "../src/flow/specs";
import { parse, type FlowGraph } from "../src/flow/dsl";
import { SAMPLE_FLOW } from "../src/flow/sample";
import { drive, type FlowDebug } from "../src/flow/session";
import { pictureOf } from "../src/flow/trace";

const specs = builtinSpecs();

function runAll(graph: FlowGraph, breaks: { node: string; enabled: boolean }[] = []): FlowDebug {
  return drive(null, graph, specs, breaks, "run");
}

describe("flow session", () => {
  it("runs the sample flow to the end when nothing is found", () => {
    const done = runAll(parse(SAMPLE_FLOW));
    expect(done.status).toBe("done");
    expect(done.log).toEqual(["流程结束"]);
    const picture = pictureOf(done.events);
    expect(picture.nodes.btn?.summary).toBe("False");
    expect(picture.nodes.ok?.summary).toBe("False");
    expect(picture.nodes.done?.status).toBe("success");
    expect(picture.nodes.attempt?.count).toBeGreaterThan(1);
    expect(picture.nodes.tap).toBeUndefined();
  });

  it("pauses on an enabled breakpoint and continues", () => {
    const graph = parse(SAMPLE_FLOW);
    const paused = drive(null, graph, specs, [{ node: "done", enabled: true }], "run");
    expect(paused.status).toBe("paused");
    expect(paused.pause).toBe("breakpoint");
    expect(paused.at).toBe("done");
    expect(paused.log).toEqual([]);
    const finished = drive(paused, graph, specs, [{ node: "done", enabled: true }], "run");
    expect(finished.status).toBe("done");
    expect(finished.log).toEqual(["流程结束"]);
  });

  it("steps one node at a time from the entry", () => {
    const graph = parse(SAMPLE_FLOW);
    const first = drive(null, graph, specs, [], "step");
    expect(first.status).toBe("paused");
    expect(first.pause).toBe("step");
    expect(first.at).toBe("open");
    expect(first.events.some((event) => event.kind === "span" && event.node === "open")).toBe(false);
    const second = drive(first, graph, specs, [], "step");
    expect(second.at).toBe("warm");
    expect(second.events.some((event) => event.kind === "span" && event.node === "open")).toBe(true);
  });

  it("takes the true branch and leaves a loop on break", () => {
    const branch = parse(["flow branch  # xflow 1", "on start:", "  flag: bool(value=1)", "  ok: if flag.result:", '    yes: log(message="yes")', "  else:", '    no: log(message="no")', ""].join("\n"));
    expect(runAll(branch).log).toEqual(["yes"]);

    const loop = parse(["flow loop  # xflow 1", "on start:", "  for attempt in range(0, 4):", '    msg: log(message="x")', "    break", '  done: log(message="out")', ""].join("\n"));
    expect(runAll(loop).log).toEqual(["x", "out"]);
  });

  it("stops a paused session", () => {
    const graph = parse(SAMPLE_FLOW);
    const paused = drive(null, graph, specs, [], "step");
    const stopped = drive(paused, graph, specs, [], "stop");
    expect(stopped.status).toBe("stopped");
    expect(drive(stopped, graph, specs, [], "run").status).toBe("done");
  });

  const flow = (...lines: string[]) => parse(["flow f  # xflow 1", "on start:", ...lines, ""].join("\n"));
  const kinds = (done: FlowDebug) => done.events.map((event) => event.kind + ":" + event.node + ":" + event.text);

  it("runs try, parallel and seq bodies before the node after them", () => {
    const guarded = runAll(flow('  btn: node.find(text="签到", timeout=1)', "  guard: try:", "    tap: click(target=btn.node)", "  except err:", '    msg: log(message="失败")', '  done: log(message="继续")'));
    expect(guarded.log).toEqual(["继续"]);
    expect(kinds(guarded)).toContain("span:tap:target=None");
    const par = runAll(flow("  par: parallel:", "    branch:", '      a: log(message="a")', "    branch:", '      b: log(message="b")', '  done: log(message="done")'));
    expect(par.log).toEqual(["a", "b", "done"]);
    expect(kinds(par)[0]).toBe("span:par:2");
    const seq = runAll(flow("  order: seq:", "    step:", '      a: log(message="a")', "    step:", '      b: log(message="b")', '  done: log(message="done")'));
    expect(seq.log).toEqual(["a", "b", "done"]);
  });

  it("picks the matching case, falls back to _, and reports the value", () => {
    const hit = runAll(flow('  v: str(value="关闭")', "  pick: match v.result:", '    "签到":', '      a: log(message="签")', '    "关闭":', '      msg: log(message="关")', "    _:", '      other: log(message="其它")', '  done: log(message="结束")'));
    expect(hit.log[0]).toBe("关");
    expect(kinds(hit)).toContain("span:pick:关闭");
    const other = runAll(flow('  btn: node.find(text="签到", timeout=1)', "  pick: match btn.text:", '    "签到":', '      a: log(message="签")', "    _:", '      other: log(message="其它")'));
    expect(other.log).toEqual(["其它"]);
    expect(kinds(other)).toContain("span:pick:None");
  });

  it("repeats a while body up to max and skips it when the condition is false", () => {
    const capped = runAll(flow("  flag: bool(value=1)", "  loop: while flag.result max=3:", '    tap: log(message="t")', '  done: log(message="结束")'));
    expect(capped.log).toEqual(["t", "t", "t", "结束"]);
    expect(kinds(capped).filter((item) => item.startsWith("loop:loop:"))).toEqual(["loop:loop:2", "loop:loop:3"]);
    const skipped = runAll(flow('  btn: node.find(text="签到", timeout=3)', "  loop: while btn.found max=5:", "    tap: click(target=btn.node)", '  done: log(message="结束")'));
    expect(skipped.log).toEqual(["结束"]);
    expect(kinds(skipped)).toContain("span:loop:False");
  });

  it("continues a range loop, skips an empty for-each, and takes the until timeout branch", () => {
    const counted = runAll(flow("  for i in range(0, 3):", '    a: log(message="x")', "    continue", '  done: log(message="out")'));
    expect(counted.log).toEqual(["x", "x", "x", "out"]);
    const empty = runAll(flow('  btn: node.find(text="行", timeout=1)', "  for item in btn.node:", '    msg: log(message="x")', '  done: log(message="d")'));
    expect(empty.log).toEqual(["d"]);
    const late = runAll(flow('  btn: node.find(text="签到", timeout=3)', "  hold: until btn.found timeout=3000 interval=200:", '    ready: log(message="ready")', "  timeout:", '    late: log(message="late")'));
    expect(late.log).toEqual(["late"]);
  });

  it("retries on fail until the attempts run out, and takes ok when the body finishes", () => {
    const failing = runAll(flow("  r: retry times=3:", '    a: log(message="try")', "    fail", "  ok:", '    ready: log(message="ok")', "  failed:", '    late: log(message="late")'));
    expect(failing.log).toEqual(["try", "try", "try", "late"]);
    const passing = runAll(flow("  r: retry times=2:", '    a: log(message="try")', "  ok:", '    ready: log(message="ok")', "  failed:", '    late: log(message="late")'));
    expect(passing.log).toEqual(["try", "ok"]);
  });

  it("enters a function body and returns to the caller", () => {
    for (const kind of ["def", "macro"]) {
      const graph = parse(["flow f  # xflow 1", `${kind} greet(name) -> text:`, "  msg: log(message=name)", "  return text=name", "on start:", '  c: call greet(name="Ada")', '  done: log(message="after")', ""].join("\n"));
      const done = runAll(graph);
      expect(done.status).toBe("done");
      expect(kinds(done)[0]).toBe("span:c:greet");
      expect(done.log[done.log.length - 1]).toBe("after");
    }
  });

  it("stops at end, records set, wait and device inputs, and finishes an empty flow", () => {
    const ended = runAll(flow('  a: log(message="a")', "  done: end(code=0)", '  b: log(message="b")'));
    expect(ended.log).toEqual(["a"]);
    expect(ended.status).toBe("done");
    const vars = runAll(parse(['flow demo  # xflow 1', "var score: int = 1", "on start:", '  set(name="score", value=2)', ""].join("\n")));
    expect(kinds(vars).some((item) => item.endsWith(":score=2"))).toBe(true);
    expect(vars.values.score).toBe("2");
    const misc = runAll(flow("  msg: log(message=sub(a=5, b=3))", "  w: wait(seconds=1)", '  t: click(target="x")'));
    expect(misc.log).toEqual(["2"]);
    expect(kinds(misc)).toContain("span:t:target=x");
    expect(runAll(flow()).status).toBe("done");
  });

  it("steps through a loop and pauses on a breakpoint inside it", () => {
    const graph = flow("  for i in range(0, 2):", '    a: log(message="x")', '  done: log(message="out")');
    let session = drive(null, graph, specs, [], "step");
    const seen: string[] = [];
    for (let guard = 0; guard < 20 && session.status === "paused"; guard++) {
      seen.push(String(session.at));
      session = drive(session, graph, specs, [], "step");
    }
    expect(session.status).toBe("done");
    expect(seen.filter((item) => item === "a").length).toBe(2);
    const paused = drive(null, graph, specs, [{ node: "a", enabled: true }], "run");
    expect(paused.pause).toBe("breakpoint");
    expect(paused.at).toBe("a");
    const again = drive(paused, graph, specs, [{ node: "a", enabled: true }], "run");
    expect(again.at).toBe("a");
    expect(again.log).toEqual(["x"]);
    expect(drive(again, graph, specs, [{ node: "a", enabled: false }], "run").log).toEqual(["x", "x", "out"]);
  });

  it("skips a disabled node and stops a session that has not started", () => {
    const graph = parse(SAMPLE_FLOW);
    const off: FlowGraph = { ...graph, nodes: graph.nodes.map((node) => (node.id === "open" ? { ...node, meta: { ...node.meta, disabled: true } } : node)) };
    const done = runAll(off);
    expect(kinds(done)).toContain("skip:open:");
    expect(drive(null, graph, specs, [], "stop").status).toBe("stopped");
  });
});
