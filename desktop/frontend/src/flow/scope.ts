import type { FlowGraph } from "./dsl";

function reached(graph: FlowGraph, root: string): Set<string> {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    for (const edge of graph.edges) {
      if (edge.from.startsWith(id + ".")) stack.push(edge.to.slice(0, edge.to.indexOf(".")));
    }
  }
  return seen;
}

/** Node ids drawn for the whole flow, or for one function. The start node is never drawn. */
export function scopeNodeIds(graph: FlowGraph, scope: string | null): string[] {
  const defs = graph.nodes.filter((node) => node.type === "flow.def" || node.type === "flow.macro");
  if (scope) {
    const owner = defs.find((node) => node.id === scope);
    if (!owner) return graph.nodes.filter((node) => node.id !== "start").map((node) => node.id);
    return [...reached(graph, scope)];
  }
  const hidden = new Set<string>();
  for (const def of defs) {
    for (const id of reached(graph, def.id)) {
      if (id !== def.id) hidden.add(id);
    }
  }
  return graph.nodes.filter((node) => node.id !== "start" && !hidden.has(node.id)).map((node) => node.id);
}

/** The function a node opens, when it is a def, a macro, or a call to one. */
export function enterableScope(graph: FlowGraph, id: string): string | null {
  const node = graph.nodes.find((item) => item.id === id);
  if (!node) return null;
  if (node.type === "flow.def" || node.type === "flow.macro") return node.id;
  if (node.type !== "flow.call") return null;
  const callee = String(node.config?.callee ?? "");
  return graph.nodes.some((item) => item.id === callee && (item.type === "flow.def" || item.type === "flow.macro")) ? callee : null;
}
