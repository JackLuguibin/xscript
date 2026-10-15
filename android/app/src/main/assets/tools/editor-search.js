"use strict";
// Web IDE project-wide search / replace: pure functions over text (unit-tested in Node) plus a glob filter.
// The browser model (EditorModel.searchProject / replaceProject) feeds them file contents.
(function (root) {
  const MAX_FILE = 1024 * 1024;                 // bytes of text searched per file
  const MAX_PER_FILE = 500, MAX_TOTAL = 2000;   // matches reported
  const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|zip|gz|jar|so|dex|apk|pyc|ttf|otf|woff2?|mp[34]|wav|ogg|pdf|bin|db|npy|npz)$/i;

  const TIMEOUT_MS = 2500;                      // one regex run (a file) may take this long before the guard aborts it
  const MAX_PATTERN = 1000;                     // characters of a regex query

  const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");

  /**
   * Static check for the classic catastrophic shapes: a group that is nothing but one atom with an unbounded
   * repeat, repeated again without bound — (a+)+, (\\w*)*, (.+)*, (?:[ab]+){2,}. Returns a message or "".
   * Other patterns that can still backtrack badly are stopped by the run-time guard (see guard()).
   */
  function riskyRegex(source) {
    if (source.length > MAX_PATTERN) return "表达式太长（上限 " + MAX_PATTERN + " 个字符）";
    const unbounded = q => q === "+" || q === "*" || /^\{\d+,\d*\}$/.test(q) && !/^\{\d+,\d{1,2}\}$/.test(q);
    const quantAt = i => {                       // the quantifier that starts at i, or ""
      const c = source[i];
      if (c === "+" || c === "*") return c;
      if (c === "{") { const m = /^\{\d+(?:,\d*)?\}/.exec(source.slice(i, i + 24)); return m ? m[0] : ""; }
      return "";
    };
    const stack = [];
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") { i++; continue; }
      if (c === "[") { for (i++; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++; continue; }
      if (c === "(") { stack.push(i); continue; }
      if (c === ")") {
        const open = stack.pop(); if (open === undefined) continue;
        let body = source.slice(open + 1, i);
        if (/^\?(?::|<[A-Za-z_]\w*>)/.test(body)) body = body.replace(/^\?(?::|<[A-Za-z_]\w*>)/, "");
        else if (body.startsWith("?")) continue;   // lookaround: not a repeat of its own
        const outer = quantAt(i + 1);
        if (!outer || !unbounded(outer)) continue;
        const single = /^(?:\\.|\[(?:\\.|[^\]\\])*\]|[^()\\|*+?{}\[])(?:[+*]|\{\d+,\d*\})\??$/.exec(body);
        if (single && unbounded(single[0].replace(/^(?:\\.|\[(?:\\.|[^\]\\])*\]|[^()\\|*+?{}\[])/, "").replace(/\?$/, ""))) {
          return "表达式含有嵌套的无限重复（如 (a+)+），可能让浏览器卡死";
        }
      }
    }
    return "";
  }

  /**
   * Build the search RegExp. Throws Error(中文) for an empty query, invalid regex, or one that matches the empty string.
   * Flags: g + m (+ i unless caseSensitive). Literal queries are escaped and use the u flag; regex queries try u first.
   */
  function compile(query, opts = {}) {
    if (!query) throw new Error("请输入要搜索的内容");
    if (opts.regex) { const risk = riskyRegex(query); if (risk) throw new Error(risk); }
    let source = opts.regex ? query : escapeRegExp(query);
    if (opts.word) source = "(?<![\\p{L}\\p{N}_])(?:" + source + ")(?![\\p{L}\\p{N}_])";
    const flags = "gm" + (opts.caseSensitive ? "" : "i");
    let re;
    try { re = new RegExp(source, flags + "u"); }
    catch (e) {
      if (!opts.regex || opts.word) throw new Error("正则表达式无效：" + e.message);
      try { re = new RegExp(source, flags); } catch (e2) { throw new Error("正则表达式无效：" + e2.message); }
    }
    if (new RegExp(re.source, re.flags.replace("g", "")).test("")) throw new Error("表达式不能匹配空字符串");
    return re;
  }

  // Offsets of line starts, for position -> (line, col).
  function lineIndex(text) {
    const starts = [0];
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
    return starts;
  }
  function locate(starts, pos) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return {line: lo + 1, col: pos - starts[lo]};
  }

  /** Matches in `text`: [{line, col, length, index, before, match, after}] (preview parts come from the first line). */
  function find(text, re, limit = MAX_PER_FILE) {
    const out = [], starts = lineIndex(text);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === "") { re.lastIndex++; continue; }
      const {line, col} = locate(starts, m.index);
      const lineEnd = text.indexOf("\n", m.index), end = lineEnd < 0 ? text.length : lineEnd;
      const first = m[0].split("\n")[0];
      const lineText = text.slice(starts[line - 1], end).replace(/\r$/, "");
      const from = Math.max(0, col - 30);
      out.push({line, col, length: m[0].length, index: m.index,
        before: (from > 0 ? "…" : "") + lineText.slice(from, col), match: first.replace(/\r$/, ""), after: lineText.slice(col + first.length, col + first.length + 80)});
      if (out.length >= limit) break;
    }
    return out;
  }

  // $$, $&, $1..$99, $<name> — only in regex mode; literal mode inserts the text as is.
  function expand(template, m) {
    return template.replace(/\$(\$|&|<([A-Za-z_]\w*)>|\d{1,2})/g, (all, tok, name) => {
      if (tok === "$") return "$";
      if (tok === "&") return m[0];
      if (name !== undefined) return (m.groups && m.groups[name]) || "";
      const n = Number(tok);
      return n >= 1 && n < m.length ? (m[n] === undefined ? "" : m[n]) : all;
    });
  }

  /** Replace every non-empty match. Returns {text, count}. */
  function replaceAll(text, re, replacement, opts = {}) {
    let count = 0;
    re.lastIndex = 0;
    const out = text.replace(re, (...args) => {
      const hasGroups = typeof args[args.length - 1] === "object";
      const groups = hasGroups ? args[args.length - 1] : undefined;
      const m = args.slice(0, hasGroups ? -3 : -2); m.index = args[hasGroups ? args.length - 3 : args.length - 2]; m.groups = groups;
      if (m[0] === "") return m[0];
      count++;
      return opts.regex ? expand(replacement, m) : replacement;
    });
    return {text: out, count};
  }

  /** "*.py, lib/**, !tests/**" -> predicate on a project-relative path. Empty -> all. A pattern without "/" matches the file name anywhere. */
  function globFilter(spec) {
    const parts = String(spec || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return () => true;
    const toRe = glob => {
      const anywhere = !glob.includes("/");
      let s = "";
      for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*") { if (glob[i + 1] === "*") { s += ".*"; i++; if (glob[i + 1] === "/") i++; } else s += "[^/]*"; }
        else if (c === "?") s += "[^/]";
        else s += escapeRegExp(c);
      }
      if (glob.endsWith("/")) s += ".*";
      return new RegExp("^" + (anywhere ? "(?:.*/)?" : "") + s + "$");
    };
    const inc = parts.filter(p => !p.startsWith("!")).map(toRe), exc = parts.filter(p => p.startsWith("!")).map(p => toRe(p.slice(1)));
    return path => (!inc.length || inc.some(r => r.test(path))) && !exc.some(r => r.test(path));
  }

  const isSearchable = (path, size) => !BINARY_EXT.test(path) && !(size > MAX_FILE);

  /**
   * Run find / replaceAll with a deadline. Regex mode in a browser executes in a Web Worker that is killed when a
   * single run exceeds [timeoutMs] (catastrophic backtracking cannot freeze the page); everywhere else (literal
   * search, Node tests) it runs inline. Calls are serialised. dispose() ends the worker.
   */
  function guard(opts = {}, timeoutMs = TIMEOUT_MS) {
    const useWorker = !!opts.regex && typeof Worker !== "undefined" && typeof window !== "undefined" && !opts.inline;
    if (!useWorker) {
      return {find: async (text, re, limit) => find(text, re, limit), replaceAll: async (text, re, rep, o) => replaceAll(text, re, rep, o), dispose() {}, worker: false};
    }
    let worker = null, seq = 0, chain = Promise.resolve();
    const run = (msg, re) => new Promise((resolve, reject) => {
      if (!worker) {
        worker = new Worker("/tools/ui/editor-search-worker.js");
      }
      const id = ++seq, w = worker;
      const timer = setTimeout(() => {
        w.terminate(); if (worker === w) worker = null;
        reject(new Error("正则表达式运行超时（超过 " + (timeoutMs / 1000) + " 秒，可能存在灾难性回溯），已中止：" + re.source.slice(0, 60)));
      }, timeoutMs);
      w.onmessage = e => { if (e.data.id !== id) return; clearTimeout(timer); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data); };
      w.onerror = e => { clearTimeout(timer); reject(new Error("搜索线程出错：" + (e.message || "未知错误"))); };
      w.postMessage(Object.assign({id, source: re.source, flags: re.flags}, msg));
    });
    const queue = job => { const p = chain.then(job, job); chain = p.catch(() => {}); return p; };
    return {
      find: (text, re, limit) => queue(() => run({op: "find", text, limit}, re).then(r => r.matches)),
      replaceAll: (text, re, rep, o) => queue(() => run({op: "replace", text, replacement: rep, regex: !!(o && o.regex)}, re).then(r => ({text: r.text, count: r.count}))),
      dispose() { if (worker) { worker.terminate(); worker = null; } },
      worker: true,
    };
  }

  const EditorSearch = {compile, find, replaceAll, expand, globFilter, isSearchable, escapeRegExp, riskyRegex, guard, MAX_FILE, MAX_PER_FILE, MAX_TOTAL, TIMEOUT_MS, MAX_PATTERN};
  if (typeof module !== "undefined" && module.exports) module.exports = { EditorSearch };
  else root.EditorSearch = EditorSearch;
})(typeof window !== "undefined" ? window : globalThis);
