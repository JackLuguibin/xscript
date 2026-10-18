import { describe, expect, it } from "vitest";
import { parse, type FlowGraph } from "../src/flow/dsl";
import { addEnvBinding, addFlowVariable, addLocal, addProjectParam, dropVariable, insertGet, insertSet, runPayload, variableRows } from "../src/flow/variables";

const empty = (): FlowGraph => ({ xflow: 1, name: "f", nodes: [], edges: [] });

describe("flow variables", () => {
  it("lists flow variables, env names, params, function locals and loop counters", () => {
    const graph = parse(["flow f  # xflow 1", "def greet(name) -> text:", "  msg: log(message=name)", "  return text=name", "on start:", "  for i in range(0, 2):", '    a: log(message="x")', ""].join("\n"));
    let next = addFlowVariable(graph, { name: "score", type: "int", default: 1, doc: "分数", category: "计数", editable: true });
    next = addEnvBinding(next, { name: "TOKEN", secret: true });
    next = addEnvBinding(next, { name: "HOST" });
    next = addProjectParam(next, { name: "retries", type: "int", default: 3 });
    const def = next.nodes.find((node) => node.type === "flow.def")!;
    next = addLocal(next, def.id, { name: "count", type: "int" });
    const rows = variableRows(next);
    const by = (name: string) => rows.find((row) => row.name === name);
    expect(by("score")).toMatchObject({ kind: "flow", detail: "1", writable: true, doc: "分数", category: "计数", editable: true });
    expect(by("TOKEN")).toMatchObject({ kind: "env", detail: "secret", writable: false });
    expect(by("HOST")?.detail).toBe("");
    expect(by("retries")).toMatchObject({ kind: "param", detail: "3" });
    expect(by("name")).toMatchObject({ kind: "local", detail: def.id });
    expect(by("count")).toMatchObject({ kind: "local", type: "int" });
    expect(rows.some((row) => row.kind === "loop" && row.type === "int")).toBe(true);
  });

  it("refuses bad names and names already used by another kind", () => {
    const base = addFlowVariable(empty(), { name: "score", type: "int" });
    expect(addFlowVariable(base, { name: "9x", type: "int" })).toBe(base);
    expect(addFlowVariable(base, { name: "score", type: "int" })).toBe(base);
    expect(addEnvBinding(base, { name: "score" })).toBe(base);
    expect(addEnvBinding(base, { name: "bad name" })).toBe(base);
    expect(addProjectParam(base, { name: "score", type: "int" })).toBe(base);
    expect(addProjectParam(base, { name: "-", type: "int" })).toBe(base);
    const withEnv = addEnvBinding(base, { name: "TOKEN" });
    expect(addEnvBinding(withEnv, { name: "TOKEN" })).toBe(withEnv);
    expect(addFlowVariable(withEnv, { name: "TOKEN", type: "string" })).toBe(withEnv);
    expect(addProjectParam(withEnv, { name: "TOKEN", type: "string" })).toBe(withEnv);
    const withParam = addProjectParam(base, { name: "retries", type: "int" });
    expect(addProjectParam(withParam, { name: "retries", type: "int" })).toBe(withParam);
    expect(addFlowVariable(withParam, { name: "retries", type: "int" })).toBe(withParam);
    expect(addEnvBinding(withParam, { name: "retries" })).toBe(withParam);
  });

  it("adds a local only to a function that does not have the name yet", () => {
    const graph = parse(["flow f  # xflow 1", "def greet(name) -> text:", "  msg: log(message=name)", "  return text=name", "on start:", ""].join("\n"));
    const def = graph.nodes.find((node) => node.type === "flow.def")!;
    expect(addLocal(graph, def.id, { name: "1bad", type: "int" })).toBe(graph);
    expect(addLocal(graph, "nope", { name: "x", type: "int" })).toBe(graph);
    expect(addLocal(graph, def.id, { name: "name", type: "int" })).toBe(graph);
    const once = addLocal(graph, def.id, { name: "x", type: "int" });
    expect(addLocal(once, def.id, { name: "x", type: "int" })).toBe(once);
  });

  it("builds run values from overrides, keeping defaults for blanks and bad numbers", () => {
    let graph = empty();
    graph = addFlowVariable(graph, { name: "n", type: "int", default: 1, editable: true });
    graph = addFlowVariable(graph, { name: "f", type: "float", default: 0.5, editable: true });
    graph = addFlowVariable(graph, { name: "b", type: "bool", default: false, editable: true });
    graph = addFlowVariable(graph, { name: "s", type: "string", editable: true });
    graph = addFlowVariable(graph, { name: "hidden", type: "int", default: 9 });
    expect(runPayload(graph, { n: "7", f: "2.5", b: "true", s: "hi" })).toEqual({ n: 7, f: 2.5, b: true, s: "hi" });
    expect(runPayload(graph, { n: "x", f: "y", b: "no", s: "" })).toEqual({ n: 1, f: 0.5, b: false, s: null });
    expect(runPayload(graph, {})).toEqual({ n: 1, f: 0.5, b: false, s: null });
  });

  it("inserts get and set nodes with fresh ids, and drops a set only with Alt on a writable variable", () => {
    const withNode: FlowGraph = { ...empty(), nodes: [{ id: "n1", type: "debug.log" }] };
    const got = insertGet(withNode, "score");
    expect(got.nodes[1]).toEqual({ id: "n2", type: "data.get", inputs: { name: "score" } });
    expect(insertSet(got, "score").nodes[2]).toEqual({ id: "n3", type: "data.set", inputs: { name: "score" } });
    expect(dropVariable(empty(), { name: "score", writable: true }, true).graph.nodes[0].type).toBe("data.set");
    expect(dropVariable(empty(), { name: "TOKEN", writable: false }, true).graph.nodes[0].type).toBe("data.get");
    expect(dropVariable(empty(), { name: "score", writable: true }, false).id).toBe("n1");
  });
});
