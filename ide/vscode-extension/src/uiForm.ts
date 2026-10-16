// UI designer core: a form spec (res/ui/<name>.ui.json) -> the HTML page ui.Window shows and the Python that
// shows it and returns the filled values. Free of `vscode` so it runs under node --test.

export type FieldKind = "text" | "password" | "textarea" | "number" | "checkbox" | "select" | "radio" | "label";
export const FIELD_KINDS: FieldKind[] = ["text", "password", "textarea", "number", "checkbox", "select", "radio", "label"];

export interface Field {
  kind: FieldKind;
  /** Key in the returned dict (Python identifier). Ignored for "label". */
  id: string;
  label: string;
  /** str for text-like/select/radio, number for number, boolean for checkbox. */
  default?: string | number | boolean;
  /** select / radio choices. */
  options?: string[];
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
}

export interface FormSpec {
  version: 1;
  title: string;
  submit: string;
  cancel?: string;
  /** Window size, CSS units ui.Window accepts (e.g. "85vw"). */
  width: string;
  height: string;
  fields: Field[];
}

export function newSpec(title = "Settings"): FormSpec {
  return { version: 1, title, submit: "开始", cancel: "取消", width: "85vw", height: "60vh", fields: [] };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PY_KEYWORDS = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "));

/** Default-ish new field of a kind with a free id (field1, field2, ...). */
export function newField(kind: FieldKind, spec: FormSpec): Field {
  const used = new Set(spec.fields.map((f) => f.id));
  let n = spec.fields.length + 1;
  while (used.has(kind + n)) n++;
  const id = kind + n;
  switch (kind) {
    case "number": return { kind, id, label: "Number", default: 0 };
    case "checkbox": return { kind, id, label: "Enabled", default: false };
    case "select": case "radio": return { kind, id, label: "Choice", options: ["A", "B"], default: "A" };
    case "label": return { kind, id, label: "Some explanation text" };
    default: return { kind, id, label: kind === "password" ? "Password" : "Text", default: "" };
  }
}

/** Problems that would make the generated code wrong; empty when the spec is fine. */
export function validateSpec(spec: FormSpec): string[] {
  const errs: string[] = [];
  if (!spec || !Array.isArray(spec.fields)) return ["not a form spec (fields missing)"];
  const seen = new Set<string>();
  spec.fields.forEach((f, i) => {
    const at = "field " + (i + 1) + " (" + (f.id || "?") + ")";
    if (!FIELD_KINDS.includes(f.kind)) errs.push(at + ": unknown kind " + f.kind);
    if (f.kind === "label") return;
    if (!IDENT.test(f.id || "") || PY_KEYWORDS.has(f.id)) errs.push(at + ": id must be a Python identifier");
    else if (seen.has(f.id)) errs.push(at + ": duplicate id");
    seen.add(f.id);
    if ((f.kind === "select" || f.kind === "radio") && !(f.options && f.options.length)) errs.push(at + ": needs at least one option");
    if (f.kind === "number" && f.default !== undefined && typeof f.default !== "number") errs.push(at + ": default must be a number");
  });
  return errs;
}

/** Normalised copy (types coerced) so JSON written by hand still generates sane code. */
export function parseSpec(text: string): FormSpec {
  const raw = JSON.parse(text);
  const spec: FormSpec = { ...newSpec(), ...raw, version: 1 };
  spec.fields = (Array.isArray(raw.fields) ? raw.fields : []).map((f: any) => ({ ...f, id: String(f.id ?? ""), label: String(f.label ?? "") }));
  return spec;
}

export function defaults(spec: FormSpec): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of spec.fields) {
    if (f.kind === "label") continue;
    if (f.kind === "checkbox") out[f.id] = Boolean(f.default);
    else if (f.kind === "number") out[f.id] = typeof f.default === "number" ? f.default : 0;
    else if (f.kind === "select" || f.kind === "radio") out[f.id] = f.default !== undefined && f.options?.includes(String(f.default)) ? String(f.default) : f.options?.[0] ?? "";
    else out[f.id] = f.default === undefined ? "" : String(f.default);
  }
  return out;
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fieldHtml(f: Field, value: string | number | boolean | undefined): string {
  const req = f.required ? " required" : "";
  const lab = `<label for="f_${esc(f.id)}">${esc(f.label)}</label>`;
  switch (f.kind) {
    case "label": return `<p class="note">${esc(f.label)}</p>`;
    case "checkbox":
      return `<div class="row check"><input type="checkbox" id="f_${esc(f.id)}" data-key="${esc(f.id)}" data-type="bool"${value ? " checked" : ""}>${lab}</div>`;
    case "textarea":
      return `<div class="row">${lab}<textarea id="f_${esc(f.id)}" data-key="${esc(f.id)}" placeholder="${esc(f.placeholder)}"${req}>${esc(value)}</textarea></div>`;
    case "select":
      return `<div class="row">${lab}<select id="f_${esc(f.id)}" data-key="${esc(f.id)}">` +
        (f.options || []).map((o) => `<option${o === value ? " selected" : ""}>${esc(o)}</option>`).join("") + `</select></div>`;
    case "radio":
      return `<div class="row"><span class="lab">${esc(f.label)}</span><div class="radios" data-key="${esc(f.id)}" data-type="radio">` +
        (f.options || []).map((o, i) => `<label><input type="radio" name="f_${esc(f.id)}" value="${esc(o)}"${o === value ? " checked" : ""}${i === 0 ? req : ""}>${esc(o)}</label>`).join("") +
        `</div></div>`;
    case "number": {
      const attrs = (["min", "max", "step"] as const).filter((k) => typeof f[k] === "number").map((k) => ` ${k}="${f[k]}"`).join("");
      return `<div class="row">${lab}<input type="number" id="f_${esc(f.id)}" data-key="${esc(f.id)}" data-type="num" value="${esc(value)}"${attrs}${req}></div>`;
    }
    default:
      return `<div class="row">${lab}<input type="${f.kind}" id="f_${esc(f.id)}" data-key="${esc(f.id)}" value="${esc(value)}" placeholder="${esc(f.placeholder)}"${req}></div>`;
  }
}

