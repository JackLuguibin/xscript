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

test("templates match the device copy (android assets/templates/projects.json)", () => {
  const file = path.join(__dirname, "..", "..", "..", "..", "android", "app", "src", "main", "assets", "templates", "projects.json");
  const device = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    templates: { id: string; label_en: string; detail_en: string; files: Record<string, string> }[];
  };
  assert.deepEqual(device.templates.map((t) => t.id), TEMPLATES.map((t) => t.id));
  for (const t of TEMPLATES) {
    const d = device.templates.find((x) => x.id === t.id)!;
    assert.equal(d.label_en, t.label, t.id);
    assert.equal(d.detail_en, t.detail, t.id);
    const rendered = Object.fromEntries(Object.entries(d.files).map(([k, v]) => [k, v.split("{{name}}").join("demo")]));
    assert.deepEqual(rendered, t.files("demo"), t.id);
  }
});
