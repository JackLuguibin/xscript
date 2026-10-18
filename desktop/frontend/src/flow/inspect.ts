import { codePins, type FlowGraph, type FlowNode, type NodeSpec } from "./dsl";

export type InspectPin = {
  name: string;
  type: string;
  ui: "bool" | "select" | "number" | "color" | "text";
  value: string | number | boolean | null;
  min?: number;
  options?: string[];
  /** `node.pin` when a wire owns this input. The literal stays hidden. */
  wired: string | null;
};

type PinDecl = {
  name: string;
  type?: string;
  ui?: string;
  default?: string | number | boolean | null;
  min?: number;
  options?: string[];
};

function controlOf(pin: PinDecl, sample: string | number | boolean | null | undefined): InspectPin["ui"] {
  if (pin.ui === "bool" || pin.ui === "select" || pin.ui === "number" || pin.ui === "color" || pin.ui === "text") return pin.ui;
  if (pin.options?.length) return "select";
  const type = pin.type ?? (typeof sample === "boolean" ? "bool" : typeof sample === "number" ? "float" : undefined);
  if (type === "bool") return "bool";
  if (type === "int" || type === "float") return "number";
  if (type === "color") return "color";
  return "text";
}

/** Parse a property field. `null` means the draft is not a value yet (an empty number). */
export function literalFromField(field: Pick<InspectPin, "ui" | "type">, raw: string): string | number | null {
  if (field.ui !== "number") return raw;
  const parsed = field.type === "float" ? Number(raw) : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function pinRow(graph: FlowGraph, node: FlowNode, pin: PinDecl): InspectPin {
  const edge = graph.edges.find((item) => item.to === node.id + "." + pin.name);
  const stored = node.inputs?.[pin.name];
  const ui = controlOf(pin, stored);
  const fallback = pin.default !== undefined ? pin.default : ui === "bool" ? false : "";
  const row: InspectPin = {
    name: pin.name,
    type: pin.type ?? "any",
    ui,
    value: stored !== undefined ? stored : fallback,
    wired: edge ? edge.from : null,
  };
  if (pin.min !== undefined) row.min = pin.min;
  if (pin.options?.length) row.options = pin.options;
  return row;
}

/** Inputs and outputs the inspector can show for one node. Wired inputs name the source pin. */
export function inspectPins(
  graph: FlowGraph,
  node: FlowNode,
  spec: NodeSpec | undefined,
): { inputs: InspectPin[]; outputs: Array<{ name: string; type: string }> } {
  const declared = codePins(node);
  const origin = node.meta?.origin;
  let decls: PinDecl[];
  let outputs: Array<{ name: string; type: string }>;
  if (node.type === "code.python") {
    decls = declared.inputs.length
      ? declared.inputs
      : (origin?.dataIn ?? []).map((pin) => ({ name: pin.codePin, type: "any" }));
    outputs = declared.outputs.length
      ? declared.outputs
      : (origin?.dataOut ?? []).map((pin) => ({ name: pin.codePin, type: "any" }));
  } else {
    decls = spec?.inputs ?? [];
    outputs = (spec?.outputs ?? []).map((pin) => ({ name: pin.name, type: pin.type ?? "any" }));
  }
  const execIn = new Set(spec?.exec.in?.length ? spec.exec.in : ["exec"]);
  const known = new Set(decls.map((pin) => pin.name));
  const extras: PinDecl[] = [];
  for (const name of Object.keys(node.inputs ?? {})) {
    if (known.has(name) || execIn.has(name)) continue;
    known.add(name);
    const sample = node.inputs?.[name];
    extras.push({
      name,
      type: typeof sample === "boolean" ? "bool" : typeof sample === "number" && Number.isInteger(sample) ? "int" : typeof sample === "number" ? "float" : "string",
    });
  }
  for (const edge of graph.edges) {
    if (!edge.to.startsWith(node.id + ".")) continue;
    const name = edge.to.slice(node.id.length + 1);
    if (!name || known.has(name) || execIn.has(name)) continue;
    known.add(name);
    extras.push({ name, type: "any" });
  }
  return { inputs: [...decls, ...extras].map((pin) => pinRow(graph, node, pin)), outputs };
}
