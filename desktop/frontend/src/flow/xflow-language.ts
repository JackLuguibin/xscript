import type { FlowGraph, NodeSpec } from "./dsl";

/** Words the flow text treats as syntax (design §8.5). */
export const XFLOW_KEYWORDS = [
  "flow", "on", "start", "if", "else", "for", "in", "range", "while", "break", "continue", "fail", "try", "except",
  "parallel", "branch", "match", "def", "macro", "call", "return", "let", "var", "env", "secret",
  "floating", "label", "goto", "max", "seq", "step",
] as const;

export type XToken = "keyword" | "alias" | "string" | "number" | "ref" | "comment" | "ident";

const KEYWORD_SET = new Set<string>(XFLOW_KEYWORDS);

/** Classify one source token. Strings and comments win over words. */
export function classifyToken(token: string, aliases: ReadonlySet<string>): XToken {
  if (token.startsWith("#")) return "comment";
  if (token.startsWith('"') || token.startsWith("'")) return "string";
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return "number";
  if (KEYWORD_SET.has(token)) return "keyword";
  if (aliases.has(token)) return "alias";
  if (/^[A-Za-z_][A-Za-z0-9_.]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return "ref";
  return "ident";
}

/** Aliases, keywords, pin names, and node ids that start with the prefix. `id.pin` lists that node's outputs, filtered by `want` when the call pin has a type. */
export function completeXflow(
  prefix: string,
  aliases: readonly string[],
  ids: readonly string[],
  scope?: { pins?: readonly string[]; refs?: ReadonlyArray<{ id: string; pin: string; type?: string }>; want?: string },
): string[] {
  if (!prefix) return [];
  const dot = prefix.indexOf(".");
  if (dot > 0) {
    const id = prefix.slice(0, dot);
    const rest = prefix.slice(dot + 1);
    return (scope?.refs ?? [])
      .filter((ref) => ref.id === id && ref.pin.startsWith(rest) && typeOk(ref.type, scope?.want))
      .map((ref) => ref.id + "." + ref.pin)
      .sort();
  }
  const pool = new Set<string>([...XFLOW_KEYWORDS, ...aliases, ...ids, ...(scope?.pins ?? [])]);
  return [...pool].filter((item) => item.startsWith(prefix)).sort();
}

function typeOk(from: string | undefined, to: string | undefined): boolean {
  if (!to) return true;
  if (!from || from === "any" || to === "any") return true;
  const base = (type: string) => type.replace(/\?$/, "");
  const left = base(from);
  const right = base(to);
  if (left === right) return true;
  return (left === "int" || left === "float") && (right === "int" || right === "float");
}

/** Output pins a later node can reference. */
export function outputRefs(graph: FlowGraph, specs: Map<string, NodeSpec>): Array<{ id: string; pin: string; type?: string }> {
  const refs: Array<{ id: string; pin: string; type?: string }> = [];
  for (const node of graph.nodes) {
    const spec = specs.get(node.type);
    if (!spec) continue;
    for (const pin of spec.outputs) refs.push({ id: node.id, pin: pin.name, type: pin.type });
  }
  return refs;
}

/** `node.pin` → type, for hover. */
export function pinTypes(graph: FlowGraph, specs: Map<string, NodeSpec>): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of graph.nodes) {
    const spec = specs.get(node.type);
    if (!spec) continue;
    for (const pin of spec.inputs) map.set(node.id + "." + pin.name, pin.type ?? "any");
    for (const pin of spec.outputs) map.set(node.id + "." + pin.name, pin.type ?? "any");
  }
  return map;
}

/** The pin type being filled at the end of `before`, such as `click(target=`. */
export function wantedPinType(before: string, specs: Iterable<NodeSpec>): string | undefined {
  const hit = /([A-Za-z_][A-Za-z0-9_.]*)\((?:[^()]*,\s*)?([A-Za-z_][A-Za-z0-9_]*)=\s*[A-Za-z0-9_.]*$/.exec(before);
  if (!hit) return undefined;
  for (const spec of specs) {
    if (spec.dsl.alias !== hit[1]) continue;
    return spec.inputs.find((pin) => pin.name === hit[2])?.type;
  }
  return undefined;
}

/** Chinese title and doc for an alias. A `node.pin` also shows its type and the latest run value. */
export function hoverXflow(
  word: string,
  specs: Iterable<NodeSpec & { title?: { zh?: string }; doc?: { zh?: string } }>,
  extra?: { runs?: Record<string, string>; pins?: ReadonlyMap<string, string> },
): string | null {
  const pinType = extra?.pins?.get(word);
  if (pinType) {
    const value = extra?.runs?.[word] ?? extra?.runs?.[word.split(".")[0] ?? ""];
    return word + " " + pinType + " = " + (value || "尚未执行");
  }
  for (const spec of specs) {
    if (spec.dsl.alias !== word) continue;
    const title = spec.title?.zh ?? spec.dsl.alias;
    const doc = spec.doc?.zh ?? "";
    return doc ? title + " — " + doc : title;
  }
  return null;
}

/** Node id a reference points at, when that id exists. */
export function definitionOf(token: string, ids: readonly string[]): string | null {
  const head = token.split(".")[0] ?? "";
  return ids.includes(head) ? head : null;
}

/** Other nodes named by `id.pin` in one statement. */
export function statementRefs(line: string, ids: readonly string[]): string[] {
  const label = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line.trim())?.[1];
  const found: string[] = [];
  for (const match of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*/g)) {
    const id = match[1] ?? "";
    if (id && id !== label && ids.includes(id) && !found.includes(id)) found.push(id);
  }
  return found;
}

/** Latest run summaries, read by the Monaco hover provider. */
export const xflowContext: { runs: Record<string, string>; locate: (id: string) => void } = {
  runs: {},
  locate: () => undefined,
};
