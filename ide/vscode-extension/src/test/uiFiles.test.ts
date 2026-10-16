import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateFor, projectRootFor } from "../uiFiles";
import { formName, newField, newSpec, serializeSpec } from "../uiForm";

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xs-uifiles-"));
  fs.writeFileSync(path.join(root, "__init__.py"), "");
  fs.mkdirSync(path.join(root, "res", "ui"), { recursive: true });
  return root;
}

test("formName accepts <identifier>.ui.json only", () => {
  assert.equal(formName("/p/res/ui/main.ui.json"), "main");
  assert.equal(formName("C:\\\\p\\\\res\\\\ui\\\\设置.ui.json"), "设置");
  for (const bad of ["/p/main.json", "/p/1x.ui.json", "/p/a-b.ui.json"]) assert.equal(formName(bad), undefined, bad);
});

test("saving a spec writes res/ui/<name>.html and ui_<name>.py at the project root, only when changed", () => {
  const root = project();
  const spec = newSpec();
  spec.fields.push(newField("text", spec));
  const file = path.join(root, "res", "ui", "main.ui.json");
  assert.equal(projectRootFor(file), root);
  const logs: string[] = [];
  assert.deepEqual(generateFor(file, serializeSpec(spec), (s) => logs.push(s)).sort(), ["res/ui/main.html", "ui_main.py"]);
  assert.ok(fs.readFileSync(path.join(root, "ui_main.py"), "utf-8").includes('R.res("ui/main.html")'));
  assert.deepEqual(generateFor(file, serializeSpec(spec)), [], "unchanged -> nothing rewritten");
  assert.match(logs[0], /wrote res\/ui\/main.html, ui_main.py/);
});

test("invalid JSON or an invalid spec generates nothing and says why", () => {
  const root = project();
  const file = path.join(root, "res", "ui", "bad.ui.json");
  const logs: string[] = [];
  assert.deepEqual(generateFor(file, "{nope", (s) => logs.push(s)), []);
  const spec = newSpec();
  spec.fields.push({ kind: "text", id: "class", label: "x" });
  assert.deepEqual(generateFor(file, serializeSpec(spec), (s) => logs.push(s)), []);
  assert.match(logs.join("\n"), /not valid JSON[\s\S]*id must be a Python identifier/);
  assert.ok(!fs.existsSync(path.join(root, "ui_bad.py")));
});

test("a res/ui spec outside any project still maps to the folder above res/", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xs-uifiles-np-"));
  assert.equal(projectRootFor(path.join(dir, "res", "ui", "x.ui.json")), dir);
  assert.equal(projectRootFor(path.join(dir, "x.ui.json")), dir);
});
