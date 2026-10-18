import { literalPreview, stepSnippet } from "./step";
import { TRACE_MARK, type TraceEvent } from "./trace";
import type { FlowGraph, FlowNode, NodeSpec } from "./dsl";

/** A value the desktop runner can keep. Lists are only for `for each`. */
type Lit = string | number | boolean | null | Lit[];

type PauseKind = "breakpoint" | "step";

interface ForFrame {
  kind: "for";
  id: string;
  index: number;
  end: number;
  body: string | null;
  completed: string | null;
}

interface EachFrame {
  kind: "each";
  id: string;
  items: Lit[];
  index: number;
  body: string | null;
  completed: string | null;
}

interface WhileFrame {
  kind: "while";
  id: string;
  max: number;
  count: number;
  body: string | null;
  completed: string | null;
}

interface RetryFrame {
  kind: "retry";
  id: string;
  left: number;
  body: string | null;
  ok: string | null;
  failed: string | null;
}

interface CallFrame {
  kind: "call";
  next: string | null;
  signal: "break" | "continue" | "fail" | null;
}

interface ArmFrame {
  kind: "arm";
}

interface SeqFrame {
  kind: "seq";
  rest: string[];
  next: string | null;
}

type Frame = ForFrame | EachFrame | WhileFrame | RetryFrame | CallFrame | ArmFrame | SeqFrame;

export interface FlowDebug {
  status: "paused" | "done" | "error" | "stopped";
  at: string | null;
  pause: PauseKind | null;
  /** Stable reason. The page turns it into a sentence. */
  detail: string;
  events: TraceEvent[];
  log: string[];
  values: Record<string, string>;
  pc: string | null;
  held: boolean;
  stack: Frame[];
  vars: Record<string, Lit>;
  pins: Record<string, Lit>;
}

const STEP_CAP = 4000;

function nodeOf(graph: FlowGraph, id: string): FlowNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

function outPin(graph: FlowGraph, id: string, pin: string): { node: string; pin: string } | null {
  const hit = graph.edges.find((edge) => edge.from === id + "." + pin);
  if (!hit) return null;
  const dot = hit.to.indexOf(".");
  return { node: hit.to.slice(0, dot), pin: hit.to.slice(dot + 1) };
}

function inPin(graph: FlowGraph, id: string, pin: string): { node: string; pin: string } | null {
  const hit = graph.edges.find((edge) => edge.to === id + "." + pin);
  if (!hit) return null;
  const dot = hit.from.indexOf(".");
  return { node: hit.from.slice(0, dot), pin: hit.from.slice(dot + 1) };
}

function pinsNamed(graph: FlowGraph, id: string, pattern: RegExp): string[] {
  const pins = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge.from.startsWith(id + ".")) continue;
    const pin = edge.from.slice(id.length + 1);
    if (pattern.test(pin)) pins.add(pin);
  }
  return [...pins].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function show(value: Lit): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return "[" + value.map(show).join(", ") + "]";
  return value;
}

