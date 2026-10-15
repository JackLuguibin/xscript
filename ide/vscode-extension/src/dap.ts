// VS Code / Cursor "XScript" debug adapter core: a Debug Adapter Protocol proxy between the editor and the
// debugpy session running inside the script process on the device (HTTP bridge: /debug/*, docs/DEBUGGING.md).
// Free of `vscode` so it runs under node --test with a fake device.
import * as path from "path";
import { currentSeq } from "./client";
import type { DebugMessages, DebugStartResult, LogEntry, Logs } from "./client";

export interface DebugDevice {
  logs(since?: number): Promise<Logs>;
  status(timeoutMs?: number): Promise<Record<string, unknown>>;
  stop(project: string): Promise<Record<string, unknown>>;
  debugStart(project: string): Promise<DebugStartResult>;
  debugConnect(): Promise<Record<string, unknown>>;
  debugRequest(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  debugMessages(since: number): Promise<DebugMessages>;
  debugClose(): Promise<Record<string, unknown>>;
}

export interface LaunchArguments {
  /** Local project directory (the one with __init__.py). */
  projectRoot?: string;
  /** Device-side project name; default: the directory name. */
  project?: string;
  /** Upload the project before starting (default true). */
  upload?: boolean;
  justMyCode?: boolean;
  /** "Run without debugging": start normally is not supported here; the field is accepted and ignored. */
  noDebug?: boolean;
}

export interface SessionOptions {
  /** Called before the debug start to push the local project to the device. */
  prepare?: (project: string, root: string) => Promise<void>;
  pollMs?: number;
  logPollMs?: number;
  connectTries?: number;
  requestTimeoutMs?: number;
  /** Diagnostic lines (shown in the Debug Console as "console" output). */
  log?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

type Dap = Record<string, any>;

/** Converts "C:\\work\\p" or "/work/p" to forward slashes without a trailing slash. */
export function posixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export class PathMap {
  readonly local: string;
  readonly remote: string;
  constructor(localRoot: string, remoteRoot: string) {
    this.local = posixPath(/^([A-Za-z]:[\\/]|\/)/.test(localRoot) ? localRoot : path.resolve(localRoot));
    this.remote = posixPath(remoteRoot);
  }
  private static under(value: string, root: string): string | undefined {
    const v = posixPath(value);
    const fold = /^[A-Za-z]:/.test(root);   // Windows paths are case-insensitive
    const a = fold ? v.toLowerCase() : v, b = fold ? root.toLowerCase() : root;
    return a === b ? "" : a.startsWith(b + "/") ? v.slice(root.length + 1) : undefined;
  }
  toRemote(p: string): string {
    const rel = PathMap.under(p, this.local);
    return rel === undefined ? p : rel === "" ? this.remote : this.remote + "/" + rel;
  }
  toLocal(p: string): string {
    const rel = PathMap.under(p, this.remote);
    return rel === undefined ? p : rel === "" ? this.local : path.join(this.local, ...rel.split("/"));
  }
  /** Deep copy of a DAP message with every string `path` field mapped. */
  map(value: unknown, fn: (p: string) => string): any {
    if (Array.isArray(value)) return value.map((v) => this.map(v, fn));
    if (value && typeof value === "object") {
      const out: Dap = {};
      for (const [k, v] of Object.entries(value as Dap)) out[k] = k === "path" && typeof v === "string" ? fn(v) : this.map(v, fn);
      return out;
    }
    return value;
  }
}

const CAPABILITIES = {
  supportsConfigurationDoneRequest: true,
  supportsConditionalBreakpoints: true,
  supportsHitConditionalBreakpoints: true,
  supportsLogPoints: true,
  supportsEvaluateForHovers: true,
  supportsSetVariable: true,
  supportsExceptionInfoRequest: true,
  supportsValueFormattingOptions: true,
  supportsTerminateRequest: false,
  supportTerminateDebuggee: true,
  exceptionBreakpointFilters: [
    { filter: "raised", label: "Raised Exceptions", default: false },
    { filter: "uncaught", label: "Uncaught Exceptions", default: true },
  ],
};

// debugpy events VS Code understands; debugpy-internal ones (debugpyWaitingForServer, ...) are dropped.
const FORWARD_EVENTS = new Set(["output", "stopped", "continued", "thread", "breakpoint", "module", "loadedSource", "process", "invalidated"]);

export class XScriptDebugSession {
  private seq = 0;                       // our outgoing sequence towards the editor
  private deviceSeq = 0;                 // sequence towards debugpy
  private pending = new Map<number, { editorSeq: number; command: string }>();
  private cursor = 0;
  private epoch = 0;
  private project = "";
  private map?: PathMap;
  private connected = false;
  private attached = false;
  private ended = false;
  private launchSeq?: number;
  private launchWaitsForAttach?: number;   // device seq of the attach request
  private initializedSeen = false;
  private sendChain: Promise<unknown> = Promise.resolve();
  private opts: Required<Pick<SessionOptions, "pollMs" | "logPollMs" | "connectTries" | "requestTimeoutMs">> & SessionOptions;
  private waitInitialized?: { resolve: () => void };

