import { describe, expect, it } from "vitest";
import { parse } from "../src/flow/dsl";
import { SAMPLE_FLOW } from "../src/flow/sample";
import { builtinSpecs } from "../src/flow/specs";
import { classifyToken, completeXflow, definitionOf, hoverXflow, outputRefs, pinTypes, statementRefs, wantedPinType } from "../src/flow/xflow-language";

const aliases = new Set([...builtinSpecs().values()].map((spec) => spec.dsl.alias));

describe("xflow language", () => {
  it("classifies keywords, aliases, refs, strings and comments", () => {
    expect(classifyToken("while", aliases)).toBe("keyword");
    expect(classifyToken("node.find", aliases)).toBe("alias");
    expect(classifyToken("btn.found", aliases)).toBe("ref");
    expect(classifyToken('"签到"', aliases)).toBe("string");
    expect(classifyToken("# 备注", aliases)).toBe("comment");
    expect(classifyToken("2000", aliases)).toBe("number");
  });

  it("completes aliases and node ids from the prefix", () => {
    expect(completeXflow("", ["log"], ["open"])).toEqual([]);
    expect(completeXflow("no", ["node.find", "log"], ["open"])).toEqual(["node.find"]);
    expect(completeXflow("op", ["log"], ["open"])).toEqual(["open"]);
  });

  it("hovers an alias with its Chinese title", () => {
    const text = hoverXflow("node.find", builtinSpecs().values());
    expect(text).toContain("查找控件");
  });

  it("completes a compatible pin and shows its last value", () => {
    const specs = builtinSpecs();
    const graph = parse(SAMPLE_FLOW);
    const refs = outputRefs(graph, specs);
    const before = '  tap: click(target=btn.';
    expect(wantedPinType(before, specs.values())).toBe("node?");
    expect(completeXflow("btn.", [], graph.nodes.map((node) => node.id), { refs, want: "node?" })).toEqual(["btn.node"]);
    expect(completeXflow("btn.f", [], graph.nodes.map((node) => node.id), { refs })).toEqual(["btn.found"]);
    expect(completeXflow("te", [], [], { pins: ["text", "timeout"] })).toEqual(["text"]);
    const hover = hoverXflow("btn.found", specs.values(), { runs: { "btn.found": "True" }, pins: pinTypes(graph, specs) });
    expect(hover).toContain("bool");
    expect(hover).toContain("True");
    expect(hoverXflow("btn.found", specs.values(), { pins: pinTypes(graph, specs) })).toContain("尚未执行");
    expect(definitionOf("btn.node", graph.nodes.map((node) => node.id))).toBe("btn");
    expect(statementRefs('tap: click(target=btn.node)', ["tap", "btn"])).toEqual(["btn"]);
  });
});
