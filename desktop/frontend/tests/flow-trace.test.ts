import { describe, expect, it } from "vitest";
import { parse } from "../src/flow/dsl";
import { blame, mapGraph } from "../src/flow/map";
import { SAMPLE_FLOW } from "../src/flow/sample";
import { builtinSpecs } from "../src/flow/specs";
import { buildRun, rememberRun, runLine } from "../src/flow/runs";
import { emptyLogCursor, flowEdges, followLogs, pictureOf, readTrace, RUN_KEEP_MS, runKept, seqGap } from "../src/flow/trace";

const mark = "\x1fXF";

describe("trace playback", () => {
  it("paints a node from a trace line and keeps user text apart", () => {
    const read = readTrace(
      ["print('hi')", mark + "\tenter\twarm\t1", mark + "\tspan\twarm\tTrue", "done"].join("\n"),
    );
    expect(read.user).toEqual(["print('hi')", "done"]);
    const picture = pictureOf(read.events);
    expect(picture.nodes.warm).toEqual({ status: "success", summary: "True", count: 0 });
    expect(picture.running).toBeNull();
    const mid = pictureOf([{ kind: "enter", node: "warm", text: "1" }]);
    expect(mid.running).toBe("warm");
    expect(mid.nodes.warm.status).toBe("running");
    const looped = pictureOf([
      { kind: "enter", node: "attempt", text: "" },
      { kind: "loop", node: "attempt", text: "12" },
    ]);
    expect(looped.nodes.attempt).toEqual({ status: "success", summary: "12", count: 12 });
    expect(pictureOf([{ kind: "error", node: "tap", text: "missing" }]).nodes.tap.status).toBe("error");
    expect(pictureOf([{ kind: "pause", node: "tap", text: "" }]).nodes.tap.status).toBe("paused");
    expect(pictureOf([{ kind: "queue", node: "tap", text: "" }]).nodes.tap.status).toBe("queued");
    expect(pictureOf([{ kind: "skip", node: "tap", text: "" }]).nodes.tap.status).toBe("skipped");
  });

  it("drops the last run after five minutes and stops edge motion on a large graph", () => {
    const ended = 1_000;
    expect(runKept(ended, ended + RUN_KEEP_MS - 1)).toBe(true);
    expect(runKept(ended, ended + RUN_KEEP_MS)).toBe(false);
    expect(flowEdges("warm", 300, false)).toBe(true);
    expect(flowEdges("warm", 301, false)).toBe(false);
    expect(flowEdges("warm", 10, true)).toBe(false);
    expect(flowEdges(null, 10, false)).toBe(false);
    const gapped = readTrace("# seq 1\n" + mark + "\tenter\twarm\t\n# seq 3");
    expect(seqGap(gapped.seqs)).toBe(true);
    expect(seqGap([4, 5, 6])).toBe(false);
    expect(gapped.user).toEqual([]);
  });

  it("blames the last traceback frame in the generated file", () => {
    const map = mapGraph(parse(SAMPLE_FLOW), builtinSpecs());
    const tapLine = Number(Object.entries(map.lines).find(([, mark]) => mark.split("(")[0] === "tap")?.[0]);
    const warmLine = Number(Object.entries(map.lines).find(([, mark]) => mark.split("(")[0] === "warm")?.[0]);
    expect(tapLine).toBeGreaterThan(0);
    const log = [
      "Traceback (most recent call last):",
      `  File "/sdcard/other.py", line 2, in <module>`,
      "    nope()",
      `  File "/sdcard/projects/demo/main.py", line ${warmLine}, in <module>`,
      "    action.sleep(2)",
      `  File "/sdcard/projects/demo/main.py", line ${tapLine}, in <module>`,
      "    btn.click()",
      "AttributeError: 'NoneType' object has no attribute 'click'",
    ].join("\n");
    expect(blame(log, map)).toEqual({
      node: "tap",
      line: tapLine,
      message: "AttributeError: 'NoneType' object has no attribute 'click'",
    });
    expect(blame("print('hi')", map)).toBeNull();
    expect(blame('Traceback (most recent call last):\n  File "other.py", line 1, in <module>\nValueError: x', map)).toBeNull();
    expect(blame(`Traceback (most recent call last):\n  File "main.py", line 9999, in <module>\nValueError: x`, map)).toBeNull();
  });

  it("splits a log page and notices a skipped seq", () => {
    const first = followLogs(emptyLogCursor(), {
      entries: [
        { seq: 1, line: "print('hi')" },
        { seq: 2, line: mark + "\tenter\twarm\t" },
      ],
      next: 2,
    });
    expect(first.user).toEqual(["print('hi')"]);
    expect(first.trace).toContain("enter");
    expect(first.trace).not.toContain("print");
    expect(first.gap).toBe(false);
    const gapped = followLogs(first, { entries: [{ seq: 4, line: mark + "\tspan\twarm\tTrue" }], next: 4 });
    expect(gapped.gap).toBe(true);
    expect(pictureOf(readTrace(gapped.trace).events).nodes.warm.status).toBe("success");
    const restarted = followLogs(gapped, { entries: [{ seq: 1, line: "again" }], next: 1 });
    expect(restarted.user).toEqual(["again"]);
    expect(restarted.trace).toBe("");
    expect(restarted.gap).toBe(false);
  });

  it("records node order and a failure from trace events", () => {
    const run = buildRun("daily", [
      { kind: "enter", node: "warm", text: "10" },
      { kind: "span", node: "warm", text: "True" },
      { kind: "error", node: "tap", text: "missing" },
    ], 7, 1, 2);
    expect(run.status).toBe("error");
    expect(run.error_node).toBe("tap");
    expect(run.nodes.map((node) => node.node)).toEqual(["warm", "tap"]);
    expect(run.nodes[0]).toMatchObject({ seq: 1, enter_ms: 10, summary: "True" });
    const word = (status: string) => (status === "error" ? "出错" : "完成");
    expect(runLine(run, word)).toBe("daily 出错 warm → tap · tap：missing");
    expect(runLine({ ...run, status: "success", error_node: "" }, word)).toBe("daily 完成 warm → tap");
    expect(rememberRun([run], { ...run, id: 8 }).map((item) => item.id)).toEqual([8, 7]);
    expect(rememberRun(Array.from({ length: 20 }, (_, index) => ({ ...run, id: index })), { ...run, id: 99 })).toHaveLength(20);
  });
});
