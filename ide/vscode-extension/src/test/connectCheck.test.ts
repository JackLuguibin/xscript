import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import { HttpError } from "../client";
import { STEP_IDS, canConnect, failureSummary, formatCheck, langOf, runConnectCheck, stepFix, stepTitle, tcpConnect } from "../connectCheck";

const ok = () => Promise.resolve();
const device = { model: "Pixel", version: "0.4.0", device_id: "d1", pairing: true, paired: true };
const oks = (steps: { ok: boolean | null }[]) => steps.map((s) => s.ok);
const fail = (e: unknown) => () => Promise.reject(e);

test("all steps pass for a paired XScript device", async () => {
  const steps = await runConnectCheck("192.168.1.23", { connect: ok, status: async () => device });
  assert.deepEqual(oks(steps), [true, true, true, true, true]);
  assert.equal(steps[0].detail, "192.168.1.23:9860");
  assert.equal(steps[3].detail, "Pixel 0.4.0");
  assert.equal(steps[4].detail, "paired");
  assert.ok(canConnect(steps));
  assert.match(formatCheck("192.168.1.23", steps, "en").join("\n"), /All checks passed/);
});

test("a bad address stops at the first step", async () => {
  const steps = await runConnectCheck("host:99999", { connect: fail(new Error("no")), status: fail(new Error("no")) });
  assert.deepEqual(oks(steps), [false, null, null, null, null]);
  assert.ok(!canConnect(steps));
});

test("refused / timeout are told apart, with the fix and the troubleshooting link", async () => {
  const refused = await runConnectCheck("127.0.0.1:1", { connect: fail(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), status: fail(new Error("no")) });
  assert.deepEqual(oks(refused), [true, false, null, null, null]);
  assert.equal(refused[1].detail, "refused");
  const text = formatCheck("127.0.0.1:1", refused, "zh").join("\n");
  assert.ok(text.includes("怎么修：" + stepFix("reach", "zh")));
  assert.ok(text.includes("TROUBLESHOOTING.md"));
  assert.ok(text.includes(stepTitle("app", "zh") + " · 未检查"));
  assert.ok(failureSummary(refused, "en").startsWith("Stopped at “Address reachable (refused)”"));
  const timeout = await runConnectCheck("10.0.0.9", { connect: fail(Object.assign(new Error("t"), { code: "ETIMEDOUT" })), status: fail(new Error("no")) });
  assert.equal(timeout[1].detail, "timeout");
});

test("an open port without the app, another server, or a non-JSON answer fail later", async () => {
  assert.deepEqual(oks(await runConnectCheck("a:1", { connect: ok, status: fail(new TypeError("fetch failed")) })), [true, true, false, null, null]);
  assert.deepEqual(oks(await runConnectCheck("a:1", { connect: ok, status: async () => ({ ok: 1 }) })), [true, true, true, false, null]);
  assert.deepEqual(oks(await runConnectCheck("a:1", { connect: ok, status: fail(new HttpError(404, "")) })), [true, true, true, false, null]);
  assert.deepEqual(oks(await runConnectCheck("a:1", { connect: ok, status: fail(new SyntaxError("bad json")) })), [true, true, true, false, null]);
  const closed = await runConnectCheck("a:1", { connect: ok, status: fail(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } })) });
  assert.equal(closed[2].detail, "closed without an answer");
  const slow = await runConnectCheck("a:1", { connect: ok, status: fail(Object.assign(new Error("t"), { name: "TimeoutError" })) });
  assert.equal(slow[2].detail, "timeout");
});

test("a missing pairing code still allows connecting (it is asked for next)", async () => {
  const viaJson = await runConnectCheck("a", { connect: ok, status: async () => ({ model: "P", pairing: true, paired: false }) });
  assert.deepEqual(oks(viaJson), [true, true, true, true, false]);
  assert.ok(canConnect(viaJson));
  const via401 = await runConnectCheck("a", { connect: ok, status: fail(new HttpError(401, "")) });
  assert.deepEqual(oks(via401), [true, true, true, true, false]);
  assert.equal((await runConnectCheck("a", { connect: ok, status: async () => ({ model: "P" }) }))[4].detail, "off");
});

test("real TCP connect: a listening port, then the same port closed", async () => {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  await tcpConnect({ host: "127.0.0.1", port }, 1000);
  await new Promise<void>((r) => server.close(() => r()));
  const steps = await runConnectCheck("127.0.0.1:" + port, { connect: (t) => tcpConnect(t, 1000), status: fail(new Error("no")) });
  assert.equal(steps[1].detail, "refused");
});

test("every step has generated zh / en texts; language follows the VS Code display language", () => {
  for (const id of STEP_IDS) for (const lang of ["zh", "en"] as const) {
    assert.ok(stepTitle(id, lang));
    assert.ok(stepFix(id, lang));
  }
  assert.equal(langOf("zh-cn"), "zh");
  assert.equal(langOf("en"), "en");
});
