import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeviceClient } from "../client";
import { collectFiles, findProjectRoot, isProjectDir } from "../project";
import {
  DEFAULT_SYNCIGNORE, IgnoreRules, SYNCIGNORE_PATH, diffAgainstLocal, fetchProject, loadIgnoreRules, planUpload, safeRelative, writePulled,
} from "../sync";

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

after(() => proc?.kill());

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xs-sync-"));
}

test(".syncignore: globs, anchors, directories, negation, last rule wins", () => {
  const r = new IgnoreRules("# c\n*.log\n/build/\ndocs/*.md\n**/tmp/\n!keep.log\nsecret?.txt\n");
  assert.equal(r.ignores("a.log", false), true);
  assert.equal(r.ignores("sub/b.log", false), true);
  assert.equal(r.ignores("keep.log", false), false);
  assert.equal(r.ignores("build", true), true);
  assert.equal(r.ignores("build", false), false, "a rule ending in / matches folders only");
  assert.equal(r.ignores("lib/build", true), false, "leading / anchors to the project root");
  assert.equal(r.ignores("docs/readme.md", false), true);
  assert.equal(r.ignores("docs/deep/readme.md", false), false, "* stays inside one segment");
  assert.equal(r.ignores("x/y/tmp", true), true);
  assert.equal(r.ignores("secret1.txt", false), true);
  assert.equal(r.ignores("secret12.txt", false), false);
  assert.equal(new IgnoreRules(DEFAULT_SYNCIGNORE).size, 5);
});

test("collectFiles honours .vscode/.syncignore; build.as marks a project", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".vscode"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.mkdirSync(path.join(root, "res"));
  fs.writeFileSync(path.join(root, "build.as"), '{"name":"p"}');
  fs.writeFileSync(path.join(root, "main.py"), "x = 1\n");
  fs.writeFileSync(path.join(root, "run.log"), "log");
  fs.writeFileSync(path.join(root, "dist", "o.py"), "o");
  fs.writeFileSync(path.join(root, "res", "a.txt"), "a");
  fs.writeFileSync(path.join(root, SYNCIGNORE_PATH), DEFAULT_SYNCIGNORE);
  assert.equal(isProjectDir(root), true, "build.as alone is a project");
  assert.equal(findProjectRoot(path.join(root, "main.py"), root), root);
  const names = collectFiles(root, loadIgnoreRules(root)).map((f) => f.path);
  assert.deepEqual(names, ["build.as", "main.py", "res/a.txt"]);
  assert.deepEqual(collectFiles(root).map((f) => f.path), ["build.as", "dist/o.py", "main.py", "res/a.txt", "run.log"]);
});

test("planUpload sends only new or changed files and never trusts a missing cache", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "__init__.py"), "print(1)\n");
  fs.writeFileSync(path.join(root, "b.py"), "B = 1\n");
  const files = collectFiles(root);
  const first = planUpload(files, undefined, {});
  assert.equal(first.upload.length, 2, "project missing on the device: everything goes");
  const remote = files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content) }));
  assert.equal(planUpload(files, remote, {}).upload.length, 2, "no cache: everything goes");
  const same = planUpload(files, remote, first.hashes);
  assert.equal(same.upload.length, 0);
  assert.equal(same.skipped, 2);
  fs.writeFileSync(path.join(root, "b.py"), "B = 2\n"); // same size, new content
  const next = planUpload(collectFiles(root), remote, first.hashes);
  assert.deepEqual(next.upload.map((f) => f.path), ["b.py"]);
  const gone = planUpload(files, remote.filter((f) => f.path !== "b.py"), first.hashes);
  assert.deepEqual(gone.upload.map((f) => f.path), ["b.py"], "deleted on the device: sent again");
  const resized = planUpload(files, remote.map((f) => (f.path === "b.py" ? { ...f, size: 99 } : f)), first.hashes);
  assert.deepEqual(resized.upload.map((f) => f.path), ["b.py"], "size differs on the device: sent again");
});

test("safeRelative rejects traversal", () => {
  for (const bad of ["", "/a", "../a", "a/../b", "a//b", "a\\b", "./a"]) assert.equal(safeRelative(bad), false, bad);
  assert.equal(safeRelative("lib/a.py"), true);
});

test("pull: round trip against the mock device, diff, and writes only what differs", async () => {
  const name = "sync_pull_" + Date.now();
  const root = tmp();
  fs.mkdirSync(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "__init__.py"), "import lib.util\n");
  fs.writeFileSync(path.join(root, "lib", "util.py"), "X = '中文'\n");
  fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 255, 1, 2]));
  await client.uploadFiles(name, collectFiles(root));
  assert.ok((await client.listProjects()).includes(name));
  assert.equal(await client.projectFiles("no_such_project_" + Date.now()), undefined);

  const pulled = await fetchProject(client, name);
  assert.deepEqual(pulled.map((f) => f.path).sort(), ["__init__.py", "bin.dat", "lib/util.py"]);
  const dest = tmp();
  let d = diffAgainstLocal(dest, pulled);
  assert.equal(d.added.length, 3);
  assert.equal(writePulled(dest, pulled, d), 3);
  assert.deepEqual(fs.readFileSync(path.join(dest, "bin.dat")), Buffer.from([0, 255, 1, 2]), "binary bytes survive");
  assert.equal(fs.readFileSync(path.join(dest, "lib", "util.py"), "utf-8"), "X = '中文'\n");
  fs.writeFileSync(path.join(dest, "lib", "util.py"), "edited");
  fs.writeFileSync(path.join(dest, "local_only.py"), "keep");
  d = diffAgainstLocal(dest, pulled);
  assert.deepEqual(d.changed, ["lib/util.py"]);
  assert.equal(d.unchanged.length, 2);
  assert.equal(writePulled(dest, pulled, d), 1);
  assert.equal(fs.readFileSync(path.join(dest, "local_only.py"), "utf-8"), "keep", "files the device lacks are left alone");
  await assert.rejects(fetchProject(client, "no_such_project_" + Date.now()), /does not exist/);
});
