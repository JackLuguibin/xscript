import type { FlowGraph, NodeSpec } from "./dsl";
import { addConnectedNode, menuTree, type MenuGroup, type MenuSpec } from "./search";

export const NODE_DRAG = "application/x-xflow-node";
export const TEMPLATE_KEY = "xscript.customNodes";

export interface PaletteDrag {
  kind: "spec" | "call" | "custom";
  type: string;
  title?: string;
}

export interface UserTemplate {
  name: string;
  title: string;
}

const FAMILIES = [
  { id: "flow", categories: ["flow", "event", "code"] },
  { id: "action", categories: ["action", "ime", "screen", "ui"] },
  { id: "find", categories: ["find", "node", "tree", "xpath", "image"] },
  { id: "data", categories: ["data", "dict", "json", "list", "string", "math", "logic", "time"] },
  { id: "device", categories: ["cloud", "models", "onnx", "paddle", "pip", "system", "yolo"] },
] as const;

export type FamilyId = (typeof FAMILIES)[number]["id"] | "other";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Catalog folded into a few families, with leftover categories kept together. */
export function paletteTree(specs: readonly MenuSpec[], recent: readonly string[]): {
  recent: MenuSpec[];
  families: Array<{ id: FamilyId; groups: MenuGroup[] }>;
} {
  const tree = menuTree(specs, recent);
  const used = new Set<string>();
  const families: Array<{ id: FamilyId; groups: MenuGroup[] }> = [];
  for (const family of FAMILIES) {
    const groups = tree.groups.filter((group) => (family.categories as readonly string[]).includes(group.category));
    if (!groups.length) continue;
    for (const group of groups) used.add(group.category);
    families.push({ id: family.id, groups });
  }
  const other = tree.groups.filter((group) => !used.has(group.category));
  if (other.length) families.push({ id: "other", groups: other });
  return { recent: tree.recent, families };
}

/** Add an empty function the user can drag back onto the canvas as a call. */
export function addUserFunction(graph: FlowGraph, name: string): FlowGraph | null {
  const trimmed = name.trim();
  if (!NAME.test(trimmed)) return null;
  if (graph.nodes.some((node) => node.id === trimmed)) return null;
  return { ...graph, nodes: [...graph.nodes, { id: trimmed, type: "flow.def", config: { params: "" } }] };
}

export function userFunctions(graph: FlowGraph): Array<{ id: string; kind: "def" | "macro" }> {
  return graph.nodes
    .filter((node) => node.type === "flow.def" || node.type === "flow.macro")
    .map((node) => ({ id: node.id, kind: node.type === "flow.macro" ? "macro" as const : "def" as const }));
}

export function rememberTemplate(list: readonly UserTemplate[], name: string, title?: string): UserTemplate[] {
  const trimmed = name.trim();
  if (!NAME.test(trimmed)) return [...list];
  if (list.some((item) => item.name === trimmed)) return [...list];
  return [...list, { name: trimmed, title: (title ?? trimmed).trim() || trimmed }];
}

function freshId(graph: FlowGraph): string {
  const used = new Set(graph.nodes.map((node) => node.id));
  let n = 1;
  while (used.has("n" + n)) n += 1;
  return "n" + n;
}

/** Place a catalog node, a call to a user function, or a saved custom node. */
export function dropPalette(
  graph: FlowGraph,
  specs: Map<string, NodeSpec>,
  drag: PaletteDrag,
): { graph: FlowGraph; id: string; title?: string } | null {
  if (drag.kind === "spec") {
    if (!specs.has(drag.type)) return null;
    const added = addConnectedNode(graph, drag.type, specs);
    return { graph: added.graph, id: added.id };
  }
  if (drag.kind === "call") {
    const owner = graph.nodes.find((node) => node.id === drag.type && (node.type === "flow.def" || node.type === "flow.macro"));
    if (!owner) return null;
    const id = freshId(graph);
    return { id, graph: { ...graph, nodes: [...graph.nodes, { id, type: "flow.call", config: { callee: drag.type } }] } };
  }
  if (drag.kind === "custom") {
    const id = freshId(graph);
    const title = drag.title?.trim() || drag.type;
    return { id, title, graph: { ...graph, nodes: [...graph.nodes, { id, type: "code.python", config: { source: "" } }] } };
  }
  return null;
}

export function readTemplates(): UserTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as UserTemplate[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && NAME.test(item.name) && typeof item.title === "string");
  } catch {
    return [];
  }
}

export function writeTemplates(list: readonly UserTemplate[]): void {
  try {
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(list));
  } catch {
    // Private mode can refuse storage. The list still lives for this session.
  }
}

/** Where a key moves the focus in the palette's flat list of visible rows, or null when the key does not move it. */
export function paletteStep(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
