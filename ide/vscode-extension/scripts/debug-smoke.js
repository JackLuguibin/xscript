#!/usr/bin/env node
// Drives the real debug adapter core (out/dap.js) against a device, the way VS Code does, with no editor:
//   adb forward tcp:19860 tcp:9860 && node scripts/debug-smoke.js 127.0.0.1:19860
// Creates and deletes its own temporary project; needs no other script running.
const fs = require("fs"), os = require("os"), path = require("path");
const { DeviceClient, parseTarget } = require("../out/client");
const { XScriptDebugSession } = require("../out/dap");
const { collectFiles } = require("../out/project");

const target = process.argv[2] || "127.0.0.1:19860";
const name = "vsc_smoke_" + process.pid;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "xs-vsc-")) + path.sep + name;
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, "__init__.py"), 'total = 1\ntotal += 41\nprint("smoke done", total)\n');
const client = new DeviceClient(parseTarget(target));
const out = [];
const session = new XScriptDebugSession(client, (m) => out.push(m), {
  prepare: async (project, dir) => { await client.uploadFiles(project, collectFiles(dir)); },
});
let seq = 0;
const send = (command, args) => { const s = ++seq; void session.handle({ seq: s, type: "request", command, arguments: args }); return s; };
const until = async (pred, what, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) { const hit = out.find(pred); if (hit) return hit; if (Date.now() > end) throw new Error("timeout: " + what + " " + JSON.stringify(out.slice(-6))); await new Promise((r) => setTimeout(r, 50)); }
};
const ask = async (command, args) => { const s = send(command, args); const r = await until((m) => m.type === "response" && m.request_seq === s, command); if (!r.success) throw new Error(command + ": " + r.message); return r; };
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) process.exitCode = 1; };

(async () => {
  try {
    const st = await client.status(5000);
    if (st.running) throw new Error("a script is running on the device; stop it first");
    await ask("initialize", { adapterID: "xscript" });
    const launch = send("launch", { projectRoot: root, project: name });
    await until((m) => m.event === "initialized", "initialized");
    check(true, "launch: uploaded, debugger started, connected, initialized");
    const file = path.join(root, "__init__.py");
    const bp = await ask("setBreakpoints", { source: { path: file }, breakpoints: [{ line: 2 }] });
    check(bp.body.breakpoints[0].verified === true && bp.body.breakpoints[0].source.path === file, "breakpoint verified, source mapped back to the local file");
    await ask("configurationDone");
    check((await until((m) => m.type === "response" && m.request_seq === launch, "launch response")).success, "launch response after configurationDone");
    const stopped = await until((m) => m.event === "stopped", "stopped");
    check(stopped.body.reason === "breakpoint", "stopped at the breakpoint");
    const stack = await ask("stackTrace", { threadId: stopped.body.threadId });
    const top = stack.body.stackFrames[0];
    check(top.line === 2 && top.source.path === file, "top frame is __init__.py:2 with the LOCAL path");
    const scopes = await ask("scopes", { frameId: top.id });
    const vars = await ask("variables", { variablesReference: scopes.body.scopes[0].variablesReference });
    check(vars.body.variables.some((v) => v.name === "total" && v.value === "1"), "variable total == 1");
    await ask("next", { threadId: stopped.body.threadId });
    await until((m) => m.event === "stopped" && m !== stopped, "stopped after next");
    const stack2 = await ask("stackTrace", { threadId: stopped.body.threadId });
    const scopes2 = await ask("scopes", { frameId: stack2.body.stackFrames[0].id });
    const vars2 = await ask("variables", { variablesReference: scopes2.body.scopes[0].variablesReference });
    check(vars2.body.variables.some((v) => v.name === "total" && v.value === "42"), "after next: total == 42, now at line " + stack2.body.stackFrames[0].line);
    const ev = await ask("evaluate", { expression: "total * 2", frameId: stack2.body.stackFrames[0].id, context: "repl" });
    check(ev.body.result === "84", "evaluate total*2 == 84");
    await ask("continue", { threadId: stopped.body.threadId });
    await until((m) => m.event === "terminated", "terminated");
    check(out.some((m) => m.event === "output" && /smoke done 42/.test(m.body.output)), "script output reached the debug console");
    await ask("disconnect", { terminateDebuggee: true });
    check(true, "disconnect");
    const after = await client.status(5000);
    check(!after.running, "device idle afterwards");
    // Second session: stop at the breakpoint, then detach WITHOUT terminating; the script must finish by itself.
    out.length = 0;
    const s2 = new XScriptDebugSession(client, (m) => out.push(m), { prepare: async () => {} });
    const send2 = (command, args) => { const n = ++seq; void s2.handle({ seq: n, type: "request", command, arguments: args }); return n; };
    const ask2 = async (command, args) => { const n = send2(command, args); const r = await until((m) => m.type === "response" && m.request_seq === n, command); if (!r.success) throw new Error(command + ": " + r.message); return r; };
    await ask2("initialize", {});
    const l2 = send2("launch", { projectRoot: root, project: name, upload: false });
    await until((m) => m.event === "initialized", "initialized (2)");
    await ask2("setBreakpoints", { source: { path: file }, breakpoints: [{ line: 2 }] });
    await ask2("configurationDone");
    await until((m) => m.type === "response" && m.request_seq === l2, "launch 2");
    await until((m) => m.event === "stopped", "stopped (2)");
    await ask2("disconnect", { terminateDebuggee: false });
    let finished = false;
    for (let i = 0; i < 60 && !finished; i++) { await new Promise((r) => setTimeout(r, 250)); finished = !(await client.status(5000)).running; }
    check(finished, "detach (terminateDebuggee=false) lets the paused script run to the end");
    s2.dispose();
  } catch (e) {
    console.log("FAIL " + e.message); process.exitCode = 1;
    try { await ask("disconnect", { terminateDebuggee: true }); } catch { /* ignore */ }
  } finally {
    session.dispose();
    try { await fetch(client.baseUrl + "/projects/" + name, { method: "DELETE" }); } catch { /* ignore */ }
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  }
})();
