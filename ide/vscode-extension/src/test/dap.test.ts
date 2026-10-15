// The debug adapter core against a fake device that behaves like the device's debugpy bridge.
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { DebugMessages, DebugStartResult, Logs } from "../client";
import { DebugDevice, PathMap, XScriptDebugSession } from "../dap";

type Dap = Record<string, any>;
const REMOTE = "/data/projects/demo";
const LOCAL = path.resolve("/work/demo");

class FakeDevice implements DebugDevice {
  queue: { id: number; message: Dap }[] = [];
  requests: Dap[] = [];
  logEntries: { seq: number; ts: number; stream: string; line: string }[] = [];
  running = true;
  connected = false;
  stopped: string[] = [];
  closed = 0;
  startResult: DebugStartResult = { ok: true, debug: { port: 5678, remote_root: REMOTE } };
  connectFails = 0;
  hold = false;                       // keep the script paused after configurationDone
  private id = 0;
  private attachSeq = 0;

  push(message: Dap) { this.queue.push({ id: ++this.id, message }); }
  log(line: string, stream = "stdout") { this.logEntries.push({ seq: this.logEntries.length + 1, ts: 0, stream, line }); }
  async logs(since = 0): Promise<Logs> {
    return { entries: this.logEntries.filter((e) => e.seq > since), next: this.logEntries.length };
  }
  async status() { return { running: this.running, project: "demo" }; }
  async stop(project: string) { this.stopped.push(project); this.running = false; return { ok: true }; }
  async debugStart() { return this.startResult; }
  async debugConnect() {
    if (this.connectFails-- > 0) throw new Error("not ready");
    this.connected = true;
    return { ok: true };
  }
  async debugClose() { this.closed++; this.connected = false; return { ok: true }; }
  async debugMessages(since: number): Promise<DebugMessages> {
    return { messages: this.queue.filter((m) => m.id > since), next: this.id, connected: this.connected };
  }
  async debugRequest(req: Dap): Promise<Dap> {
    this.requests.push(req);
    const ok = (body: Dap = {}) => this.push({ type: "response", request_seq: req.seq, success: true, command: req.command, body });
    switch (req.command) {
      case "initialize": ok({ supportsConfigurationDoneRequest: true }); break;
      case "attach": this.attachSeq = req.seq; this.push({ type: "event", event: "initialized" }); break;
      case "setBreakpoints":
        ok({ breakpoints: req.arguments.breakpoints.map((b: Dap) => ({ verified: true, line: b.line, source: req.arguments.source })) });
        break;
      case "configurationDone":
        ok();
        this.push({ type: "response", request_seq: this.attachSeq, success: true, command: "attach", body: {} });
        this.push({ type: "event", event: "debugpyWaitingForServer", body: {} });
        this.push({ type: "event", event: "output", body: { category: "stdout", output: "dup\n" } });
        this.push({ type: "event", event: "output", body: { category: "stdout", output: "lp x=1\n", source: { name: "__init__.py", path: REMOTE + "/__init__.py" }, line: 2 } });
        if (this.hold) this.push({ type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } });
        break;
      case "threads": ok({ threads: [{ id: 1, name: "MainThread" }] }); break;
      case "stackTrace":
        ok({ stackFrames: [
          { id: 1, name: "main", line: 2, column: 1, source: { name: "__init__.py", path: REMOTE + "/__init__.py" } },
          { id: 2, name: "lib", line: 9, column: 1, source: { name: "mod.py", path: "/data/python/lib/mod.py" } }] });
        break;
      case "continue":
        ok({ allThreadsContinued: true });
        this.log("done 42\n");
        this.running = false;
        this.push({ type: "event", event: "exited", body: { exitCode: 0 } });
        this.push({ type: "event", event: "terminated", body: {} });
        break;
      case "disconnect": ok(); break;
      default: ok();
    }
    return {};
  }
}

const sessions: XScriptDebugSession[] = [];
afterEach(() => { while (sessions.length) sessions.pop()!.dispose(); });

function harness(device = new FakeDevice(), extra: Dap = {}) {
  const out: Dap[] = [];
  const uploads: string[] = [];
  const session = new XScriptDebugSession(device, (m) => out.push(m), {
    prepare: async (project, root) => { uploads.push(project + "@" + root); },
    pollMs: 2, logPollMs: 2, connectTries: 5, requestTimeoutMs: 400,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 3))),
    ...extra,
  });
  sessions.push(session);
  let seq = 0;
  const req = (command: string, args?: Dap) => { const r = { seq: ++seq, type: "request", command, arguments: args }; void session.handle(r); return r.seq; };
  const waitFor = async (pred: (m: Dap) => boolean, what: string, ms = 5000): Promise<Dap> => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = out.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error("timed out waiting for " + what + "; got " + JSON.stringify(out.map((m) => m.event || m.command + ":" + m.success)));
      await new Promise((r) => setTimeout(r, 3));
    }
  };
  const response = (s: number) => waitFor((m) => m.type === "response" && m.request_seq === s, "response " + s);
  const event = (name: string) => waitFor((m) => m.type === "event" && m.event === name, "event " + name);
  return { device, session, out, uploads, req, response, event, waitFor };
}

