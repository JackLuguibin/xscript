import { codePins, danglingEdges, type FlowGraph, type FlowNode, type NodeSpec } from "./dsl";

export interface Diagnostic {
  code: "E100" | "E110" | "E111" | "E112" | "E113" | "E114" | "E115" | "E200" | "E201" | "E202" | "E301" | "W116" | "W300" | "W301";
  severity: "error" | "warning";
  node?: string;
  message: string;
  fix?: { from: string; to: string };
}

function pinNode(ref: string): string {
  return ref.slice(0, ref.indexOf("."));
}

function pinName(ref: string): string {
  return ref.slice(ref.indexOf(".") + 1);
}

function baseType(type: string | undefined): string {
  const raw = (type ?? "").trim();
  const list = /^list<(.+)>$/.exec(raw);
  return (list ? list[1] : raw).replace(/\?$/, "");
}

/** A wire that can be saved by inserting a pure cast. Same types and `any` stay direct. */
export function conversionFor(from: string | undefined, to: string | undefined): "math.float" | "math.int" | "math.str" | "math.bool" | null {
  if (!from || !to) return null;
  const source = baseType(from);
  const target = baseType(to);
  if (!source || !target || source === "any" || target === "any" || source === target) return null;
  if (target === "string") return "math.str";
  const numeric = source === "bool" || source === "int" || source === "float";
  if (!numeric) return null;
  if (target === "float") return "math.float";
  if (target === "int") return "math.int";
  if (target === "bool") return "math.bool";
  return null;
}

function nullableToRequired(from: string | undefined, to: string | undefined): boolean {
  if (!from || !to || from === "any" || to === "any") return false;
  if (!from.endsWith("?") || to.endsWith("?")) return false;
  return from.slice(0, -1) === to;
}

function typesOk(from: string | undefined, to: string | undefined): boolean {
  if (!from || !to || from === "any" || to === "any") return true;
  const base = (type: string) => type.replace(/\?$/, "");
  const a = base(from);
  const b = base(to);
  if (a === b) return true;
  return (a === "int" || a === "float") && (b === "int" || b === "float");
}

interface PinFace {
  kind: "exec" | "data";
  dir: "in" | "out";
  type?: string;
}

function declaredFace(node: FlowNode | undefined, pin: string): PinFace | undefined {
  if (!node || node.type !== "code.python") return undefined;
  if (pin === "exec") return { kind: "exec", dir: "in" };
  if (pin === "then" || node.meta?.origin?.execOut.some((item) => item.codePin === pin)) return { kind: "exec", dir: "out" };
  const pins = codePins(node);
  const input = pins.inputs.find((item) => item.name === pin);
  if (input) return { kind: "data", dir: "in", type: input.type };
  const output = pins.outputs.find((item) => item.name === pin);
  if (output) return { kind: "data", dir: "out", type: output.type };
  if (node.meta?.origin?.dataIn.some((item) => item.codePin === pin)) return { kind: "data", dir: "in", type: "any" };
  if (node.meta?.origin?.dataOut.some((item) => item.codePin === pin)) return { kind: "data", dir: "out", type: "any" };
  return undefined;
}

function faces(spec: NodeSpec | undefined): Map<string, PinFace> {
  const map = new Map<string, PinFace>();
  if (!spec) return map;
  for (const name of spec.exec.in) map.set(name, { kind: "exec", dir: "in" });
  for (const name of spec.exec.out) map.set(name, { kind: "exec", dir: "out" });
  for (const pin of spec.inputs) map.set(pin.name, { kind: "data", dir: "in", type: pin.type });
  for (const pin of spec.outputs) map.set(pin.name, { kind: "data", dir: "out", type: pin.type });
  return map;
}

function pinFace(node: FlowNode | undefined, spec: NodeSpec | undefined, pin: string): PinFace | undefined {
  return faces(spec).get(pin) ?? declaredFace(node, pin);
}

