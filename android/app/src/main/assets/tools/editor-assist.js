"use strict";
// Web IDE assistance for the <textarea> editor: the completion popup (EditorComplete) and syntax diagnostics
// (EditorCheck: wavy underlines, gutter marks, a problems button). Browser-only glue; the logic lives in the
// two pure modules, which are unit-tested in Node.
(function (root) {
  const ESC = {"&": "&amp;", "<": "&lt;", ">": "&gt;"};
  const esc = s => s.replace(/[&<>]/g, c => ESC[c]);
  const KIND = {f: "ƒ", c: "C", m: "M", v: "x", k: "k", w: "w"};
  const LINE = 21, PAD_TOP = 16, PAD_LEFT = 12, CHECK_DELAY = 350;

  class EditorAssist {
    /**
     * @param {object} o  box (textarea), host (positioned wrapper), popup (ul), layer (pre under the textarea),
     *                    problems (button), toggle (checkbox), onMarks (called when gutter marks change)
     */
    constructor(o) {
      Object.assign(this, o);
      this.complete = new EditorComplete(root.XSApi || {modules: {}});
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
      this.render();
    }

    // The open file changed (or none): null disables assistance for non-Python files.
    setFile(path) {
      this.path = path && /\.pyw?$/.test(path) ? path : null;
      this.close(); clearTimeout(this.timer); this.problemCursor = -1;
      this.runCheck();
    }

    get active() { return !!this.path && !this.box.disabled; }

    // ---- diagnostics ----
    scheduleCheck() { clearTimeout(this.timer); this.timer = setTimeout(() => this.runCheck(), CHECK_DELAY); }
    runCheck() {
      clearTimeout(this.timer);
      this.diags = this.active && this.box.value.length <= 400000 ? EditorCheck.check(this.box.value) : [];
      this.render(); if (this.onMarks) this.onMarks();
    }
    marks() { const m = new Map(); for (const d of this.diags) if (!m.has(d.line)) m.set(d.line, d.message); return m; }
    render() {
      const text = this.active ? this.box.value : "";
      if (!this.diags.length) this.layer.textContent = "";
      else {
        const lines = text.split("\n"), byLine = new Map();
        for (const d of this.diags) { if (!byLine.has(d.line)) byLine.set(d.line, []); byLine.get(d.line).push(d); }
        this.layer.innerHTML = lines.map((raw, i) => {
          const ds = byLine.get(i + 1); if (!ds) return esc(raw);
          let out = "", at = 0;
          for (const d of ds.sort((a, b) => a.col - b.col)) {
            const from = Math.min(Math.max(d.col, at), raw.length), to = Math.min(Math.max(from + d.length, from + 1), raw.length);
            if (to <= from) { out += esc(raw.slice(at)) + '<span class="sq"> </span>'; at = raw.length; continue; }
            out += esc(raw.slice(at, from)) + '<span class="sq">' + esc(raw.slice(from, to)) + "</span>"; at = to;
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
      b.classList.toggle("has-problems", n > 0);
      b.textContent = n === 0 ? "✓ 无语法问题" : here ? "⚠ 第 " + here.line + " 行：" + here.message : "⚠ " + n + " 个语法问题（点击跳转）";
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
      this.diags = []; this.layer.textContent = ""; if (this.onMarks) this.onMarks();    // positions are stale while typing
      this.scheduleCheck();
      const type = e && e.inputType;
      if (!this.enabled || (type !== "insertText" && type !== "insertCompositionText")) { this.close(); return; }
      this.open({});
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
      this.select(this.index);
      this.place();
    }
    select(i) {
      this.index = (i + this.items.length) % this.items.length;
      const lis = this.popup.querySelectorAll("li");
      lis.forEach((li, n) => li.setAttribute("aria-selected", String(n === this.index)));
      const li = lis[this.index];
      if (li) { li.scrollIntoView({block: "nearest"}); this.box.setAttribute("aria-activedescendant", li.id); }
      const item = this.items[this.index], doc = this.popup.querySelector(".cdoc");
      if (doc) { const text = ((item.detail ? item.label + item.detail + "\n" : "") + (item.doc || "")).trim(); doc.textContent = text; doc.hidden = !text; }
    }
    /** The textarea scrolled (the browser follows the caret on a narrow screen, or the user scrolled): keep the popup
     *  next to the caret while the caret is still visible, close it once the caret has scrolled out of view. */
    onScroll() {
      if (this.popup.hidden || !this.range) return;
      const c = this.caretBox();
      if (c.x < 0 || c.x > c.hostW || c.y < 0 || c.y > c.hostH) this.close(); else this.place();
    }
    caretBox() {
      const box = this.box, value = box.value, pos = this.range.from;
      const ls = value.lastIndexOf("\n", pos - 1) + 1, row = value.slice(0, pos).split("\n").length - 1;
      const probe = document.createElement("span"), cs = getComputedStyle(box);
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;tab-size:4;letter-spacing:0;font-variant-ligatures:none";
      probe.style.fontFamily = cs.fontFamily; probe.style.fontSize = cs.fontSize; probe.style.fontWeight = cs.fontWeight;
      probe.textContent = value.slice(ls, pos); this.host.append(probe);
      const width = probe.getBoundingClientRect().width; probe.remove();
      const hostBox = this.host.getBoundingClientRect();
      return {x: PAD_LEFT + width - box.scrollLeft, y: PAD_TOP + (row + 1) * LINE - box.scrollTop, hostW: hostBox.width, hostH: hostBox.height};
    }
    place() {
      const box = this.box, value = box.value, pos = this.range.from;
      const ls = value.lastIndexOf("\n", pos - 1) + 1, row = value.slice(0, pos).split("\n").length - 1;
      const probe = document.createElement("span");
      const cs = getComputedStyle(box);
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;tab-size:4;letter-spacing:0;font-variant-ligatures:none";
      probe.style.fontFamily = cs.fontFamily; probe.style.fontSize = cs.fontSize; probe.style.fontWeight = cs.fontWeight;
      probe.textContent = value.slice(ls, pos); this.host.append(probe);
      const width = probe.getBoundingClientRect().width; probe.remove();
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

    // Returns true when the key was consumed.
    onKey(e) {
      if (!this.active) return false;
      if ((e.ctrlKey || e.metaKey) && e.code === "Space" || (e.altKey && e.key === "/")) { e.preventDefault(); this.open({force: true}); return true; }
      if (!this.isOpen) return false;
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
