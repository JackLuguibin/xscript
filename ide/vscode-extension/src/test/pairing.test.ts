// Pairing against scripts/mock_device.py started with a code (the phone's default).
import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DeviceClient, HttpError, isPairingError, normalizeCode, validateCode } from "../client";

const REPO = path.resolve(__dirname, "..", "..", "..", "..");
let proc: ChildProcess;
let port = 0;

function python(): string {
  const venv = path.join(REPO, ".venv", "bin", "python");
  return process.env.XSCRIPT_TEST_PYTHON || (fs.existsSync(venv) ? venv : "python3");
}

before(async () => {
  const code =
    "import sys, threading; sys.path.insert(0, sys.argv[1]); import mock_device;" +
    "s = mock_device.serve('127.0.0.1', 0, token='ABCDEFGH'); print(s.server_address[1], flush=True); threading.Event().wait()";
  proc = spawn(python(), ["-c", code, path.join(REPO, "scripts")], { stdio: ["ignore", "pipe", "inherit"] });
  port = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.stdout!.once("data", (d: Buffer) => resolve(Number(d.toString().trim())));
  });
});

after(() => {
  proc?.kill();
});

test("pairing code helpers", () => {
  assert.equal(normalizeCode(" abcd-efgh "), "ABCDEFGH");
  assert.equal(validateCode("abcd-efgh"), undefined);
  assert.ok(validateCode("abc"));
  assert.ok(validateCode("ABCD-EFGH-1"));
  assert.ok(isPairingError(new HttpError(401, "{}")));
  assert.ok(!isPairingError(new HttpError(403, "{}")));
  assert.ok(!isPairingError(new Error("x")));
});

test("an unpaired client sees the public status and is refused everything else", async () => {
  const c = new DeviceClient({ host: "127.0.0.1", port });
  const s = await c.status();
  assert.equal(s.pairing, true);
  assert.equal(s.paired, false);
  assert.equal(s.running, undefined);
  await assert.rejects(c.listProjects(), (e: unknown) => isPairingError(e));
  const wrong = new DeviceClient({ host: "127.0.0.1", port }, 5000, "WRONG123");
  await assert.rejects(wrong.listProjects(), (e: unknown) => isPairingError(e));
});

test("a paired client works and sees the full status", async () => {
  const c = new DeviceClient({ host: "127.0.0.1", port }, 5000, "abcd-efgh");
  assert.ok(Array.isArray(await c.listProjects()));
  const s = await c.status();
  assert.equal(s.paired, true);
  assert.equal(typeof s.running, "boolean");
});
