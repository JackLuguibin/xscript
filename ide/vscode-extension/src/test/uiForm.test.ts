import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FIELD_KINDS, FormSpec, INIT_MARKER, defaults, newField, newSpec, outputs, parseSpec, renderHtml, validateSpec } from "../uiForm";

function fullSpec(): FormSpec {
  const s = newSpec("设置 <&>");
  for (const k of FIELD_KINDS) s.fields.push(newField(k, s));
  return s;
}

test("newField gives every kind a unique Python-identifier id and the spec validates", () => {
  const s = fullSpec();
  assert.deepEqual(validateSpec(s), []);
  const ids = s.fields.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(defaults(s), { text1: "", password2: "", textarea3: "", number4: 0, checkbox5: false, select6: "A", radio7: "A" });
});

test("validateSpec catches bad ids, duplicates, keywords, empty options and non-numeric number defaults", () => {
  const s = newSpec();
  s.fields = [
    { kind: "text", id: "1x", label: "a" },
    { kind: "text", id: "dup", label: "b" },
    { kind: "text", id: "dup", label: "c" },
    { kind: "text", id: "class", label: "d" },
    { kind: "select", id: "s", label: "e", options: [] },
    { kind: "number", id: "n", label: "f", default: "3" as any },
    { kind: "label", id: "", label: "labels need no id" },
  ];
  const errs = validateSpec(s).join("\n");
  for (const want of ["(1x): id", "(dup): duplicate", "(class): id", "(s): needs", "(n): default"]) assert.ok(errs.includes(want), want + " in " + errs);
  assert.equal(validateSpec(s).length, 5);
  assert.deepEqual(validateSpec({} as FormSpec), ["not a form spec (fields missing)"]);
});

test("parseSpec fills missing top-level settings from newSpec", () => {
  const s = parseSpec('{"title":"T","fields":[{"kind":"text","id":"a","label":"A"}]}');
  assert.equal(s.submit, newSpec().submit);
  assert.equal(s.width, "85vw");
  assert.equal(s.fields[0].id, "a");
});

test("renderHtml escapes user text, has one control per field, the init marker and valid inline JS", () => {
  const s = fullSpec();
  s.fields[0].label = '<script>alert("x")</script>';
  const html = renderHtml(s);
  assert.ok(!html.includes('<script>alert("x")'), "label escaped");
  assert.ok(html.includes("设置 &lt;&amp;&gt;"));
  for (const f of s.fields) if (f.kind !== "label") assert.ok(html.includes(`data-key="${f.id}"`), f.id);
  assert.equal(html.split(INIT_MARKER).length, 2, "exactly one init marker");
  const js = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(js), "inline script parses");
  assert.match(html, /\.call\("submit", JSON\.stringify\(collect\(\)\)\)/);
});

test("generated Python shows the page, pre-fills values and returns typed submitted values (fake ui.Window)", (t) => {
  const python = ["python3", "python"].find((p) => { try { execFileSync(p, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } });
  if (!python) return t.skip("no python");
  const s = fullSpec();
  s.fields[3].default = 5;                       // number4: int default -> int results
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xs-uiform-"));
  for (const [rel, text] of Object.entries(outputs(s, "main"))) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  // fake runtime: Window records the html and, on show(wait=True), "submits" like the page's JS would
  fs.mkdirSync(path.join(dir, "xscript", "android"), { recursive: true });
  fs.writeFileSync(path.join(dir, "xscript", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "xscript", "android", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "xscript", "android", "system.py"),
    "import os\nclass R:\n    @staticmethod\n    def res(*p):\n        return os.path.join(os.environ['XS_ROOT'], 'res', *p)\n");
  fs.writeFileSync(path.join(dir, "xscript", "android", "ui.py"), `import json, os
SEEN = {}
class Window:
    def __init__(self, html, width=None, height=None, **o):
        SEEN.update(html=html, width=width, height=height); self.h = {}; self.closed = False
    def on(self, key):
        def deco(fn): self.h[key] = fn; return fn
        return deco
    def close(self): self.closed = True
    def show(self, wait=False):
        action = os.environ["XS_ACTION"]
        if action == "cancel": self.h["cancel"]("")
        else: self.h["submit"](action)
        assert wait and self.closed
`);
  fs.writeFileSync(path.join(dir, "check.py"), `import json, sys
from ui_main import show
from xscript.android.ui import SEEN
r = show(values={"text1": "</script>x", "number4": 7})
init = SEEN["html"].split("var init = ")[1].split(";")[0]
print(json.dumps({"r": r, "init": json.loads(init.replace("<\\\\/", "</")), "marker_left": "/*XS_INIT*/" in SEEN["html"], "w": SEEN["width"]}))
`);
  const run = (action: string) => JSON.parse(execFileSync(python, ["check.py"], { cwd: dir, env: { ...process.env, XS_ROOT: dir, XS_ACTION: action, PYTHONWARNINGS: "error" } }).toString());
  const submitted = { text1: "hi", password2: "pw", textarea3: "a\nb", number4: "12", checkbox5: true, select6: "B", radio7: "B", extra: 1 };
  const out = run(JSON.stringify(submitted));
  assert.deepEqual(out.r, { text1: "hi", password2: "pw", textarea3: "a\nb", number4: 12, checkbox5: true, select6: "B", radio7: "B" });
  assert.equal(out.init.text1, "</script>x", "script values reach the page, '</' escaped");
  assert.equal(out.init.number4, 7);
  assert.equal(out.marker_left, false);
  assert.equal(out.w, "85vw");
  const fl = run(JSON.stringify({ number4: 2.5 }));
  assert.equal(fl.r.number4, 2.5, "fractional numbers stay floats");
  assert.equal(run("cancel").r, null, "cancel returns None");
});

test("select renders as an in-page option list (no native pop-up in the overlay window)", () => {
  const s = newSpec();
  s.fields.push({ kind: "select", id: "mode", label: "Mode", options: ["easy", "hard"], default: "hard" });
  const h = renderHtml(s);
  assert.doesNotMatch(h, /<select/);
  assert.match(h, /<div class="choice" role="listbox" aria-labelledby="l_mode" id="f_mode" data-key="mode" data-type="choice" data-value="hard">/);
  assert.match(h, /<button type="button" role="option" class="opt" aria-selected="false" data-value="easy">easy<\/button>/);
  assert.match(h, /class="opt sel" aria-selected="true" data-value="hard">hard</);
});

test("the core is the Web IDE's ui-form.js, copied unchanged into the build", () => {
  const shared = path.resolve(__dirname, "..", "..", "..", "..", "android", "app", "src", "main", "assets", "tools", "ui-form.js");
  const built = path.resolve(__dirname, "..", "ui-form-core.js");
  assert.equal(fs.readFileSync(built, "utf8"), fs.readFileSync(shared, "utf8"), "out/ui-form-core.js is stale: run npm run compile");
});
