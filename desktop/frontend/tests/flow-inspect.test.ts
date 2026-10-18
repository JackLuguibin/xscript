import { describe, expect, it } from "vitest";
import { parse, type FlowGraph } from "../src/flow/dsl";
import { inspectPins, literalFromField } from "../src/flow/inspect";
import { SAMPLE_FLOW } from "../src/flow/sample";
import { builtinSpecs } from "../src/flow/specs";

describe("inspect pins", () => {
  const specs = builtinSpecs();

  it("shows literals, wires, and outputs for the sign-in flow", () => {
    const graph = parse(SAMPLE_FLOW);
    const node = (id: string) => graph.nodes.find((item) => item.id === id);
    const warm = node("warm");
    const btn = node("btn");
    const tap = node("tap");
    const branch = node("ok");
    if (!warm || !btn || !tap || !branch) throw new Error("sample nodes missing");

    expect(inspectPins(graph, warm, specs.get(warm.type)).inputs).toEqual([
      { name: "ms", type: "int", ui: "number", value: 2000, min: 0, wired: null },
    ]);
    expect(inspectPins(graph, btn, specs.get(btn.type)).inputs).toEqual([
      { name: "text", type: "string", ui: "text", value: "签到", wired: null },
      { name: "timeout", type: "float", ui: "number", value: 3, min: 0, wired: null },
    ]);
    expect(inspectPins(graph, btn, specs.get(btn.type)).outputs).toEqual([
      { name: "node", type: "node?" },
      { name: "found", type: "bool" },
    ]);
    expect(inspectPins(graph, tap, specs.get(tap.type)).inputs[0]).toMatchObject({ name: "target", wired: "btn.node" });
    expect(inspectPins(graph, branch, specs.get(branch.type)).inputs[0]).toMatchObject({ name: "cond", wired: "btn.found" });
  });

  it("keeps unknown literals, select options, and folded pins", () => {
    const bad = parse(["flow t  # xflow 1", "on start:", '  btn: node.find(txt="签到")', ""].join("\n"));
    const btn = bad.nodes.find((item) => item.id === "btn");
    if (!btn) throw new Error("btn missing");
    const pins = inspectPins(bad, btn, specs.get(btn.type));
    expect(pins.inputs.map((pin) => pin.name)).toEqual(["text", "timeout", "txt"]);
    expect(pins.inputs.find((pin) => pin.name === "txt")).toMatchObject({ ui: "text", value: "签到", wired: null });

    const mapped = parse(["flow t  # xflow 1", "on start:", '  m: map(a="ab", op="int")', ""].join("\n"));
    const mapNode = mapped.nodes.find((item) => item.id === "m");
    if (!mapNode) throw new Error("map missing");
    const op = inspectPins(mapped, mapNode, specs.get(mapNode.type)).inputs.find((pin) => pin.name === "op");
    expect(op).toMatchObject({ ui: "select", value: "int", options: ["str", "int", "float", "len", "bool"] });

    const flagged: FlowGraph = {
      xflow: 1,
      name: "t",
      nodes: [{ id: "n", type: "debug.log", inputs: { message: "a", flag: true } }],
      edges: [{ from: "up.value", to: "n.extra" }],
    };
    const extra = inspectPins(flagged, flagged.nodes[0], specs.get("debug.log"));
    expect(extra.inputs.map((pin) => [pin.name, pin.ui, pin.value, pin.wired])).toEqual([
      ["message", "text", "a", null],
      ["flag", "bool", true, null],
      ["extra", "text", "", "up.value"],
    ]);

    const folded: FlowGraph = {
      xflow: 1,
      name: "t",
      nodes: [{
        id: "box",
        type: "code.python",
        meta: {
          origin: {
            nodes: [],
            edges: [],
            entry: null,
            execOut: [],
            dataIn: [{ codePin: "name", to: "a", pin: "x" }],
            dataOut: [{ codePin: "value", from: "a", pin: "y" }],
          },
        },
      }],
      edges: [],
    };
    const code = inspectPins(folded, folded.nodes[0], specs.get("code.python"));
    expect(code.inputs.map((pin) => pin.name)).toEqual(["name"]);
    expect(code.outputs.map((pin) => pin.name)).toEqual(["value"]);
  });

  it("parses number drafts and leaves text alone", () => {
    expect(literalFromField({ ui: "number", type: "int" }, "2500")).toBe(2500);
    expect(literalFromField({ ui: "number", type: "float" }, "1.5")).toBe(1.5);
    expect(literalFromField({ ui: "number", type: "int" }, "")).toBeNull();
    expect(literalFromField({ ui: "text", type: "string" }, "打卡")).toBe("打卡");
  });
});
