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

  /** Comment for code that only the node's path can pin (no unique id / text / desc): it breaks when the layout moves. */
  const FRAGILE = "# 没有唯一的 id、文字或描述，只能靠路径定位：界面变了可能找不到\n";
  const fragile = (n, roots) => selectorFields(n, roots).includes("path");

  /** For a node only its path can pin: the closest node that has a selector without the path, as {node, rel}. Children
   *  first (a list row's title), then parents (the button around an icon); at most 3 levels away. Siblings are other
   *  controls, so they are never offered. null when the node is stable already or nothing around it is. */
  function stableAlternative(n, roots) {
    if (!roots || !fragile(n, roots)) return null;
    const ok = c => c !== n && !fragile(c, roots);
    let level = n.children || [];
    for (let d = 0; d < 3 && level.length; d++) {
      const hit = level.find(ok); if (hit) return {node: hit, rel: "子节点"};
      level = level.flatMap(c => c.children || []);
    }
    const up = ancestry(roots, n).slice(0, -1).reverse().slice(0, 3);
    const parent = up.find(ok);
    return parent ? {node: parent, rel: "父节点"} : null;
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
    const note = fragile(n, roots) ? FRAGILE : "";
    if (kind === "xpath") return {imports: [NODE_IMPORT], code: note + "hit = node.Selector(" + (mode ? "1, " : "") + "xpath=" + pyStr(nodeXPath(n, roots)) + ").find(timeout=5)"};
    const chain = selectorChain(n, "node", mode, roots);
    if (kind === "click") return {imports: [NODE_IMPORT], code: note + chain + ".click().find(timeout=5)"};
    if (kind === "exists") return {imports: [NODE_IMPORT], code: note + "if " + chain + ".exists(timeout=5):\n    pass"};
    return {imports: [NODE_IMPORT], code: note + "hit = " + chain + ".find(timeout=5)"};
  }
  const fullText = s => s.imports.join("\n") + "\n" + s.code;

  /** Snippet for POST /eval that runs the node's selector on the phone without acting on anything: every match (at most
   *  20) as [path, l, t, r, b]. null for 点击中心坐标, which has nothing to look up. */
  function tryCode(n, kind = "find", mode = 0, roots = null) {
    if (kind === "tap") return null;
    const sel = kind === "xpath" ? "node.Selector(" + (mode ? "1, " : "") + "xpath=" + pyStr(nodeXPath(n, roots)) + ")" : selectorChain(n, "node", mode, roots);
    return NODE_IMPORT + "\n_hits = " + sel + ".find_all(timeout=0, limit=20)\n_result = [[h.path, h.left, h.top, h.right, h.bottom, h.id, h.text, h.desc, h.type] for h in _hits]";
  }

  /** The inserted snippet as a POST /eval body that really runs on the phone (find-and-click clicks, 点击中心坐标 taps)
   *  and answers in `_result`: what was found, whether the condition held, or that the tap was sent. */
  function runCode(n, kind = "find", mode = 0, roots = null) {
    const s = snippet(n, kind, mode, roots);
    let code = s.code;
    if (kind === "tap") code += "\n_result = \"已点击坐标\"";
    else if (kind === "exists") code = code.replace(/\n    pass$/, "\n    _result = \"条件成立：找到了\"\nelse:\n    _result = \"条件不成立：5 秒内没找到\"");
    else {
      if (kind === "click") code = code.replace(/^(node\.Selector)/m, "hit = $1");
      code += "\n_result = \"没找到（5 秒内）\" if hit is None else (\"已点击 \" if " + (kind === "click" ? "True" : "False") + " else \"找到 \") + repr(hit)";
    }
    return s.imports.join("\n") + "\n" + code;
  }

  /** A picked node as remembered in 最近选过 (no children, nothing else of the tree). */
  const recentEntry = n => ({path: n.path || "", id: n.id || "", text: n.text || "", desc: n.desc || "", type: n.type || "", label: label(n)});
  const sameEntry = (a, b) => a.path === b.path && a.id === b.id && a.text === b.text && a.desc === b.desc && a.type === b.type;
  /** `list` with `entry` moved to the front, at most `max` long. */
  function pushRecent(list, entry, max = 8) { return [entry, ...(list || []).filter(e => !sameEntry(e, entry))].slice(0, max); }

  /** Find a remembered node in a freshly read tree: the same path with the same id / text / desc / type, else the one
   *  node with those values (it may have moved). null when it is gone or more than one node looks like it. */
  function findRecent(roots, entry) {
    const all = []; const walk = n => { all.push(n); for (const c of n.children || []) walk(c); }; for (const r of roots || []) walk(r);
    const same = n => (n.id || "") === entry.id && (n.text || "") === entry.text && (n.desc || "") === entry.desc && (n.type || "") === entry.type;
    const exact = all.find(n => n.path === entry.path && same(n)); if (exact) return exact;
    if (!entry.id && !entry.text && !entry.desc) return null;           // a bare layout node is only known by its path
    const like = all.filter(same);
    return like.length === 1 ? like[0] : null;
  }

  /** What a try found, for the picked node `n`: {text, ok, hits: [{path, rect}]}. `result` is /eval's JSON text. */
  function tryVerdict(result, n) {
    let list = [];
    try { list = JSON.parse(result || "[]"); } catch (e) { list = []; }
    // the picked node itself: the same id / text / desc / type (it may have moved since the tree was read); the path only for nodes without them
    const me = h => h.vals && (n.id || n.text || n.desc) ? h.vals.join("\u0000") === [n.id || "", n.text || "", n.desc || "", n.type || ""].join("\u0000") : h.path === n.path;
    const hits = (Array.isArray(list) ? list : []).map(h => ({path: String(h[0]), rect: {l: h[1], t: h[2], r: h[3], b: h[4]}, vals: h.length > 5 ? h.slice(5, 9).map(v => v || "") : null}));
    for (const h of hits) { h.self = !!me(h); delete h.vals; }
    if (!hits.length) return {ok: false, hits, text: "试一下：没找到。界面可能变了，点「重新获取」再试"};
    const many = hits.length >= 20 ? "20 个及以上" : hits.length + " 个";
    if (!hits[0].self) return {ok: false, hits, text: "试一下：找到 " + many + "，第一个不是选中的节点（路径 " + hits[0].path + "）"};
    if (hits[0].path !== n.path) return {ok: true, hits, text: "试一下：找到 " + many + "，" + (hits.length > 1 ? "第一个" : "") + "是选中的节点，但它移动了（现在路径 " + hits[0].path + "），可点「重新获取」"};
    return {ok: true, hits, text: hits.length === 1 ? "试一下：找到 1 个，就是选中的节点" : "试一下：找到 " + many + "，第一个是选中的节点（.find 用第一个）"};
  }

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

  const EditorNodes = {hitTest, ancestry, rows, count, label, pyStr, xpathStr, selectorChain, nodeXPath, center, KINDS, snippet, fullText, runCode, recentEntry, pushRecent, findRecent, tryCode, tryVerdict, fragile, FRAGILE, stableAlternative, importEdit, attrs, boxStyle, shortType};

  // ---- browser dock ----
  // ctx: {message(text, error), insertCode(code, imports) -> bool, onOpen()}
  function initNodes(ctx) {
    const $ = id => document.getElementById(id);
    const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const st = {tree: null, selected: null, collapsed: new Set(), shotUrl: "", token: 0, tryToken: 0};
    const info = (text, error = false) => { $("node-info").textContent = text; $("node-info").classList.toggle("error", error); };
    const mode = () => ($("node-full").checked ? 1 : 0);
    for (const k of KINDS) { const o = make("option", "", k.label); o.value = k.id; $("node-kind").append(o); }
    try { st.recent = JSON.parse(localStorage.getItem("xs-node-recent") || "[]").filter(e => e && typeof e.label === "string"); } catch (e) { st.recent = []; }
    function renderRecent() {
      const sel = $("node-recent"); sel.replaceChildren(make("option", "", st.recent.length ? "最近选过（" + st.recent.length + "）" : "最近选过"));
      sel.firstChild.value = "";
      st.recent.forEach((e, i) => { const o = make("option", "", e.label + " · " + shortType(e.type)); o.value = String(i); sel.append(o); });
      sel.disabled = !st.recent.length; sel.value = "";
    }
    /** Remember a node the user picked (tree click, screenshot click, 换成它); arrow keys do not count. */
    function remember(n) {
      if (!n) return;
      st.recent = pushRecent(st.recent, recentEntry(n));
      try { localStorage.setItem("xs-node-recent", JSON.stringify(st.recent)); } catch (e) { /* storage off */ }
      renderRecent();
    }
    try { const saved = localStorage.getItem("xs-node-kind"); if (KINDS.some(k => k.id === saved)) $("node-kind").value = saved; } catch (e) { /* storage off */ }

    function current() { return st.selected ? snippet(st.selected, $("node-kind").value, mode(), st.tree && st.tree.roots) : null; }
    function renderDetail() {
      const n = st.selected, dl = $("node-attrs"); dl.replaceChildren();
      if (!n) { dl.append(make("p", "node-empty", st.tree ? "在树里或截图上点一个节点" : "")); }
      else for (const [k, v] of attrs(n)) dl.append(make("dt", "", k), make("dd", "", v));
      const s = current();
      $("node-code").value = s ? fullText(s) : "";
      $("node-copy").disabled = $("node-insert").disabled = !s;
      const alt = n && st.tree ? stableAlternative(n, st.tree.roots) : null;
      $("node-alt").hidden = !alt; st.alt = alt && alt.node;
      if (alt) $("node-alt-text").textContent = "更稳的选择：" + alt.rel + "「" + label(alt.node) + "」，它的 id、文字或描述在界面上唯一";
      $("node-try").disabled = !n || !tryCode(n, $("node-kind").value, mode(), st.tree && st.tree.roots);
      clearTry();
      $("node-run").hidden = true;
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

    function clearTry() {
      st.tryToken += 1;
      $("node-try-result").textContent = ""; $("node-try-result").classList.remove("error", "ok");
      $("node-hits").replaceChildren();
    }
    /** Run the selector on the phone (POST /eval, find_all only: nothing is clicked) and box what it finds. */
    async function tryIt() {
      const n = st.selected, code = n && tryCode(n, $("node-kind").value, mode(), st.tree && st.tree.roots);
      if (!code) return;
      clearTry();
      const token = st.tryToken, out = $("node-try-result");
      $("node-try").disabled = true; out.textContent = "试一下：在手机上查找…";
      // a screenshot taken now, so the boxes are drawn over what the phone shows at try time, not when the tree was read
      const fresh = fetch("/screen?t=" + Date.now(), {cache: "no-store", headers: {"X-XScript-Client": "tools"}}).then(r => r.ok ? r.blob() : null).catch(() => null);
      try {
        const r = await fetch("/eval", {method: "POST", cache: "no-store", headers: {"Content-Type": "application/json", "X-XScript-Client": "tools"}, body: JSON.stringify({code, timeout_ms: 5000})});
        if (r.status === 401) { location.href = "/pair?next=" + encodeURIComponent(location.pathname + location.search); return; }
        let data = null; try { data = await r.json(); } catch (e) { /* not JSON */ }
        if (token !== st.tryToken) return;
        if (!r.ok || !data || !data.ok) throw new Error("试一下失败：" + ((data && (data.error || "").trim().split("\n").pop()) || "HTTP " + r.status));
        const v = tryVerdict(data.result, n);
        const blob = await fresh; if (token !== st.tryToken) return;
        if (blob) {
          if (st.shotUrl) URL.revokeObjectURL(st.shotUrl);
          st.shotUrl = URL.createObjectURL(blob); $("node-shot").src = st.shotUrl; $("node-shot").hidden = false; $("node-shot-note").hidden = true;
          $("node-box").hidden = true;                   // the tree-time box may be stale; the try's own boxes are current
        }
        out.textContent = v.text + (blob ? " · 截图已刷新" : ""); out.classList.add(v.ok ? "ok" : "error");
        if (st.tree && !$("node-shot").hidden) for (const h of v.hits) {
          const css = boxStyle(h.rect, st.tree.width, st.tree.height); if (!css) continue;
          const b = make("div", "node-hit" + (h.self ? " self" : "")); b.title = h.path; Object.assign(b.style, css); $("node-hits").append(b);
        }
      } catch (e) { if (token === st.tryToken) { out.textContent = e.message; out.classList.add("error"); } }
      finally { if (token === st.tryToken) $("node-try").disabled = false; }
    }

    /** Run the snippet that was just inserted, for real (POST /eval): find-and-click clicks, 点击中心坐标 taps. */
    async function runIt() {
      const n = st.selected; if (!n) return;
      const code = runCode(n, $("node-kind").value, mode(), st.tree && st.tree.roots);
      clearTry();
      const token = st.tryToken, out = $("node-try-result");
      $("node-run").disabled = true; out.textContent = "在手机上运行…";
      try {
        const r = await fetch("/eval", {method: "POST", cache: "no-store", headers: {"Content-Type": "application/json", "X-XScript-Client": "tools"}, body: JSON.stringify({code, timeout_ms: 8000})});
        if (r.status === 401) { location.href = "/pair?next=" + encodeURIComponent(location.pathname + location.search); return; }
        let data = null; try { data = await r.json(); } catch (e) { /* not JSON */ }
        if (token !== st.tryToken) return;
        if (!r.ok || !data || !data.ok) throw new Error("运行失败：" + ((data && (data.error || "").trim().split("\n").pop()) || "HTTP " + r.status));
        const text = String(data.result || "");
        out.textContent = "运行结果：" + text; out.classList.add(/^(没找到|条件不成立)/.test(text) ? "error" : "ok");
      } catch (e) { if (token === st.tryToken) { out.textContent = e.message; out.classList.add("error"); } }
      finally { if (token === st.tryToken) $("node-run").disabled = false; }
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
        // keep the same control selected, not whatever now sits at its old path (a scrolled list shifts every row)
        const prev = st.selected && recentEntry(st.selected);
        st.tree = {width: Number(data.width) || 0, height: Number(data.height) || 0, roots: Array.isArray(data.roots) ? data.roots : [], mode: mode()};
        st.selected = null;
        if (prev) st.selected = findRecent(st.tree.roots, prev);
        renderTree(); renderDetail();
        info(count(st.tree.roots) + " 个节点 · " + st.tree.width + "×" + st.tree.height + " · " + (prev && !st.selected ? "之前选中的「" + prev.label + "」不在当前界面上" : "点截图或树选中节点"));
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
    $("node-try").addEventListener("click", tryIt);
    $("node-alt-use").addEventListener("click", () => { if (st.alt) { remember(st.alt); select(st.alt, {reveal: true, focus: true}); } });
    $("node-recent").addEventListener("change", () => {
      const entry = st.recent[Number($("node-recent").value)]; $("node-recent").value = "";
      if (!entry || !st.tree) return;
      const n = findRecent(st.tree.roots, entry);
      if (!n) { info("当前界面上找不到「" + entry.label + "」：先在手机上回到那个界面，再点「重新获取」", true); return; }
      remember(n); select(n, {reveal: true, focus: true});
      info("已选中最近的「" + entry.label + "」（路径 " + n.path + "）");
    });
    $("node-full").addEventListener("change", take);
    $("node-filter").addEventListener("input", renderTree);
    $("node-kind").addEventListener("change", () => { try { localStorage.setItem("xs-node-kind", $("node-kind").value); } catch (e) { /* storage off */ } renderDetail(); });
    $("node-copy").addEventListener("click", () => { const s = current(); if (s) XS.copy(fullText(s), "已复制代码"); });
    $("node-insert").addEventListener("click", () => {
      const s = current(); if (!s || !ctx.insertCode(s.code, s.imports)) return;
      ctx.message("已插入节点代码：" + label(st.selected));
      // offer to run what was just inserted; it acts on the phone for the click kinds, so the button says so
      const acts = ["click", "tap"].includes($("node-kind").value);
      $("node-run").textContent = acts ? "在手机上运行（会点击）" : "在手机上运行";
      $("node-run").hidden = false; $("node-run").disabled = false;
    });
    $("node-run").addEventListener("click", runIt);
    $("node-tree").addEventListener("click", e => {
      const row = e.target.closest(".node-row"); if (!row) return;
      const n = row._node;
      if (e.target.closest(".node-twisty") && (n.children || []).length) { const k = key(n); if (st.collapsed.has(k)) st.collapsed.delete(k); else st.collapsed.add(k); renderTree(); return; }
      remember(n); select(n, {focus: true});
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
      if (hit) { remember(hit); select(hit, {reveal: true}); } else info("x=" + x + "，y=" + y + " 处没有节点");
    });
    renderRecent(); renderDetail();
    return {take, open: () => setOpen(true), close: () => setOpen(false), state: () => st};
  }
  EditorNodes.initNodes = initNodes;

  if (typeof module !== "undefined" && module.exports) module.exports = {EditorNodes};
  else root.EditorNodes = EditorNodes;
})(typeof window !== "undefined" ? window : globalThis);
