import { connectPins } from "./diagnostics";
import type { FlowGraph, NodeSpec } from "./dsl";

export interface MenuSpec {
  type: string;
  category: string;
  alias: string;
  title: string;
  execIn: string[];
  inputs: Array<{ name: string; type?: string }>;
  outputs: Array<{ name: string; type?: string }>;
}

function typesOk(from: string | undefined, to: string | undefined): boolean {
  if (!from || !to || from === "any" || to === "any") return true;
  const base = (type: string) => type.replace(/\?$/, "");
  const a = base(from);
  const b = base(to);
  if (a === b) return true;
  return (a === "int" || a === "float") && (b === "int" || b === "float");
}

/** Category search with a prefix boost and a recent-use boost. Empty query lists everything, recents first. */
export function searchNodes(query: string, specs: readonly MenuSpec[], recent: readonly string[]): MenuSpec[] {
  const q = query.trim().toLowerCase();
  const ranked = specs
    .map((spec) => {
      const hay = (spec.title + " " + spec.alias + " " + spec.category + " " + spec.type).toLowerCase();
      let score = 0;
      if (!q) score = 1;
      else if (spec.alias.toLowerCase().startsWith(q) || spec.title.toLowerCase().startsWith(q)) score = 3;
      else if (hay.includes(q)) score = 2;
      if (score > 0 && recent.includes(spec.type)) score += 1;
      return { spec, score };
    })
    .filter((item) => item.score > 0);
  ranked.sort((a, b) => b.score - a.score || a.spec.title.localeCompare(b.spec.title, "zh"));
  return ranked.map((item) => item.spec);
}

export interface MenuGroup {
  category: string;
  specs: MenuSpec[];
}

/** Empty-query browse tree. Recent types stay in their category as well. */
export function menuTree(specs: readonly MenuSpec[], recent: readonly string[]): { recent: MenuSpec[]; groups: MenuGroup[] } {
  const byType = new Map(specs.map((spec) => [spec.type, spec]));
  const seen = new Set<string>();
  const recentSpecs: MenuSpec[] = [];
  for (const type of recent) {
    const spec = byType.get(type);
    if (!spec || seen.has(type)) continue;
    seen.add(type);
    recentSpecs.push(spec);
  }
  const grouped = new Map<string, MenuSpec[]>();
  const ordered = [...specs].sort((a, b) => a.title.localeCompare(b.title, "zh") || a.type.localeCompare(b.type));
  for (const spec of ordered) {
    const list = grouped.get(spec.category) ?? [];
    list.push(spec);
    grouped.set(spec.category, list);
  }
  const names = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  return { recent: recentSpecs, groups: names.map((category) => ({ category, specs: grouped.get(category) ?? [] })) };
}

/** Specs that can accept a wire dropped from `pin` of `from`. */
export function specsForSource(from: NodeSpec | undefined, pin: string, specs: readonly MenuSpec[]): MenuSpec[] {
  if (!from) return [...specs];
  if (from.exec.out.includes(pin)) return specs.filter((spec) => spec.execIn.length > 0);
  const output = from.outputs.find((item) => item.name === pin);
  if (!output) return [];
  return specs.filter((spec) => spec.inputs.some((input) => typesOk(output.type, input.type)));
}

/** Insert a node and, when a wire was dropped, connect the first compatible pin. */
export function addConnectedNode(
  graph: FlowGraph,
  type: string,
  specs: Map<string, NodeSpec>,
  link?: { from: string; pin: string },
): { graph: FlowGraph; id: string } {
  const used = new Set(graph.nodes.map((node) => node.id));
  let n = 1;
  while (used.has("n" + n)) n += 1;
  const id = "n" + n;
  const created = specs.get(type);
  const inputs: Record<string, string | number | boolean | null> = {};
  for (const pin of created?.inputs ?? []) {
    if (pin.default !== undefined) inputs[pin.name] = pin.default;
  }
  const node: FlowGraph["nodes"][number] = { id, type };
  if (Object.keys(inputs).length) node.inputs = inputs;
  let next: FlowGraph = { ...graph, nodes: [...graph.nodes, node] };
  if (!link) return { graph: next, id };
  const source = specs.get(graph.nodes.find((item) => item.id === link.from)?.type ?? "");
  if (source?.exec.out.includes(link.pin) && created?.exec.in[0]) {
    const wired = connectPins(next, link.from, link.pin, id, created.exec.in[0], specs);
    if (wired.ok) next = wired.graph;
  } else {
    const output = source?.outputs.find((pin) => pin.name === link.pin);
    const input = created?.inputs.find((pin) => typesOk(output?.type, pin.type));
    if (output && input) {
      const wired = connectPins(next, link.from, link.pin, id, input.name, specs);
      if (wired.ok) next = wired.graph;
    }
  }
  return { graph: next, id };
}

/** Node ids whose id, type, comment, or literal values contain the query. */
export function findInGraph(graph: FlowGraph, query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return graph.nodes
    .filter((node) => node.id !== "start")
    .filter((node) => {
      const bits = [node.id, node.type, node.meta?.comment ?? ""];
      for (const value of Object.values(node.inputs ?? {})) bits.push(String(value ?? ""));
      for (const value of Object.values(node.config ?? {})) bits.push(String(value ?? ""));
      return bits.some((bit) => bit.toLowerCase().includes(needle));
    })
    .map((node) => node.id);
}

/** The flow name, then each function or macro, for Ctrl+P. */
export function jumpTargets(graph: FlowGraph): Array<{ id: string; kind: "flow" | "def" }> {
  const defs = graph.nodes
    .filter((node) => node.type === "flow.def" || node.type === "flow.macro")
    .map((node) => ({ id: node.id, kind: "def" as const }));
  return [{ id: graph.name, kind: "flow" }, ...defs];
}
