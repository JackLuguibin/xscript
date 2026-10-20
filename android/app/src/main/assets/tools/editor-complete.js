"use strict";
// Web IDE completion for Python: imports, dotted access on xscript/ascript modules and classes, names in
// scope, builtins and keywords. Pure functions over (text, caret) and the XSApi index, so it is unit-tested
// in Node; editor.js only draws the popup. With the XSDocs index (editor-docs.js, from ide/python-stubs) it also
// answers hover docs (symbolAt) and signature help (callAt).
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
    constructor(api, docs) {
      this.modules = (api && api.modules) || {};
      this.docs = docs || {};
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

    // ---- hover docs and signature help (XSDocs) ----

    // Dotted expression -> qualified name in XSDocs ("action.click" -> "xscript.android.action.click"), or null.
    qualify(expr, names) {
      const parts = expr.split(".");
      const cur = names.get(parts[0]);
      let base;
      if (!cur) base = this.docs[parts[0]] ? parts[0] : null;   // a bare top-level package name
      else if (cur.type === "module") base = cur.path;
      else if (cur.type === "member") base = cur.module + "." + cur.name;
      else if (cur.type === "instance") base = cur.cls.module + "." + cur.cls.name;
      if (!base) return null;
      const key = [base, ...parts.slice(1)].join(".");
      return Object.prototype.hasOwnProperty.call(this.docs, key) ? key : null;
    }

    /** Docs for the name under `pos` (the dotted expression up to the end of that word).
     *  @returns {{from:number,to:number,key:string,label:string,sig:string,doc:string}|null} */
    symbolAt(text, pos) {
      if (text.length > MAX_TEXT || pos < 0 || pos > text.length) return null;
      let to = pos; while (to < text.length && IDENT.test(text[to])) to++;
      let from = pos; while (from > 0 && IDENT.test(text[from - 1])) from--;
      if (from === to || /^[0-9]/.test(text.slice(from, to))) return null;
      let start = from;
      while (start > 1 && text[start - 1] === "." && IDENT.test(text[start - 2])) { start--; while (start > 0 && IDENT.test(text[start - 1])) start--; }
      if (inStringOrComment(text, from)) return null;
      const expr = text.slice(start, to);
      const ls = lineStart(text, from), line = text.slice(ls, text.indexOf("\n", from) < 0 ? text.length : text.indexOf("\n", from));
      const names = this.scope(text);
      let key = null;
      const imp = /^\s*(?:from\s+([\w.]+)\s+import\b|import\s)/.exec(line);
      if (imp && from - ls > imp[0].length - 1 && imp[1]) key = this.docs[imp[1] + "." + expr] ? imp[1] + "." + expr : null;   // from m import <name>
      else if (imp || /^\s*from\s+[\w.]*$/.test(text.slice(ls, to))) key = this.docs[expr] ? expr : null;                    // a module path
      else key = this.qualify(expr, names);
      if (!key) return null;
      const [sig, doc] = this.docs[key];
      return {from, to, key, label: key.split(".").pop(), sig, doc};
    }

    /** Signature help: the innermost unclosed call around `pos` whose callee has docs, and which argument the caret is in.
     *  @returns {{key:string,label:string,sig:string,doc:string,open:number,index:number,keyword:string,active:number}|null}
     *  `active` indexes EditorComplete.params(sig) (-1 when no parameter matches). */
    callAt(text, pos) {
      if (text.length > MAX_TEXT || pos < 0 || pos > text.length) return null;
      const stack = [];     // {ch, at, commas, argStart}
      let i = 0;
      while (i < pos) {
        const c = text[i];
        if (c === "#") { const nl = text.indexOf("\n", i); if (nl < 0 || nl >= pos) return null; i = nl + 1; continue; }
        if (c === "'" || c === '"') {
          const triple = text.startsWith(c + c + c, i), q = triple ? c + c + c : c;
          let j = i + q.length;
          for (;;) {
            if (j >= pos) return null;                              // caret inside a string
            if (text[j] === "\\") { j += 2; continue; }
            if (!triple && text[j] === "\n") break;
            if (text.startsWith(q, j)) { j += q.length; break; }
            j++;
          }
          i = j; continue;
        }
        if (c === "(" || c === "[" || c === "{") stack.push({ch: c, at: i, commas: 0, argStart: i + 1});
        else if (c === ")" || c === "]" || c === "}") stack.pop();
        else if (c === "," && stack.length) { const top = stack[stack.length - 1]; top.commas++; top.argStart = i + 1; }
        i++;
      }
      const names = this.scope(text);
      for (let k = stack.length - 1; k >= 0; k--) {
        const f = stack[k];
        if (f.ch !== "(") continue;
        const m = /([A-Za-z_][\w.]*)\s*$/.exec(text.slice(Math.max(0, f.at - 200), f.at));
        const key = m && this.qualify(m[1], names);
        if (!key) continue;                                         // unknown callee (str(...), a local): try the call around it
        const [sig, doc] = this.docs[key];
        const kw = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(k === stack.length - 1 ? text.slice(f.argStart, pos) : text.slice(f.argStart, stack[k + 1].at));
        const params = EditorComplete.params(sig);
        let active = -1;
        if (kw) active = params.findIndex(p => p.name === kw[1]);
        if (active < 0 && !kw) {
          const positional = params.filter(p => p.name && !p.text.startsWith("**") && !p.kwOnly);
          const star = positional.findIndex(p => p.text.startsWith("*"));
          const p = star >= 0 && f.commas >= star ? positional[star] : positional[f.commas];
          active = p ? params.indexOf(p) : -1;
        }
        return {key, label: key.split(".").pop(), sig, doc, open: f.at, index: f.commas, keyword: kw ? kw[1] : "", active};
      }
      return null;
    }
  }

  /** Split "(x, y=(1, 2), *a, dur=20) -> R" into parameters with offsets into the string, for highlighting.
   *  Bare "*" and "/" markers are kept (name "") so offsets stay exact; parameters after "*" are kwOnly. */
  EditorComplete.params = function (sig) {
    const out = []; if (!sig || sig[0] !== "(") return out;
    let depth = 0, start = 1, kwOnly = false, quote = "";
    for (let i = 1; i < sig.length; i++) {
      const c = sig[i];
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
      else if ((c === "," || c === ")") && depth === 0) {
        const raw = sig.slice(start, i), lead = raw.length - raw.trimStart().length, text = raw.trim();
        if (text) {
          const name = (/^\*{0,2}([A-Za-z_]\w*)/.exec(text) || [])[1] || "";
          out.push({text, name, start: start + lead, end: start + lead + text.length, kwOnly: kwOnly && !text.startsWith("**")});
          if (text === "*" || (text.startsWith("*") && !text.startsWith("**"))) kwOnly = true;
        }
        start = i + 1;
        if (c === ")") break;
      }
    }
    return out;
  };

  EditorComplete.inStringOrComment = inStringOrComment;
  EditorComplete.KEYWORDS = KEYWORDS;
  EditorComplete.BUILTINS = BUILTINS;
  if (typeof module !== "undefined" && module.exports) module.exports = { EditorComplete };
  else root.EditorComplete = EditorComplete;
})(typeof window !== "undefined" ? window : globalThis);
