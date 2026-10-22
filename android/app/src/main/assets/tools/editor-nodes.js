"use strict";
// Web IDE 节点 dock: grab the phone's UI node tree (GET /ui-tree, protocol/openapi.yaml UiNode as dumped by NodeDumper),
// pick a node in the tree or on the screenshot, and generate xscript code for it. The helpers are pure (unit-tested in
// Node); code generation follows the desktop inspector (desktop/frontend/src/ui-tree.ts) so both write the same selectors.
(function (root) {
  const shortType = t => { if (!t) return ""; const i = t.lastIndexOf("."); return i >= 0 ? t.slice(i + 1) : t; };
  const contains = (r, x, y) => r.r > r.l && r.b > r.t && x >= r.l && x < r.r && y >= r.t && y < r.b;

  /** Deepest, then smallest, node whose rect contains the point. Later nodes win ties (they paint on top). */
  function hitTest(roots, x, y) {
    let best = null, area = Infinity, depth = -1;
    const walk = (n, d) => {
      const r = n.rect;
      if (r && contains(r, x, y)) {
        const a = (r.r - r.l) * (r.b - r.t);
        if (!best || a < area || (a === area && d >= depth)) { best = n; area = a; depth = d; }
      }
      for (const c of n.children || []) walk(c, d + 1);
    };
    for (const n of roots || []) walk(n, 0);
    return best;
  }

  /** Nodes from a root down to `target` (inclusive), or [] when it is not in the tree. */
  function ancestry(roots, target) {
    const trail = [];
    const walk = n => { trail.push(n); if (n === target) return true; for (const c of n.children || []) if (walk(c)) return true; trail.pop(); return false; };
    for (const n of roots || []) if (walk(n)) return trail;
    return [];
  }

  const key = n => n.path || "";
  const matches = (n, q) => [n.text, n.desc, n.id, n.type, n.hint].some(v => v && String(v).toLowerCase().includes(q));

  /**
   * Visible rows for the tree view: {node, depth, hasChildren, expanded, match}. `collapsed` holds node paths the user
   * folded. With a filter only matching nodes and their ancestors are listed (ancestors always open).
   */
  function rows(roots, {collapsed = new Set(), filter = "", limit = 2000} = {}) {
    const q = String(filter || "").trim().toLowerCase(), out = [];
    let truncated = false;
    const keep = new Set();
    if (q) {
      const mark = n => { let hit = matches(n, q); for (const c of n.children || []) if (mark(c)) hit = true; if (hit) keep.add(n); return hit; };
      for (const n of roots || []) mark(n);
    }
    const walk = (list, depth) => {
      for (const n of list) {
        if (q && !keep.has(n)) continue;
        if (out.length >= limit) { truncated = true; return; }
        const kids = n.children || [], expanded = q ? true : !collapsed.has(key(n));
        out.push({node: n, depth, hasChildren: kids.length > 0, expanded, match: q ? matches(n, q) : false});
        if (kids.length && expanded) walk(kids, depth + 1);
      }
    };
    walk(roots || [], 0);
    return {rows: out, truncated};
  }

  function count(roots) { let c = 0; const walk = n => { c++; for (const k of n.children || []) walk(k); }; for (const n of roots || []) walk(n); return c; }

  function label(n) {
    const t = String(n.text || n.desc || n.id || shortType(n.type) || n.path || "").trim();
    return t || "(无名称)";
  }

  /** Python string literal: single-quoted, backslash escapes. */
  const pyStr = v => "'" + String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n") + "'";
  /** XPath string literal; concat() when the value has both quote styles. */
  function xpathStr(v) {
    v = String(v);
    if (!v.includes('"')) return '"' + v + '"';
    if (!v.includes("'")) return "'" + v + "'";
    return "concat(" + v.split('"').map(p => '"' + p + '"').join(", '\"', ") + ")";
  }

  /** Fields the Selector / XPath filters on, in the order they are tried. A field is added only while the earlier
   *  ones still match other nodes of `roots` (e.g. every row of a list shares one resource id), so the code finds
   *  the picked node rather than the first look-alike. Without `roots` (or a unique match) the first field is enough;
   *  when none of them is unique the node's path pins it. */
  /** Clocks and timers rewrite their own text, so a selector on it stops matching; their text/desc are skipped. */
  function volatileText(n) {
    return /:id\/clock$/.test(n.id || "") || /(^|\.)(TextClock|Chronometer)$/.test(n.type || "");
  }

  function selectorFields(n, roots) {
    const all = []; const walk = x => { all.push(x); for (const k of x.children || []) walk(k); }; for (const r of roots || []) walk(r);
    const same = fields => all.filter(x => fields.every(f => x[f] === n[f]) && (!n.clickable || x.clickable)).length;
    const fields = [];
    for (const f of ["id", "text", "desc"]) {
      if (!n[f] || (f !== "id" && volatileText(n))) continue;
      fields.push(f);
      if (!roots || same(fields) <= 1) return fields;
    }
    if (!fields.length && n.type) fields.push("type");
    if (n.path) fields.push("path");
    return fields;
  }
  const CALL = {id: "id", text: "text", desc: "desc", type: "type", path: "path"};

  /** `<module>.Selector(...)` chain: resource id, text, content-desc as needed to be unique in `roots`, else class +
   *  path; plus .clickable(). */
  function selectorChain(n, module = "node", mode = 0, roots = null) {
    const calls = selectorFields(n, roots).map(f => "." + CALL[f] + "(" + pyStr(n[f]) + ")");
    if (n.clickable) calls.push(".clickable()");
    const chain = calls.length ? calls.join("") : ".path(" + pyStr(n.path || "0") + ")";
    return module + ".Selector(" + (mode ? "1" : "") + ")" + chain;
  }

  /** One XPath for the node: resource-id, text, content-desc as needed to be unique in `roots`, else path. */
  function nodeXPath(n, roots = null) {
    const cls = shortType(n.type) || "*";
    const fields = selectorFields(n, roots).filter(f => f !== "type");
    if (!fields.length) return "//" + cls;
    const attr = {id: "resource-id", text: "text", desc: "content-desc", path: "path"};
    const tag = fields[0] === "id" || fields[0] === "path" ? "*" : cls;
    return "//" + tag + fields.map(f => "[@" + attr[f] + "=" + xpathStr(n[f]) + "]").join("");
  }

  const center = r => r ? {x: Math.round((r.l + r.r) / 2), y: Math.round((r.t + r.b) / 2)} : null;

  const KINDS = [
    {id: "find", label: "查找节点"},
    {id: "click", label: "查找并点击"},
    {id: "exists", label: "等待出现"},
    {id: "xpath", label: "XPath 查找"},
    {id: "tap", label: "点击中心坐标"},
  ];
  const NODE_IMPORT = "from xscript.android import node", ACTION_IMPORT = "from xscript.android import action";

  /** Code for one node: {imports: [lines], code}. `mode` 1 when the tree was dumped in full mode (Selector(1) sees it). */
  function snippet(n, kind = "find", mode = 0, roots = null) {
    if (kind === "tap") {
      const c = center(n.rect) || {x: 0, y: 0};
      return {imports: [ACTION_IMPORT], code: "action.click(" + c.x + ", " + c.y + ")  # " + label(n).replace(/\s+/g, " ").slice(0, 40)};
    }
    if (kind === "xpath") return {imports: [NODE_IMPORT], code: "hit = node.Selector(" + (mode ? "1, " : "") + "xpath=" + pyStr(nodeXPath(n, roots)) + ").find(timeout=5)"};
    const chain = selectorChain(n, "node", mode, roots);
    if (kind === "click") return {imports: [NODE_IMPORT], code: chain + ".click().find(timeout=5)"};
    if (kind === "exists") return {imports: [NODE_IMPORT], code: "if " + chain + ".exists(timeout=5):\n    pass"};
    return {imports: [NODE_IMPORT], code: "hit = " + chain + ".find(timeout=5)"};
  }
  const fullText = s => s.imports.join("\n") + "\n" + s.code;

  /** Where to add a missing import line: null when `text` already has it, else {at, text} (after the leading import block). */
  function importEdit(text, line) {
    const lines = String(text).split("\n");
    if (lines.some(l => l.trim() === line)) return null;
    const m = /^from\s+(\S+)\s+import\s+(\w+)$/.exec(line);
    if (m && lines.some(l => { const f = /^from\s+(\S+)\s+import\s+\(?([^#)]*)/.exec(l); return f && f[1] === m[1] && f[2].split(",").some(x => x.trim().split(/\s+/)[0] === m[2] && !/\sas\s/.test(x)); })) return null;
    let at = 0, offset = 0, end = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], t = l.trim();
      offset += l.length + 1;
      if (/^(import|from)\s/.test(l)) { at = offset; end = i + 1; continue; }
      if (t === "" || t.startsWith("#")) { if (!end) at = offset; continue; }
      break;
    }
    if (!end) at = 0;                                // no imports yet: put it on the first line
    return {at: Math.min(at, String(text).length), text: line + "\n"};
  }

  /** Attribute rows for the detail list. */
  function attrs(n) {
    const out = [], r = n.rect, c = center(r);
    const add = (k, v) => { if (v !== undefined && v !== null && v !== "") out.push([k, String(v)]); };
    add("文字 text", n.text); add("描述 desc", n.desc); add("id", n.id); add("提示 hint", n.hint); add("类名 type", n.type); add("包名", n.package);
    add("路径 path", n.path);
    if (r) { add("范围", "[" + r.l + "," + r.t + "][" + r.r + "," + r.b + "]  " + (r.r - r.l) + "×" + (r.b - r.t)); add("中心", c.x + ", " + c.y); }
    const flags = ["clickable", "editable", "enabled", "visible"].filter(f => n[f] !== undefined).map(f => f + "=" + (n[f] ? "是" : "否"));
    add("属性", flags.join("  "));
    add("子节点", (n.children || []).length || n.childCount);
    return out;
  }

  /** Percent box over the screenshot for a rect in tree (device) pixels. */
  function boxStyle(r, w, h) {
    if (!r || !(w > 0) || !(h > 0)) return null;
    return {left: r.l / w * 100 + "%", top: r.t / h * 100 + "%", width: (r.r - r.l) / w * 100 + "%", height: (r.b - r.t) / h * 100 + "%"};
  }

  const EditorNodes = {hitTest, ancestry, rows, count, label, pyStr, xpathStr, selectorChain, nodeXPath, center, KINDS, snippet, fullText, importEdit, attrs, boxStyle, shortType};

  // ---- browser dock ----
  // ctx: {message(text, error), insertCode(code, imports) -> bool, onOpen()}
  function initNodes(ctx) {
    const $ = id => document.getElementById(id);
    const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const st = {tree: null, selected: null, collapsed: new Set(), shotUrl: "", token: 0};
    const info = (text, error = false) => { $("node-info").textContent = text; $("node-info").classList.toggle("error", error); };
    const mode = () => ($("node-full").checked ? 1 : 0);
    for (const k of KINDS) { const o = make("option", "", k.label); o.value = k.id; $("node-kind").append(o); }
    try { const saved = localStorage.getItem("xs-node-kind"); if (KINDS.some(k => k.id === saved)) $("node-kind").value = saved; } catch (e) { /* storage off */ }

    function current() { return st.selected ? snippet(st.selected, $("node-kind").value, mode(), st.tree && st.tree.roots) : null; }
    function renderDetail() {
      const n = st.selected, dl = $("node-attrs"); dl.replaceChildren();
      if (!n) { dl.append(make("p", "node-empty", st.tree ? "在树里或截图上点一个节点" : "")); }
      else for (const [k, v] of attrs(n)) dl.append(make("dt", "", k), make("dd", "", v));
      const s = current();
      $("node-code").value = s ? fullText(s) : "";
      $("node-copy").disabled = $("node-insert").disabled = !s;
      const box = $("node-box"), css = n && st.tree && boxStyle(n.rect, st.tree.width, st.tree.height);
      box.hidden = !css || $("node-shot").hidden;
      if (css) Object.assign(box.style, css);
    }
    function renderTree() {
      const box = $("node-tree"); box.replaceChildren();
      if (!st.tree) return;
      const {rows: list, truncated} = rows(st.tree.roots, {collapsed: st.collapsed, filter: $("node-filter").value});
      for (const r of list) {
        const row = make("div", "node-row" + (r.match ? " match" : "")); row.setAttribute("role", "treeitem"); row.tabIndex = -1;
        row.dataset.path = key(r.node); row.setAttribute("aria-level", String(r.depth + 1)); row.style.paddingLeft = 4 + r.depth * 12 + "px";
        if (r.hasChildren) row.setAttribute("aria-expanded", String(r.expanded));
        row.setAttribute("aria-selected", String(r.node === st.selected));
        const tw = make("span", "node-twisty", r.hasChildren ? (r.expanded ? "▾" : "▸") : ""); tw.setAttribute("aria-hidden", "true");
        row.append(tw, make("span", "node-label", label(r.node)), make("span", "node-type", shortType(r.node.type)));
        if (r.node.clickable) row.append(make("span", "node-tag", "可点"));
        row._node = r.node;
        box.append(row);
      }
      if (!list.length) box.append(make("p", "node-empty", $("node-filter").value ? "没有匹配的节点" : "没有节点"));
      if (truncated) box.append(make("p", "node-empty", "节点太多，只显示前 2000 个；可用筛选缩小范围"));
      const sel = box.querySelector('[aria-selected="true"]') || box.querySelector(".node-row");
      if (sel) sel.tabIndex = 0;
    }
    function select(n, {reveal = false, focus = false} = {}) {
      st.selected = n;
      if (n && reveal) for (const a of ancestry(st.tree.roots, n)) if (a !== n) st.collapsed.delete(key(a));
      renderTree(); renderDetail();
      const row = $("node-tree").querySelector('[aria-selected="true"]');
      if (row && (reveal || focus)) { row.scrollIntoView({block: "nearest"}); if (focus) row.focus(); }
    }

    async function take() {
      const token = ++st.token;
      $("node-take").disabled = true; info("读取节点…");
      try {
        const r = await fetch("/ui-tree?mode=" + mode() + "&t=" + Date.now(), {cache: "no-store", headers: {"X-XScript-Client": "tools"}});
        if (r.status === 401) { location.href = "/pair?next=" + encodeURIComponent(location.pathname + location.search); return; }
        let data = null; try { data = await r.json(); } catch (e) { /* not JSON */ }
        if (!r.ok) throw new Error(r.status === 503 || /no_channel/.test(data && data.error || "") ? "读不到节点：请在手机上开启 XScript 的无障碍服务（或授予 Root）后再试" : "读取节点失败（HTTP " + r.status + (data && data.error ? "：" + data.error : "") + "）");
        if (token !== st.token) return;
        const prev = st.selected && st.selected.path;
        st.tree = {width: Number(data.width) || 0, height: Number(data.height) || 0, roots: Array.isArray(data.roots) ? data.roots : [], mode: mode()};
        st.selected = null;
        if (prev) { const walk = l => { for (const n of l) { if (n.path === prev) return n; const f = walk(n.children || []); if (f) return f; } return null; }; st.selected = walk(st.tree.roots); }
        renderTree(); renderDetail();
        info(count(st.tree.roots) + " 个节点 · " + st.tree.width + "×" + st.tree.height + " · 点截图或树选中节点");
        shot(token);
      } catch (e) { if (token === st.token) { info(e.message, true); st.tree = null; st.selected = null; renderTree(); renderDetail(); } }
      finally { if (token === st.token) $("node-take").disabled = false; }
    }
    async function shot(token) {
      const img = $("node-shot");
      try {
        const r = await fetch("/screen?t=" + Date.now(), {cache: "no-store", headers: {"X-XScript-Client": "tools"}});
        if (!r.ok) throw new Error("HTTP " + r.status);
        const blob = await r.blob(); if (token !== st.token) return;
        if (st.shotUrl) URL.revokeObjectURL(st.shotUrl);
        st.shotUrl = URL.createObjectURL(blob); img.src = st.shotUrl; img.hidden = false;
        $("node-shot-note").hidden = true;
      } catch (e) {
        if (token !== st.token) return;
        img.hidden = true; $("node-shot-note").hidden = false;
      }
      renderDetail();
    }

    function setOpen(open) {
      $("node-panel").hidden = !open; $("node-toggle").setAttribute("aria-pressed", String(open));
      if (open) { if (ctx.onOpen) ctx.onOpen(); if (!st.tree) take(); }
    }
    $("node-toggle").addEventListener("click", () => setOpen($("node-panel").hidden));
    $("node-close").addEventListener("click", () => setOpen(false));
    $("node-take").addEventListener("click", take);
    $("node-full").addEventListener("change", take);
    $("node-filter").addEventListener("input", renderTree);
    $("node-kind").addEventListener("change", () => { try { localStorage.setItem("xs-node-kind", $("node-kind").value); } catch (e) { /* storage off */ } renderDetail(); });
    $("node-copy").addEventListener("click", () => { const s = current(); if (s) XS.copy(fullText(s), "已复制代码"); });
    $("node-insert").addEventListener("click", () => { const s = current(); if (s && ctx.insertCode(s.code, s.imports)) ctx.message("已插入节点代码：" + label(st.selected)); });
    $("node-tree").addEventListener("click", e => {
      const row = e.target.closest(".node-row"); if (!row) return;
      const n = row._node;
      if (e.target.closest(".node-twisty") && (n.children || []).length) { const k = key(n); if (st.collapsed.has(k)) st.collapsed.delete(k); else st.collapsed.add(k); renderTree(); return; }
      select(n, {focus: true});
    });
    $("node-tree").addEventListener("keydown", e => {
      const list = [...$("node-tree").querySelectorAll(".node-row")], i = list.indexOf(document.activeElement);
      if (i < 0) return;
      const n = list[i]._node, kids = (n.children || []).length, k = key(n);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]; select(next._node, {focus: true}); }
      else if (e.key === "ArrowRight" && kids && st.collapsed.has(k)) { e.preventDefault(); st.collapsed.delete(k); select(n, {focus: true}); }
      else if (e.key === "ArrowLeft" && kids && !st.collapsed.has(k) && !$("node-filter").value) { e.preventDefault(); st.collapsed.add(k); select(n, {focus: true}); }
      else if (e.key === "Enter") { e.preventDefault(); $("node-insert").click(); }
    });
    $("node-shot").addEventListener("click", e => {
      if (!st.tree) return;
      const rect = e.currentTarget.getBoundingClientRect(); if (!rect.width || !rect.height) return;
      const x = Math.floor((e.clientX - rect.left) * st.tree.width / rect.width), y = Math.floor((e.clientY - rect.top) * st.tree.height / rect.height);
      const hit = hitTest(st.tree.roots, x, y);
      if (hit) select(hit, {reveal: true}); else info("x=" + x + "，y=" + y + " 处没有节点");
    });
    renderDetail();
    return {take, open: () => setOpen(true), close: () => setOpen(false), state: () => st};
  }
  EditorNodes.initNodes = initNodes;

  if (typeof module !== "undefined" && module.exports) module.exports = {EditorNodes};
  else root.EditorNodes = EditorNodes;
})(typeof window !== "undefined" ? window : globalThis);
