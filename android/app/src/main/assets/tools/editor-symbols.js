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

  const BUILTIN_TYPES = { int: "int", float: "float", str: "str", bytes: "bytes", bool: "bool", list: "list", dict: "dict", set: "set",
    tuple: "tuple", frozenset: "frozenset", len: "int", range: "range", sorted: "list", repr: "str", round: "int", abs: null,
    input: "str", open: "file", enumerate: "enumerate", zip: "zip", chr: "str", ord: "int", hex: "str", bin: "str", format: "str" };
  // Short source-like text of an expression for signatures (defaults, annotations, bases).
  function show(e, depth) {
    depth = (depth || 0) + 1; if (!e) return ""; if (depth > 6) return "…";
    const list = (xs, o, c) => { const s = (xs || []).map(x => show(x, depth)); const t = s.join(", "); return o + (t.length > 24 ? s[0] + ", …" : t) + c; };
    switch (e.type) {
      case "Name": return e.id;
      case "Attribute": return show(e.value, depth) + "." + e.attr;
      case "Constant": return String(e.value).length > 24 ? String(e.value).slice(0, 20) + "…" + String(e.value).slice(-1) : String(e.value);
      case "JoinedStr": return e.value.length > 24 ? e.value.slice(0, 20) + "…" + e.value.slice(-1) : e.value;
      case "Subscript": return show(e.value, depth) + "[" + (Array.isArray(e.slice) ? e.slice.map(x => show(x, depth)).join(", ") : show(e.slice, depth)) + "]";
      case "List": return list(e.elts, "[", "]");
      case "Tuple": return list(e.elts, "(", (e.elts || []).length === 1 ? ",)" : ")");
      case "Set": return list(e.elts, "{", "}");
      case "Dict": return (e.keys || []).length ? "{…}" : "{}";
      case "UnaryOp": return (e.op === "not" ? "not " : e.op) + show(e.operand, depth);
      case "Call": return show(e.func, depth) + "(…)";
      case "BinOp": return show(e.left, depth) + " " + e.op + " " + show(e.right, depth);
      default: return "…";
    }
  }
  // The docstring of a module, class or function node (first statement a string), shortened for a tooltip.
  function docstring(n) {
    const first = n && Array.isArray(n.body) ? n.body[0] : null;
    if (!first || first.type !== "Expr" || !first.value || first.value.type !== "Constant" || first.value.kind !== "string") return "";
    const raw = first.value.value.replace(/^[a-zA-Z]*("""|'''|"|')/, "").replace(/("""|'''|"|')$/, "");
    const lines = raw.split("\n"), ind = Math.min(...lines.slice(1).filter(l => l.trim()).map(l => l.match(/^ */)[0].length), 99);
    const text = [lines[0].trim(), ...lines.slice(1).map(l => l.slice(Math.min(ind, 99)))].join("\n").trim();
    return text.length > 400 ? text.slice(0, 399) + "…" : text;
  }
  const PY_KEYWORDS = new Set(("False None True and as assert async await break class continue def del elif else except finally for " +
    "from global if import in is lambda nonlocal not or pass raise return try while with yield").split(" "));

  const BUILTINS = new Set(("ArithmeticError AssertionError AttributeError BaseException BaseExceptionGroup BlockingIOError BrokenPipeError " +
    "BufferError BytesWarning ChildProcessError ConnectionAbortedError ConnectionError ConnectionRefusedError ConnectionResetError " +
    "DeprecationWarning EOFError Ellipsis EncodingWarning EnvironmentError Exception ExceptionGroup False FileExistsError FileNotFoundError " +
    "FloatingPointError FutureWarning GeneratorExit IOError ImportError ImportWarning IndentationError IndexError InterruptedError " +
    "IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError None NotADirectoryError " +
    "NotImplemented NotImplementedError OSError OverflowError PendingDeprecationWarning PermissionError ProcessLookupError " +
    "PythonFinalizationError RecursionError ReferenceError ResourceWarning RuntimeError RuntimeWarning StopAsyncIteration StopIteration " +
    "SyntaxError SyntaxWarning SystemError SystemExit TabError TimeoutError True TypeError UnboundLocalError UnicodeDecodeError " +
    "UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning UserWarning ValueError Warning ZeroDivisionError " +
    "abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex copyright credits " +
    "delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr globals hasattr hash help hex id input int " +
    "isinstance issubclass iter len license list locals map max memoryview min next object oct open ord pow print property quit range " +
    "repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip " +
    "__name__ __file__ __doc__ __spec__ __loader__ __package__ __path__ __builtins__ __debug__ __import__ __build_class__ __annotations__ __dict__ __class__").split(" "));

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
    const file = { path, module: moduleName(path), text, scopes: [], occ: [], calls: [], lines: null };
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
          occ(n.attr, n.line, n.col, scope, "attr", { base: n.value, store: n.ctx === "store" || n.ctx === "del" });
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
          for (const t of n.targets) {
            if (t.type === "Name") { const ds = bindScope(scope, t.id).defs.get(t.id); if (ds) Object.assign(ds[ds.length - 1], { value: n.value, valueScope: scope }); }
            else if (t.type === "Attribute" && t.value.type === "Name" && scope.kind === "function" && scope.parent.kind === "class" && scope.firstParam === t.value.id) {
              const ds = scope.parent.defs.get(t.attr); if (ds) Object.assign(ds[ds.length - 1], { value: n.value, valueScope: scope });
            }
          }
          return;
        case "AnnAssign": {
          visit(n.annotation, scope); visit(n.value, scope); visit(n.target, scope);
          const t = n.target, ds = t.type === "Name" ? bindScope(scope, t.id).defs.get(t.id)
            : t.type === "Attribute" && t.value.type === "Name" && scope.kind === "function" && scope.parent.kind === "class" && scope.firstParam === t.value.id ? scope.parent.defs.get(t.attr) : null;
          if (ds) Object.assign(ds[ds.length - 1], { annotation: n.annotation, value: n.value || undefined, valueScope: scope });
          return;
        }
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
        case "Call": file.calls.push({ node: n, scope }); kids(n, scope); return;
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
      const v = ds.find(d => d.value); if (v) return this.valueOf(v.value, v.valueScope || sym.scope, hops);
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
    /**
     * Hover text for a project symbol at (path, line, col): {name, head, where, doc} or null (library symbols and
     * unknown names are left to the library hover). `head` is a signature or "name: type" with an inferred type.
     */
    describeAt(path, line, col) {
      const o = this.occurrenceAt(path, line, col); if (!o) return null;
      const sym = this.resolveOcc(o);
      if (!sym || sym.library) return null;
      if (sym.module) return { name: sym.module.module, head: "module " + sym.module.module, where: sym.module.path, doc: docstring(sym.module.root.node) };
      const all = this.defs(sym), ds = all.filter(d => d.kind !== "import"), d = ds[0] || all[0]; if (!d) return null;
      const scope = sym.scope, owner = scope.kind === "class" ? scope.name + "." : "", where = scope.file.path + ":" + d.line;
      if (d.kind === "function") {
        const n = d.node, params = n.args.map(a => (a.kind === "vararg" ? "*" : a.kind === "kwarg" ? "**" : "") + a.arg +
          (a.annotation ? ": " + show(a.annotation) : "") + (a.default ? (a.annotation ? " = " : "=") + show(a.default) : ""));
        return { name: sym.name, head: (n.isAsync ? "async def " : "def ") + owner + sym.name + "(" + params.join(", ") + ")" + (n.returns ? " -> " + show(n.returns) : ""), where, doc: docstring(n) };
      }
      if (d.kind === "class") {
        const n = d.node, bases = (n.bases || []).map(show);
        return { name: sym.name, head: "class " + sym.name + (bases.length ? "(" + bases.join(", ") + ")" : ""), where, doc: docstring(n) };
      }
      if (d.kind === "parameter") {
        const a = this.param(sym), t = this.paramType(sym);
        return { name: sym.name, head: "(参数) " + (a && a.kind === "vararg" ? "*" : a && a.kind === "kwarg" ? "**" : "") + sym.name + (t ? ": " + t : "") + (a && a.default ? " = " + show(a.default) : ""), where, doc: "" };
      }
      const label = d.kind === "attribute" ? "(属性) " + owner : "(变量) ";
      const typed = ds.find(x => x.annotation), valued = ds.find(x => x.value);
      const t = typed ? show(typed.annotation) : valued ? this.typeOf(valued.value, valued.valueScope || scope) : null;
      return { name: sym.name, head: label + sym.name + (t ? ": " + t : ""), where, doc: "" };
    }
    param(sym) { return sym.scope.node && (sym.scope.node.args || []).find(x => x.arg === sym.name) || null; }
    paramType(sym) {
      const a = this.param(sym); if (!a) return null;
      if (a.annotation) return show(a.annotation);
      if (a.kind === "vararg") return "tuple"; if (a.kind === "kwarg") return "dict";
      const t = a.default ? this.typeOf(a.default, sym.scope.parent) : null;
      return t === "None" ? null : t;
    }
    /** A short inferred type for expression `e` evaluated in `scope`: "int", "list", a project class name, a library key, or null. */
    typeOf(e, scope, depth) {
      depth = (depth || 0) + 1; if (!e || depth > MAX_HOPS) return null;
      switch (e.type) {
        case "Constant":
          if (e.kind === "number") return /j$/i.test(e.value) ? "complex" : /^0[xob]/i.test(e.value) ? "int" : /[.eE]/.test(e.value) ? "float" : "int";
          if (e.kind === "string") return /^[a-zA-Z]*[bB]/.test(e.value) ? "bytes" : "str";
          return e.value === "None" ? "None" : e.value === "True" || e.value === "False" ? "bool" : e.value === "..." ? "ellipsis" : null;
        case "JoinedStr": return "str";
        case "List": case "ListComp": return "list";
        case "Dict": case "DictComp": return "dict";
        case "Set": case "SetComp": return "set";
        case "Tuple": return "tuple";
        case "GeneratorExp": return "generator";
        case "Lambda": return "function";
        case "Compare": return "bool";
        case "BoolOp": { const a = this.typeOf(e.values && e.values[0], scope, depth); return a && (e.values || []).every(v => this.typeOf(v, scope, depth) === a) ? a : null; }
        case "UnaryOp": return e.op === "not" ? "bool" : this.typeOf(e.operand, scope, depth);
        case "BinOp": {
          const l = this.typeOf(e.left, scope, depth), r = this.typeOf(e.right, scope, depth);
          if (e.op === "/" && /^(int|float)$/.test(l) && /^(int|float)$/.test(r)) return "float";
          if (/^(int|float)$/.test(l) && /^(int|float)$/.test(r)) return l === "float" || r === "float" ? "float" : "int";
          if (e.op === "%" && (l === "str" || l === "bytes")) return l;
          return l && l === r && /^[-+*|&^]$|^\/\/$/.test(e.op) ? l : null;
        }
        case "Call": {
          if (e.func.type === "Name" && BUILTIN_TYPES[e.func.id] && !this.lookup(scope, e.func.id)) return BUILTIN_TYPES[e.func.id];
          const v = this.valueOf(e.func, scope);
          if (v && v.cls) return v.cls.name;
          if (v && v.library) return v.library;
          const f = e.func.type === "Name" ? this.lookup(scope, e.func.id) : e.func.type === "Attribute" ? this.member(this.valueOf(e.func.value, scope), e.func.attr) : null;
          const fd = f && !f.module && !f.library ? this.defs(f).find(x => x.kind === "function") : null;
          return fd && fd.node.returns ? show(fd.node.returns) : null;
        }
        case "Name": case "Attribute": {
          const v = this.valueOf(e, scope);
          if (v && v.module) return "module " + v.module.module;
          if (v && v.cls) return v.cls.name;
          if (e.type === "Name") {
            const sym = this.lookup(scope, e.id); if (!sym || sym.module || sym.library) return null;
            if (this.defs(sym).some(x => x.kind === "parameter")) return this.paramType(sym);
            const d = this.defs(sym).find(x => x.annotation || x.value);
            return d ? (d.annotation ? show(d.annotation) : this.typeOf(d.value, d.valueScope || sym.scope, depth)) : null;
          }
          return null;
        }
        default: return null;
      }
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
    /** Is `name` bound anywhere `scope` can see (any binding counts, imports of unknown modules too; a star import counts as everything)? */
    bound(scope, name) {
      if (scope.globals.has(name)) scope = scope.file.root;
      for (let s = scope, first = true; s; s = s.parent, first = false) {
        if (s.kind === "class" && !first) continue;
        if (s.defs.has(name) || s.star) return true;
      }
      return false;
    }
    // Parameters a call fills for the project function/class it resolves to, or null when it cannot tell for sure.
    callTarget(call) {
      const e = call.node.func, scope = call.scope;
      let sym = e.type === "Name" ? this.lookup(scope, e.id) : e.type === "Attribute" ? this.member(this.valueOf(e.value, scope), e.attr) : null;
      if (!sym || sym.module || sym.library) return null;
      let ds = this.defs(sym); if (ds.length !== 1) return null;
      let d = ds[0], drop = 0, label = sym.name;
      if (d.kind === "class") {
        if ((d.node.decorators || []).length) return null;
        const init = this.member({ cls: d.inner }, "__init__"); if (!init || init.module || init.library) return null;
        ds = this.defs(init); if (ds.length !== 1 || ds[0].kind !== "function") return null;
        d = ds[0]; drop = 1;
      } else if (d.kind !== "function") return null;
      else if (sym.scope.kind === "class") {
        if (e.type !== "Attribute") return null;
        const decos = (d.node.decorators || []).map(x => x.type === "Name" ? x.id : "?");
        if (decos.length > 1 || (decos.length && decos[0] !== "staticmethod" && decos[0] !== "classmethod")) return null;
        if (decos[0] !== "staticmethod") {
          // Through an instance or self the first parameter is bound; through the class itself only for classmethods.
          const base = e.value.type === "Name" ? this.lookup(scope, e.value.id) : null;
          const viaClass = base && !base.module && !base.library && this.defs(base).some(x => x.kind === "class");
          if (viaClass && decos[0] !== "classmethod") return null;
          drop = 1;
        }
        label = sym.scope.name + "." + sym.name;
      } else if ((d.node.decorators || []).length) return null;
      return { label, params: d.node.args.slice(drop), node: d.node };
    }
    // Argument-count / keyword problems of one call, or null.
    callProblem(call) {
      const n = call.node;
      if (n.args.some(a => a.type === "Starred") || n.keywords.some(k => k.arg === null)) return null;
      const t = this.callTarget(call); if (!t) return null;
      if (t.node.args.length && t.node.args.slice(0, t.node.args.length - t.params.length).some(a => a.kind !== "arg")) return null;
      const pos = t.params.filter(a => a.kind === "arg"), vararg = t.params.some(a => a.kind === "vararg"), kwarg = t.params.some(a => a.kind === "kwarg");
      if (n.args.length > pos.length && !vararg) return t.label + "() 最多接受 " + pos.length + " 个位置参数，这里传了 " + n.args.length + " 个";
      const filled = new Set(pos.slice(0, n.args.length).map(a => a.arg));
      for (const k of n.keywords) {
        const p = t.params.find(a => a.arg === k.arg && (a.kind === "arg" || a.kind === "kwonly"));
        if (!p) { if (kwarg) continue; return t.label + "() 没有名为 " + k.arg + " 的参数"; }
        if (filled.has(k.arg)) return t.label + "() 的参数 " + k.arg + " 传了两次";
        filled.add(k.arg);
      }
      const missing = t.params.filter(a => (a.kind === "arg" || a.kind === "kwonly") && !a.default && !filled.has(a.arg)).map(a => a.arg);
      return missing.length ? t.label + "() 缺少参数 " + missing.join("、") : null;
    }
    // Attribute names assigned anywhere in the project (`obj.x = ...`): they may exist at run time, so they are never
    // reported. Files using setattr / __dict__ / __getattr__ / __slots__ are marked dynamic.
    dynamicAttrs() {
      if (this._dyn) return this._dyn;
      const names = new Set();
      for (const f of this.files.values()) {
        f.dynamic = /\bsetattr\s*\(|__dict__|__getattr__|__getattribute__|__slots__/.test(f.text);
        for (const o of f.occ) if (o.kind === "attr" && o.store) names.add(o.name);
      }
      return this._dyn = names;
    }
    // Class scope of `base` when it is for sure a project class or an instance of one: `self` in a method, a class
    // name, or a variable bound exactly once to `ClassName(...)`. Null otherwise.
    knownClass(base, scope) {
      if (base.type !== "Name") return null;
      if (scope.kind === "function" && scope.parent && scope.parent.kind === "class" && scope.firstParam === base.id) {
        // plain methods only (not static/class methods), and not in a class that project classes extend: a base
        // class often uses attributes its subclasses define
        const ds = this.defs({ scope, name: base.id });
        if (ds.length !== 1 || ds[0].kind !== "parameter" || (scope.node.decorators || []).length) return null;
        return this.subclassed(scope.parent) ? null : scope.parent;
      }
      const sym = this.lookup(scope, base.id);
      if (!sym || sym.module || sym.library) return null;
      const ds = this.defs(sym); if (ds.length !== 1) return null;
      const d = ds[0];
      if (d.kind === "class") return d.inner;
      if (d.kind === "variable" && d.value && d.value.type === "Call" && !d.annotation) {
        const v = this.valueOf(d.value.func, d.valueScope || sym.scope);
        const f = d.value.func.type === "Name" ? this.lookup(d.valueScope || sym.scope, d.value.func.id) : null;
        return v && v.cls && f && !f.module && !f.library && this.defs(f).length === 1 && this.defs(f)[0].kind === "class" ? v.cls : null;
      }
      return null;
    }
    subclassed(cls) {
      if (!this._bases) {
        this._bases = new Set();
        for (const f of this.files.values()) for (const sc of f.scopes) if (sc.kind === "class")
          for (const b of sc.node.bases || []) { const v = this.valueOf(b, sc.parent); if (v && v.cls) this._bases.add(v.cls); }
      }
      return this._bases.has(cls);
    }
    // Every class in the hierarchy is a plain project class (no decorators, metaclass or unknown bases).
    closedClass(cls, depth) {
      if ((depth || 0) > MAX_HOPS || !cls || !cls.node) return false;
      if ((cls.node.decorators || []).length || (cls.node.keywords || []).length) return false;
      for (const b of cls.node.bases || []) {
        if (b.type === "Name" && b.id === "object" && !this.bound(cls.parent, "object")) continue;
        const v = this.valueOf(b, cls.parent);
        if (!v || !v.cls || !this.closedClass(v.cls, (depth || 0) + 1)) return false;
      }
      return true;
    }
    attrProblem(o) {
      if (o.name.startsWith("__")) return null;
      const dyn = this.dynamicAttrs(); if (dyn.has(o.name) || o.scope.file.dynamic) return null;
      const cls = this.knownClass(o.base, o.scope);
      if (!cls || cls.file.dynamic || !this.closedClass(cls) || this.member({ cls }, o.name)) return null;
      return cls.name + " 没有属性或方法 " + o.name;
    }
    /**
     * Basic checks of one file (warnings, not errors): names that are not defined anywhere visible and calls of
     * project functions/classes with the wrong arguments. Conservative: anything it cannot resolve for sure is skipped.
     * @returns {Array<{line,col,length,message,severity:"warning"}>}
     */
    problemsIn(path) {
      const f = this.files.get(path); if (!f) return [];
      const out = [], seen = new Set();
      for (const o of f.occ) {
        if (o.kind !== "name" || BUILTINS.has(o.name) || this.bound(o.scope, o.name)) continue;
        out.push({ line: o.line, col: o.col, length: o.name.length, message: "未定义的名字 " + o.name, severity: "warning" });
      }
      for (const o of f.occ) {
        const m = o.kind === "attr" && !o.store ? this.attrProblem(o) : null; if (!m) continue;
        out.push({ line: o.line, col: o.col, length: o.name.length, message: m, severity: "warning" });
      }
      for (const c of f.calls) {
        const m = this.callProblem(c); if (!m) continue;
        const e = c.node.func, at = e.type === "Name" ? { line: e.line, col: e.col, length: e.id.length } : { line: e.line, col: e.col, length: e.attr.length };
        const k = at.line + ":" + at.col; if (seen.has(k)) continue; seen.add(k);
        out.push(Object.assign(at, { message: m, severity: "warning" }));
      }
      return out.sort((a, b) => a.line - b.line || a.col - b.col);
    }
  }

  const EditorSymbols = { moduleName, indexFile, build: (files, docs) => new Project(files, docs) };
  if (typeof module !== "undefined" && module.exports) module.exports = { EditorSymbols };
  else root.EditorSymbols = EditorSymbols;
})(typeof window !== "undefined" ? window : globalThis);