function dataCycle(graph: FlowGraph, specs: Map<string, NodeSpec>): string | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const next = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const fromId = pinNode(edge.from);
    const toId = pinNode(edge.to);
    const fromNode = byId.get(fromId);
    const toNode = byId.get(toId);
    const src = pinFace(fromNode, specs.get(fromNode?.type ?? ""), pinName(edge.from));
    const dst = pinFace(toNode, specs.get(toNode?.type ?? ""), pinName(edge.to));
    if (src?.kind !== "data" || dst?.kind !== "data") continue;
    next.set(fromId, [...(next.get(fromId) ?? []), toId]);
  }
  const color = new Map<string, number>();
  const visit = (id: string): string | null => {
    color.set(id, 1);
    for (const hop of next.get(id) ?? []) {
      const seen = color.get(hop) ?? 0;
      if (seen === 1) return hop;
      if (seen === 0) {
        const found = visit(hop);
        if (found) return found;
      }
    }
    color.set(id, 2);
    return null;
  };
  for (const id of next.keys()) {
    if ((color.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

function pinDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = row[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((row[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, prev + cost);
      prev = next;
    }
  }
  return row[b.length] ?? a.length;
}

function closestPin(name: string, pins: readonly string[]): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const pin of pins) {
    const distance = pinDistance(name, pin);
    if (distance > 2) continue;
    if (!best || distance < best.distance || (distance === best.distance && pin.length < best.name.length)) best = { name: pin, distance };
  }
  return best?.name ?? null;
}

function literalTypeOk(type: string | undefined, value: string | number | boolean | null): boolean {
  if (!type || type === "any") return true;
  if (value === null) return type.endsWith("?");
  const base = type.replace(/\?$/, "");
  if (base === "string") return typeof value === "string";
  if (base === "bool") return typeof value === "boolean";
  if (base === "int") return typeof value === "number" && Number.isInteger(value);
  if (base === "float") return typeof value === "number";
  return true;
}

/** Codes from design §8.6 / §14.11: E1xx wires, E2xx parameters, E3xx structure, W3xx suspicious. */
export function diagnose(graph: FlowGraph, parseError?: string, specs?: Map<string, NodeSpec>): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (parseError) out.push({ code: "E100", severity: "error", message: parseError });
  if (!graph.nodes.some((node) => node.type === "event.start")) {
    out.push({ code: "E301", severity: "error", message: "缺少事件入口" });
  }
  const ids = new Set(graph.nodes.map((node) => node.id));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of danglingEdges(graph)) {
    const from = pinNode(edge.from);
    const to = pinNode(edge.to);
    const node = ids.has(to) ? to : ids.has(from) ? from : undefined;
    out.push({ code: "W300", severity: "warning", node, message: edge.from + " → " + edge.to });
  }
  if (!specs) return out;
  const execOuts = new Map<string, number>();
  const dataIns = new Map<string, number>();
  for (const edge of graph.edges) {
    const fromId = pinNode(edge.from);
    const toId = pinNode(edge.to);
    if (!ids.has(fromId) || !ids.has(toId)) continue;
    const fromNode = byId.get(fromId);
    const toNode = byId.get(toId);
    const src = pinFace(fromNode, specs.get(fromNode?.type ?? ""), pinName(edge.from));
    const dst = pinFace(toNode, specs.get(toNode?.type ?? ""), pinName(edge.to));
    if (!src || !dst) {
      out.push({ code: "E110", severity: "error", node: toId, message: edge.from + " → " + edge.to });
      continue;
    }
    if (src.kind !== dst.kind || src.dir !== "out" || dst.dir !== "in") {
      out.push({ code: "E111", severity: "error", node: toId, message: edge.from + " → " + edge.to });
      continue;
    }
    if (src.kind === "data" && !typesOk(src.type, dst.type)) {
      out.push({ code: "E112", severity: "error", node: toId, message: (src.type ?? "?") + " → " + (dst.type ?? "?") });
    } else if (src.kind === "data" && nullableToRequired(src.type, dst.type)) {
      out.push({ code: "W116", severity: "warning", node: toId, message: (src.type ?? "?") + " → " + (dst.type ?? "?") });
    }
    if (src.kind === "exec" && src.dir === "out") {
      const count = (execOuts.get(edge.from) ?? 0) + 1;
      execOuts.set(edge.from, count);
      if (count > 1) out.push({ code: "E113", severity: "error", node: fromId, message: edge.from });
    }
    if (dst.kind === "data" && dst.dir === "in") {
      const count = (dataIns.get(edge.to) ?? 0) + 1;
      dataIns.set(edge.to, count);
      if (count > 1) out.push({ code: "E114", severity: "error", node: toId, message: edge.to });
    }
  }
  const cycle = dataCycle(graph, specs);
  if (cycle) out.push({ code: "E115", severity: "error", node: cycle, message: "数据线成环" });
  for (const node of graph.nodes) {
    const spec = specs.get(node.type);
    if (!spec) continue;
    const declared = codePins(node).inputs;
    const known = new Set([...spec.inputs.map((pin) => pin.name), ...declared.map((pin) => pin.name)]);
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (!known.has(key)) {
        const suggestion = closestPin(key, [...known]);
        const taken = Object.prototype.hasOwnProperty.call(node.inputs ?? {}, suggestion ?? "");
        out.push({
          code: "E200",
          severity: "error",
          node: node.id,
          message: suggestion ? "没有引脚 " + key + "，是不是想写 " + suggestion : "没有引脚 " + key,
          fix: suggestion && !taken ? { from: key, to: suggestion } : undefined,
        });
        continue;
      }
      const pin = spec.inputs.find((item) => item.name === key) ?? declared.find((item) => item.name === key);
      if (!pin) continue;
      if (!literalTypeOk(pin.type, value)) {
        out.push({ code: "E201", severity: "error", node: node.id, message: "引脚 " + key + " 需要 " + (pin.type ?? "any") });
        continue;
      }
      if (typeof value === "number" && "min" in pin && pin.min !== undefined && value < pin.min) {
        out.push({ code: "E202", severity: "error", node: node.id, message: "引脚 " + key + " 小于 " + pin.min });
      } else if ("options" in pin && pin.options && value !== null && !pin.options.includes(String(value))) {
        out.push({ code: "E202", severity: "error", node: node.id, message: "引脚 " + key + " 不在选项里" });
      }
    }
  }
  return out;
}

