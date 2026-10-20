// UI designer core shared by the Web IDE and the VS Code extension (android/app/src/main/assets/tools/ui-form.js).
// The extension's own tests (ide/vscode-extension/src/test/uiForm.test.ts) cover generation in depth; these check
// the browser-facing contract: the global, the module export and a round trip of every control kind.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const FILE = path.join(__dirname, "..", "..", "android", "app", "src", "main", "assets", "tools", "ui-form.js");
const F = require(FILE);

test("loads as window.XSUiForm in a browser-like context", () => {
  const win = {};
  vm.runInNewContext(fs.readFileSync(FILE, "utf8"), { window: win });
  assert.deepEqual(Object.keys(win.XSUiForm).sort(), Object.keys(F).sort());
  assert.equal(typeof win.XSUiForm.renderHtml, "function");
});

test("every control kind generates; ids stay valid and unique", () => {
  const s = F.newSpec("t");
  for (const k of F.FIELD_KINDS) s.fields.push(F.newField(k, s));
  assert.deepEqual(F.validateSpec(s), []);
  const out = F.outputs(s, "main");
  assert.deepEqual(Object.keys(out).sort(), ["res/ui/main.html", "ui_main.py"]);
  assert.ok(out["res/ui/main.html"].includes(F.INIT_MARKER));
  assert.ok(out["ui_main.py"].includes('R.res("ui/main.html")'));
  assert.equal(F.parseSpec(F.serializeSpec(s)).fields.length, F.FIELD_KINDS.length);
});

test("validation catches bad ids, duplicates and empty choices", () => {
  const s = F.newSpec();
  s.fields.push({ kind: "text", id: "class", label: "a" }, { kind: "text", id: "x", label: "b" },
    { kind: "text", id: "x", label: "c" }, { kind: "radio", id: "r", label: "d", options: [] });
  const errs = F.validateSpec(s).join("\n");
  assert.match(errs, /Python identifier/);
  assert.match(errs, /duplicate id/);
  assert.match(errs, /at least one option/);
});

test("formName accepts only <identifier>.ui.json", () => {
  assert.equal(F.formName("res/ui/main.ui.json"), "main");
  assert.equal(F.formName("res/ui/设置.ui.json"), "设置");
  assert.equal(F.formName("res/ui/1x.ui.json"), undefined);
  assert.equal(F.formName("res/ui/main.json"), undefined);
});
