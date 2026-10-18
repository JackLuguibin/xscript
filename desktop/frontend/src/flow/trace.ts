/** Trace lines from a debug compile. The device poller is separate; this reads the same text. */

export const TRACE_MARK = "\x1fXF";
export const RUN_KEEP_MS = 5 * 60 * 1000;

export type RunStatus = "idle" | "queued" | "running" | "success" | "error" | "skipped" | "paused";

export interface TraceEvent {
  kind: "enter" | "exit" | "span" | "loop" | "error" | "queue" | "skip" | "pause";
  node: string;
  text: string;
}

export interface NodeRun {
  status: Exclude<RunStatus, "idle">;
  summary: string;
  count: number;
}

export interface TracePicture {
  nodes: Record<string, NodeRun>;
  running: string | null;
  user: string[];
  truncated: boolean;
}

const KINDS = new Set<TraceEvent["kind"]>(["enter", "exit", "span", "loop", "error", "queue", "skip", "pause"]);

export function parseTraceLine(line: string): TraceEvent | null {
  if (!line.startsWith(TRACE_MARK + "\t")) return null;
  const parts = line.split("\t");
  const kind = parts[1] as TraceEvent["kind"];
  const node = parts[2] ?? "";
  if (!KINDS.has(kind) || !node) return null;
  return { kind, node, text: parts.slice(3).join("\t") };
}

/** Pull `# seq N` cursors out of a pasted `/logs` dump. Other lines stay user text or trace events. */
export function readTrace(log: string): { events: TraceEvent[]; user: string[]; seqs: number[] } {
  const events: TraceEvent[] = [];
  const user: string[] = [];
  const seqs: number[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (!line) continue;
    const seq = /^# seq (\d+)$/.exec(line);
    if (seq) {
      seqs.push(Number(seq[1]));
      continue;
    }
    const event = parseTraceLine(line);
    if (event) events.push(event);
    else user.push(line);
  }
  return { events, user, seqs };
}

export function pictureOf(events: readonly TraceEvent[]): TracePicture {
  const nodes: Record<string, NodeRun> = {};
  let running: string | null = null;
  for (const event of events) {
    const prev = nodes[event.node] ?? { status: "success" as const, summary: "", count: 0 };
    if (event.kind === "enter") {
      nodes[event.node] = { status: "running", summary: prev.summary, count: prev.count };
      running = event.node;
    } else if (event.kind === "exit" || event.kind === "span") {
      nodes[event.node] = { status: "success", summary: event.text, count: prev.count };
      if (running === event.node) running = null;
    } else if (event.kind === "loop") {
      const count = Number(event.text);
      nodes[event.node] = {
        status: "success",
        summary: event.text,
        count: Number.isFinite(count) ? count : prev.count + 1,
      };
      if (running === event.node) running = null;
    } else if (event.kind === "error") {
      nodes[event.node] = { status: "error", summary: event.text, count: prev.count };
      if (running === event.node) running = null;
    } else if (event.kind === "queue") {
      nodes[event.node] = { status: "queued", summary: prev.summary, count: prev.count };
    } else if (event.kind === "skip") {
      nodes[event.node] = { status: "skipped", summary: event.text, count: prev.count };
    } else {
      nodes[event.node] = { status: "paused", summary: prev.summary, count: prev.count };
      running = event.node;
    }
  }
  return { nodes, running, user: [], truncated: false };
}

export function seqGap(seqs: readonly number[]): boolean {
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] !== seqs[i - 1] + 1) return true;
  }
  return false;
}

/** Last-run colours stay up for five minutes after the run ends, then drop. */
export function runKept(endedAt: number, now: number, keepMs = RUN_KEEP_MS): boolean {
  return now - endedAt < keepMs;
}

/** Exec edges dash only while a node is inside `enter`, motion is allowed, and the graph is within the large-graph line. */
export function flowEdges(running: string | null, nodeCount: number, reducedMotion: boolean): boolean {
  return running !== null && nodeCount <= 300 && !reducedMotion;
}

/** How often the flow page asks `device.logs` while following. */
export const LOG_POLL_MS = 300;

export interface LogRow {
  seq: number;
  line: string;
}

export interface LogCursor {
  next: number | null;
  trace: string;
  user: string[];
  gap: boolean;
}

export const emptyLogCursor = (): LogCursor => ({ next: null, trace: "", user: [], gap: false });

/** Merge one `/logs` page. Trace lines stay out of the user log. A backwards cursor starts over. A skipped seq is a gap. */
export function followLogs(state: LogCursor, page: { entries: readonly LogRow[]; next: number }, keep = 200): LogCursor {
  if (state.next !== null && page.next < state.next) return followLogs(emptyLogCursor(), page, keep);
  let gap = state.gap;
  let expect = state.next;
  const traceLines: string[] = [];
  const user = [...state.user];
  for (const row of page.entries) {
    if (expect !== null && row.seq !== expect + 1) gap = true;
    expect = row.seq;
    if (parseTraceLine(row.line)) traceLines.push("# seq " + row.seq, row.line);
    else if (row.line.trim()) user.push(row.line);
  }
  const trace = [state.trace, ...traceLines].filter(Boolean).join("\n");
  return { next: page.next, trace, user: user.slice(-keep), gap };
}
