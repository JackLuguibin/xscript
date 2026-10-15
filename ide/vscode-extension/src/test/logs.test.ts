// Pure helpers behind the extension commands: address parsing, error text, log following,
// and project collection edge cases. The mock-device parts reuse scripts/mock_device.py.
import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_PORT, DeviceClient, FollowState, HttpError, Logs, baseUrl, currentSeq, describeError, followTick, parseTarget,
} from "../client";
import { collectFiles, findProjectRoot } from "../project";

const REPO = path.resolve(__dirname, "..", "..", "..", "..");
let proc: ChildProcess;
let client: DeviceClient;

before(async () => {
  const venv = path.join(REPO, ".venv", "bin", "python");
  const py = process.env.XSCRIPT_TEST_PYTHON || (fs.existsSync(venv) ? venv : "python3");
  const code =
    "import sys, threading; sys.path.insert(0, sys.argv[1]); import mock_device;" +
    "s = mock_device.serve('127.0.0.1', 0); print(s.server_address[1], flush=True); threading.Event().wait()";
  proc = spawn(py, ["-c", code, path.join(REPO, "scripts")], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.stdout!.once("data", (d: Buffer) => resolve(Number(d.toString().trim())));
  });
  client = new DeviceClient({ host: "127.0.0.1", port });
});

after(() => proc?.kill());

test("parseTarget handles paths, IPv6 and bad ports", () => {
  assert.deepEqual(parseTarget("http://10.0.0.2:9860/tools/"), { host: "10.0.0.2", port: 9860 });
  assert.deepEqual(parseTarget("  10.0.0.2:19860  "), { host: "10.0.0.2", port: 19860 });
  assert.deepEqual(parseTarget(":19860"), { host: "127.0.0.1", port: 19860 });
  assert.deepEqual(parseTarget("10.0.0.2:"), { host: "10.0.0.2", port: DEFAULT_PORT });
  assert.deepEqual(parseTarget("[::1]:19860"), { host: "::1", port: 19860 });
  assert.deepEqual(parseTarget("fe80::1"), { host: "fe80::1", port: DEFAULT_PORT });
  assert.deepEqual(parseTarget("[fe80::1]"), { host: "fe80::1", port: DEFAULT_PORT });
  assert.equal(baseUrl(parseTarget("[::1]:19860")), "http://[::1]:19860");
  for (const bad of ["host:0", "host:70000", "host:12ab", "host:-1", "[::1"]) assert.throws(() => parseTarget(bad), bad);
});

test("describeError gives the device's reason, timeouts and socket codes", () => {
  const e = new HttpError(409, JSON.stringify({ error: "工程已存在: demo" }));
  assert.equal(e.detail, "工程已存在: demo");
  assert.equal(describeError(e), "HTTP 409: 工程已存在: demo");
  assert.equal(describeError(new HttpError(500, "<html>oops</html>")), "HTTP 500: <html>oops</html>");
  assert.equal(describeError(new HttpError(502, "")), "HTTP 502");
  assert.equal(describeError(Object.assign(new Error("x"), { name: "TimeoutError" })), "timed out");
  assert.equal(describeError(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } } as ErrorOptions)), "ECONNREFUSED");
  assert.equal(describeError("plain"), "plain");
});

function fakeLogs(pages: Logs[], running: boolean[] = []) {
  const seen: number[] = [];
  return {
    seen,
    async logs(since = 0): Promise<Logs> {
      seen.push(since);
      return pages.shift() ?? { entries: [], next: since };
    },
    async status(): Promise<Record<string, unknown>> {
      return { running: running.length ? running.shift() : false };
    },
  };
}

const entry = (seq: number, line: string) => ({ seq, ts: 0, stream: "stdout", line });

test("currentSeq pages to the end and stops on a stuck cursor", async () => {
  const c = fakeLogs([{ entries: [entry(1, "a")], next: 2 }, { entries: [entry(2, "b")], next: 3 }, { entries: [], next: 3 }]);
  assert.equal(await currentSeq(c), 3);
  assert.deepEqual(c.seen, [0, 2, 3]);
  const stuck = fakeLogs(Array.from({ length: 10 }, () => ({ entries: [entry(5, "x")], next: 5 })));
  assert.equal(await currentSeq(stuck), 5, "a device that keeps returning the same next does not loop forever");
  const endless = { logs: async (since = 0) => ({ entries: [entry(since, "x")], next: since + 1 }) };
  assert.equal(await currentSeq(endless, 7), 7, "bounded number of pages");
});

