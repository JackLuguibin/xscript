// Webview side of the XScript UI designer (src/uiDesigner.ts). Holds a copy of the form spec, renders the
// palette / field list / properties / preview, and posts every change back as {type:"edit", spec}.
(function () {
  const vscode = acquireVsCodeApi();
  const KINDS = document.body.getAttribute("data-kinds").split(",");
  const LABELS = { text: "Text", password: "Password", textarea: "Multi-line text", number: "Number", checkbox: "Checkbox", select: "Dropdown", radio: "Radio group", label: "Static text" };
  let spec = null, errors = [], preview = "", sel = -1;
  const app = document.getElementById("app");
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "checked" || k === "value") el[k] = v;
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const commit = () => { vscode.postMessage({ type: "edit", spec }); };

  function newField(kind) {
    const used = new Set(spec.fields.map((f) => f.id));
    let n = spec.fields.length + 1;
    while (used.has(kind + n)) n++;
    const id = kind + n;
    if (kind === "number") return { kind, id, label: "Number", default: 0 };
    if (kind === "checkbox") return { kind, id, label: "Enabled", default: false };
    if (kind === "select" || kind === "radio") return { kind, id, label: "Choice", options: ["A", "B"], default: "A" };
    if (kind === "label") return { kind, id, label: "Some explanation text" };
    return { kind, id, label: kind === "password" ? "Password" : "Text", default: "" };
  }
  function insert(kind, at) {
    const f = newField(kind);
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
    return h("div", { class: "col pal" }, h("h4", {}, "Controls"),
      KINDS.map((k) => h("button", { draggable: "true", title: "Click or drag into the form", onclick: () => insert(k, sel >= 0 ? sel + 1 : -1),
        ondragstart: (e) => { e.dataTransfer.setData("text/x-xs-kind", k); } }, "+ " + (LABELS[k] || k))),
      h("p", { class: "hint" }, "Save (Ctrl+S) writes res/ui/<name>.html and ui_<name>.py."));
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
      h("button", { title: "Move up", onclick: (e) => { e.stopPropagation(); if (i > 0) move(i, i - 1); } }, "↑"),
      h("button", { title: "Move down", onclick: (e) => { e.stopPropagation(); if (i < spec.fields.length - 1) move(i, i + 2); } }, "↓"),
      h("button", { title: "Delete", onclick: (e) => { e.stopPropagation(); spec.fields.splice(i, 1); sel = Math.min(sel, spec.fields.length - 1); commit(); render(); } }, "✕"))));
    if (!spec.fields.length) box.append(h("p", { class: "hint" }, "Drag controls here."));
    return h("div", { class: "col" }, h("h4", {}, "Form"), box, errors.length ? h("div", { class: "errors" }, errors.join("\n")) : null);
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
      col.append(h("h4", {}, "Field: " + (LABELS[f.kind] || f.kind)));
      col.append(input(f.kind === "label" ? "Text" : "Label", f.label, (v) => (f.label = v)));
      if (f.kind !== "label") col.append(input("Key in the returned dict (id)", f.id, (v) => (f.id = v.trim())));
      if (f.kind === "select" || f.kind === "radio") col.append(input("Options (one per line)", (f.options || []).join("\n"), (v) => (f.options = v.split("\n").map((s) => s.trim()).filter(Boolean)), "textarea"));
      if (f.kind === "checkbox") col.append(input("Checked by default", f.default, (v) => (f.default = v), "checkbox"));
      else if (f.kind === "number") {
        col.append(input("Default", f.default, (v) => (f.default = num(v) ?? 0), "number"));
        for (const k of ["min", "max", "step"]) col.append(input(k, f[k], (v) => { const n = num(v); if (n === undefined || isNaN(n)) delete f[k]; else f[k] = n; }, "number"));
      } else if (f.kind === "select" || f.kind === "radio") {
        const s = h("select", {}, (f.options || []).map((o) => h("option", { value: o }, o)));
        s.value = f.default || (f.options || [])[0] || "";
        s.addEventListener("change", () => { f.default = s.value; commit(); render(); });
        col.append(h("label", {}, h("span", {}, "Default"), s));
      } else if (f.kind !== "label") {
        col.append(input("Default", f.default, (v) => (f.default = v)));
        col.append(input("Placeholder", f.placeholder, (v) => (f.placeholder = v || undefined)));
      }
      if (f.kind !== "label" && f.kind !== "checkbox") col.append(input("Required", f.required, (v) => (f.required = v || undefined), "checkbox"));
    } else col.append(h("p", { class: "hint" }, "Select a field to edit it."));
    col.append(h("h4", { style: "margin-top:14px" }, "Window"));
    col.append(input("Title", spec.title, (v) => (spec.title = v)));
    col.append(input("Submit button", spec.submit, (v) => (spec.submit = v)));
    col.append(input("Cancel button (empty = none)", spec.cancel, (v) => (spec.cancel = v || undefined)));
    col.append(input("Width (e.g. 85vw, 600)", spec.width, (v) => (spec.width = v)));
    col.append(input("Height (e.g. 60vh)", spec.height, (v) => (spec.height = v)));
    return col;
  }

  function render() {
    const scroll = [...app.querySelectorAll(".col")].map((c) => c.scrollTop);
    app.replaceChildren();
    if (!spec) return;
    const frame = h("iframe", { sandbox: "", title: "Preview" });
    frame.srcdoc = preview;
    app.append(palette(), list(), props(), h("div", { class: "col" }, h("h4", {}, "Preview"), frame,
      h("p", { class: "hint" }, "Preview only; on the phone: from ui_" + "<name> import show; values = show()")));
    app.querySelectorAll(".col").forEach((c, i) => (c.scrollTop = scroll[i] || 0));
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "spec") { spec = m.spec; errors = m.errors || []; preview = m.preview || ""; if (sel >= spec.fields.length) sel = spec.fields.length - 1; render(); }
    if (m.type === "error") { spec = null; app.replaceChildren(h("div", { class: "errors" }, m.error)); }
  });
  vscode.postMessage({ type: "ready" });
})();
