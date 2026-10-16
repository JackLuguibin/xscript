import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TEMPLATES, createProject, validateProjectName } from "../newProject";
import { findProjectRoot } from "../project";

test("project names follow the device rule", () => {
  for (const ok of ["demo", "_x", "脚本1", "a_b2"]) assert.equal(validateProjectName(ok), undefined, ok);
  for (const bad of ["", "1a", "a-b", "a b", "a/b", "..", "a.b"]) assert.notEqual(validateProjectName(bad), undefined, bad);
});

test("every template creates an entry file, build.as and res/, and refuses a non-empty folder", () => {
  for (const t of TEMPLATES) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "xs-new-"));
    const dir = createProject(parent, "demo", t);
    assert.equal(dir, path.join(parent, "demo"));
    assert.ok(fs.statSync(path.join(dir, "__init__.py")).size > 0, t.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "build.as"), "utf-8")), { name: "demo", version: "1.0.0", entry: "__init__.py" });
    assert.ok(fs.existsSync(path.join(dir, "res")));
    for (const rel of Object.keys(t.files("demo"))) assert.ok(fs.existsSync(path.join(dir, ...rel.split("/"))), t.id + ": " + rel);
    assert.equal(findProjectRoot(path.join(dir, "__init__.py"), parent), dir);
    assert.throws(() => createProject(parent, "demo", t), /not empty/);
  }
  assert.throws(() => createProject(os.tmpdir(), "bad-name", TEMPLATES[0]), /letters/);
});

test("template ids are unique and the scenario templates from the roadmap exist", () => {
  const ids = TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["checkin", "findImage", "ocr", "floatUi"]) assert.ok(ids.includes(id), id);
});
