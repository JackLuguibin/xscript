"use strict";
// Web IDE completion for Python: imports, dotted access on xscript/ascript modules and classes, names in
// scope, builtins and keywords. Pure functions over (text, caret) and the XSApi index, so it is unit-tested
// in Node; editor.js only draws the popup.
(function (root) {
  const KEYWORDS = ("False None True and as assert async await break class continue def del elif else except finally for from " +
    "global if import in is lambda nonlocal not or pass raise return try while with yield").split(" ");
  const BUILTINS = ("abs all any bin bool bytearray bytes callable chr dict dir divmod enumerate filter float format frozenset " +
    "getattr globals hasattr hash hex id input int isinstance issubclass iter len list locals map max min next object oct open " +
    "ord pow print range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip " +
    "Exception ValueError TypeError KeyError IndexError RuntimeError OSError ImportError AttributeError StopIteration " +
    "TimeoutError NotImplementedError ZeroDivisionError AssertionError NameError").split(" ");
  const IDENT = /[A-Za-z_\u0080-\uffff0-9]/;
  const MAX_TEXT = 400000;

  // Is `pos` inside a string literal or a comment? A forward scan that understands triple quotes and prefixes.
  function inStringOrComment(text, pos) {
    let i = 0;
    while (i < pos) {
      const c = text[i];
      if (c === "#") { const nl = text.indexOf("\n", i); if (nl < 0 || nl >= pos) return true; i = nl + 1; continue; }
      if (c === "'" || c === '"') {
        const triple = text.startsWith(c + c + c, i);
        const q = triple ? c + c + c : c;
        let j = i + q.length;
        for (;;) {
          if (j >= pos) return true;
          if (text[j] === "\\") { j += 2; continue; }
          if (!triple && text[j] === "\n") break;                // unterminated single-line string ends at the newline
          if (text.startsWith(q, j)) { j += q.length; break; }
          j++;
        }
        i = j; continue;
      }
      i++;
    }
    return false;
  }

  function lineStart(text, pos) { return text.lastIndexOf("\n", pos - 1) + 1; }

  class EditorComplete {
    constructor(api) {
      this.modules = (api && api.modules) || {};
      this.topLevel = [...new Set(Object.keys(this.modules).map(k => k.split(".")[0]))];
    }

    // name -> {type: "module", path} | {type: "member", module, name} | {type: "local", kind}
    scope(text) {
      const names = new Map();
      const bindModule = (name, path) => names.set(name, {type: "module", path});
      const member = (path, name, alias) => {
        const full = path + "." + name;
        if (this.modules[full]) return bindModule(alias || name, full);
        const m = this.modules[path] && this.modules[path].m[name];
        names.set(alias || name, {type: "member", module: path, name, kind: m ? m.k : "v"});
      };
      for (const raw of text.split("\n")) {
        const line = raw.replace(/#.*$/, "").trim();
        let m = /^import\s+(.+)$/.exec(line);
        if (m) {
          for (const part of m[1].split(",")) {
            const mm = /^([\w.]+)(?:\s+as\s+(\w+))?$/.exec(part.trim());
            if (!mm) continue;
            if (mm[2]) bindModule(mm[2], mm[1]); else bindModule(mm[1].split(".")[0], mm[1].split(".")[0]);
          }
          continue;
        }
        m = /^from\s+([\w.]+)\s+import\s+\(?\s*([^)]*)\)?$/.exec(line);
        if (m) {
          for (const part of m[2].split(",")) {
            const mm = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(part.trim());
            if (mm) member(m[1], mm[1], mm[2]);
          }
          continue;
        }
        m = /^(?:async\s+)?def\s+(\w+)/.exec(line);
        if (m) { names.set(m[1], {type: "local", kind: "f"}); continue; }
        m = /^class\s+(\w+)/.exec(line);
        if (m) { names.set(m[1], {type: "local", kind: "c"}); continue; }
        // x = SomeClass(...)  where SomeClass resolves to a known class: remember the instance type.
        m = /^(\w+)\s*=\s*([\w.]+)\s*\(/.exec(line);
        if (m && !names.has(m[1])) {
          const target = this.resolve(m[2], names);
          if (target && target.type === "class") names.set(m[1], {type: "instance", cls: target});
          else names.set(m[1], {type: "local", kind: "v"});
          continue;
        }
        m = /^(\w+)\s*=/.exec(line);
        if (m && !names.has(m[1])) names.set(m[1], {type: "local", kind: "v"});
        m = /^for\s+(\w+)\s+in\b/.exec(line);
        if (m && !names.has(m[1])) names.set(m[1], {type: "local", kind: "v"});
      }
      return names;
    }

    // Dotted expression ("action", "xscript.android.action", "FindImages") -> module or class descriptor.
    resolve(expr, names) {
      const parts = expr.split(".");
      let cur = names.get(parts[0]);
      if (!cur) return null;
      let node = null;
      if (cur.type === "module") node = {type: "module", path: cur.path};
      else if (cur.type === "member" && cur.kind === "c") node = {type: "class", module: cur.module, name: cur.name};
      else if (cur.type === "instance") node = {type: "instance", cls: cur.cls};
      else return null;
      for (const part of parts.slice(1)) {
        if (node.type === "module") {
          const sub = node.path + "." + part;
          if (this.modules[sub]) { node = {type: "module", path: sub}; continue; }
          const m = this.modules[node.path] && this.modules[node.path].m[part];
          if (m && m.k === "c") { node = {type: "class", module: node.path, name: part}; continue; }
          return null;
        }
        return null;
      }
      return node;
    }

    // Members offered after "<expr>.".
    membersOf(node) {
      if (node.type === "module") {
        const mod = this.modules[node.path];
        return mod ? Object.entries(mod.m).map(([name, m]) => ({label: name, kind: m.k, detail: m.s || "", doc: m.d || ""})) : [];
      }
      const cls = node.type === "instance" ? node.cls : node;
      const entry = this.modules[cls.module] && this.modules[cls.module].m[cls.name];
      if (!entry || !entry.m) return [];
      return Object.entries(entry.m).map(([name, m]) => ({label: name, kind: m.k === "f" ? "f" : m.k, detail: m.s || "", doc: m.d || ""}));
    }

    /**
     * Suggestions at caret `pos`.
     * @returns {{from:number,to:number,items:Array}|null}  `from..to` is the word to replace.
     */
    suggest(text, pos, opts = {}) {
      if (text.length > MAX_TEXT || pos < 0 || pos > text.length) return null;
      if (inStringOrComment(text, pos)) return null;
      let from = pos;
      while (from > 0 && IDENT.test(text[from - 1])) from--;
      const prefix = text.slice(from, pos);
      if (/^[0-9]/.test(prefix)) return null;                  // a number literal, not a name
      const ls = lineStart(text, pos);
      const before = text.slice(ls, from);
      const names = this.scope(text);
      let items = [];

      let m = /^\s*import\s+(?:[\w.\s,]*,\s*)?([\w.]*)$/.exec(before);
      if (m) {                                                   // import xscript.android.<here>
        items = this.moduleNames(m[1]);
      } else if ((m = /^\s*from\s+([\w.]*)$/.exec(before))) {  // from xscript.<here>
        items = this.moduleNames(m[1]);
      } else if ((m = /^\s*from\s+([\w.]+)\s+import\s+(?:\(?[\w\s,]*,\s*)?$/.exec(before))) {
        const mod = this.modules[m[1]];                           // from xscript.android.action import <here>
        items = mod ? this.membersOf({type: "module", path: m[1]}) : [];
      } else if ((m = /([A-Za-z_][\w.]*)\.$/.exec(before))) {  // expr.<here>
        const node = this.resolve(m[1], names);
        if (!node) return null;
        items = this.membersOf(node);
      } else if (/\.\s*$/.test(before) || /[)\]}"']\s*\.$/.test(before)) {
        return null;                                             // attribute of an unknown value
      } else {
        if (!prefix && !opts.force) return null;
        if (prefix.length < (opts.minPrefix === undefined ? 2 : opts.minPrefix) && !opts.force) return null;
        const seen = new Set();
        const add = (label, kind, detail = "", doc = "") => { if (!seen.has(label)) { seen.add(label); items.push({label, kind, detail, doc}); } };
        for (const [name, d] of names) {
          if (d.type === "module") add(name, "m");
          else if (d.type === "member") { const e = this.modules[d.module] && this.modules[d.module].m[d.name]; add(name, d.kind, e && e.s || "", e && e.d || ""); }
          else if (d.type === "instance") add(name, "v");
          else add(name, d.kind);
        }
        for (const k of this.topLevel) add(k, "m");
        for (const k of KEYWORDS) add(k, "k");
        for (const k of BUILTINS) add(k, /^[A-Z]/.test(k) ? "c" : "f");
        for (const k of text.matchAll(/[A-Za-z_][A-Za-z_0-9]{2,}/g)) if (k.index + k[0].length !== pos) add(k[0], "w");   // words in the file
      }
      const needle = prefix.toLowerCase();
      items = items.filter(i => i.label.toLowerCase().includes(needle) && i.label !== prefix)
        .map(i => {
          const l = i.label.toLowerCase();
          const rank = l.startsWith(needle) ? 0 : 1;
          const kindRank = {c: 0, f: 0, m: 0, v: 1, k: 2, w: 3}[i.kind] ?? 1;
          return {...i, rank: rank * 10 + kindRank};
        })
        .sort((a, b) => a.rank - b.rank || a.label.length - b.label.length || (a.label < b.label ? -1 : 1))
        .slice(0, 60);
      if (!items.length) return null;
      return {from, to: pos, items};
    }

    // Next dotted segment of known modules below `typed` ("xscript.an" -> "xscript.android").
    moduleNames(typed) {
      const dot = typed.lastIndexOf(".");
      const parent = dot < 0 ? "" : typed.slice(0, dot);
      const out = new Map();
      for (const path of Object.keys(this.modules)) {
        if (parent) { if (!path.startsWith(parent + ".")) continue; }
        const rest = parent ? path.slice(parent.length + 1) : path;
        const seg = rest.split(".")[0];
        out.set(seg, (this.modules[parent ? parent + "." + seg : seg] || {}).d || "");
      }
      return [...out].map(([label, doc]) => ({label, kind: "m", detail: "", doc}));
    }
  }

  EditorComplete.inStringOrComment = inStringOrComment;
  EditorComplete.KEYWORDS = KEYWORDS;
  EditorComplete.BUILTINS = BUILTINS;
  if (typeof module !== "undefined" && module.exports) module.exports = { EditorComplete };
  else root.EditorComplete = EditorComplete;
})(typeof window !== "undefined" ? window : globalThis);