  constructor(private device: DebugDevice, private emit: (message: Dap) => void, opts: SessionOptions = {}) {
    this.opts = { pollMs: 100, logPollMs: 400, connectTries: 40, requestTimeoutMs: 60000, ...opts };
  }

  private sleep(ms: number): Promise<void> {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }
  private log(text: string): void {
    this.opts.log?.(text);
  }

  // ---- editor-facing helpers ----
  private send(message: Dap): void {
    this.emit({ seq: ++this.seq, ...message });
  }
  private respond(req: Dap, body?: Dap): void {
    this.send({ type: "response", request_seq: req.seq, success: true, command: req.command, body: body ?? {} });
  }
  private fail(req: Dap, message: string): void {
    this.send({ type: "response", request_seq: req.seq, success: false, command: req.command, message, body: { error: { id: 1, format: message } } });
  }
  private output(text: string, category = "console"): void {
    this.send({ type: "event", event: "output", body: { category, output: text.endsWith("\n") ? text : text + "\n" } });
  }
  /** The script is over: flush its last log lines first, then tell the editor. */
  private async finish(): Promise<void> {
    if (this.ended || this.finishing) return;
    this.finishing = true;
    try { await this.drainLogs(); } catch { /* best effort */ }
    if (this.ended) return;
    this.ended = true;
    this.send({ type: "event", event: "terminated", body: {} });
  }
  private finishing = false;
  private logSince = 0;
  private async drainLogs(): Promise<void> {
    const r = await this.device.logs(this.logSince);
    this.logSince = typeof r.next === "number" ? r.next : this.logSince;
    for (const e of r.entries as LogEntry[]) this.output(e.line, e.stream === "stderr" ? "stderr" : "stdout");
  }

  /** Entry point for every message from the editor. */
  async handle(message: Dap): Promise<void> {
    if (message.type !== "request") return;
    try {
      switch (message.command) {
        case "initialize":
          this.respond(message, CAPABILITIES);
          return;
        case "launch":
        case "attach":
          await this.launch(message);
          return;
        case "disconnect":
        case "terminate":
          await this.disconnect(message);
          return;
        default:
          this.forward(message);
      }
    } catch (err) {
      this.fail(message, (err as Error).message || String(err));
    }
  }