/**
 * The page shown by ui.Window. Submitting calls xscript.call("submit", <JSON of the values>); cancel closes.
 * The generated Python swaps the XS_INIT marker (INIT_MARKER) for the script's current values before showing it.
 */
export const INIT_MARKER = "/*XS_INIT*/null";

export function renderHtml(spec: FormSpec): string {
  const vals = defaults(spec);
  const body = spec.fields.map((f) => fieldHtml(f, vals[f.id])).join("\n    ");
  return `<!doctype html>
<!-- Generated by the XScript UI designer; edit the matching .ui.json (XScript: Open UI Designer), not this file. -->
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:-apple-system,Roboto,"Noto Sans CJK SC",sans-serif;margin:0;padding:14px;font-size:15px;color:#222;background:#fff}
  h3{margin:0 0 12px}.row{margin:0 0 12px;display:flex;flex-direction:column;gap:4px}.row.check{flex-direction:row;align-items:center;gap:8px}
  input:not([type=checkbox]):not([type=radio]),select,textarea{font:inherit;padding:7px;border:1px solid #bbb;border-radius:6px}
  textarea{min-height:64px}.radios{display:flex;flex-wrap:wrap;gap:12px}.note{color:#666;margin:0 0 12px}
  .bar{display:flex;gap:10px;justify-content:flex-end;margin-top:6px}button{font:inherit;padding:8px 18px;border-radius:6px;border:0;background:#2f6fed;color:#fff}
  button.sec{background:#ddd;color:#222}
</style></head>
<body>
  <h3>${esc(spec.title)}</h3>
  <form id="xs_form">
    ${body}
    <div class="bar">${spec.cancel ? `<button type="button" class="sec" id="xs_cancel">${esc(spec.cancel)}</button>` : ""}<button type="submit">${esc(spec.submit)}</button></div>
  </form>
<script>
(function () {
  var bridge = function () { return window.xscript || window.airscript; };
  var form = document.getElementById("xs_form");
  function collect() {
    var out = {};
    form.querySelectorAll("[data-key]").forEach(function (el) {
      var k = el.getAttribute("data-key"), t = el.getAttribute("data-type");
      if (t === "bool") out[k] = el.checked;
      else if (t === "num") out[k] = el.value === "" ? null : Number(el.value);
      else if (t === "radio") { var c = el.querySelector("input:checked"); out[k] = c ? c.value : null; }
      else out[k] = el.value;
    });
    return out;
  }
  window.xsInit = function (values) {   // called by the generated Python with the script's current values
    Object.keys(values || {}).forEach(function (k) {
      var el = form.querySelector('[data-key="' + k + '"]'), v = values[k];
      if (!el) return;
      if (el.getAttribute("data-type") === "bool") el.checked = !!v;
      else if (el.getAttribute("data-type") === "radio") el.querySelectorAll("input").forEach(function (r) { r.checked = r.value === String(v); });
      else el.value = v == null ? "" : v;
    });
  };
  var init = /*XS_INIT*/null;   // the generated Python replaces this with the script's current values
  if (init) window.xsInit(init);
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var b = bridge(); if (b) b.call("submit", JSON.stringify(collect()));
  });
  var cancel = document.getElementById("xs_cancel");
  if (cancel) cancel.addEventListener("click", function () { var b = bridge(); if (b) { b.call("cancel", ""); if (b.close) b.close(); } });
})();
</script>
</body></html>
`;
}

