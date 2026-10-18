import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "../src/flow/dsl";
import { SAMPLE_FLOW } from "../src/flow/sample";
import { literalPreview, rememberRuns, STEP_TIMEOUT_MS, stepSnippet } from "../src/flow/step";
import { builtinSpecs } from "../src/flow/specs";

function pyValue(code: string): string {
  const runner = [
    "import io, sys",
    "ns = {}",
    "code = sys.stdin.read()",
    "held = sys.stdout",
    "sys.stdout = io.StringIO()",
    "try:",
    "    exec(compile(code, 'step.py', 'exec'), ns)",
    "finally:",
    "    sys.stdout = held",
    "value = ns.get('_result')",
    "print('None' if value is None else 'True' if value is True else 'False' if value is False else str(value))",
  ].join("\n");
  return execFileSync("python3", ["-c", runner], { input: code, timeout: STEP_TIMEOUT_MS }).toString().trim();
}

describe("single node step run", () => {
  it("runs a literal add on this machine and refuses control nodes", () => {
    const specs = builtinSpecs();
    const graph = parse(["flow calc  # xflow 1", "on start:", "  sum: add(a=1, b=2)", ""].join("\n"));
    const step = stepSnippet(graph, "sum", specs);
    expect(step).toMatchObject({ ok: true, where: "local", timeoutMs: 8000, code: "_result = (1 + 2)" });
    if (!step.ok) return;
    expect(literalPreview(step.code)).toBe("3");
    expect(pyValue(step.code)).toBe("3");
    const words = parse(["flow words  # xflow 1", "on start:", '  msg: concat(a="a", b="b")', ""].join("\n"));
    const joined = stepSnippet(words, "msg", specs);
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(literalPreview(joined.code)).toBe("ab");
    expect(pyValue(joined.code)).toBe("ab");
    const sign = parse(SAMPLE_FLOW);
    const logged = stepSnippet(sign, "done", specs);
    expect(logged.ok).toBe(true);
    if (!logged.ok) return;
    expect(logged.where).toBe("local");
    expect(logged.code).toContain("print('流程结束')");
    expect(pyValue(logged.code)).toBe("None");
    const found = stepSnippet(sign, "btn", specs);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.where).toBe("device");
    expect(found.timeoutMs).toBe(STEP_TIMEOUT_MS);
    expect(found.code).toContain("_result = btn");
    expect(stepSnippet(sign, "ok", specs)).toEqual({ ok: false, reason: "refused" });
    expect(stepSnippet(sign, "start", specs)).toEqual({ ok: false, reason: "refused" });
    const bare = parse(["flow bare  # xflow 1", "on start:", "  sum: add()", ""].join("\n"));
    expect(stepSnippet(bare, "sum", specs)).toEqual({ ok: false, reason: "missing", pin: "a" });
  });

  it("reruns a downstream node from a cached upstream value", () => {
    const specs = builtinSpecs();
    const graph = parse(["flow use  # xflow 1", "on start:", "  sum: add(a=1, b=2)", "  msg: log(message=sum)", ""].join("\n"));
    expect(stepSnippet(graph, "msg", specs)).toEqual({ ok: false, reason: "wired", pin: "message" });
    const step = stepSnippet(graph, "msg", specs, { sum: "9" });
    expect(step.ok).toBe(true);
    if (!step.ok) return;
    expect(step.code).toContain("print(9)");
    expect(pyValue(step.code)).toBe("None");
    const edited = new Set(["sum"]);
    expect(rememberRuns({ sum: "9" }, edited, { sum: "1", warm: "True" })).toEqual({ sum: "9", warm: "True" });
  });
  it("folds literal expressions the way Python would and gives up on anything else", () => {
    const cases: Array<[string, string | null]> = [
      ["1 + 2 * 3 - 4 / 2 % 3", "5"],
      ["-(2) + -1", "-3"],
      ["'a' + \"b\"", "ab"],
      ["'x\\n\\r\\\\\\'\\\"'", "x\n\r\\'\""],
      ["1 < 2", "True"], ["2 > 1", "True"], ["1 <= 1", "True"], ["1 >= 2", "False"], ["1 == 1", "True"], ["1 != 1", "False"],
      ["'a' < 'b'", "True"], ["'a' > 'b'", "False"], ["'a' <= 'a'", "True"], ["'a' >= 'b'", "False"], ["'a' == 'a'", "True"], ["'a' != 'a'", "False"],
      ["not 0", "True"], ["not 'x'", "False"], ["0 or 'y'", "y"], ["1 or 2", "1"], ["1 and 2", "2"], ["None and 2", "None"],
      ["True", "True"], ["False", "False"], ["None", "None"],
      ["str(None)", "None"], ["str(True)", "True"], ["str(False)", "False"], ["str(1.5)", "1.5"],
      ["int(True)", "1"], ["int(False)", "0"], ["int(2.7)", "2"], ["int('42')", "42"],
      ["float(2)", "2"], ["float(True)", "1"], ["float(False)", "0"], ["float('2.5')", "2.5"],
      ["bool()", "False"], ["bool('a')", "True"], ["len('abc')", "3"], ["min(3, 1, 2)", "1"], ["max(3, 1, 2)", "3"],
      ["int('x')", null], ["float('x')", null], ["float(None)", null], ["len(1)", null], ["min()", null], ["max('a', 1)", null],
      ["nope(1)", null], ["name", null], ["1 + 'a'", null], ["'a' * 2", null], ["-'a'", null], ["1 < 'a'", null],
      ["(1", null], ["'abc", null], ["'\\q'", null], ["min(1", null], ["1 2", null], ["@", null],
    ];
    for (const [expr, want] of cases) expect([expr, literalPreview("_result = " + expr)]).toEqual([expr, want]);
    expect(literalPreview("print(1)")).toBeNull();
  });

  it("reads cached pin values as Python literals and keeps unknown forms as text", () => {
    const specs = builtinSpecs();
    const graph = parse(["flow use  # xflow 1", "on start:", "  sum: add(a=1, b=2)", "  msg: log(message=sum)", ""].join("\n"));
    const code = (cache: Record<string, string>) => {
      const step = stepSnippet(graph, "msg", specs, cache);
      return step.ok ? step.code : step.reason;
    };
    expect(code({ sum: "None" })).toContain("print(None)");
    expect(code({ sum: "True" })).toContain("print(True)");
    expect(code({ sum: "False" })).toContain("print(False)");
    expect(code({ sum: "  " })).toBe("wired");
    expect(code({ "sum.result": "-1.5" })).toContain("-1.5");
    expect(code({ sum: "hello" })).toContain("hello");
    expect(stepSnippet(graph, "missing", specs)).toEqual({ ok: false, reason: "refused" });
    expect(stepSnippet(graph, "sum", new Map())).toEqual({ ok: false, reason: "refused" });
  });
});
