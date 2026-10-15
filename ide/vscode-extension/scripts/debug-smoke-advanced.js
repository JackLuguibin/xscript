#!/usr/bin/env node
// Conditional breakpoints, hit counts, logpoints, setVariable and evaluate-assignment through the real adapter core
// (out/dap.js) against a device — the pieces scripts/debug-smoke.js does not cover:
//   adb forward tcp:19860 tcp:9860 && node scripts/debug-smoke-advanced.js 127.0.0.1:19860
// Creates and deletes its own temporary project; needs no other script running. Works on any emulator (pure Python).
const fs = require("fs"), os = require("os"), path = require("path");
const { DeviceClient, parseTarget } = require("../out/client");
const { XScriptDebugSession } = require("../out/dap");
const { collectFiles } = require("../out/project");

const target = process.argv[2] || "127.0.0.1:19860";
const name = "vsc_adv_" + process.pid;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "xs-vsc-")) + path.sep + name;
fs.mkdirSync(root);
const file = path.join(root, "__init__.py");
fs.writeFileSync(file, [
  "total = 0",                    // 1
  "for i in range(10):",          // 2
  "    total += i",               // 3
  'print("loop done", total)',    // 4
  "x = 5",                        // 5
  "y = x * 2",                    // 6
  'print("y", y)',                // 7
  "",
].join("\n"));
const client = new DeviceClient(parseTarget(target));
let failed = false;
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) { failed = true; process.exitCode = 1; } };

async function session(label, body) {
  const out = [];
  let seq = 0;
  const s = new XScriptDebugSession(client, (m) => out.push(m), { prepare: async (project, dir) => { await client.uploadFiles(project, collectFiles(dir)); } });
  const send = (command, args) => { const n = ++seq; void s.handle({ seq: n, type: "request", command, arguments: args }); return n; };
  const until = async (pred, what, ms = 25000) => {
    const end = Date.now() + ms;
    for (;;) { const hit = out.find(pred); if (hit) return hit; if (Date.now() > end) throw new Error("timeout: " + what + " " + JSON.stringify(out.slice(-6))); await new Promise((r) => setTimeout(r, 50)); }
  };
  const ask = async (command, args) => { const n = send(command, args); const r = await until((m) => m.type === "response" && m.request_seq === n, command); if (!r.success) throw new Error(command + ": " + r.message); return r; };
  const nextStop = async (after) => { const m = await until((x) => x.event === "stopped" && !after.includes(x), "stopped"); after.push(m); return m; };
  const locals = async (threadId) => {
    const st = await ask("stackTrace", { threadId });
    const top = st.body.stackFrames[0];
    const sc = await ask("scopes", { frameId: top.id });
    const vars = await ask("variables", { variablesReference: sc.body.scopes[0].variablesReference });
    return { top, scope: sc.body.scopes[0], vars: Object.fromEntries(vars.body.variables.map((v) => [v.name, v.value])), frameId: top.id };
  };
  console.log("-- " + label);
  try {
    await ask("initialize", { adapterID: "xscript" });
    const launch = send("launch", { projectRoot: root, project: name });
    await until((m) => m.event === "initialized", "initialized");
    await body({ ask, until, nextStop, locals, out, launch, send });
  } catch (e) {
    check(false, label + ": " + e.message);
    try { await ask("disconnect", { terminateDebuggee: true }); } catch { /* ignore */ }
  } finally { s.dispose(); }
  for (let i = 0; i < 40 && (await client.status(5000)).running; i++) await new Promise((r) => setTimeout(r, 250));
}

const finish = async (c, seen) => {
  await c.ask("continue", { threadId: seen[seen.length - 1].body.threadId });
  await c.until((m) => m.event === "terminated", "terminated");
  await c.ask("disconnect", { terminateDebuggee: true });
};