function truthy(value: Lit): boolean {
  if (value === null || value === false || value === "" || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function asNumber(value: Lit, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return fallback;
}

function parseShown(text: string): Lit {
  if (text === "None") return null;
  if (text === "True") return true;
  if (text === "False") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function isLoop(frame: Frame): frame is ForFrame | EachFrame | WhileFrame {
  return frame.kind === "for" || frame.kind === "each" || frame.kind === "while";
}

function fresh(graph: FlowGraph, entry: string | null): FlowDebug {
  const vars: Record<string, Lit> = {};
  for (const item of graph.variables ?? []) vars[item.name] = item.default ?? null;
  for (const item of graph.params ?? []) vars[item.name] = item.default ?? null;
  return {
    status: "paused",
    at: entry,
    pause: null,
    detail: "",
    events: [],
    log: [],
    values: {},
    pc: entry,
    held: false,
    stack: [],
    vars,
    pins: {},
  };
}

function publish(session: FlowDebug): void {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(session.pins)) values[key] = show(value);
  for (const [key, value] of Object.entries(session.vars)) values[key] = show(value);
  session.values = values;
}

function remember(session: FlowDebug, id: string, pin: string, value: Lit): void {
  session.pins[id + "." + pin] = value;
  session.pins[id] = value;
}

function readOut(session: FlowDebug, graph: FlowGraph, specs: Map<string, NodeSpec>, id: string, pin: string): Lit {
  const key = id + "." + pin;
  if (Object.prototype.hasOwnProperty.call(session.pins, key)) return session.pins[key];
  const node = nodeOf(graph, id);
  if (!node) return null;
  if (node.type === "data.get" && pin === "value") {
    const name = String(node.inputs?.name ?? "");
    return session.vars[name] ?? null;
  }
  if (node.type === "flow.for_range" && pin === "index") {
    const frame = [...session.stack].reverse().find((item): item is ForFrame => item.kind === "for" && item.id === id);
    return frame?.index ?? asNumber(node.inputs?.start ?? 0, 0);
  }
  if (node.type === "flow.for_each" && pin === "item") {
    const frame = [...session.stack].reverse().find((item): item is EachFrame => item.kind === "each" && item.id === id);
    return frame ? (frame.items[frame.index] ?? null) : null;
  }
  if (!specs.get(node.type)?.exec.in.length && !specs.get(node.type)?.exec.out.length) {
    evalPure(session, graph, specs, node);
    if (Object.prototype.hasOwnProperty.call(session.pins, key)) return session.pins[key];
  }
  return null;
}

function readIn(session: FlowDebug, graph: FlowGraph, specs: Map<string, NodeSpec>, id: string, pin: string): Lit {
  const edge = inPin(graph, id, pin);
  if (edge) return readOut(session, graph, specs, edge.node, edge.pin);
  const node = nodeOf(graph, id);
  if (node?.inputs && Object.prototype.hasOwnProperty.call(node.inputs, pin)) return node.inputs[pin] ?? null;
  const decl = specs.get(node?.type ?? "")?.inputs.find((item) => item.name === pin);
  if (decl && decl.default !== undefined) return decl.default;
  return null;
}

function evalPure(session: FlowDebug, graph: FlowGraph, specs: Map<string, NodeSpec>, node: FlowNode): void {
  const outcome = stepSnippet(graph, node.id, specs, session.values);
  if (!outcome.ok) return;
  const preview = literalPreview(outcome.code);
  if (preview === null) return;
  const value = parseShown(preview);
  const outputs = specs.get(node.type)?.outputs ?? [];
  if (!outputs.length) remember(session, node.id, "result", value);
  for (const pin of outputs) remember(session, node.id, pin.name, value);
  publish(session);
}

function mark(session: FlowDebug, kind: TraceEvent["kind"], id: string, text: string): void {
  session.events.push({ kind, node: id, text });
}

function finish(session: FlowDebug, status: FlowDebug["status"], detail: string): FlowDebug {
  session.status = status;
  session.detail = detail;
  session.pause = null;
  session.held = false;
  if (status !== "paused") session.at = null;
  publish(session);
  return session;
}

function pause(session: FlowDebug, kind: PauseKind): FlowDebug {
  session.status = "paused";
  session.pause = kind;
  session.held = true;
  session.at = session.pc;
  session.detail = session.pc ?? "";
  const last = session.events[session.events.length - 1];
  if (session.pc && !(last?.kind === "pause" && last.node === session.pc)) mark(session, "pause", session.pc, "");
  publish(session);
  return session;
}

function jump(session: FlowDebug, graph: FlowGraph, id: string, pin: string): "ok" | "error" {
  const target = outPin(graph, id, pin);
  if (!target) {
    session.pc = null;
    return "ok";
  }
  if (target.pin === "break" || target.pin === "continue" || target.pin === "fail") return signal(session, target.pin);
  session.pc = target.node;
  return "ok";
}

function signal(session: FlowDebug, kind: "break" | "continue" | "fail"): "ok" | "error" {
  if (kind === "fail") {
    while (session.stack.length && session.stack[session.stack.length - 1].kind !== "retry") session.stack.pop();
    const frame = session.stack[session.stack.length - 1];
    if (!frame || frame.kind !== "retry") return fail(session, "fail");
    frame.left -= 1;
    session.pc = frame.left > 0 ? frame.body : frame.failed;
    if (frame.left <= 0) session.stack.pop();
    return "ok";
  }
  while (session.stack.length && !isLoop(session.stack[session.stack.length - 1])) session.stack.pop();
  const loop = session.stack[session.stack.length - 1];
  if (!loop || !isLoop(loop)) return fail(session, kind);
  if (kind === "break") {
    session.stack.pop();
    session.pc = loop.completed;
    return "ok";
  }
  session.pc = null;
  return "ok";
}

function fail(session: FlowDebug, detail: string): "error" {
  session.status = "error";
  session.detail = detail;
  session.at = session.pc;
  if (session.pc) mark(session, "error", session.pc, detail);
  publish(session);
  return "error";
}

function enterFor(session: FlowDebug, graph: FlowGraph, specs: Map<string, NodeSpec>, id: string): "ok" | "error" {
  const start = Math.trunc(asNumber(readIn(session, graph, specs, id, "start"), 0));
  const end = Math.trunc(asNumber(readIn(session, graph, specs, id, "end"), 0));
  mark(session, "span", id, start + ".." + end);
  const body = outPin(graph, id, "body")?.node ?? null;
  const completed = outPin(graph, id, "completed")?.node ?? null;
  if (start >= end) {
    session.pc = completed;
    return "ok";
  }
  session.stack.push({ kind: "for", id, index: start, end, body, completed });
  remember(session, id, "index", start);
  session.pc = body;
  return "ok";
}

function enterEach(session: FlowDebug, graph: FlowGraph, specs: Map<string, NodeSpec>, id: string): "ok" | "error" {
  const raw = readIn(session, graph, specs, id, "items");
  const items = Array.isArray(raw) ? raw : [];
  const body = outPin(graph, id, "body")?.node ?? null;
  const completed = outPin(graph, id, "completed")?.node ?? null;
  mark(session, "span", id, String(items.length));
  if (!items.length) {
    session.pc = completed;
    return "ok";
  }
  session.stack.push({ kind: "each", id, items, index: 0, body, completed });
  remember(session, id, "item", items[0] ?? null);
  session.pc = body;
  return "ok";
}

function enterWhile(session: FlowDebug, graph: FlowGraph, specs: Map<string, NodeSpec>, id: string): "ok" | "error" {
  const max = Math.max(0, Math.trunc(asNumber(readIn(session, graph, specs, id, "max"), 1)));
  const body = outPin(graph, id, "body")?.node ?? null;
  const completed = outPin(graph, id, "completed")?.node ?? null;
  const cond = truthy(readIn(session, graph, specs, id, "cond"));
  mark(session, "span", id, cond ? "True" : "False");
  if (!cond || max < 1) {
    session.pc = completed;
    return "ok";
  }
  session.stack.push({ kind: "while", id, max, count: 1, body, completed });
  session.pc = body;
  return "ok";
}

function execute(session: FlowDebug, graph: FlowGraph, specs: Map<string, NodeSpec>): "ok" | "error" | "end" {
  const id = session.pc;
  if (!id) return "ok";
  const node = nodeOf(graph, id);
  if (!node) return fail(session, id);
  if (node.meta?.disabled) {
    mark(session, "skip", id, "");
    session.pc = disabledTarget(graph, node);
    return "ok";
  }
  const spec = specs.get(node.type);
  if (spec?.latent) mark(session, "enter", id, "");
  if (node.type === "flow.for_range") return enterFor(session, graph, specs, id);
  if (node.type === "flow.for_each") return enterEach(session, graph, specs, id);
  if (node.type === "flow.while") return enterWhile(session, graph, specs, id);
  if (node.type === "flow.branch") {
    const cond = truthy(readIn(session, graph, specs, id, "cond"));
    mark(session, "span", id, cond ? "True" : "False");
    session.stack.push({ kind: "arm" });
    session.pc = outPin(graph, id, cond ? "then" : "else")?.node ?? null;
    return "ok";
  }
  if (node.type === "flow.match") {
    const value = readIn(session, graph, specs, id, "value");
    const cases = JSON.parse(String(node.config?.cases ?? "[]")) as Array<string | number>;
    const index = cases.findIndex((item) => item === "_" || item === value);
    mark(session, "span", id, show(value));
    session.stack.push({ kind: "arm" });
    session.pc = (index >= 0 ? outPin(graph, id, "c" + index)?.node : null) ?? outPin(graph, id, "completed")?.node ?? null;
    return "ok";
  }
  if (node.type === "flow.retry") {
    const times = Math.max(1, Math.trunc(asNumber(readIn(session, graph, specs, id, "times"), 1)));
    mark(session, "span", id, String(times));
    session.stack.push({
      kind: "retry",
      id,
      left: times,
      body: outPin(graph, id, "body")?.node ?? null,
      ok: outPin(graph, id, "ok")?.node ?? null,
      failed: outPin(graph, id, "failed")?.node ?? null,
    });
    session.pc = outPin(graph, id, "body")?.node ?? null;
    return "ok";
  }
  if (node.type === "flow.sequence" || node.type === "flow.parallel") {
    const pattern = node.type === "flow.sequence" ? /^s\d+$/ : /^b\d+$/;
    const steps = pinsNamed(graph, id, pattern).map((pin) => outPin(graph, id, pin)?.node).filter((item): item is string => Boolean(item));
    const nextPin = node.type === "flow.sequence" ? "next" : "joined";
    mark(session, "span", id, String(steps.length));
    session.stack.push({ kind: "seq", rest: steps.slice(1), next: outPin(graph, id, nextPin)?.node ?? null });
    session.pc = steps[0] ?? outPin(graph, id, nextPin)?.node ?? null;
    return "ok";
  }
  if (node.type === "flow.wait_until") {
    const cond = truthy(readIn(session, graph, specs, id, "cond"));
    mark(session, "span", id, cond ? "True" : "False");
    session.stack.push({ kind: "arm" });
    session.pc = outPin(graph, id, cond ? "then" : "timeout")?.node ?? null;
    return "ok";
  }
  if (node.type === "flow.try") {
    mark(session, "span", id, "");
    session.stack.push({ kind: "seq", rest: [], next: outPin(graph, id, "completed")?.node ?? null });
    session.pc = outPin(graph, id, "body")?.node ?? null;
    return "ok";
  }
  if (node.type === "flow.call" || node.type === "flow.macro") {
    const callee = String(node.config?.callee ?? "");
    const body = outPin(graph, callee, "body")?.node ?? null;
    mark(session, "span", id, callee);
    const next = outPin(graph, id, "then");
    const signalPin = next && (next.pin === "break" || next.pin === "continue" || next.pin === "fail") ? next.pin : null;
    session.stack.push({ kind: "call", next: signalPin ? null : (next?.node ?? null), signal: signalPin });
    session.pc = body;
    return "ok";
  }
  if (node.type === "flow.end") {
    const code = asNumber(readIn(session, graph, specs, id, "code"), 0);
    mark(session, "span", id, String(code));
    session.pc = null;
    session.stack = [];
    return "end";
  }
  if (node.type === "debug.log") {
    const message = readIn(session, graph, specs, id, "message");
    const text = show(message);
    session.log.push(text);
    mark(session, "span", id, text);
    return jump(session, graph, id, "then");
  }
  if (node.type === "data.set") {
    const name = String(readIn(session, graph, specs, id, "name") ?? "");
    const value = readIn(session, graph, specs, id, "value");
    if (name) session.vars[name] = value;
    mark(session, "span", id, name + "=" + show(value));
    return jump(session, graph, id, "then");
  }
  if (node.type === "node.find") {
    remember(session, id, "node", null);
    remember(session, id, "found", false);
    mark(session, "span", id, "False");
    return jump(session, graph, id, "then");
  }
  if (node.type === "flow.wait") {
    mark(session, "span", id, show(readIn(session, graph, specs, id, "ms")));
    return jump(session, graph, id, "then");
  }
  const inputs = (spec?.inputs ?? []).map((pin) => pin.name + "=" + show(readIn(session, graph, specs, id, pin.name)));
  mark(session, "span", id, inputs.join(" "));
  return jump(session, graph, id, "then");
}

function disabledTarget(graph: FlowGraph, node: FlowNode): string | null {
  if (["flow.for_range", "flow.for_each", "flow.while", "flow.branch", "flow.match", "flow.try", "flow.wait_until", "flow.retry", "flow.parallel"].includes(node.type)) {
    return outPin(graph, node.id, "completed")?.node ?? null;
  }
  if (node.type === "flow.sequence") return outPin(graph, node.id, "next")?.node ?? null;
  return outPin(graph, node.id, "then")?.node ?? outPin(graph, node.id, "next")?.node ?? null;
}

function unwind(session: FlowDebug, graph: FlowGraph, specs: Map<string, NodeSpec>): boolean {
  while (session.stack.length) {
    const top = session.stack[session.stack.length - 1];
    if (top.kind === "arm") {
      session.stack.pop();
      continue;
    }
    if (top.kind === "call") {
      session.stack.pop();
      if (top.signal) {
        signal(session, top.signal);
        return true;
      }
      session.pc = top.next;
      return true;
    }
    if (top.kind === "seq") {
      const next = top.rest.shift();
      if (next) {
        session.pc = next;
        return true;
      }
      session.stack.pop();
      session.pc = top.next;
      return true;
    }
    if (top.kind === "retry") {
      session.stack.pop();
      session.pc = top.ok;
      return true;
    }
    if (top.kind === "for") {
      top.index += 1;
      if (top.index < top.end) {
        remember(session, top.id, "index", top.index);
        mark(session, "loop", top.id, String(top.index - Math.trunc(asNumber(nodeOf(graph, top.id)?.inputs?.start ?? 0, 0)) + 1));
        session.pc = top.body;
        return true;
      }
      session.stack.pop();
      session.pc = top.completed;
      return true;
    }
    if (top.kind === "each") {
      top.index += 1;
      if (top.index < top.items.length) {
        remember(session, top.id, "item", top.items[top.index] ?? null);
        mark(session, "loop", top.id, String(top.index + 1));
        session.pc = top.body;
        return true;
      }
      session.stack.pop();
      session.pc = top.completed;
      return true;
    }
    top.count += 1;
    const cond = truthy(readIn(session, graph, specs, top.id, "cond"));
    if (cond && top.count <= top.max) {
      mark(session, "loop", top.id, String(top.count));
      session.pc = top.body;
      return true;
    }
    session.stack.pop();
    session.pc = top.completed;
    return true;
  }
  session.pc = null;
  return false;
}

function breakpointOn(breaks: readonly { node: string; enabled: boolean }[], id: string): boolean {
  return breaks.some((item) => item.node === id && item.enabled);
}

/**
 * Run, step, or stop a desktop session.
 * `run` goes until an enabled breakpoint or the flow ends.
 * `step` executes one node, then pauses on the next one.
 * Device calls are not sent: a find is a miss, and other actions only record their inputs.
 */
export function drive(
  session: FlowDebug | null,
  graph: FlowGraph,
  specs: Map<string, NodeSpec>,
  breaks: readonly { node: string; enabled: boolean }[],
  mode: "run" | "step" | "stop",
): FlowDebug {
  const entry = outPin(graph, "start", "then")?.node ?? null;
  const resuming = session?.status === "paused";
  let current = resuming && session ? structuredClone(session) : fresh(graph, entry);
  if (!resuming && !entry) return finish(current, "done", "done");
  if (mode === "stop") {
    if (current.pc) mark(current, "skip", current.pc, "stop");
    return finish(current, "stopped", "stopped");
  }
  if (!resuming && mode === "step") return pause(current, "step");
  let executed = 0;
  for (let guard = 0; guard < STEP_CAP; guard++) {
    if (current.status === "error") return current;
    if (current.pc === null) {
      if (!unwind(current, graph, specs)) return finish(current, "done", "done");
      if (mode === "step" && executed > 0 && current.pc) return pause(current, breakpointOn(breaks, current.pc) ? "breakpoint" : "step");
      continue;
    }
    if (!current.held && (breakpointOn(breaks, current.pc) || (mode === "step" && executed > 0))) {
      return pause(current, breakpointOn(breaks, current.pc) ? "breakpoint" : "step");
    }
    current.held = false;
    const outcome = execute(current, graph, specs);
    if (outcome === "error") return current;
    if (outcome === "end") return finish(current, "done", "done");
    executed += 1;
    if (executed > STEP_CAP) return finish(current, "error", "limit");
    if (mode === "step" && current.pc && !breakpointOn(breaks, current.pc)) return pause(current, "step");
  }
  return finish(current, "error", "limit");
}

export function traceText(events: readonly TraceEvent[]): string {
  return events.map((event) => [TRACE_MARK, event.kind, event.node, event.text].join("\t")).join("\n");
}
