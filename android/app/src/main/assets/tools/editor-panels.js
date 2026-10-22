"use strict";
// Web IDE side panels: project-wide search/replace and the screenshot dock. Browser glue only; the search logic is
// EditorSearch/EditorModel (unit-tested in Node). `ctx` is supplied by editor.js.
(function (root) {
  const $ = id => document.getElementById(id);
  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  // ---- search / replace ----
  // ctx: {model, message, openMatch(path, match), syncCurrent(), refreshFiles(), selectionText()}
  function initSearch(ctx) {
    const state = {results: [], query: "", opts: {}, token: 0};
    const flag = id => $(id).getAttribute("aria-pressed") === "true";
    const opts = () => ({caseSensitive: flag("s-case"), word: flag("s-word"), regex: flag("s-regex"), include: $("search-inc").value.trim()});
    const ide = document.querySelector(".ide");

    function open(prefill) {
      ide.classList.remove("refs"); $("refs-panel").hidden = true;
      ide.classList.add("searching"); $("search-panel").hidden = false;
      if (prefill) $("search-q").value = prefill;
      $("search-q").focus(); $("search-q").select();
      $("open-search").setAttribute("aria-pressed", "true");
    }
    function close() {
      ide.classList.remove("searching"); $("search-panel").hidden = true; $("open-search").setAttribute("aria-pressed", "false");
    }
    const summary = (text, error = false) => { $("search-summary").textContent = text; $("search-summary").classList.toggle("error", error); };

    function render() {
      const box = $("search-results"); box.replaceChildren();
      for (const group of state.results) {
        const file = make("div", "sr-file"); file.setAttribute("role", "group");
        const name = make("button", "sr-name"); name.type = "button"; name.setAttribute("aria-expanded", "true");
        name.append(make("span", "chev", "▾"), make("span", "sr-path", group.path), make("span", "sr-count", String(group.matches.length)));
        const rep = make("button", "sr-replace", "替换"); rep.type = "button"; rep.title = "只替换这个文件里的匹配"; rep.dataset.path = group.path;
        file.append(name, rep);
        const list = make("div", "sr-list");
        for (const [i, m] of group.matches.entries()) {
          const row = make("button", "sr-match"); row.type = "button"; row.dataset.path = group.path; row.dataset.i = String(i);
          row.title = group.path + ":" + m.line;
          row.append(make("span", "ln", String(m.line)), make("span", "tx"));
          const tx = row.lastChild; tx.append(make("span", "", m.before.replace(/^\s+/, "")), make("mark", "", m.match), make("span", "", m.after));
          list.append(row);
        }
        name.onclick = () => { const hidden = !list.hidden; list.hidden = hidden; name.setAttribute("aria-expanded", String(!hidden)); name.firstChild.textContent = hidden ? "▸" : "▾"; };
        box.append(file, list);
      }
      $("replace-all").disabled = !state.results.length;
    }

    async function run() {
      const q = $("search-q").value, token = ++state.token;
      if (!ctx.model.project) { summary("请先选择工程", true); return; }
      let o = opts();
      summary("搜索中…");
      try {
        const r = await ctx.model.searchProject(q, o);
        if (token !== state.token) return;
        state.results = r.results; state.query = q; state.opts = o;
        render();
        summary(r.matches ? r.matches + " 处匹配，" + r.files + " 个文件" + (r.truncated ? "（结果过多，已截断，请缩小范围）" : "") + (r.skipped ? " · 跳过 " + r.skipped + " 个二进制/过大文件" : "")
          : "没有找到“" + q + "”（已搜索 " + r.scanned + " 个文件）");
      } catch (e) { if (token === state.token) { state.results = []; render(); summary(e.message, true); } }
    }

    async function replace(paths) {
      if (!state.results.length) return;
      const wanted = paths || state.results.map(g => g.path), groups = state.results.filter(g => wanted.includes(g.path));
      const n = groups.reduce((s, g) => s + g.matches.length, 0), text = $("search-r").value;
      const dirty = groups.filter(g => { const d = ctx.model.documents.get(ctx.model.key(g.path)); return d && ctx.model.dirty(d); }).length;
      const ok = confirm("把 " + groups.length + " 个文件中的 " + n + " 处“" + state.query + "”替换为" + (text === "" ? "空（相当于删除）" : "“" + text + "”") + "？\n" +
        "没有未保存修改的文件会直接写入设备，无法撤销" + (dirty ? "；有未保存修改的 " + dirty + " 个文件只改编辑器内容，仍需保存" : "") + "。");
      if (!ok) return;
      try {
        summary("替换中…");
        const r = await ctx.model.replaceInFiles(groups.map(g => g.path), state.query, text, state.opts);
        ctx.syncCurrent();
        await ctx.refreshFiles();
        await run();
        const note = "已替换 " + r.count + " 处（" + r.files + " 个文件）" + (r.unsaved.length ? "；未保存：" + r.unsaved.join("、") : "") + (r.undoable ? "；可点「撤销替换」恢复" : "");
        summary(note); ctx.message(note); syncUndo();
      } catch (e) { summary("替换失败：" + e.message, true); ctx.message("替换失败：" + e.message, true); syncUndo(); await run().catch(() => {}); }
    }

    // 撤销替换: one step, for the latest replace of the current project (files edited since are left alone).
    function syncUndo() {
      const last = ctx.model.lastReplace, ok = !!last && last.project === ctx.model.project;
      $("replace-undo").disabled = !ok;
      $("replace-undo").title = ok ? "撤销上一次「全部替换」（" + last.changes.length + " 个文件）" : "没有可撤销的替换";
    }
    async function undo() {
      const last = ctx.model.lastReplace; if (!last || last.project !== ctx.model.project) { syncUndo(); return; }
      const saved = last.changes.filter(c => c.saved).length;
      if (!confirm("撤销上一次替换（" + last.changes.length + " 个文件）？\n仍保持替换后内容的文件会恢复原样" + (saved ? "，其中 " + saved + " 个会写回设备" : "") + "；替换后又改过的文件不会动。")) return;
      try {
        summary("撤销中…");
        const r = await ctx.model.undoReplace();
        ctx.syncCurrent(); await ctx.refreshFiles(); await run();
        const note = "已撤销 " + r.restored.length + " 个文件" + (r.skipped.length ? "；未撤销：" + r.skipped.map(s => s.path + "（" + s.reason + "）").join("、") : "");
        summary(note, r.skipped.length > 0); ctx.message(note, r.skipped.length > 0); syncUndo();
      } catch (e) { summary("撤销失败：" + e.message, true); ctx.message("撤销失败：" + e.message, true); syncUndo(); }
    }

    $("open-search").addEventListener("click", () => ($("search-panel").hidden ? open(ctx.selectionText()) : close()));
    $("search-close").addEventListener("click", close);
    $("search-go").addEventListener("click", run);
    for (const id of ["search-q", "search-r", "search-inc"]) $(id).addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); if (id === "search-r" && e.shiftKey) replace(); else run(); }
    });
    $("search-panel").addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); close(); $("files").querySelector(".tree-row.selected, .tree-row")?.focus(); } });
    for (const id of ["s-case", "s-word", "s-regex"]) $(id).addEventListener("click", () => {
      $(id).setAttribute("aria-pressed", String(!flag(id)));
      if ($("search-q").value) run();
    });
    $("replace-all").addEventListener("click", () => replace());
    $("replace-undo").addEventListener("click", undo);
    syncUndo();
    $("search-results").addEventListener("click", e => {
      const rep = e.target.closest(".sr-replace"); if (rep) { replace([rep.dataset.path]); return; }
      const row = e.target.closest(".sr-match"); if (!row) return;
      const group = state.results.find(g => g.path === row.dataset.path); if (group) ctx.openMatch(group.path, group.matches[Number(row.dataset.i)]);
    });
    function reset() { ++state.token; state.results = []; render(); summary(""); syncUndo(); }
    return {open, close, run, reset, state, syncUndo};
  }

  // ---- find references (Shift+F12) ----
  // ctx: {open(path, line, col, length)}
  function initRefs(ctx) {
    const ide = document.querySelector(".ide");
    let refs = [];
    function close() { ide.classList.remove("refs"); $("refs-panel").hidden = true; }
    function show(name, list) {
      refs = list; ide.classList.remove("searching"); $("search-panel").hidden = true; $("open-search").setAttribute("aria-pressed", "false");
      ide.classList.add("refs", "sidebar-open"); $("refs-panel").hidden = false;
      $("refs-title").textContent = "引用：" + name;
      const files = new Set(list.map(r => r.path));
      $("refs-summary").textContent = list.length + " 处，" + files.size + " 个文件";
      const box = $("refs-results"); box.replaceChildren();
      for (const path of files) {
        const head = make("div", "sr-file"); head.append(make("span", "sr-path", path), make("span", "sr-count", String(list.filter(r => r.path === path).length)));
        box.append(head);
        list.forEach((r, i) => {
          if (r.path !== path) return;
          const row = make("button", "sr-match"); row.type = "button"; row.dataset.i = String(i); row.title = path + ":" + r.line + (r.def ? "（定义）" : "");
          const at = r.text.indexOf(name), tx = make("span", "tx");
          if (at >= 0) tx.append(make("span", "", r.text.slice(0, at)), make("mark", "", name), make("span", "", r.text.slice(at + name.length))); else tx.textContent = r.text;
          row.append(make("span", "ln", String(r.line)), tx);
          if (r.def) row.append(make("span", "ref-def", "定义"));
          box.append(row);
        });
      }
      const first = box.querySelector(".sr-match"); if (first) first.focus();
    }
    $("refs-results").addEventListener("click", e => {
      const row = e.target.closest(".sr-match"); if (!row) return;
      const r = refs[Number(row.dataset.i)]; if (r) ctx.open(r.path, r.line, r.col, r.length);
    });
    $("refs-close").addEventListener("click", close);
    $("refs-panel").addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); close(); $("editor").focus(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const rows = [...$("refs-results").querySelectorAll(".sr-match")], i = rows.indexOf(document.activeElement);
        if (i >= 0) { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].focus(); }
      }
    });
    return {show, close};
  }

  // ---- screenshot dock ----
  // ctx: {api, model, message, refreshFiles(), insertAtCaret(text), onOpen()}
  function initShot(ctx) {
    let blob = null, point = null;
    const canvas = $("shot-canvas"), g = canvas.getContext("2d", {willReadFrequently: true});
    const info = (text, error = false) => { $("shot-info").textContent = text; $("shot-info").classList.toggle("error", error); };
    const sync = () => { for (const id of ["shot-save", "shot-download"]) $(id).disabled = !blob; $("shot-insert").disabled = !point; };
    sync();

    async function take() {
      $("shot-take").disabled = true; info("截图中…");
      try {
        const r = await fetch("/screen?t=" + Date.now(), {cache: "no-store"});
        if (!r.ok) {
          let code = ""; try { code = (await r.json()).error || ""; } catch (e) { /* not JSON */ }
          throw new Error(/capture_unavailable/.test(code) ? "手机还没有开启截屏权限：请在 XScript 首页授权「屏幕截取」后再试" : "截图失败（HTTP " + r.status + (code ? "：" + code : "") + "）");
        }
        blob = await r.blob();
        const bmp = await createImageBitmap(blob);
        canvas.width = bmp.width; canvas.height = bmp.height; g.drawImage(bmp, 0, 0); bmp.close && bmp.close();
        canvas.hidden = false; point = null;
        info(canvas.width + "×" + canvas.height + " · " + Math.max(1, Math.round(blob.size / 1024)) + " KB · 点击画面取坐标和颜色");
      } catch (e) { info(e.message, true); }
      finally { $("shot-take").disabled = false; sync(); }
    }
    const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };
    function toBase64(b) {
      return new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(",")[1] || ""); fr.onerror = () => reject(fr.error); fr.readAsDataURL(b); });
    }
    async function save() {
      if (!blob || !ctx.model.project) { info("请先截图并选择工程", true); return; }
      const path = "res/img/shot-" + stamp() + ".png";
      try {
        const png = blob.type === "image/png" ? blob : await new Promise(res => canvas.toBlob(res, "image/png"));
        await ctx.api("PUT", ctx.model.projectUrl() + "/files", {path, content: await toBase64(png), encoding: "base64", create: true});
        await ctx.refreshFiles();
        info("已保存到 " + path); ctx.message("截图已保存到 " + path);
      } catch (e) { info("保存失败：" + e.message, true); }
    }
    function pick(e) {
      const rect = canvas.getBoundingClientRect(); if (!rect.width) return;
      const x = Math.min(canvas.width - 1, Math.max(0, Math.floor((e.clientX - rect.left) * canvas.width / rect.width)));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.floor((e.clientY - rect.top) * canvas.height / rect.height)));
      const [r, gr, b] = g.getImageData(x, y, 1, 1).data, hex = "#" + [r, gr, b].map(v => v.toString(16).padStart(2, "0")).join("");
      point = {x, y, hex}; $("shot-swatch").style.background = hex; $("shot-swatch").hidden = false;
      info("x=" + x + "，y=" + y + " · " + hex + " · rgb(" + r + "," + gr + "," + b + ")"); sync();
    }
    $("shot-toggle").addEventListener("click", () => {
      const open = $("shot-panel").hidden; $("shot-panel").hidden = !open; $("shot-toggle").setAttribute("aria-pressed", String(open));
      if (open && ctx.onOpen) ctx.onOpen();       // one dock at a time (节点 closes)
      if (open && !blob) take();
    });
    $("shot-close").addEventListener("click", () => { $("shot-panel").hidden = true; $("shot-toggle").setAttribute("aria-pressed", "false"); });
    $("shot-take").addEventListener("click", take);
    $("shot-save").addEventListener("click", save);
    $("shot-download").addEventListener("click", () => {
      if (!blob) return; const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "screenshot-" + stamp() + ".png";
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $("shot-insert").addEventListener("click", () => { if (point) ctx.insertAtCaret(point.x + ", " + point.y); });
    canvas.addEventListener("click", pick);
    return {take, state: () => ({blob, point})};
  }

  root.EditorPanels = {initSearch, initShot, initRefs};
})(typeof window !== "undefined" ? window : globalThis);
