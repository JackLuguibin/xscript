// Turn a control picked on the screen page into "find it, and click it when found" on the canvas.
// Text that only this control has on the screen → the native node.find node (editable in the inspector). Otherwise
// (no text, or a list where several rows share it) → a code node with a Selector chain that finds only this control,
// since node.find only searches by text and would take the first match.
import { nodeLabel, selectorChain, type UiNode } from "../ui-tree";
import type { CanvasPick } from "./inbox";
import type { FlowGraph, NodeSpec } from "./dsl";

export interface TreeDrop {
  graph: FlowGraph;
  ids: string[];
  /** The exec pin the new chain hangs off, or null when it was left floating. */
  attached: string | null;
  label: string;
}

function freshId(graph: FlowGraph, base: string, taken: Set<string>): string {
  const used = new Set([...graph.nodes.map((node) => node.id), ...taken]);
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = base + "_" + n;
  taken.add(id);
  return id;
}

const CONTINUE = ["then", "completed"];

/** Where the main chain ends: follow then/completed from start; the last node's free continuation pin. */
export function chainTail(graph: FlowGraph, specs: Map<string, NodeSpec>): string | null {
  const seen = new Set<string>();
  let id = "start";
  for (;;) {
    if (seen.has(id)) return null;
    seen.add(id);
    const node = graph.nodes.find((item) => item.id === id);
    if (!node) return null;
    const outs = node.type === "event.start" ? ["then"] : (specs.get(node.type)?.exec.out ?? []);
    // A branch's `then` (or any extra exit like timeout / failed) is conditional: the main line ends there.
    if (node.type === "flow.branch" || outs.some((name) => !CONTINUE.includes(name) && name !== "body")) return null;
    const pin = outs.find((name) => CONTINUE.includes(name));
    if (!pin) return null;
    const edge = graph.edges.find((item) => item.from === id + "." + pin);
    if (!edge) return id + "." + pin;
    if (!edge.to.endsWith(".exec")) return null;
    id = edge.to.slice(0, edge.to.length - ".exec".length);
  }
}

export function dropTreeNode(graph: FlowGraph, pick: UiNode & Pick<CanvasPick, "where">, specs: Map<string, NodeSpec>): TreeDrop {
  const taken = new Set<string>();
  const find = freshId(graph, "find", taken);
  const ok = freshId(graph, "found", taken);
  const tap = freshId(graph, "tap", taken);
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const text = (pick.text ?? "").trim();
  let hit: string;
  let found: string;
  // Picks without `where` (queued without a tree) keep the old rule: any text goes to node.find.
  const byText = !!text && (pick.where ? pick.where.textUnique : true);
  if (byText) {
    nodes.push({ id: find, type: "node.find", inputs: { text, timeout: 5 } });
    hit = find + ".node";
    found = find + ".found";
  } else {
    const why = pick.where?.why ? [pick.where.why] : [];
    const source = ["from xscript.android import node as xs_node", ...why, "hit = " + (pick.where ? "xs_node.Selector()" + pick.where.chain : selectorChain(pick, "xs_node")) + ".find(timeout=5)", "found = hit is not None"].join("\n");
    nodes.push({ id: find, type: "code.python", config: { source, outPins: "hit:node?, found:bool" } });
    hit = find + ".hit";
    found = find + ".found";
  }
  nodes.push({ id: ok, type: "flow.branch" }, { id: tap, type: "action.click" });
  edges.push(
    { from: find + ".then", to: ok + ".exec" },
    { from: found, to: ok + ".cond" },
    { from: ok + ".then", to: tap + ".exec" },
    { from: hit, to: tap + ".target" },
  );
  const attached = chainTail(graph, specs);
  if (attached) edges.push({ from: attached, to: find + ".exec" });
  return { graph: { ...graph, nodes, edges }, ids: [find, ok, tap], attached, label: nodeLabel(pick) };
}
