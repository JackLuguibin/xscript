// Runs DeviceClient against scripts/mock_device.py, the same mock the MCP tests use,
// so the extension stays in step with protocol/openapi.yaml.
import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeviceClient, parseTarget, DEFAULT_PORT } from "../client";
import { collectFiles, findProjectRoot } from "../project";

const REPO = path.resolve(__dirname, "..", "..", "..", "..");
let proc: ChildProcess;
let client: DeviceClient;

function python(): string {
  const venv = path.join(REPO, ".venv", "bin", "python");
  return process.env.XSCRIPT_TEST_PYTHON || (fs.existsSync(venv) ? venv : "python3");
}

before(async () => {
  const code =
    "import sys, threading; sys.path.insert(0, sys.argv[1]); import mock_device;" +
    "s = mock_device.serve('127.0.0.1', 0); print(s.server_address[1], flush=True); threading.Event().wait()";
  proc = spawn(python(), ["-c", code, path.join(REPO, "scripts")], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.stdout!.once("data", (d: Buffer) => resolve(Number(d.toString().trim())));
  });
  client = new DeviceClient({ host: "127.0.0.1", port });
});

after(() => {
  proc?.kill();
});

test("parseTarget", () => {
  assert.deepEqual(parseTarget(""), { host: "127.0.0.1", port: DEFAULT_PORT });
  assert.deepEqual(parseTarget("192.168.1.5"), { host: "192.168.1.5", port: DEFAULT_PORT });
  assert.deepEqual(parseTarget("http://10.0.0.2:9861/"), { host: "10.0.0.2", port: 9861 });
  assert.throws(() => parseTarget("host:abc"));
});

test("findProjectRoot picks the topmost package and collectFiles skips junk", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "xs-ext-"));
  const proj = path.join(ws, "demo");
  fs.mkdirSync(path.join(proj, "lib", "__pycache__"), { recursive: true });
  fs.mkdirSync(path.join(proj, "res", "img"), { recursive: true });
  fs.writeFileSync(path.join(proj, "__init__.py"), "print('hi')\n");
  fs.writeFileSync(path.join(proj, "lib", "__init__.py"), "X = '中文'\n");
  fs.writeFileSync(path.join(proj, "lib", "__pycache__", "x.pyc"), "junk");
  fs.writeFileSync(path.join(proj, ".hidden"), "junk");
  fs.writeFileSync(path.join(proj, "res", "img", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  assert.equal(findProjectRoot(path.join(proj, "lib", "__init__.py"), ws), proj);
  assert.equal(findProjectRoot(path.join(proj, "res", "img"), ws), proj);
  assert.equal(findProjectRoot(ws, ws), undefined);

  const files = collectFiles(proj);
  assert.deepEqual(files.map((f) => f.path), ["__init__.py", "lib/__init__.py", "res/img/a.png"]);
  assert.equal(files[1].content, "X = '中文'\n");
  assert.equal(files[2].encoding, "base64");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("upload, run, logs, stop, eval, screen", async () => {
  const s = await client.status();
  assert.equal(s.running, false);

  const up = await client.uploadFiles("ext_demo", [
    { path: "__init__.py", content: "print('hi')\n", encoding: "utf-8" },
    { path: "res/a.bin", content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64" },
  ]);
  assert.equal(up.ok, true);
  assert.equal(up.count, 2);
  assert.ok((await client.listProjects()).includes("ext_demo"));

  assert.equal((await client.run("ext_demo")).running, true);
  const again = await client.run("ext_demo");
  assert.equal(again.error, "already running");
  assert.equal((await client.status()).project, "ext_demo");

  const logs = await client.logs(0);
  assert.ok(Array.isArray(logs.entries));
  assert.equal(typeof logs.next, "number");

  assert.equal((await client.stop("ext_demo")).running, false);

  const ev = await client.eval("1 + 1");
  assert.equal(ev.ok, true);

  const png = await client.screenPng();
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