const py = (v: unknown) => (typeof v === "boolean" ? (v ? "True" : "False") : typeof v === "number" ? String(v) : JSON.stringify(String(v ?? "")));

/** res/ui/<name>.py: `from res.ui.<name> import show` is awkward, so it lives next to the entry as ui_<name>.py. */
export function renderPython(spec: FormSpec, htmlRel: string): string {
  const vals = defaults(spec);
  const keys = Object.keys(vals);
  const defLines = keys.map((k) => `    ${JSON.stringify(k)}: ${py(vals[k])},`).join("\n");
  const types = keys.map((k) => {
    const f = spec.fields.find((x) => x.id === k)!;
    return `    ${JSON.stringify(k)}: ${f.kind === "checkbox" ? "bool" : f.kind === "number" ? "float" : "str"},`;
  }).join("\n");
  return `# Generated by the XScript UI designer from ${htmlRel.replace(/\.html$/, ".ui.json")}. Edit the form there; this file is rewritten.
#
#     from ${modName(htmlRel)} import show
#     values = show()            # blocks until the user submits; None when cancelled / closed
#     if values: print(values[${JSON.stringify(keys[0] ?? "key")}])
import json

from xscript.android import ui
from xscript.android.system import R

DEFAULTS = {
${defLines}
}

TYPES = {
${types}
}


def _coerce(values):
    out = dict(DEFAULTS)
    for k, v in (values or {}).items():
        if k not in TYPES or v is None:
            continue
        try:
            if TYPES[k] is float:
                v = float(v)
                out[k] = int(v) if v.is_integer() and isinstance(DEFAULTS[k], int) else v
            else:
                out[k] = TYPES[k](v)
        except (TypeError, ValueError):
            pass
    return out


def show(values=None, width=${JSON.stringify(spec.width)}, height=${JSON.stringify(spec.height)}):
    """Show the form pre-filled with DEFAULTS updated by \`values\`; return the submitted dict, or None when cancelled."""
    with open(R.res(${JSON.stringify(htmlRel.replace(/^res\//, ""))}), encoding="utf-8") as f:
        html = f.read()
    init = json.dumps(_coerce(values), ensure_ascii=False).replace("</", "<\\\\/")
    win = ui.Window(html.replace("/*XS_INIT*/null", init, 1), width=width, height=height)
    result = {}

    @win.on("submit")
    def _submit(value):
        result["values"] = _coerce(json.loads(value))
        win.close()

    @win.on("cancel")
    def _cancel(value):
        win.close()

    win.show(wait=True)
    return result.get("values")
`;
}

function modName(htmlRel: string): string {
  return "ui_" + htmlRel.replace(/^.*\//, "").replace(/\.html$/, "");
}

/** Files written for a spec saved at res/ui/<name>.ui.json (paths relative to the project root). */
export function outputs(spec: FormSpec, name: string): Record<string, string> {
  const html = "res/ui/" + name + ".html";
  return { [html]: renderHtml(spec), [modName(html) + ".py"]: renderPython(spec, html) };
}

/** "res/ui/main.ui.json" -> "main"; undefined when the file is not a form spec. */
export function formName(file: string): string | undefined {
  const m = /([^/\\]+)\.ui\.json$/.exec(file);
  return m && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(m[1]) ? m[1] : undefined;
}

/** Pretty JSON as stored on disk (stable so undo/redo and git diffs stay small). */
export function serializeSpec(spec: FormSpec): string {
  return JSON.stringify(spec, null, 2) + "\n";
}
