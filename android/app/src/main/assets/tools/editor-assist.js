"use strict";
// Web IDE assistance for the <textarea> editor: the completion popup (EditorComplete), hover docs and signature
// help (EditorComplete.symbolAt / callAt over XSDocs) and syntax diagnostics (EditorCheck: wavy underlines, gutter
// marks, a problems button). Browser-only glue; the logic lives in the
// two pure modules, which are unit-tested in Node.
(function (root) {
  const ESC = {"&": "&amp;", "<": "&lt;", ">": "&gt;"};
  const esc = s => s.replace(/[&<>]/g, c => ESC[c]);
  const KIND = {f: "ƒ", c: "C", m: "M", v: "x", k: "k", w: "w"};
  const LINE = 21, PAD_TOP = 16, PAD_LEFT = 12, CHECK_DELAY = 350, HOVER_DELAY = 400;
  const firstParagraph = doc => (doc || "").split(/\n\s*\n/)[0].trim();

  class EditorAssist {
    /**
     * @param {object} o  box (textarea), host (positioned wrapper), popup (ul), layer (pre under the textarea),
     *                    problems (button), toggle (checkbox), onMarks (called when gutter marks change)
     */
    constructor(o) {
      Object.assign(this, o);
      this.complete = new EditorComplete(root.XSApi || {modules: {}}, root.XSDocs || {});
      this.path = null; this.diags = []; this.items = []; this.index = 0; this.range = null; this.timer = 0; this.problemCursor = -1;
      this.enabled = (() => { try { return localStorage.getItem("xs-complete") !== "off"; } catch (e) { return true; } })();
      if (this.toggle) {
        this.toggle.checked = this.enabled;
        this.toggle.addEventListener("change", () => { this.enabled = this.toggle.checked; try { localStorage.setItem("xs-complete", this.enabled ? "on" : "off"); } catch (e) { /* private mode */ } if (!this.enabled) this.close(); });
      }
      this.popup.addEventListener("mousedown", e => {      // keep the textarea focused
        e.preventDefault();
        const li = e.target.closest("li"); if (li) this.accept(Number(li.dataset.i));
      });
      this.box.addEventListener("blur", () => this.close());
      this.box.addEventListener("mousedown", () => this.close());
      if (this.problems) this.problems.addEventListener("click", () => this.nextProblem());
      this.initTips();
      this.render();
    }

    // The open file changed (or none): null disables assistance for non-Python files.
    setFile(path) {
      this.path = path && /\.pyw?$/.test(path) ? path : null;
      this.close(); this.hideSig(); this.hideHover(); clearTimeout(this.timer); this.problemCursor = -1;
      this.runCheck();
    }

    get active() { return !!this.path && !this.box.disabled; }

    // ---- diagnostics ----
    scheduleCheck() { clearTimeout(this.timer); this.timer = setTimeout(() => this.runCheck(), CHECK_DELAY); }
    runCheck() {
      clearTimeout(this.timer);
      this.diags = this.active && this.box.value.length <= 400000 ? EditorCheck.check(this.box.value) : []; this.faded = [];
      this.render(); if (this.onMarks) this.onMarks();
      // Basic project checks (undefined names, wrong call arguments) only when the syntax is clean; `lint` is set
      // by editor.js and resolves to warnings for the text it was given.
      const token = this.lintToken = (this.lintToken || 0) + 1;
      if (!this.lint || !this.active || this.diags.length || this.box.value.length > 400000) return;
      const path = this.path, text = this.box.value;
      Promise.resolve().then(() => this.lint(path, text)).then(ws => {
        if (token !== this.lintToken || !this.active || this.path !== path || this.box.value !== text || !ws || !ws.length) return;
        this.diags = ws.filter(w => w.severity !== "unused"); this.faded = ws.filter(w => w.severity === "unused"); this.problemCursor = -1; this.render(); if (this.onMarks) this.onMarks();
      }, () => {});
    }
    /** True when every diagnostic on `line` is a warning (basic checks), not a syntax error. */
    warnOnly(line) { const ds = this.diags.filter(d => d.line === line); return ds.length > 0 && ds.every(d => d.severity === "warning"); }
    marks() { const m = new Map(); for (const d of this.diags) if (!m.has(d.line)) m.set(d.line, d.message); return m; }
    render() {
      const text = this.active ? this.box.value : "";
      const all = this.diags.concat(this.faded || []);
      if (!all.length) this.layer.textContent = "";
      else {
        const lines = text.split("\n"), byLine = new Map();
        for (const d of all) { if (!byLine.has(d.line)) byLine.set(d.line, []); byLine.get(d.line).push(d); }
        this.layer.innerHTML = lines.map((raw, i) => {
          const ds = byLine.get(i + 1); if (!ds) return esc(raw);
          let out = "", at = 0;
          for (const d of ds.sort((a, b) => a.col - b.col)) {
            let from = Math.min(Math.max(d.col, at), raw.length), to = Math.min(Math.max(from + d.length, from + 1), raw.length);
            if (to <= from) { if (at >= raw.length) continue; from = raw.length - 1; to = raw.length; }   // error at end of line: mark its last character
            out += esc(raw.slice(at, from)) + '<span class="' + (d.severity === "unused" ? "fade" : d.severity === "warning" ? "sq warn" : "sq") + '">' + esc(raw.slice(from, to)) + "</span>"; at = to;
          }
          return out + esc(raw.slice(at));
        }).join("\n") + "\n";
      }
      this.syncScroll(); this.renderProblems();
    }
    renderProblems() {
      const b = this.problems; if (!b) return;
      const n = this.diags.length, line = this.box.value.slice(0, this.box.selectionStart).split("\n").length;
      const here = this.diags.find(d => d.line === line);
      b.dataset.count = String(n); b.hidden = !this.path;
      const warn = n > 0 && this.diags.every(d => d.severity === "warning");
      b.classList.toggle("has-problems", n > 0 && !warn); b.classList.toggle("has-warnings", warn);
      const faded = n === 0 && (this.faded || []).find(d => d.line === line);
      b.textContent = faded ? "· 第 " + faded.line + " 行：" + faded.message : n === 0 ? "✓ 无语法问题" : here ? "⚠ 第 " + here.line + " 行：" + here.message : "⚠ " + n + (warn ? " 个问题" : " 个语法问题") + "（点击跳转）";
    }
    nextProblem() {
      if (!this.diags.length) return;
      this.problemCursor = (this.problemCursor + 1) % this.diags.length;
      const d = this.diags[this.problemCursor], lines = this.box.value.split("\n");
      const pos = lines.slice(0, d.line - 1).reduce((n, r) => n + r.length + 1, 0) + Math.min(d.col, lines[d.line - 1].length);
      this.box.focus(); this.box.setSelectionRange(pos, pos);
      this.box.scrollTop = Math.max(0, (d.line - 4) * LINE);
      this.box.dispatchEvent(new Event("scroll")); this.box.dispatchEvent(new Event("keyup"));
      if (this.problems) this.problems.textContent = "⚠ 第 " + d.line + " 行：" + d.message;
    }
    syncScroll() { this.layer.scrollTop = this.box.scrollTop; this.layer.scrollLeft = this.box.scrollLeft; }

    // ---- completion ----
    onInput(e) {
      if (!this.active) return;
      this.diags = []; this.faded = []; this.lintToken = (this.lintToken || 0) + 1; this.layer.textContent = ""; if (this.onMarks) this.onMarks();    // positions are stale while typing
      this.scheduleCheck();
      const type = e && e.inputType;
      if (!this.enabled || (type !== "insertText" && type !== "insertCompositionText")) { this.close(); this.updateSig(false); return; }
      this.open({});
      this.updateSig(false);
    }
    open(opts) {
      if (!this.active || this.box.selectionStart !== this.box.selectionEnd) return this.close();
      const r = this.complete.suggest(this.box.value, this.box.selectionStart, opts);
      if (!r) return this.close();
      this.items = r.items; this.range = r; this.index = 0; this.draw();
    }
    draw() {
      const p = this.popup;
      p.replaceChildren();
      this.items.forEach((item, i) => {
        const li = document.createElement("li");
        li.role = "option"; li.id = "complete-" + i; li.dataset.i = String(i); li.dataset.label = item.label;
        li.setAttribute("aria-selected", String(i === this.index));
        const k = document.createElement("span"); k.className = "ck ck-" + item.kind; k.textContent = KIND[item.kind] || "·";
        const l = document.createElement("span"); l.className = "cl"; l.textContent = item.label;
        const d = document.createElement("span"); d.className = "cd"; d.textContent = item.detail || "";
        li.append(k, l, d); p.append(li);
      });
      const doc = document.createElement("div"); doc.className = "cdoc"; doc.id = "complete-doc"; doc.setAttribute("aria-hidden", "true");
      p.append(doc);
      p.hidden = false;
      this.box.setAttribute("aria-expanded", "true"); this.box.setAttribute("aria-controls", "complete");
      // A fresh list starts at the top, so no scrollIntoView; and the popup is placed in the next frame, together
      // with the syntax repaint: measuring right after an edit forced an extra layout of the whole textarea per
      // keystroke (~25 ms at 2 000 lines).
      this.select(this.index, false);
      if (!this.placeQueued) { this.placeQueued = true; requestAnimationFrame(() => { this.placeQueued = false; if (!this.popup.hidden && this.range) { this.popup.scrollTop = 0; this.place(); } }); }
    }
    select(i, scroll = true) {
      this.index = (i + this.items.length) % this.items.length;
      const lis = this.popup.querySelectorAll("li");
      lis.forEach((li, n) => li.setAttribute("aria-selected", String(n === this.index)));
      const li = lis[this.index];
      if (li) { if (scroll) li.scrollIntoView({block: "nearest"}); this.box.setAttribute("aria-activedescendant", li.id); }
      const item = this.items[this.index], doc = this.popup.querySelector(".cdoc");
      if (doc) { const text = ((item.detail ? item.label + item.detail + "\n" : "") + (item.doc || "")).trim(); doc.textContent = text; doc.hidden = !text; }
    }
    /** The textarea scrolled (the browser follows the caret on a narrow screen, or the user scrolled): keep the popup
     *  next to the caret while the caret is still visible, close it once the caret has scrolled out of view. */
    onScroll() {
      this.hideHover(); if (!this.sigTip.hidden) this.updateSig(true);
      if (this.popup.hidden || !this.range) return;
      const c = this.caretBox();
      if (c.x < 0 || c.x > c.hostW || c.y < 0 || c.y > c.hostH) this.close(); else this.place();
    }
    caretBox() {
      const box = this.box, value = box.value, pos = this.range.from;
      const ls = value.lastIndexOf("\n", pos - 1) + 1, row = value.slice(0, pos).split("\n").length - 1;
      const width = this.textWidth(value.slice(ls, pos));
      const hostBox = this.host.getBoundingClientRect();
      return {x: PAD_LEFT + width - box.scrollLeft, y: PAD_TOP + (row + 1) * LINE - box.scrollTop, hostW: hostBox.width, hostH: hostBox.height};
    }
    place() {
      const box = this.box, value = box.value, pos = this.range.from;
      const ls = value.lastIndexOf("\n", pos - 1) + 1, row = value.slice(0, pos).split("\n").length - 1;
      const width = this.textWidth(value.slice(ls, pos));
      const hostBox = this.host.getBoundingClientRect(), pw = this.popup.offsetWidth, ph = this.popup.offsetHeight;
      let left = PAD_LEFT + width - box.scrollLeft, top = PAD_TOP + (row + 1) * LINE - box.scrollTop + 2;
      if (left + pw > hostBox.width - 4) left = Math.max(4, hostBox.width - pw - 4);
      if (top + ph > hostBox.height - 4 && top - LINE - ph >= 0) top = top - LINE - ph;       // flip above the caret
      this.popup.style.left = Math.max(0, left) + "px"; this.popup.style.top = Math.max(0, top) + "px";
    }
    accept(i) {
      const item = this.items[i === undefined ? this.index : i];
      if (!item || !this.range) return this.close();
      const {from, to} = this.range;
      this.close();
      this.box.setRangeText(item.label, from, to, "end");
      this.box.dispatchEvent(new Event("input"));          // plain Event: no inputType, so it does not reopen the popup
    }
    close() {
      if (!this.popup.hidden) { this.popup.hidden = true; this.popup.replaceChildren(); }
      this.items = []; this.range = null;
      this.box.setAttribute("aria-expanded", "false"); this.box.removeAttribute("aria-activedescendant");
    }
    get isOpen() { return !this.popup.hidden && this.items.length > 0; }

    // ---- hover docs and signature help ----
    initTips() {
      const make = (cls, id) => {
        const d = document.createElement("div"); d.className = "ide-tip " + cls; d.id = id; d.hidden = true; d.setAttribute("role", "tooltip");
        this.host.append(d); return d;
      };
      this.sigTip = make("ide-sig", "sig-help"); this.hoverTip = make("ide-hover", "hover-doc");
      this.sigForced = false; this.hoverKey = ""; this.hoverTimer = 0; this.hoverRaf = 0; this.mouse = null;
      this.box.addEventListener("mousemove", e => {
        this.mouse = {x: e.clientX, y: e.clientY};
        if (!this.hoverRaf) this.hoverRaf = requestAnimationFrame(() => { this.hoverRaf = 0; this.onHover(); });
      });
      this.box.addEventListener("mouseleave", () => { this.mouse = null; this.hideHover(); });
      this.box.addEventListener("blur", () => { this.hideSig(); this.hideHover(); });
      for (const name of ["click", "keyup"]) this.box.addEventListener(name, e => {
        if (e.type === "keyup" && !/^(Arrow|Home|End|Page)/.test(e.key)) return;     // typing is handled by onInput
        if (!this.sigTip.hidden || this.sigForced) this.updateSig(this.sigForced); else if (this.enabled) this.updateSig(false);
      });
    }
    /** Width in px of `text` in the editor font (tabs every 4 columns, like the textarea). Measured on a canvas:
     *  a probe element in the page forced a layout of the whole textarea on each call (every keystroke). */
    textWidth(text) {
      const cs = getComputedStyle(this.box);
      const ctx = this.measure || (this.measure = document.createElement("canvas").getContext("2d"));
      ctx.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
      let line = "";
      for (const ch of text) line += ch === "\t" ? " ".repeat(4 - line.length % 4) : ch;
      return ctx.measureText(line).width;
    }
    /** Host-relative {x, top} of text offset `pos` (top = top edge of its line), scrolled like the textarea. */
    coords(pos) {
      const v = this.box.value, ls = v.lastIndexOf("\n", pos - 1) + 1, row = v.slice(0, pos).split("\n").length - 1;
      return {x: PAD_LEFT + this.textWidth(v.slice(ls, pos)) - this.box.scrollLeft, top: PAD_TOP + row * LINE - this.box.scrollTop};
    }
    /** Text offset under a viewport point, or -1 when the point is not on a character. */
    posAt(clientX, clientY) {
      const hb = this.host.getBoundingClientRect(), v = this.box.value;
      const x = clientX - hb.left - PAD_LEFT + this.box.scrollLeft, y = clientY - hb.top - PAD_TOP + this.box.scrollTop;
      const row = Math.floor(y / LINE);
      if (x < 0 || y < 0) return -1;
      let ls = 0;
      for (let r = 0; r < row; r++) { const nl = v.indexOf("\n", ls); if (nl < 0) return -1; ls = nl + 1; }
      const end = v.indexOf("\n", ls) < 0 ? v.length : v.indexOf("\n", ls), line = v.slice(ls, end);
      if (!line || x >= this.textWidth(line)) return -1;
      let lo = 0, hi = line.length - 1;                // first index whose right edge is past x
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.textWidth(line.slice(0, mid + 1)) > x) hi = mid; else lo = mid + 1; }
      return ls + lo;
    }
    onHover() {
      if (!this.active || !this.mouse || this.box.value.length > 400000) return this.hideHover();
      const pos = this.posAt(this.mouse.x, this.mouse.y);
      const sym = pos < 0 ? null : this.complete.symbolAt(this.box.value, pos);
      if (!sym && pos >= 0 && this.describe && this.path) return this.hoverProject(pos);
      const id = sym ? sym.key + "@" + sym.from : "";
      if (id === this.hoverKey) return;
      this.hideHover(); this.hoverKey = id;
      if (!sym) return;
      this.hoverTimer = setTimeout(() => this.showHover(sym), HOVER_DELAY);
    }
    // A project name under the mouse: `describe(pos)` (the page's symbol table) answers its signature or inferred type.
    hoverProject(pos) {
      const v = this.box.value, word = /[\p{L}\p{N}_]/u;
      let from = pos; while (from > 0 && word.test(v[from - 1])) from--;
      if (!word.test(v[pos] || "") || /[0-9]/.test(v[from])) { if (this.hoverKey) this.hideHover(); return; }
      const id = "p@" + from + ":" + v.length;
      if (id === this.hoverKey) return;
      this.hideHover(); this.hoverKey = id;
      this.hoverTimer = setTimeout(async () => {
        let info = null;
        try { info = await this.describe(pos); } catch (e) { info = null; }
        if (info && this.hoverKey === id && this.mouse) this.showHover({from, head: info.head, where: info.where, doc: info.doc});
      }, HOVER_DELAY);
    }
    showHover(sym) {
      const t = this.hoverTip; t.replaceChildren();
      const head = document.createElement("div"); head.className = "tip-sig";
      const kind = /^[A-Z]/.test(sym.label) && sym.sig ? "class " : sym.sig ? "def " : "module ";
      head.textContent = sym.head || kind + (sym.sig ? sym.label + sym.sig : sym.key);
      const where = document.createElement("div"); where.className = "tip-where"; where.textContent = sym.head ? sym.where : sym.key;
      t.append(head);
      if (sym.sig || sym.head && sym.where) t.append(where);
      if (sym.doc) { const d = document.createElement("div"); d.className = "tip-doc"; d.textContent = sym.doc; t.append(d); }
      t.hidden = false;
      const c = this.coords(sym.from), hostBox = this.host.getBoundingClientRect();
      let left = c.x, top = c.top + LINE + 2;
      if (left + t.offsetWidth > hostBox.width - 4) left = Math.max(4, hostBox.width - t.offsetWidth - 4);
      if (top + t.offsetHeight > hostBox.height - 4 && c.top - t.offsetHeight - 2 >= 0) top = c.top - t.offsetHeight - 2;
      t.style.left = Math.max(0, left) + "px"; t.style.top = Math.max(0, top) + "px";
    }
    /** F12 on a library symbol: its stub signature and docs (XSDocs) in the hover tip, right away. */
    showDoc(key, from) {
      const d = this.complete.docs[key]; if (!d || !this.hoverTip) return false;
      this.hideHover(); this.showHover({from, to: from, key, label: key.split(".").pop(), sig: d[0], doc: d[1]}); this.hoverKey = key + "@" + from;
      return true;
    }
    hideHover() {
      clearTimeout(this.hoverTimer); this.hoverKey = "";
      if (this.hoverTip && !this.hoverTip.hidden) { this.hoverTip.hidden = true; this.hoverTip.replaceChildren(); }
    }
    /** Show / refresh / hide signature help for the caret. `force` = Ctrl/Cmd+Shift+Space (works with auto-assist off). */
    updateSig(keep, force) {
      if (force) this.sigForced = true;
      if (!this.active || this.box.selectionStart !== this.box.selectionEnd || (!this.enabled && !this.sigForced && !keep)) return this.hideSig();
      const r = this.complete.callAt(this.box.value, this.box.selectionStart);
      if (!r) return this.hideSig();
      const t = this.sigTip; t.replaceChildren();
      const head = document.createElement("div"); head.className = "tip-sig";
      const params = EditorComplete.params(r.sig);
      let at = 0;
      head.append(r.label);
      params.forEach((p, i) => {
        head.append(r.sig.slice(at, p.start));
        const s = document.createElement(i === r.active ? "b" : "span"); s.textContent = r.sig.slice(p.start, p.end);
        if (i === r.active) s.className = "tip-active";
        head.append(s); at = p.end;
      });
      head.append(r.sig.slice(at));
      t.append(head);
      const docText = firstParagraph(r.doc);
      if (docText) { const d = document.createElement("div"); d.className = "tip-doc"; d.textContent = docText; t.append(d); }
      t.dataset.key = r.key; t.dataset.active = String(r.active);
      t.hidden = false;
      const c = this.coords(Math.max(0, r.open - r.label.length)), caret = this.coords(this.box.selectionStart);
      const hostBox = this.host.getBoundingClientRect();
      let left = Math.min(c.x, caret.x), top = caret.top - t.offsetHeight - 2;
      if (top < 0) top = caret.top + LINE + 2 + (this.isOpen ? this.popup.offsetHeight + 2 : 0);
      if (left + t.offsetWidth > hostBox.width - 4) left = Math.max(4, hostBox.width - t.offsetWidth - 4);
      t.style.left = Math.max(0, left) + "px"; t.style.top = Math.max(0, top) + "px";
    }
    hideSig() {
      this.sigForced = false;
      if (this.sigTip && !this.sigTip.hidden) { this.sigTip.hidden = true; this.sigTip.replaceChildren(); }
    }

    // Returns true when the key was consumed.
    onKey(e) {
      if (!this.active) return false;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "Space") { e.preventDefault(); this.updateSig(true, true); return true; }
      if ((e.ctrlKey || e.metaKey) && e.code === "Space" || (e.altKey && e.key === "/")) { e.preventDefault(); this.open({force: true}); return true; }
      if (!this.isOpen) {
        if (e.key === "Escape" && (!this.sigTip.hidden || !this.hoverTip.hidden)) { e.preventDefault(); this.hideSig(); this.hideHover(); return true; }
        return false;
      }
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); this.select(this.index + 1); return true;
        case "ArrowUp": e.preventDefault(); this.select(this.index - 1); return true;
        case "PageDown": e.preventDefault(); this.select(Math.min(this.items.length - 1, this.index + 7)); return true;
        case "PageUp": e.preventDefault(); this.select(Math.max(0, this.index - 7)); return true;
        case "Enter": case "Tab": if (e.shiftKey || e.isComposing) return false; e.preventDefault(); this.accept(); return true;
        case "Escape": e.preventDefault(); this.close(); return true;
        case "ArrowLeft": case "ArrowRight": case "Home": case "End": this.close(); return false;
        default: return false;
      }
    }
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { EditorAssist };
  else root.EditorAssist = EditorAssist;
})(typeof window !== "undefined" ? window : globalThis);
