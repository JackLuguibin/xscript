import type { TraceEvent } from "./trace";

/** One recorded run. Columns match design §10.1 `runs` / `run_nodes`. */
export interface FlowRun {
  id: number;
  flow: string;
  started_at: number;
  ended_at: number;
  status: "success" | "error";
  error_node: string;
  error_line: number | null;
  nodes: Array<{ seq: number; node: string; enter_ms: number | null; exit_ms: number | null; summary: string }>;
}

const KEY = "xscript.flow.runs";
const CAP = 20;

export function buildRun(
  flow: string,
  events: readonly TraceEvent[],
  id: number,
  startedAt: number,
  endedAt: number,
): FlowRun {
  const nodes: FlowRun["nodes"] = [];
  const at = new Map<string, number>();
  let errorNode = "";
  for (const event of events) {
    let index = at.get(event.node);
    if (index === undefined) {
      index = nodes.length;
      at.set(event.node, index);
      nodes.push({ seq: index + 1, node: event.node, enter_ms: null, exit_ms: null, summary: "" });
    }
    const row = nodes[index];
    if (!row) continue;
    const ms = Number(event.text);
    if (event.kind === "enter") {
      if (Number.isFinite(ms)) row.enter_ms = ms;
    } else if (event.kind === "exit") {
      if (Number.isFinite(ms)) row.exit_ms = ms;
    } else if (event.text) {
      row.summary = event.text;
    }
    if (event.kind === "error" && !errorNode) errorNode = event.node;
  }
  return {
    id,
    flow,
    started_at: startedAt,
    ended_at: endedAt,
    status: errorNode ? "error" : "success",
    error_node: errorNode,
    error_line: null,
    nodes,
  };
}

/**
 * One history row: flow, status word, the steps in order, and for a failed run the failing step with its message
 * (e.g. "daily 出错 warm → tap · tap：missing"). `word` maps the status to the UI text.
 */
export function runLine(run: FlowRun, word: (status: FlowRun["status"]) => string): string {
  const steps = run.nodes.map((node) => node.node).join(" → ");
  let line = [run.flow, word(run.status), steps].filter(Boolean).join(" ");
  if (run.status === "error" && run.error_node) {
    const summary = run.nodes.find((node) => node.node === run.error_node)?.summary ?? "";
    line += " · " + run.error_node + (summary ? "：" + summary : "");
  }
  return line;
}

export function rememberRun(runs: readonly FlowRun[], run: FlowRun, cap = CAP): FlowRun[] {
  return [run, ...runs.filter((item) => item.id !== run.id)].slice(0, cap);
}

export function readRuns(): FlowRun[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FlowRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeRuns(runs: readonly FlowRun[]): void {
  localStorage.setItem(KEY, JSON.stringify(runs.slice(0, CAP)));
}
