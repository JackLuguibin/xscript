import type { FlowEnv, FlowGraph, FlowVariable } from "./dsl";
import { readLocals } from "./dsl";

export interface VarRow {
  kind: "flow" | "env" | "param" | "local" | "loop";
  name: string;
  type: string;
  detail: string;
  writable: boolean;
  doc?: string;
  category?: string;
  editable?: boolean;
}

export function variableRows(graph: FlowGraph): VarRow[] {
  const rows: VarRow[] = [];
  for (const variable of graph.variables ?? []) {
    rows.push({
      kind: "flow",
      name: variable.name,
      type: variable.type,
      detail: JSON.stringify(variable.default ?? null),
      writable: true,
      doc: variable.doc,
      category: variable.category,
      editable: variable.editable,
    });
  }
  for (const item of graph.env ?? []) {
    rows.push({ kind: "env", name: item.name, type: "string", detail: item.secret ? "secret" : "", writable: false });
  }
  for (const param of graph.params ?? []) {
    rows.push({ kind: "param", name: param.name, type: param.type, detail: JSON.stringify(param.default ?? null), writable: false });
  }
  for (const node of graph.nodes) {
    if (node.type !== "flow.def" && node.type !== "flow.macro") continue;
    const names = String(node.config?.params ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const name of names) rows.push({ kind: "local", name, type: "any", detail: node.id, writable: true });
    for (const local of readLocals(node)) rows.push({ kind: "local", name: local.name, type: local.type, detail: node.id, writable: true });
  }
  for (const node of graph.nodes) {
    if (node.type !== "flow.for_range" && node.type !== "flow.for_each") continue;
    rows.push({ kind: "loop", name: node.id, type: node.type === "flow.for_range" ? "int" : "any", detail: node.type, writable: false });
  }
  return rows;
}

function freshId(graph: FlowGraph): string {
  const used = new Set(graph.nodes.map((node) => node.id));
  let n = 1;
  while (used.has("n" + n)) n += 1;
  return "n" + n;
}

export function addFlowVariable(graph: FlowGraph, variable: FlowVariable): FlowGraph {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) return graph;
  if ((graph.variables ?? []).some((item) => item.name === variable.name)) return graph;
  if ((graph.env ?? []).some((item) => item.name === variable.name)) return graph;
  if ((graph.params ?? []).some((item) => item.name === variable.name)) return graph;
  return { ...graph, variables: [...(graph.variables ?? []), variable] };
}

export function addEnvBinding(graph: FlowGraph, item: FlowEnv): FlowGraph {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name)) return graph;
  if ((graph.env ?? []).some((env) => env.name === item.name)) return graph;
  if ((graph.variables ?? []).some((variable) => variable.name === item.name)) return graph;
  if ((graph.params ?? []).some((param) => param.name === item.name)) return graph;
  return { ...graph, env: [...(graph.env ?? []), { name: item.name, secret: item.secret }] };
}

export function addProjectParam(graph: FlowGraph, param: FlowVariable): FlowGraph {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param.name)) return graph;
  if ((graph.params ?? []).some((item) => item.name === param.name)) return graph;
  if ((graph.variables ?? []).some((item) => item.name === param.name)) return graph;
  if ((graph.env ?? []).some((item) => item.name === param.name)) return graph;
  return { ...graph, params: [...(graph.params ?? []), param] };
}

export function addLocal(graph: FlowGraph, scope: string, local: FlowVariable): FlowGraph {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(local.name)) return graph;
  const owner = graph.nodes.find((node) => node.id === scope && (node.type === "flow.def" || node.type === "flow.macro"));
  if (!owner) return graph;
  const params = String(owner.config?.params ?? "")
    .split(",")
    .map((part) => part.trim());
  if (params.includes(local.name) || readLocals(owner).some((item) => item.name === local.name)) return graph;
  const next = graph.nodes.map((node) => {
    if (node.id !== owner.id) return node;
    const list = [...readLocals(node), local];
    return { ...node, config: { ...(node.config ?? {}), locals: JSON.stringify(list) } };
  });
  return { ...graph, nodes: next };
}

/** Values a run dialog would pass for instance-editable variables. A blank override keeps the default. */
export function runPayload(graph: FlowGraph, overrides: Record<string, string>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const variable of graph.variables ?? []) {
    if (!variable.editable) continue;
    const raw = overrides[variable.name];
    if (raw === undefined || raw === "") {
      out[variable.name] = variable.default ?? null;
      continue;
    }
    if (variable.type === "int") {
      const value = Number.parseInt(raw, 10);
      out[variable.name] = Number.isNaN(value) ? (variable.default ?? null) : value;
    } else if (variable.type === "float") {
      const value = Number.parseFloat(raw);
      out[variable.name] = Number.isNaN(value) ? (variable.default ?? null) : value;
    } else if (variable.type === "bool") out[variable.name] = raw === "true";
    else out[variable.name] = raw;
  }
  return out;
}

export function insertGet(graph: FlowGraph, name: string): FlowGraph {
  return { ...graph, nodes: [...graph.nodes, { id: freshId(graph), type: "data.get", inputs: { name } }] };
}

export function insertSet(graph: FlowGraph, name: string): FlowGraph {
  return { ...graph, nodes: [...graph.nodes, { id: freshId(graph), type: "data.set", inputs: { name } }] };
}

export const VAR_DRAG = "application/x-xflow-var";

export interface VarDrag {
  name: string;
  writable: boolean;
}

/** Plain drop inserts a get. Alt drop inserts a set when the variable is writable. */
export function dropVariable(graph: FlowGraph, drag: VarDrag, alt: boolean): { graph: FlowGraph; id: string } {
  const id = freshId(graph);
  const type = alt && drag.writable ? "data.set" : "data.get";
  return { id, graph: { ...graph, nodes: [...graph.nodes, { id, type, inputs: { name: drag.name } }] } };
}