test("followTick writes lines, advances, and finishes after quiet polls once the script stops", async () => {
  const out: string[] = [];
  const c = fakeLogs(
    [{ entries: [entry(1, "one\n"), entry(2, "two")], next: 3 }, { entries: [], next: 3 }, { entries: [], next: 3 },
      { entries: [], next: 3 }, { entries: [], next: 3 }, { entries: [], next: 3 }, { entries: [], next: 3 }],
    [true, false],
  );
  const st: FollowState = { since: 1, idle: 0 };
  assert.equal(await followTick(c, st, (t) => out.push(t)), "more");
  assert.deepEqual(out, ["one\n", "two\n"]);
  assert.equal(st.since, 3);
  assert.equal(await followTick(c, st, (t) => out.push(t)), "more");
  assert.equal(await followTick(c, st, (t) => out.push(t)), "more");
  assert.equal(await followTick(c, st, (t) => out.push(t)), "more", "3rd quiet poll: still running");
  assert.equal(await followTick(c, st, (t) => out.push(t)), "more");
  assert.equal(await followTick(c, st, (t) => out.push(t)), "more");
  assert.equal(await followTick(c, st, (t) => out.push(t)), "done", "6th quiet poll: stopped");
  // A cleared device log (next below our cursor) resets the cursor instead of stalling.
  const cleared = fakeLogs([{ entries: [], next: 0 }]);
  const st2: FollowState = { since: 50, idle: 0 };
  await followTick(cleared, st2, () => {});
  assert.equal(st2.since, 0);
});

test("followTick against the mock device follows a real run", async () => {
  await client.uploadFiles("ext_follow", [{ path: "__init__.py", content: "print('x')\n", encoding: "utf-8" }]);
  const start = await currentSeq(client);
  await client.run("ext_follow");
  const out: string[] = [];
  const st: FollowState = { since: start, idle: 0 };
  await followTick(client, st, (t) => out.push(t));
  assert.ok(out.length > 0, "lines from the new run");
  assert.ok(st.since > start);
  await client.stop("ext_follow");
});

test("device errors carry the device's message; run of a missing project is data, not a throw", async () => {
  await assert.rejects(
    client.uploadFiles("ext_bad", [{ path: "../evil.py", content: "", encoding: "utf-8" }]),
    (e: unknown) => e instanceof HttpError && e.status === 400 && /invalid path/.test(e.message),
  );
  const missing = await client.run("no_such_project_zz");
  assert.ok(missing.error, "404 body returned as data");
  const dead = new DeviceClient({ host: "127.0.0.1", port: 1 }, 2000);
  await assert.rejects(dead.status(), (e: unknown) => /ECONNREFUSED|fetch failed|timed out/.test(describeError(e)));
});

test("collectFiles: non-UTF-8 text goes as base64, symlinks and dotfiles are skipped", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "xs-ext2-"));
  const proj = path.join(ws, "p");
  fs.mkdirSync(path.join(proj, "node_modules", "x"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".git"));
  fs.writeFileSync(path.join(proj, "__init__.py"), "print(1)\n");
  fs.writeFileSync(path.join(proj, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  fs.writeFileSync(path.join(proj, "data.JSON"), '{"a":1}');
  fs.writeFileSync(path.join(proj, "node_modules", "x", "i.js"), "x");
  fs.writeFileSync(path.join(proj, ".git", "HEAD"), "x");
  fs.writeFileSync(path.join(proj, "m.pyo"), "x");
  fs.writeFileSync(path.join(ws, "secret.txt"), "TOP");
  fs.symlinkSync(path.join(ws, "secret.txt"), path.join(proj, "link.txt"));
  const files = collectFiles(proj);
  assert.deepEqual(files.map((f) => f.path), ["__init__.py", "data.JSON", "latin1.txt"]);
  assert.equal(files.find((f) => f.path === "latin1.txt")!.encoding, "base64");
  assert.equal(files.find((f) => f.path === "data.JSON")!.encoding, "utf-8", "extension match is case-insensitive");
  assert.equal(findProjectRoot(path.join(proj, "nope", "deeper.py"), ws), proj, "a not-yet-existing path resolves via its parent");
  fs.rmSync(ws, { recursive: true, force: true });
});