test("PathMap maps project paths both ways and leaves others alone", () => {
  const m = new PathMap(LOCAL, REMOTE);
  assert.equal(m.toRemote(path.join(LOCAL, "lib", "a.py")), REMOTE + "/lib/a.py");
  assert.equal(m.toRemote(LOCAL), REMOTE);
  assert.equal(m.toRemote("/elsewhere/x.py"), "/elsewhere/x.py");
  assert.equal(m.toRemote(LOCAL + "-other/a.py"), LOCAL + "-other/a.py", "prefix of a sibling is not inside the project");
  assert.equal(m.toLocal(REMOTE + "/lib/a.py"), path.join(LOCAL, "lib", "a.py"));
  assert.equal(m.toLocal("/data/python/x.py"), "/data/python/x.py");
  const msg = m.map({ source: { path: REMOTE + "/__init__.py", name: "n" }, list: [{ path: REMOTE + "/b.py" }], value: REMOTE + "/not-a-path-key" }, (p) => m.toLocal(p));
  assert.equal(msg.source.path, path.join(LOCAL, "__init__.py")); assert.equal(msg.list[0].path, path.join(LOCAL, "b.py")); assert.equal(msg.value, REMOTE + "/not-a-path-key");
  const win = new PathMap("C:\\work\\demo", REMOTE);
  assert.equal(win.toRemote("c:\\Work\\Demo\\lib\\a.py"), REMOTE + "/lib/a.py", "Windows paths: case-insensitive, backslashes");
  assert.equal(win.toRemote("D:\\other\\a.py"), "D:\\other\\a.py");
});

test("initialize answers with capabilities that make VS Code send configurationDone", async () => {
  const h = harness();
  const r = await h.response(h.req("initialize", { adapterID: "xscript" }));
  assert.equal(r.success, true); assert.equal(r.body.supportsConfigurationDoneRequest, true);
});

test("full session: upload, start, connect, breakpoints mapped, stopped, stack mapped, continue, logs before terminated", async () => {
  const h = harness();
  h.device.hold = true;
  h.device.log("old line\n");              // before the session: must not be replayed
  await h.response(h.req("initialize"));
  const launch = h.req("launch", { projectRoot: LOCAL });
  await h.event("initialized");
  assert.deepEqual(h.uploads, ["demo@" + LOCAL]);
  const set = await h.response(h.req("setBreakpoints", { source: { path: path.join(LOCAL, "__init__.py") }, breakpoints: [{ line: 2 }] }));
  const sent = h.device.requests.find((r) => r.command === "setBreakpoints")!;
  assert.equal(sent.arguments.source.path, REMOTE + "/__init__.py", "editor path -> device path");
  assert.equal(set.body.breakpoints[0].source.path, path.join(LOCAL, "__init__.py"), "device path -> editor path");
  await h.response(h.req("configurationDone"));
  assert.equal((await h.response(launch)).success, true, "launch answered once debugpy answered attach");
  assert.equal((await h.response(launch)).command, "launch");
  const stopped = await h.event("stopped"); assert.equal(stopped.body.reason, "breakpoint");
  const st = await h.response(h.req("stackTrace", { threadId: 1 }));
  assert.equal(st.body.stackFrames[0].source.path, path.join(LOCAL, "__init__.py"));
  assert.equal(st.body.stackFrames[1].source.path, "/data/python/lib/mod.py", "library frames keep the device path");
  await h.response(h.req("continue", { threadId: 1 }));
  await h.event("terminated");
  const names = h.out.map((m) => m.event || m.command);
  assert.ok(!h.out.some((m) => m.event === "debugpyWaitingForServer"), "debugpy-internal events are dropped");
  assert.ok(!h.out.some((m) => m.event === "output" && /^dup/.test(m.body.output)), "debugpy's duplicate stdout is dropped");
  const lp = h.out.find((m) => m.event === "output" && /^lp x=1/.test(m.body.output));
  assert.ok(lp, "logpoint output (carries source/line) is forwarded");
  assert.equal(lp.body.source.path, path.join(LOCAL, "__init__.py"), "logpoint source mapped to the editor path");
  assert.ok(!h.out.some((m) => m.event === "output" && /old line/.test(m.body.output)), "earlier log lines are not replayed");
  const done = h.out.findIndex((m) => m.event === "output" && m.body.output === "done 42\n");
  assert.ok(done >= 0, "script output reaches the debug console");
  assert.ok(done < names.indexOf("terminated"), "last log lines are flushed before terminated");
  assert.ok(names.indexOf("exited") < names.indexOf("terminated"), "exited comes before terminated");
  // The editor then disconnects: the script already finished, so nobody is stopped.
  const d = await h.response(h.req("disconnect", {}));
  assert.equal(d.success, true); assert.deepEqual(h.device.stopped, []); assert.ok(h.device.closed >= 1);
});