  // ---- launch: upload, start with debugpy waiting, connect, handshake ----
  private async launch(req: Dap): Promise<void> {
    const args = (req.arguments ?? {}) as LaunchArguments;
    if (!args.projectRoot) return this.fail(req, "launch.json needs \"projectRoot\" (a folder with __init__.py)");
    const project = args.project || path.basename(path.resolve(args.projectRoot));
    this.project = project;
    if (args.upload !== false && this.opts.prepare) {
      this.output("[xscript] uploading " + project);
      await this.opts.prepare(project, args.projectRoot);
    }
    try { this.logSince = await currentSeq(this.device); } catch { /* log cursor is best effort */ }
    const started = await this.device.debugStart(project);
    if (started.error || !started.debug) {
      const why = started.error || "device did not return a debug port";
      return this.fail(req, /running|busy|409/i.test(why) ? "A script is already running on the device (" + why + "). Stop it first." : why);
    }
    this.map = new PathMap(args.projectRoot, started.debug.remote_root);
    this.output("[xscript] debugger waiting on device port " + started.debug.port);
    let ok = false;
    let lastErr: unknown;
    for (let i = 0; i < this.opts.connectTries; i++) {
      try { const r = await this.device.debugConnect(); if (!r.error) { ok = true; break; } lastErr = r.error; }
      catch (e) { lastErr = e; }
      await this.sleep(250);
    }
    if (!ok) return this.fail(req, "could not connect to the device debugger: " + String((lastErr as Error)?.message ?? lastErr));
    this.connected = true;
    const epoch = ++this.epoch;
    void this.loop(epoch);
    void this.logLoop(epoch);

    const initialized = new Promise<void>((resolve) => { this.waitInitialized = { resolve }; });
    await this.request({ command: "initialize", arguments: {
      adapterID: "python", clientID: "vscode", clientName: "XScript for VS Code", linesStartAt1: true, columnsStartAt1: true,
      pathFormat: "path", supportsVariableType: true, supportsVariablePaging: false, supportsRunInTerminalRequest: false } });
    this.launchSeq = req.seq;
    // The attach response only arrives after configurationDone, so it must not be awaited here.
    this.launchWaitsForAttach = this.sendDevice({ command: "attach", arguments: { justMyCode: args.justMyCode !== false, name: "XScript", subProcess: false } }, req.seq, "launch");
    this.attached = true;
    // A real timer: the injected sleep is shortened in tests and would make this timeout race the handshake.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out waiting for the debugger to initialise")), 20000); });
    try { await Promise.race([initialized, timeout]); } finally { clearTimeout(timer); }
    this.send({ type: "event", event: "initialized" });
  }

  // ---- forwarding ----
  private forward(req: Dap): void {
    if (!this.connected || !this.map) return this.fail(req, "the debug session is not connected");
    this.sendDevice({ command: req.command, arguments: req.arguments }, req.seq, req.command);
  }