/** Nodes that are still on the canvas but have a pin wired to nothing. */
export function danglingNodeIds(graph: FlowGraph): string[] {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const hit = new Set<string>();
  for (const edge of danglingEdges(graph)) {
    const from = pinNode(edge.from);
    const to = pinNode(edge.to);
    if (ids.has(from)) hit.add(from);
    if (ids.has(to)) hit.add(to);
  }
  return [...hit];
}

/** Add one wire when the specs allow it. A convertible pair inserts a pure cast instead of a direct wire. */
export function connectPins(
  graph: FlowGraph,
  from: string,
  fromPin: string,
  to: string,
  toPin: string,
  specs: Map<string, NodeSpec>,
): { ok: true; graph: FlowGraph } | { ok: false; code: Diagnostic["code"] } {
  const source = from + "." + fromPin;
  const target = to + "." + toPin;
  if (graph.edges.some((edge) => edge.from === source && edge.to === target)) return { ok: true, graph };
  const fromNode = graph.nodes.find((node) => node.id === from);
  const toNode = graph.nodes.find((node) => node.id === to);
  const srcType = pinFace(fromNode, specs.get(fromNode?.type ?? ""), fromPin)?.type;
  const dstType = pinFace(toNode, specs.get(toNode?.type ?? ""), toPin)?.type;
  const cast = conversionFor(srcType, dstType);
  const next: FlowGraph = cast ? insertCast(graph, from, fromPin, to, toPin, cast) : { ...graph, edges: [...graph.edges, { from: source, to: target }] };
  const hit = diagnose(next, undefined, specs).find((item) => item.code === "E110" || item.code === "E111" || item.code === "E112" || item.code === "E113" || item.code === "E114" || item.code === "E115");
  if (hit) return { ok: false, code: hit.code };
  return { ok: true, graph: next };
}

function insertCast(graph: FlowGraph, from: string, fromPin: string, to: string, toPin: string, type: string): FlowGraph {
  const used = new Set(graph.nodes.map((node) => node.id));
  let n = 1;
  while (used.has("n" + n)) n += 1;
  const id = "n" + n;
  return {
    ...graph,
    nodes: [...graph.nodes, { id, type }],
    edges: [...graph.edges, { from: from + "." + fromPin, to: id + ".value" }, { from: id + ".result", to: to + "." + toPin }],
  };
}

/** Hover text while dragging a wire. A compatible pin is ✓. A cast that will be inserted is ✓ plus the call. */
export function connectionHint(
  graph: FlowGraph,
  from: string,
  fromPin: string,
  to: string,
  toPin: string,
  specs: Map<string, NodeSpec>,
): string {
  if (!from || !to || !fromPin || !toPin || from === to) return "";
  const source = from + "." + fromPin;
  const target = to + "." + toPin;
  if (graph.edges.some((edge) => edge.from === source && edge.to === target)) return "✓";
  const fromNode = graph.nodes.find((node) => node.id === from);
  const toNode = graph.nodes.find((node) => node.id === to);
  const srcType = pinFace(fromNode, specs.get(fromNode?.type ?? ""), fromPin)?.type;
  const dstType = pinFace(toNode, specs.get(toNode?.type ?? ""), toPin)?.type;
  const cast = conversionFor(srcType, dstType);
  const next: FlowGraph = cast ? insertCast(graph, from, fromPin, to, toPin, cast) : { ...graph, edges: [...graph.edges, { from: source, to: target }] };
  const hit = diagnose(next, undefined, specs).find((item) => item.code === "E110" || item.code === "E111" || item.code === "E112" || item.code === "E113" || item.code === "E114" || item.code === "E115");
  if (hit) return hit.code + " " + hit.message;
  if (cast === "math.float") return "✓ float()";
  if (cast === "math.int") return "✓ int()";
  if (cast === "math.str") return "✓ str()";
  if (cast === "math.bool") return "✓ bool()";
  return "✓";
}
