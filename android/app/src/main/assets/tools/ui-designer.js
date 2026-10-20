"use strict";
// UI designer view, shared by the VS Code extension (webview: ide/vscode-extension/media/uiDesigner.js) and the Web
// IDE (editor.js, for res/ui/<name>.ui.json). Holds a copy of the form spec and renders the palette, the field list
// (click or drag to add, drag or ↑↓ to reorder), the properties and a sandboxed preview. The host owns the file:
// every change is posted as {type: "edit", spec}; the host answers with {type: "spec", spec, errors, preview} (or
// {type: "error", error}) through receive(). Needs tools/ui-form.js (window.XSUiForm) for new fields.
(function (root) {
  const TEXT = {
    en: {
      kinds: { text: "Text", password: "Password", textarea: "Multi-line text", number: "Number", checkbox: "Checkbox", select: "Dropdown", radio: "Radio group", label: "Static text" },
      controls: "Controls", addHint: "Click or drag into the form", saveHint: "Save (Ctrl+S) writes res/ui/<name>.html and ui_<name>.py.",
      form: "Form", dropHint: "Drag controls here.", up: "Move up", down: "Move down", del: "Delete",
      field: "Field: ", text: "Text", label: "Label", id: "Key in the returned dict (id)", options: "Options (one per line)",
      checked: "Checked by default", def: "Default", placeholder: "Placeholder", required: "Required", pick: "Select a field to edit it.",
      window: "Window", title: "Title", submit: "Submit button", cancel: "Cancel button (empty = none)",
      width: "Width (e.g. 85vw, 600)", height: "Height (e.g. 60vh)", preview: "Preview",
      previewHint: "Preview only; on the phone: from ui_<name> import show; values = show()",
    },
    zh: {
      kinds: { text: "单行文本", password: "密码", textarea: "多行文本", number: "数字", checkbox: "复选框", select: "下拉选择", radio: "单选组", label: "说明文字" },
      controls: "控件", addHint: "点击或拖到表单里", saveHint: "保存（Ctrl/Cmd+S）时生成 res/ui/<名称>.html 和 ui_<名称>.py。",
      form: "表单", dropHint: "把控件拖到这里。", up: "上移", down: "下移", del: "删除",
      field: "字段：", text: "文字", label: "标题", id: "返回字典里的键（id）", options: "选项（每行一个）",
      checked: "默认勾选", def: "默认值", placeholder: "占位提示", required: "必填", pick: "选择一个字段来编辑。",
      window: "窗口", title: "标题", submit: "提交按钮", cancel: "取消按钮（留空则没有）",
      width: "宽度（如 85vw、600）", height: "高度（如 60vh）", preview: "预览",
      previewHint: "仅预览；手机上：from ui_<名称> import show; values = show()",
    },
  };

  function mount(app, opts) {
    const F = opts.form || root.XSUiForm;
    const T = TEXT[opts.lang] || TEXT.en;
    const KINDS = opts.kinds || F.FIELD_KINDS;
    const post = opts.post;
    let spec = null, errors = [], preview = "", sel = -1;
    const doc = app.ownerDocument;
    const h = (tag, attrs, ...kids) => {
      const el = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) {
        if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (k === "checked" || k === "value") el[k] = v;
        else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
      }
      for (const c of kids.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : doc.createTextNode(String(c)));
      return el;
    };
    const commit = () => { post({ type: "edit", spec }); };

    function insert(kind, at) {
      const f = F.newField(kind, spec);
      at = at < 0 || at > spec.fields.length ? spec.fields.length : at;
      spec.fields.splice(at, 0, f);
      sel = at;
      commit(); render();
    }
    function move(from, to) {
      if (from === to || from + 1 === to) return;
      const [f] = spec.fields.splice(from, 1);
      spec.fields.splice(to > from ? to - 1 : to, 0, f);
      sel = to > from ? to - 1 : to;
      commit(); render();
    }

    function palette() {
      return h("div", { class: "col pal" }, h("h4", {}, T.controls),
        KINDS.map((k) => h("button", { type: "button", draggable: "true", title: T.addHint, "data-kind": k, onclick: () => insert(k, sel >= 0 ? sel + 1 : -1),
          ondragstart: (e) => { e.dataTransfer.setData("text/x-xs-kind", k); } }, "+ " + (T.kinds[k] || k))),
        h("p", { class: "hint" }, T.saveHint));
    }

    function list() {
      const box = h("div", { class: "list" });
      const dropIndex = (e) => {
        const items = [...box.querySelectorAll(".item")];
        for (let i = 0; i < items.length; i++) { const r = items[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) return i; }
        return items.length;
      };
      const mark = (i) => box.querySelectorAll(".item").forEach((el, j) => el.classList.toggle("drop-before", j === i));
      box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("over"); mark(dropIndex(e)); });
      box.addEventListener("dragleave", () => { box.classList.remove("over"); mark(-1); });
      box.addEventListener("drop", (e) => {
        e.preventDefault(); box.classList.remove("over");
        const at = dropIndex(e), kind = e.dataTransfer.getData("text/x-xs-kind"), from = e.dataTransfer.getData("text/x-xs-index");
        if (kind) insert(kind, at); else if (from !== "") move(Number(from), at);
      });
      spec.fields.forEach((f, i) => box.append(h("div", { class: "item" + (i === sel ? " sel" : ""), draggable: "true",
        onclick: () => { sel = i; render(); },
        ondragstart: (e) => e.dataTransfer.setData("text/x-xs-index", String(i)) },
        h("span", { class: "k" }, f.kind), h("span", { class: "t" }, f.label + (f.kind === "label" ? "" : "  · " + f.id)),
        h("button", { type: "button", title: T.up, "aria-label": T.up, onclick: (e) => { e.stopPropagation(); if (i > 0) move(i, i - 1); } }, "↑"),
        h("button", { type: "button", title: T.down, "aria-label": T.down, onclick: (e) => { e.stopPropagation(); if (i < spec.fields.length - 1) move(i, i + 2); } }, "↓"),
        h("button", { type: "button", title: T.del, "aria-label": T.del, onclick: (e) => { e.stopPropagation(); spec.fields.splice(i, 1); sel = Math.min(sel, spec.fields.length - 1); commit(); render(); } }, "✕"))));
      if (!spec.fields.length) box.append(h("p", { class: "hint" }, T.dropHint));
      return h("div", { class: "col" }, h("h4", {}, T.form), box, errors.length ? h("div", { class: "errors", role: "alert" }, errors.join("\n")) : null);
    }

    function input(label, value, onchange, type) {
      const el = type === "textarea" ? h("textarea", { rows: 4 }) : h("input", { type: type || "text" });
      if (type === "checkbox") el.checked = !!value; else el.value = value === undefined || value === null ? "" : value;
      el.addEventListener("change", () => { onchange(type === "checkbox" ? el.checked : el.value); commit(); render(); });
      return h("label", {}, h("span", {}, label), el);
    }
    const num = (v) => (v === "" ? undefined : Number(v));

    function props() {
      const col = h("div", { class: "col props" });
      const f = spec.fields[sel];
      if (f) {
        col.append(h("h4", {}, T.field + (T.kinds[f.kind] || f.kind)));
        col.append(input(f.kind === "label" ? T.text : T.label, f.label, (v) => (f.label = v)));
        if (f.kind !== "label") col.append(input(T.id, f.id, (v) => (f.id = v.trim())));
        if (f.kind === "select" || f.kind === "radio") col.append(input(T.options, (f.options || []).join("\n"), (v) => (f.options = v.split("\n").map((s) => s.trim()).filter(Boolean)), "textarea"));
        if (f.kind === "checkbox") col.append(input(T.checked, f.default, (v) => (f.default = v), "checkbox"));
        else if (f.kind === "number") {
          col.append(input(T.def, f.default, (v) => (f.default = num(v) ?? 0), "number"));
          for (const k of ["min", "max", "step"]) col.append(input(k, f[k], (v) => { const n = num(v); if (n === undefined || isNaN(n)) delete f[k]; else f[k] = n; }, "number"));
        } else if (f.kind === "select" || f.kind === "radio") {
          const s = h("select", {}, (f.options || []).map((o) => h("option", { value: o }, o)));
          s.value = f.default || (f.options || [])[0] || "";
          s.addEventListener("change", () => { f.default = s.value; commit(); render(); });
          col.append(h("label", {}, h("span", {}, T.def), s));
        } else if (f.kind !== "label") {
          col.append(input(T.def, f.default, (v) => (f.default = v)));
          col.append(input(T.placeholder, f.placeholder, (v) => (f.placeholder = v || undefined)));
        }
        if (f.kind !== "label" && f.kind !== "checkbox") col.append(input(T.required, f.required, (v) => (f.required = v || undefined), "checkbox"));
      } else col.append(h("p", { class: "hint" }, T.pick));
      col.append(h("h4", { style: "margin-top:14px" }, T.window));
      col.append(input(T.title, spec.title, (v) => (spec.title = v)));
      col.append(input(T.submit, spec.submit, (v) => (spec.submit = v)));
      col.append(input(T.cancel, spec.cancel, (v) => (spec.cancel = v || undefined)));
      col.append(input(T.width, spec.width, (v) => (spec.width = v)));
      col.append(input(T.height, spec.height, (v) => (spec.height = v)));
      return col;
    }

    function render() {
      const scroll = [...app.querySelectorAll(".col")].map((c) => c.scrollTop);
      app.replaceChildren();
      if (!spec) return;
      const frame = h("iframe", { sandbox: "", title: T.preview });
      frame.srcdoc = preview;
      app.append(palette(), list(), props(), h("div", { class: "col" }, h("h4", {}, T.preview), frame, h("p", { class: "hint" }, T.previewHint)));
      app.querySelectorAll(".col").forEach((c, i) => (c.scrollTop = scroll[i] || 0));
    }

    return {
      receive(m) {
        if (!m) return;
        if (m.type === "spec") { spec = m.spec; errors = m.errors || []; preview = m.preview || ""; if (sel >= spec.fields.length) sel = spec.fields.length - 1; render(); }
        if (m.type === "error") { spec = null; app.replaceChildren(h("div", { class: "errors", role: "alert" }, m.error)); }
      },
      get selected() { return sel; },
    };
  }

  /** The {type: "spec"} / {type: "error"} message for a spec file's text (what both hosts send to receive()). */
  function messageFor(text, F, invalidHint) {
    F = F || root.XSUiForm;
    let spec;
    try { spec = String(text || "").trim() ? F.parseSpec(text) : F.newSpec(); }
    catch (e) { return { type: "error", error: "Invalid JSON: " + e.message + (invalidHint || "") }; }
    return { type: "spec", spec, errors: F.validateSpec(spec), preview: F.renderHtml(spec) };
  }

  const XSUiDesigner = { mount, messageFor, TEXT };
  if (typeof module !== "undefined" && module.exports) module.exports = XSUiDesigner;
  else root.XSUiDesigner = XSUiDesigner;
})(typeof window !== "undefined" ? window : globalThis);