(async () => {
  try {
    if ((await client.status(5000)).running) throw new Error("a script is running on the device; stop it first");
    await session("conditional breakpoint + setVariable + evaluate", async (c) => {
      const bps = await c.ask("setBreakpoints", { source: { path: file }, breakpoints: [{ line: 3, condition: "i == 7" }, { line: 6 }] });
      check(bps.body.breakpoints.every((b) => b.verified), "conditional and plain breakpoints verified");
      await c.ask("configurationDone");
      const seen = [];
      const s1 = await c.nextStop(seen);
      const a = await c.locals(s1.body.threadId);
      check(a.top.line === 3 && a.vars.i === "7" && a.vars.total === "21", `condition i == 7 stops at line 3 with i=7 total=21 (got line ${a.top.line}, i=${a.vars.i}, total=${a.vars.total})`);
      await c.ask("continue", { threadId: s1.body.threadId });
      const s2 = await c.nextStop(seen);
      const b = await c.locals(s2.body.threadId);
      check(b.top.line === 6 && b.vars.x === "5", "next stop is line 6 (the loop did not stop again after i == 7), x == 5");
      const set = await c.ask("setVariable", { variablesReference: b.scope.variablesReference, name: "x", value: "100" });
      check(set.body.value === "100", "setVariable x=100 answered with the new value");
      const ev = await c.ask("evaluate", { expression: "x + 1", frameId: b.frameId, context: "repl" });
      check(ev.body.result === "101", "evaluate sees the changed x (x + 1 == 101)");
      await c.ask("next", { threadId: s2.body.threadId });
      await c.nextStop(seen);
      const d = await c.locals(s2.body.threadId);
      check(d.vars.y === "200", `y computed from the changed x: y == ${d.vars.y}`);
      const bad = await c.send("setVariable", { variablesReference: d.scope.variablesReference, name: "y", value: "1 +" });
      const resp = await c.until((m) => m.type === "response" && m.request_seq === bad, "bad setVariable response");
      if (process.env.XS_TRACE) console.log("   bad setVariable response:", JSON.stringify(resp));
      // debugpy either refuses the bad expression or keeps the old value; both are fine, a changed value or a hang is not.
      const after = await c.locals(s2.body.threadId);
      check((resp.success === false || resp.body.value === "200") && after.vars.y === "200",
        `invalid value does not corrupt the variable (success=${resp.success}, value=${resp.body && resp.body.value}, y=${after.vars.y})`);
      await finish(c, seen);
      check(c.out.some((m) => m.event === "output" && /y 200/.test(m.body.output)), "script printed y 200 (the edit really changed execution)");
    });
    await session("hit count breakpoint", async (c) => {
      const bps = await c.ask("setBreakpoints", { source: { path: file }, breakpoints: [{ line: 3, hitCondition: "4" }] });
      check(bps.body.breakpoints[0].verified, "hit-count breakpoint verified");
      await c.ask("configurationDone");
      const seen = [];
      const s1 = await c.nextStop(seen);
      const a = await c.locals(s1.body.threadId);
      check(a.top.line === 3 && a.vars.i === "3", `hit condition 4 stops on the 4th pass (i == 3), got i=${a.vars.i}`);
      await c.ask("clearBreakpointsPlaceholder", {}).catch(() => {});
      await c.ask("setBreakpoints", { source: { path: file }, breakpoints: [] });
      await finish(c, seen);
    });
    await session("logpoint (no stop) + plain breakpoint", async (c) => {
      const bps = await c.ask("setBreakpoints", { source: { path: file }, breakpoints: [{ line: 3, logMessage: "pass i={i} total={total}" }, { line: 6 }] });
      check(bps.body.breakpoints.every((b) => b.verified), "logpoint and plain breakpoint verified");
      await c.ask("configurationDone");
      const seen = [];
      const s1 = await c.nextStop(seen);
      const a = await c.locals(s1.body.threadId);
      check(a.top.line === 6, "the logpoint did not stop: first stop is line 6 (got " + a.top.line + ")");
      if (process.env.XS_TRACE) console.log("   output events:", JSON.stringify(c.out.filter((m) => m.event === "output").map((m) => [m.body.category, m.body.output.slice(0, 60)])));
      const logs = c.out.filter((m) => m.event === "output" && /pass i=\d+ total=\d+/.test(m.body.output)).map((m) => m.body.output.trim());
      check(logs.length === 10 && logs[0] === "pass i=0 total=0" && logs[9] === "pass i=9 total=36", `logpoint printed 10 interpolated lines to the debug console (${logs.length}: first "${logs[0]}", last "${logs[9]}")`);
      await finish(c, seen);
    });
  } catch (e) {
    check(false, e.message);
  } finally {
    try { await fetch(client.baseUrl + "/projects/" + name, { method: "DELETE" }); } catch { /* ignore */ }
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  }
  console.log(failed ? "SOME CHECKS FAILED" : "ALL PASS");
})();