test("launch problems are reported as failed responses, not hangs", async () => {
  let h = harness();
  assert.match((await h.response(h.req("launch", {}))).message, /projectRoot/);
  h = harness();
  h.device.startResult = { error: "a script is already running: other" };
  const r = await h.response(h.req("launch", { projectRoot: LOCAL }));
  assert.equal(r.success, false); assert.match(r.message, /already running/);
  assert.ok(!h.device.requests.length, "nothing was sent to a debugger that never started");
  h = harness();
  h.device.connectFails = 99;
  assert.match((await h.response(h.req("launch", { projectRoot: LOCAL }))).message, /could not connect/);
  h = harness();
  const bad = await h.response(h.req("stackTrace", { threadId: 1 }));
  assert.equal(bad.success, false); assert.match(bad.message, /not connected/);
});

test("connect retries until the debugger listens", async () => {
  const h = harness();
  h.device.connectFails = 3;
  h.req("launch", { projectRoot: LOCAL });
  await h.event("initialized");
});

test("disconnect while paused detaches debugpy, closes the bridge and stops our own script", async () => {
  const h = harness();
  h.device.hold = true;
  const launch = h.req("launch", { projectRoot: LOCAL, project: "demo" });
  await h.event("initialized"); await h.response(h.req("configurationDone")); await h.response(launch);
  await h.event("stopped");
  const d = await h.response(h.req("disconnect", { terminateDebuggee: true }));
  assert.equal(d.success, true);
  assert.ok(h.device.requests.some((r) => r.command === "disconnect" && r.arguments.terminateDebuggee === false), "DAP detach first");
  assert.equal(h.device.closed, 1); assert.deepEqual(h.device.stopped, ["demo"]);
});

test("disconnect with terminateDebuggee=false keeps the script running", async () => {
  const h = harness();
  h.device.hold = true;
  const launch = h.req("launch", { projectRoot: LOCAL });
  await h.event("initialized"); await h.response(h.req("configurationDone")); await h.response(launch);
  await h.response(h.req("disconnect", { terminateDebuggee: false }));
  assert.deepEqual(h.device.stopped, []);
});

test("a script that ends without debugpy events is noticed through the device status", async () => {
  const h = harness();
  h.device.hold = true;
  const launch = h.req("launch", { projectRoot: LOCAL });
  await h.event("initialized"); await h.response(h.req("configurationDone")); await h.response(launch);
  h.device.running = false; h.device.connected = false; h.device.log("bye\n");
  await h.event("terminated");
  assert.ok(h.out.some((m) => m.event === "output" && m.body.output === "bye\n"));
});

test("stderr lines keep their category; a vanished device ends the session with a message", async () => {
  const h = harness();
  h.device.hold = true;
  const launch = h.req("launch", { projectRoot: LOCAL });
  await h.event("initialized"); await h.response(h.req("configurationDone")); await h.response(launch);
  h.device.log("Traceback...\n", "stderr");
  const err = await h.waitFor((m) => m.event === "output" && m.body.category === "stderr", "stderr output");
  assert.match(err.body.output, /Traceback/);
  h.device.debugMessages = async () => { throw new Error("ECONNREFUSED"); };
  await h.event("terminated");
  assert.ok(h.out.some((m) => m.event === "output" && /lost the device: ECONNREFUSED/.test(m.body.output)));
});

test("a request the device never answers fails after the timeout instead of hanging the editor", async () => {
  const h = harness(new FakeDevice(), { requestTimeoutMs: 60 });
  h.device.hold = true;
  const launch = h.req("launch", { projectRoot: LOCAL });
  await h.event("initialized"); await h.response(h.req("configurationDone")); await h.response(launch);
  const orig = h.device.debugRequest.bind(h.device);
  h.device.debugRequest = async (r: Dap) => { if (r.command === "evaluate") return {}; return orig(r); };
  const r = await h.response(h.req("evaluate", { expression: "1" }));
  assert.equal(r.success, false); assert.match(r.message, /did not answer/);
});