  /** Queue a request to debugpy; the response is routed back to `editorSeq`. */
  private sendDevice(req: { command: string; arguments?: unknown }, editorSeq: number, command: string): number {
    const seq = ++this.deviceSeq;
    this.pending.set(seq, { editorSeq, command });
    const args = this.map && req.arguments !== undefined ? this.map.map(req.arguments, (p) => this.map!.toRemote(p)) : req.arguments;
    const frame = { seq, type: "request", command: req.command, arguments: args ?? {} };
    this.sendChain = this.sendChain.then(() => this.device.debugRequest(frame)).catch((err) => {
      const entry = this.pending.get(seq);
      if (!entry) return;
      this.pending.delete(seq);
      const msg = "device request failed: " + ((err as Error).message || String(err));
      const waiter = this.internal.get(seq);
      if (waiter) { this.internal.delete(seq); waiter.reject(new Error(msg)); return; }
      this.answer(entry, { success: false, message: msg, body: {} });
    });
    const timer = setTimeout(() => {
      const entry = this.pending.get(seq);
      if (!entry || this.ended) return;
      this.pending.delete(seq);
      const waiter = this.internal.get(seq);
      if (waiter) { this.internal.delete(seq); waiter.reject(new Error("debugger did not answer " + req.command)); return; }
      this.answer(entry, { success: false, message: "debugger did not answer " + req.command, body: {} });
    }, this.opts.requestTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    return seq;
  }
  /** An internal request whose result we await (handshake). */
  private request(req: { command: string; arguments?: unknown }): Promise<Dap> {
    return new Promise((resolve, reject) => {
      const seq = this.sendDevice(req, -1, "internal:" + req.command);
      this.internal.set(seq, { resolve, reject });
    });
  }
  private internal = new Map<number, { resolve: (body: Dap) => void; reject: (e: Error) => void }>();

  private answer(entry: { editorSeq: number; command: string }, r: Dap): void {
    if (entry.editorSeq < 0) return;
    const body = this.map ? this.map.map(r.body ?? {}, (p) => this.map!.toLocal(p)) : r.body ?? {};
    this.send({ type: "response", request_seq: entry.editorSeq, success: r.success !== false, command: entry.command === "launch" ? "launch" : entry.command, ...(r.success === false ? { message: r.message || "failed" } : {}), body });
  }

  // ---- incoming from debugpy ----
  private receive(msg: Dap): void {
    if (msg.type === "response") {
      const waiter = this.internal.get(msg.request_seq);
      if (waiter) {
        this.internal.delete(msg.request_seq);
        this.pending.delete(msg.request_seq);
        msg.success === false ? waiter.reject(new Error(msg.message || msg.command + " failed")) : waiter.resolve(msg.body ?? {});
        return;
      }
      const entry = this.pending.get(msg.request_seq);
      if (!entry) return;
      this.pending.delete(msg.request_seq);
      this.answer(entry, msg);
    } else if (msg.type === "event") {
      if (msg.event === "initialized") { this.initializedSeen = true; this.waitInitialized?.resolve(); return; }
      if (msg.event === "terminated" || msg.event === "exited") { this.finishFromDevice(msg); return; }
      if (!FORWARD_EVENTS.has(msg.event)) return;
      const body = this.map ? this.map.map(msg.body ?? {}, (p) => this.map!.toLocal(p)) : msg.body ?? {};
      // The script's own output reaches the Debug Console through the log poller; skip debugpy's duplicate.
      // Logpoint messages are debugpy-only output (they never touch the script's stdout) and carry source/line: keep them.
      if (msg.event === "output" && (body.category === "stdout" || body.category === "stderr") && !body.source && !body.line) return;
      this.send({ type: "event", event: msg.event, body });
    }
  }
  private finishFromDevice(msg: Dap): void {
    if (msg.event === "exited" && !this.ended) this.send({ type: "event", event: "exited", body: { exitCode: msg.body?.exitCode ?? 0 } });
    void this.finish();
  }

  private async loop(epoch: number): Promise<void> {
    while (epoch === this.epoch && !this.ended) {
      try {
        const r = await this.device.debugMessages(this.cursor);
        if (epoch !== this.epoch) return;
        this.cursor = r.next;
        for (const item of r.messages ?? []) this.receive(item.message);
        if (r.connected === false && !this.ended) {
          let running = true;
          try { running = Boolean((await this.device.status(3000)).running); } catch { /* assume still running */ }
          if (!running) { this.output("[xscript] script finished"); await this.finish(); return; }
          this.output("[xscript] debugger connection lost", "stderr");
          await this.finish();
          return;
        }
      } catch (err) {
        if (epoch !== this.epoch) return;
        this.output("[xscript] lost the device: " + ((err as Error).message || String(err)), "stderr");
        await this.finish();
        return;
      }
      await this.sleep(this.opts.pollMs);
    }
  }

  private async logLoop(epoch: number): Promise<void> {
    while (epoch === this.epoch && !this.ended && !this.finishing) {
      try { await this.drainLogs(); } catch { /* transient */ }
      await this.sleep(this.opts.logPollMs);
    }
  }

  // ---- disconnect ----
  private async disconnect(req: Dap): Promise<void> {
    const terminate = req.arguments?.terminateDebuggee !== false;
    if (this.connected && this.attached && !this.ended) {
      // A TCP close alone leaves debugpy's threads suspended: detach properly first.
      try { await Promise.race([this.request({ command: "disconnect", arguments: { terminateDebuggee: false } }), this.sleep(1500)]); } catch { /* best effort */ }
    }
    this.epoch++;
    this.ended = true;
    if (this.connected) { try { await this.device.debugClose(); } catch { /* already closed */ } }
    this.connected = false;
    if (terminate && this.project) {
      try {
        const st = await this.device.status(3000);
        if (st.running && (!st.project || st.project === this.project)) await this.device.stop(this.project);   // never stop someone else's script
      } catch { /* device gone or nothing running */ }
    }
    this.respond(req);
  }

  /** Stop the background pollers (the editor closed the session). */
  dispose(): void {
    this.epoch++;
    this.ended = true;
  }

  get state(): { connected: boolean; ended: boolean; initialized: boolean } {
    return { connected: this.connected, ended: this.ended, initialized: this.initializedSeen };
  }
}
