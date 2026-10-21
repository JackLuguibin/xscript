"use strict";
// Project symbol table for the Web IDE: scopes, definitions and name occurrences of every Python file (from the
// EditorParse AST), with Python's lookup rules (function -> enclosing functions -> module, class bodies not visible
// from methods, global/nonlocal), imports between project modules, `self.x` members, base classes and `x = C()`
// instances. Powers go to definition (F12) and find references (Shift+F12). Library modules resolve to their
// XSDocs key (stub signature and docs). Pure functions; Node-testable.
(function (root) {
  const P = root.EditorParse || (typeof require === "function" ? require("./editor-parse.js").EditorParse : null);
  const MAX_FILE = 400000, MAX_HOPS = 8;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /** "pkg/mod.py" -> "pkg.mod", "pkg/__init__.py" -> "pkg"; null for non-Python files. */
  function moduleName(path) {
    if (!/\.py$/.test(path)) return null;
    const parts = path.replace(/\.py$/, "").split("/");
    if (parts.length > 1 && parts[parts.length - 1] === "__init__") parts.pop();
    return parts.join(".");
  }

  const PY_KEYWORDS = new Set(("False None True and as assert async await break class continue def del elif else except finally for " +
    "from global if import in is lambda nonlocal not or pass raise return try while with yield").split(" "));

  class Scope {
    constructor(kind, name, parent, file, node) {
      this.kind = kind; this.name = name; this.parent = parent; this.file = file; this.node = node;
      this.defs = new Map(); this.globals = new Set(); this.nonlocals = new Set();
      this.id = file.scopes.length; file.scopes.push(this);
    }
    add(name, def) { def.scope = this; def.name = name; if (!this.defs.has(name)) this.defs.set(name, []); this.defs.get(name).push(def); return def; }
  }

  // ---- indexing one file ----
  function indexFile(path, text) {
    const file = { path, module: moduleName(path), text, scopes: [], occ: [], lines: null };
    const parsed = text.length > MAX_FILE ? { ast: { body: [] } } : P.parse(text);
    const mod = file.root = new Scope("module", file.module, null, file, parsed.ast);
    const isPkg = /(^|\/)__init__\.py$/.test(path);
    const pkgOf = (level) => { const parts = (file.module || "").split(".").filter(Boolean); const keep = parts.length - level + (isPkg ? 1 : 0); return keep < 0 ? null : parts.slice(0, keep).join("."); };
    const occ = (name, line, col, scope, kind, extra) => file.occ.push(Object.assign({ name, line, col, scope, kind }, extra));
    const bindScope = (scope, name) => {
      if (scope.globals.has(name)) return mod;
      if (scope.nonlocals.has(name)) { for (let s = scope.parent; s; s = s.parent) if (s.kind === "function" && s.defs.has(name)) return s; }
      return scope;
    };
    const kids = (n, scope) => { for (const k in n) { if (k === "type" || k === "scope") continue; const v = n[k]; if (v && typeof v === "object") visit(v, scope); } };
    function visit(n, scope) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { for (const x of n) visit(x, scope); return; }
      switch (n.type) {
        case "Name":
          if (n.ctx === "store") bindScope(scope, n.id).add(n.id, { kind: "variable", line: n.line, col: n.col });
          occ(n.id, n.line, n.col, scope, n.ctx === "store" ? "def" : "name");
          return;
        case "Attribute":
          visit(n.value, scope);
          occ(n.attr, n.line, n.col, scope, "attr", { base: n.value });
          if (n.ctx === "store" && n.value.type === "Name" && scope.kind === "function" && scope.parent.kind === "class" && scope.firstParam === n.value.id)
            scope.parent.add(n.attr, { kind: "attribute", line: n.line, col: n.col });
          return;
        case "FunctionDef": case "ClassDef": {
          visit(n.decorators, scope);
          const isFn = n.type === "FunctionDef";
          if (isFn) { for (const a of n.args) { visit(a.default, scope); visit(a.annotation, scope); } visit(n.returns, scope); }
          else { visit(n.bases, scope); visit(n.keywords, scope); }
          const d = bindScope(scope, n.name).add(n.name, { kind: isFn ? "function" : "class", line: n.nameLine, col: n.nameCol, node: n });
          occ(n.name, n.nameLine, n.nameCol, scope, "def");
          const inner = d.inner = new Scope(isFn ? "function" : "class", n.name, scope, file, n);
          if (isFn) {
            for (const a of n.args) { inner.add(a.arg, { kind: "parameter", line: a.line, col: a.col }); occ(a.arg, a.line, a.col, inner, "def"); }
            const first = n.args.find(a => a.kind === "arg");
            if (scope.kind === "class" && first) inner.firstParam = first.arg;
          }
          visit(n.body, inner);
          return;
        }
        case "Lambda": {
          for (const a of n.args) visit(a.default, scope);
          const inner = new Scope("function", "<lambda>", scope, file, n);
          for (const a of n.args) { inner.add(a.arg, { kind: "parameter", line: a.line, col: a.col }); occ(a.arg, a.line, a.col, inner, "def"); }
          visit(n.body, inner); return;
        }
        case "ListComp": case "SetComp": case "DictComp": case "GeneratorExp": {
          const g = n.generators; visit(g[0].iter, scope);
          const inner = new Scope("comp", "<comp>", scope, file, n);
          g.forEach((c, i) => { visit(c.target, inner); if (i) visit(c.iter, inner); visit(c.ifs, inner); });
          visit(n.elt, inner); visit(n.key, inner); visit(n.value, inner); return;
        }
        case "NamedExpr": {
          let s = scope; while (s.kind === "comp") s = s.parent;
          visit(n.value, scope); visit(n.target, s); return;
        }
        case "Global": case "Nonlocal":
          for (const x of n.names) { (n.type === "Global" ? scope.globals : scope.nonlocals).add(x.id); occ(x.id, x.line, x.col, scope, "name"); }
          return;
        case "Assign":
          visit(n.value, scope); visit(n.targets, scope);
          for (const t of n.targets) if (t.type === "Name") { const ds = bindScope(scope, t.id).defs.get(t.id); if (ds) ds[ds.length - 1].value = n.value; }
          return;
        case "Import":
          for (const a of n.names) {
            const local = a.asname || a.name.split(".")[0];
            bindScope(scope, local).add(local, { kind: "import", line: a.bindLine, col: a.bindCol, imp: { module: a.asname ? a.name : local } });
            if (a.asname) occ(a.asname, a.bindLine, a.bindCol, scope, "def");
            let col = a.col; const parts = a.name.split(".");
            parts.forEach((p, i) => { occ(p, a.line, col, scope, "module", { module: parts.slice(0, i + 1).join(".") }); col += p.length + 1; });
          }
          return;
        case "ImportFrom": {
          const base = n.level ? pkgOf(n.level) : "";
          const from = n.level ? (base === null ? null : [base, n.module].filter(Boolean).join(".")) : n.module;
          for (const a of n.names) {
            if (a.name === "*") { scope.star = scope.star || []; if (from !== null) scope.star.push(from); continue; }
            const local = a.asname || a.name;
            bindScope(scope, local).add(local, { kind: "import", line: a.bindLine, col: a.bindCol, imp: { module: from, name: a.name } });
            occ(a.name, a.line, a.col, scope, "import", { module: from, imported: a.name });
            if (a.asname) occ(a.asname, a.bindLine, a.bindCol, scope, "def");
          }
          return;
        }
        default: kids(n, scope);
      }
    }
    visit(parsed.ast.body, mod);
    return file;
  }

  // ---- project-wide resolution ----
  class Project {
    constructor(files, docs) {
      this.docs = docs || null; this.files = new Map(); this.modules = new Map();
      for (const f of files || []) {
        if (!/\.py$/.test(f.path) || typeof f.content !== "string") continue;
        const idx = indexFile(f.path, f.content); this.files.set(f.path, idx); this.modules.set(idx.module, idx);
      }
    }
    lib(key) { return !this.docs ? { library: key } : has(this.docs, key) ? { library: key } : null; }
    moduleSym(name) { const m = this.modules.get(name); return m ? { module: m } : this.lib(name); }
    // Symbol for `name` looked up from `scope` (Python LEGB, class bodies skipped for nested scopes).
    lookup(scope, name, hops) {
      if (scope.globals.has(name)) scope = scope.file.root;
      for (let s = scope, first = true; s; s = s.parent, first = false) {
        if (s.kind === "class" && !first) continue;
        if (s.defs.has(name)) return this.follow({ scope: s, name }, hops);
        if (s.star) for (const m of s.star) { const r = this.member({ module: this.modules.get(m) }, name, hops); if (r) return r; }
      }
      return null;
    }
    defs(sym) { return sym.scope.defs.get(sym.name) || []; }
    // Through imports to the symbol they bind.
    follow(sym, hops) {
      hops = (hops || 0) + 1; if (hops > MAX_HOPS) return sym;
      const ds = this.defs(sym), imp = ds.length && ds.every(d => d.kind === "import") ? ds[0].imp : null;
      if (!imp) return sym;
      if (imp.module === null) return null;
      if (imp.name === undefined) return this.moduleSym(imp.module);
      const m = this.modules.get(imp.module);
      if (m) return this.member({ module: m }, imp.name, hops) || this.moduleSym(imp.module + "." + imp.name);
      return this.modules.get(imp.module + "." + imp.name) ? this.moduleSym(imp.module + "." + imp.name) : this.lib(imp.module + "." + imp.name);
    }
    // What an expression evaluates to: {module}, {cls: scope} (class or its instance), {library: key} or null.
    valueOf(e, scope, hops) {
      hops = (hops || 0) + 1; if (!e || hops > MAX_HOPS) return null;
      if (e.type === "Name") {
        if (scope.kind === "function" && scope.parent && scope.parent.kind === "class" && scope.firstParam === e.id && !this.defs({ scope, name: e.id }).some(d => d.kind !== "parameter")) return { cls: scope.parent };
        return this.symValue(this.lookup(scope, e.id, hops), hops);
      }
      if (e.type === "Attribute") return this.symValue(this.member(this.valueOf(e.value, scope, hops), e.attr, hops), hops);
      if (e.type === "Call") { const v = this.valueOf(e.func, scope, hops); return v && v.cls ? v : v && v.library ? v : null; }
      return null;
    }
    symValue(sym, hops) {
      if (!sym || sym.module || sym.library) return sym;
      const ds = this.defs(sym);
      const c = ds.find(d => d.kind === "class"); if (c) return { cls: c.inner };
      const v = ds.find(d => d.value); if (v) return this.valueOf(v.value, sym.scope, hops);
      return null;
    }
    member(v, attr, hops) {
      hops = (hops || 0) + 1; if (!v || hops > MAX_HOPS) return null;
      if (v.module) {
        if (v.module.root.defs.has(attr)) return this.follow({ scope: v.module.root, name: attr }, hops);
        const sub = this.modules.get(v.module.module + "." + attr); return sub ? { module: sub } : null;
      }
      if (v.library) return this.lib(v.library + "." + attr);
      if (v.cls) {
        if (v.cls.defs.has(attr)) return { scope: v.cls, name: attr };
        for (const b of v.cls.node.bases || []) { const r = this.member(this.valueOf(b, v.cls.parent, hops), attr, hops); if (r) return r; }
      }
      return null;
    }
    occurrenceAt(path, line, col) {
      const f = this.files.get(path); if (!f) return null;
      return f.occ.find(o => o.line === line && col >= o.col && col <= o.col + o.name.length) || null;
    }
    resolveOcc(o) {
      if (o.kind === "module") return this.moduleSym(o.module);
      if (o.kind === "import") { if (o.module === null) return null; const m = this.modules.get(o.module); return m ? this.member({ module: m }, o.imported) || this.moduleSym(o.module + "." + o.imported) : this.modules.get(o.module + "." + o.imported) ? this.moduleSym(o.module + "." + o.imported) : this.lib(o.module + "." + o.imported); }
      if (o.kind === "attr") return this.member(this.valueOf(o.base, o.scope), o.name);
      return this.lookup(o.scope, o.name);
    }
    key(sym) { return !sym ? null : sym.module ? "m:" + sym.module.path : sym.library ? "l:" + sym.library : "s:" + sym.scope.file.path + "#" + sym.scope.id + ":" + sym.name; }
    location(sym) {
      if (sym.module) return { path: sym.module.path, line: 1, col: 0, name: sym.module.module, kind: "module" };
      if (sym.library) return { library: sym.library };
      const ds = this.defs(sym).filter(d => d.kind !== "import"), all = ds.length ? ds : this.defs(sym);
      const d = all[0];   // the first binding, like "def"/"class"/the first assignment
      return { path: sym.scope.file.path, line: d.line, col: d.col, name: sym.name, kind: d.kind };
    }
    /** Definition of the name at (path, 1-based line, 0-based col): {path,line,col,name,kind} | {library:key} | null. */
    definitionAt(path, line, col) {
      const o = this.occurrenceAt(path, line, col); if (!o) return null;
      const sym = this.resolveOcc(o); return sym ? this.location(sym) : null;
    }
    /** Every occurrence in the project that resolves to the same symbol: {name, refs:[{path,line,col,length,text,def}]}. */
    referencesAt(path, line, col) {
      const o = this.occurrenceAt(path, line, col); if (!o) return null;
      const want = this.key(this.resolveOcc(o)); if (!want) return null;
      const refs = [];
      for (const f of this.files.values()) {
        for (const x of f.occ) {
          if (this.key(this.resolveOcc(x)) !== want) continue;
          f.lines = f.lines || f.text.split("\n");
          refs.push({ path: f.path, line: x.line, col: x.col, length: x.name.length, text: (f.lines[x.line - 1] || "").trim(), def: x.kind === "def" });
        }
      }
      refs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.col - b.col);
      return { name: o.name, refs };
    }
    /**
     * Rename the project symbol at (path, line, col). Without `newName` only checks it can be renamed: {name} | {error}.
     * With it: {name, newName, edits:[{path,line,col,length}], files} | {error}. Every occurrence that resolves to the
     * same symbol and is spelled like it is edited (import lines included); `as` aliases keep their own name.
     */
    renameAt(path, line, col, newName) {
      const o = this.occurrenceAt(path, line, col); if (!o) return { error: "光标处没有可重命名的名字" };
      const sym = this.resolveOcc(o);
      if (!sym) return { error: "找不到 " + o.name + " 的定义，不能重命名" };
      if (sym.library) return { error: "库符号 " + sym.library + " 不能重命名" };
      if (sym.module) return { error: "模块名不能在这里重命名（请重命名文件）" };
      const name = sym.name;
      if (newName === undefined) return { name };
      if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(newName) || PY_KEYWORDS.has(newName)) return { error: "“" + newName + "”不是合法的 Python 名字" };
      if (newName === name) return { error: "新名字和原来一样" };
      if (sym.scope.defs.has(newName)) return { error: newName + " 在同一作用域里已经有定义，重命名会冲突" };
      const want = this.key(sym), edits = [], files = new Set();
      for (const f of this.files.values()) {
        for (const x of f.occ) {
          if (x.name !== name || this.key(this.resolveOcc(x)) !== want) continue;
          edits.push({ path: f.path, line: x.line, col: x.col, length: name.length }); files.add(f.path);
        }
      }
      edits.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.col - b.col);
      return { name, newName, edits, files: files.size };
    }
  }

  const EditorSymbols = { moduleName, indexFile, build: (files, docs) => new Project(files, docs) };
  if (typeof module !== "undefined" && module.exports) module.exports = { EditorSymbols };
  else root.EditorSymbols = EditorSymbols;
})(typeof window !== "undefined" ? window : globalThis);
