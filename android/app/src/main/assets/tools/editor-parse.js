// Python 3.10 parser for the web IDE: tokenizer (INDENT/DEDENT, brackets, strings, numbers) plus a
// recursive-descent parser that returns a positioned AST and the first syntax error, like CPython's ast.parse.
// Lines are 1-based, columns 0-based. Used by EditorCheck (diagnostics) and EditorSymbols (definitions/references).
(function (root) {
  "use strict";
  const KW = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "));
  const OPS = ["**=", "//=", ">>=", "<<=", "...", "->", ":=", "**", "//", ">>", "<<", "<=", ">=", "==", "!=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "@=",
    "+", "-", "*", "/", "%", "@", "&", "|", "^", "~", "<", ">", "(", ")", "[", "]", "{", "}", ",", ":", ".", ";", "="];
  const AUG = new Set(["+=", "-=", "*=", "/=", "//=", "%=", "@=", "&=", "|=", "^=", ">>=", "<<=", "**="]);
  const OPEN = { "(": ")", "[": "]", "{": "}" };
  const PREFIX = new Set(["r", "u", "b", "f", "br", "rb", "fr", "rf"]);
  const ID0 = /[\p{L}\p{Nl}_]/u, ID = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]/u;
  const NUM = /^(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?[jJ]?)/;
  const MSG = {
    syntax: "语法错误", comma: "语法错误：是不是少了逗号？",
    unclosed: o => "'" + o.ch + "' 没有闭合",
  };
  class SyntaxErr { constructor(line, col, length, message) { this.line = line; this.col = col; this.length = Math.max(1, length || 1); this.message = message; } }

  function tokenize(src) {
    const toks = [], indents = [0], stack = [];
    const n = src.length; let i = 0, line = 1, ls = 0, bol = true, lastLine = 1, lastCol = 0;
    const cp = (k) => String.fromCodePoint(src.codePointAt(k));
    const tok = (t, v, l, c, el, ec) => { toks.push({ t, v, line: l, col: c, eline: el, ecol: ec }); if (t !== "NEWLINE" && t !== "INDENT" && t !== "DEDENT") { lastLine = el; lastCol = ec; } };
    const fail = (l, c, len, m, extra) => { toks.push(Object.assign({ t: "ERR", line: l, col: c, eline: l, ecol: c, err: new SyntaxErr(l, c, len, m) }, extra)); return toks; };
    while (true) {
      if (bol && stack.length === 0) {
        let w = 0, j = i;
        for (; j < n; j++) { const c = src[j]; if (c === " ") w++; else if (c === "\t") w = (w >> 3 << 3) + 8; else if (c === "\f") w = 0; else break; }
        if (j >= n) { i = j; break; }
        if (src[j] === "\n" || src[j] === "\r" || src[j] === "#") {
          while (j < n && src[j] !== "\n") j++;
          i = j + 1; line++; ls = i; if (j >= n) break; continue;
        }
        const top = indents[indents.length - 1];
        if (w > top) { indents.push(w); tok("INDENT", "", line, 0, line, j - ls); }
        else if (w < top) {
          while (w < indents[indents.length - 1]) { indents.pop(); tok("DEDENT", "", line, j - ls, line, j - ls); }
          if (w !== indents[indents.length - 1]) return fail(line, 0, j - ls, "缩进与外层任何一级都不一致");
        }
        i = j; bol = false;
      }
      if (i >= n) break;
      const c = src[i], col = i - ls;
      if (c === " " || c === "\t" || c === "\f" || c === "\r") { i++; continue; }
      if (c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "\n") {
        if (stack.length === 0 && toks.length && toks[toks.length - 1].t !== "NEWLINE") tok("NEWLINE", "", line, col, line, col + 1);
        i++; line++; ls = i; bol = stack.length === 0; continue;
      }
      if (c === "\\") {
        let j = i + 1; if (src[j] === "\r") j++;
        if (src[j] === "\n") { if (j + 1 >= n) return fail(line, col, 1, "文件在续行符 '\\' 之后结束"); i = j + 1; line++; ls = i; continue; }
        if (j >= n) return fail(line, col, 1, "文件在续行符 '\\' 之后结束");
        return fail(line, col + 1, 1, "续行符 '\\' 后面不能再有内容");
      }
      let q = -1;
      if (c === "'" || c === '"') q = i;
      else if (ID0.test(cp(i))) {
        let j = i + cp(i).length; while (j < n && ID.test(cp(j))) j += cp(j).length;
        const word = src.slice(i, j);
        if ((src[j] === "'" || src[j] === '"') && PREFIX.has(word.toLowerCase())) q = j;
        else { tok("NAME", word, line, col, line, col + j - i); i = j; continue; }
      }
      if (q >= 0) {
        const pfx = src.slice(i, q).toLowerCase(), qc = src[q], triple = src[q + 1] === qc && src[q + 2] === qc;
        const sl = line, sc = col; let j = q + (triple ? 3 : 1), done = false;
        while (j < n) {
          const d = src[j];
          if (d === "\\") { if (src[j + 1] === "\n") { line++; ls = j + 2; } j += 2; continue; }
          if (d === "\n") { if (!triple) break; line++; ls = j + 1; j++; continue; }
          if (d === qc && (!triple || src[j + 1] === qc && src[j + 2] === qc)) { j += triple ? 3 : 1; done = true; break; }
          j++;
        }
        if (!done) return triple ? fail(sl, sc, 3 + pfx.length, "三引号字符串没有结束") : fail(sl, sc, 1 + pfx.length, "字符串没有结束（缺少 " + qc + "）");
        toks.push({ t: "STRING", v: src.slice(i, j), pfx, line: sl, col: sc, eline: line, ecol: j - ls }); lastLine = line; lastCol = j - ls;
        i = j; continue;
      }
      if (c >= "0" && c <= "9" || c === "." && src[i + 1] >= "0" && src[i + 1] <= "9") {
        const m = NUM.exec(src.slice(i, i + 400)); let j = i + m[0].length;
        if (j < n && (ID.test(src[j]) || src[j] === "_")) return fail(line, col, j - i + 1, "无效的数字写法");
        if (/^0[xob]$/i.test(m[0]) || /^0\d*[1-9]/.test(m[0]) && !/[.eEjJ]/.test(m[0])) return fail(line, col, j - i, "无效的数字写法");
        tok("NUMBER", m[0], line, col, line, col + j - i); i = j; continue;
      }
      let op = null;
      for (const o of OPS) if (src.startsWith(o, i)) { op = o; break; }
      if (!op) return fail(line, col, 1, "无效字符 '" + cp(i) + "'");
      if (OPEN[op]) stack.push({ ch: op, line, col });
      else if (op === ")" || op === "]" || op === "}") {
        const top = stack.pop();
        if (!top) return fail(line, col, 1, "多余的 '" + op + "'");
        if (OPEN[top.ch] !== op) return fail(line, col, 1, "括号不匹配：'" + top.ch + "'（第 " + top.line + " 行）需要 '" + OPEN[top.ch] + "'，这里是 '" + op + "'");
      }
      tok("OP", op, line, col, line, col + op.length); i += op.length;
    }
    if (stack.length) { const o = stack[stack.length - 1]; return fail(o.line, o.col, 1, MSG.unclosed(o), { unclosed: o }); }
    if (toks.length && toks[toks.length - 1].t !== "NEWLINE" && toks[toks.length - 1].t !== "DEDENT") tok("NEWLINE", "", lastLine, lastCol, lastLine, lastCol);
    while (indents.length > 1) { indents.pop(); toks.push({ t: "DEDENT", v: "", line: lastLine, col: lastCol, eline: lastLine, ecol: lastCol }); }
    toks.push({ t: "END", v: "", line: lastLine, col: lastCol, eline: lastLine, ecol: lastCol });
    return toks;
  }

  const TARGET_NAMES = { Call: "函数调用", Constant: "常量", BinOp: "表达式", UnaryOp: "表达式", BoolOp: "表达式", Compare: "比较表达式", Lambda: "lambda", IfExp: "条件表达式",
    Dict: "字典", Set: "集合", ListComp: "列表推导式", SetComp: "集合推导式", DictComp: "字典推导式", GeneratorExp: "生成器表达式", Yield: "yield 表达式", YieldFrom: "yield 表达式",
    Await: "await 表达式", JoinedStr: "f-字符串", NamedExpr: "海象表达式", Ellipsis: "...", Keyword: "关键字" };

  function parse(src) {
    if (typeof src !== "string") src = String(src == null ? "" : src);
    const toks = tokenize(src.replace(/\r\n?/g, "\n"));
    let p = 0, unclosed = null;
    const last = toks[toks.length - 1]; if (last.t === "ERR" && last.unclosed) unclosed = last.unclosed;
    const peek = (k) => toks[Math.min(p + (k || 0), toks.length - 1)];
    const at = (v, k) => { const t = peek(k); return (t.t === "OP" || t.t === "NAME") && t.v === v; };
    const isKw = (t, v) => t.t === "NAME" && t.v === v;
    const fail = (t, m, len) => {
      if (t.t === "ERR") throw t.err;
      if (unclosed && (!m || m === MSG.syntax || m === MSG.comma) && t.line > unclosed.line) throw new SyntaxErr(unclosed.line, unclosed.col, 1, MSG.unclosed(unclosed));
      throw new SyntaxErr(t.line, t.col, len || Math.max(1, (t.ecol - t.col) || 1), m || MSG.syntax);
    };
    const next = () => { const t = peek(); if (t.t === "ERR") throw t.err; if (p < toks.length - 1) p++; return t; };
    const eat = (v) => at(v) ? next() : null;
    const expect = (v, m) => eat(v) || fail(peek(), m);
    const node = (type, t, o) => Object.assign({ type, line: t.line, col: t.col }, o);
    const nameTok = () => { const t = peek(); if (t.t !== "NAME" || KW.has(t.v)) fail(t); return next(); };
    const name = (ctx) => { const t = nameTok(); return node("Name", t, { id: t.v, ctx: ctx || "load" }); };
    const startsExpr = (t) => t.t === "NUMBER" || t.t === "STRING" || t.t === "NAME" && (!KW.has(t.v) || /^(None|True|False|not|lambda|await|yield)$/.test(t.v)) || t.t === "OP" && /^(\(|\[|\{|-|\+|~|\.\.\.|\*)$/.test(t.v);

    // ---- targets ----
    function setStore(e, how) {
      const bad = (m) => { throw new SyntaxErr(e.line, e.col, 1, m); };
      switch (e.type) {
        case "Name": e.ctx = "store"; return;
        case "Attribute": case "Subscript": e.ctx = "store"; return;
        case "Starred": if (how === "aug" || how === "ann") bad("这里不能用 *"); return setStore(e.value, how);
        case "Tuple": case "List":
          if (how === "aug") bad("增强赋值（如 +=）的左边不能是" + (e.type === "Tuple" ? "元组" : "列表"));
          if (how === "ann") bad("这里不能加类型注解");
          for (const x of e.elts) setStore(x, how); return;
        default:
          if (how === "ann") bad("这里不能加类型注解");
          bad((how === "del" ? "不能删除" : "不能给") + (TARGET_NAMES[e.type] || "这个表达式") + (how === "del" ? "" : "赋值"));
      }
    }
    // ---- expressions ----
    function atom() {
      const t = peek();
      if (t.t === "NUMBER") { next(); return node("Constant", t, { kind: "number", value: t.v }); }
      if (t.t === "STRING") {
        let b = null, v = [];
        while (peek().t === "STRING") { const s = next(); const isB = s.pfx.includes("b"); if (b === null) b = isB; else if (b !== isB) fail(s, "不能把 bytes 和普通字符串拼在一起"); v.push(s.v); }
        return node(/f/.test(t.pfx) ? "JoinedStr" : "Constant", t, { kind: "string", value: v.join(" ") });
      }
      if (t.t === "NAME") {
        if (t.v === "None" || t.v === "True" || t.v === "False") { next(); return node("Constant", t, { value: t.v }); }
        if (KW.has(t.v)) fail(t);
        next(); return node("Name", t, { id: t.v, ctx: "load" });
      }
      if (t.t === "OP") {
        if (t.v === "...") { next(); return node("Constant", t, { value: "..." }); }
        if (t.v === "(") {
          next();
          if (eat(")")) return node("Tuple", t, { elts: [] });
          if (isKw(peek(), "yield")) { const y = yieldExpr(); expect(")"); return y; }
          const first = starOrNamed();
          if (isKw(peek(), "for") || isKw(peek(), "async")) { const g = node("GeneratorExp", t, { elt: first, generators: comps() }); expect(")"); return g; }
          if (eat(")")) { if (first.type === "Starred") fail(peek(-1), "不能单独使用带 * 的表达式"); first.paren = true; return first; }
          const elts = [first];
          if (!at(",")) fail(peek(), startsExpr(peek()) ? MSG.comma : MSG.syntax);
          while (eat(",")) { if (at(")")) break; elts.push(starOrNamed()); }
          expect(")", startsExpr(peek()) ? MSG.comma : MSG.syntax);
          return node("Tuple", t, { elts, paren: true });
        }
        if (t.v === "[") {
          next();
          if (eat("]")) return node("List", t, { elts: [] });
          const first = starOrNamed();
          if (isKw(peek(), "for") || isKw(peek(), "async")) { const g = node("ListComp", t, { elt: first, generators: comps() }); expect("]"); return g; }
          const elts = [first];
          while (eat(",")) { if (at("]")) break; elts.push(starOrNamed()); }
          expect("]", startsExpr(peek()) ? MSG.comma : MSG.syntax);
          return node("List", t, { elts });
        }
        if (t.v === "{") return dictOrSet();
      }
      return fail(t);
    }
    function dictOrSet() {
      const t = next();
      if (eat("}")) return node("Dict", t, { keys: [], values: [] });
      let isDict = null; const keys = [], values = [], elts = [];
      const item = () => {
        if (at("**")) { const s = next(); if (isDict === false) fail(s); isDict = true; keys.push(null); values.push(bitor()); return; }
        const k = isDict === true ? test() : starOrNamed();
        if (isDict === true) { if (!eat(":")) fail(peek(), "字典里的键后面要有 ':'"); keys.push(k); values.push(test()); return; }
        if (isDict === null && at(":") && k.type !== "Starred") { next(); isDict = true; keys.push(k); values.push(test()); return; }
        isDict = false; elts.push(k);
      };
      item();
      if (isKw(peek(), "for") || isKw(peek(), "async")) {
        if (keys.length && keys[0] === null) fail(peek());
        const g = isDict ? node("DictComp", t, { key: keys[0], value: values[0], generators: comps() }) : node("SetComp", t, { elt: elts[0], generators: comps() });
        expect("}"); return g;
      }
      while (eat(",")) { if (at("}")) break; item(); }
      expect("}", startsExpr(peek()) ? MSG.comma : MSG.syntax);
      return isDict ? node("Dict", t, { keys, values }) : node("Set", t, { elts });
    }
    function comps() {
      const gens = [];
      while (isKw(peek(), "for") || isKw(peek(), "async") && isKw(peek(1), "for")) {
        const isAsync = !!(isKw(peek(), "async") && next()); next();
        const target = targetList(); setStore(target, "for");
        if (!isKw(peek(), "in")) fail(peek());
        next(); const iter = orTest(); const ifs = [];
        while (isKw(peek(), "if")) { next(); ifs.push(orTestNoCond()); }
        gens.push({ type: "comprehension", target, iter, ifs, isAsync });
      }
      return gens;
    }
    function orTestNoCond() { return isKw(peek(), "lambda") ? lambdef(true) : orTest(); }
    function targetList() {
      const t = peek(), first = starExpr(bitor);
      if (!at(",")) return first;
      const elts = [first];
      while (eat(",")) { if (isKw(peek(), "in") || at("=")) break; elts.push(starExpr(bitor)); }
      return node("Tuple", t, { elts });
    }
    function starExpr(inner) { const t = peek(); if (at("*")) { next(); return node("Starred", t, { value: bitor() }); } return inner(); }
    function starOrNamed() { return starExpr(namedExpr); }
    function namedExpr() {
      const t = peek();
      if (t.t === "NAME" && !KW.has(t.v) && at(":=", 1)) { next(); next(); return node("NamedExpr", t, { target: node("Name", t, { id: t.v, ctx: "store" }), value: test() }); }
      const e = test();
      if (at(":=")) fail(peek(), "海象运算符 ':=' 左边只能是变量名");
      return e;
    }
    function test() {
      if (isKw(peek(), "lambda")) return lambdef(false);
      const t = peek(), body = orTest();
      if (isKw(peek(), "if") ) {
        next(); const cond = orTest();
        if (!isKw(peek(), "else")) fail(t, "条件表达式缺少 else");
        next(); return node("IfExp", t, { body, test: cond, orelse: test() });
      }
      return body;
    }
    function lambdef(noCond) {
      const t = next(); const args = params(":", false); expect(":");
      return node("Lambda", t, { args, body: noCond ? orTestNoCond() : test() });
    }
    function orTest() { const t = peek(); let e = andTest(); if (isKw(peek(), "or")) { const vs = [e]; while (isKw(peek(), "or")) { next(); vs.push(andTest()); } e = node("BoolOp", t, { op: "or", values: vs }); } return e; }
    function andTest() { const t = peek(); let e = notTest(); if (isKw(peek(), "and")) { const vs = [e]; while (isKw(peek(), "and")) { next(); vs.push(notTest()); } e = node("BoolOp", t, { op: "and", values: vs }); } return e; }
    function notTest() { const t = peek(); if (isKw(t, "not")) { next(); return node("UnaryOp", t, { op: "not", operand: notTest() }); } return comparison(); }
    const CMP = new Set(["<", ">", "==", ">=", "<=", "!="]);
    function comparison() {
      const t = peek(), left = bitor(), ops = [], rest = [];
      while (true) {
        const o = peek();
        if (o.t === "OP" && CMP.has(o.v)) { next(); ops.push(o.v); }
        else if (isKw(o, "in")) { next(); ops.push("in"); }
        else if (isKw(o, "not") && isKw(peek(1), "in")) { next(); next(); ops.push("not in"); }
        else if (isKw(o, "is")) { next(); if (isKw(peek(), "not")) { next(); ops.push("is not"); } else ops.push("is"); }
        else break;
        rest.push(bitor());
      }
      return ops.length ? node("Compare", t, { left, ops, comparators: rest }) : left;
    }
    const BIN = [["|"], ["^"], ["&"], ["<<", ">>"], ["+", "-"], ["*", "/", "//", "%", "@"]];
    function binLevel(k) {
      if (k === BIN.length) return factor();
      const t = peek(); let e = binLevel(k + 1);
      while (peek().t === "OP" && BIN[k].includes(peek().v)) { const o = next().v; e = node("BinOp", t, { op: o, left: e, right: binLevel(k + 1) }); }
      return e;
    }
    function bitor() { return binLevel(0); }
    function factor() {
      const t = peek();
      if (t.t === "OP" && (t.v === "-" || t.v === "+" || t.v === "~")) { next(); return node("UnaryOp", t, { op: t.v, operand: factor() }); }
      return power();
    }
    function power() {
      const t = peek(); let e;
      if (isKw(t, "await")) { next(); e = node("Await", t, { value: primary() }); } else e = primary();
      if (at("**")) { next(); e = node("BinOp", t, { op: "**", left: e, right: factor() }); }
      return e;
    }
    function primary() {
      let e = atom();
      while (true) {
        const t = peek();
        if (at(".")) { next(); const n = nameTok(); e = node("Attribute", n, { value: e, attr: n.v }); }
        else if (at("(")) { next(); e = node("Call", t, Object.assign({ func: e }, callArgs())); }
        else if (at("[")) { next(); e = node("Subscript", t, { value: e, slice: subscripts() }); expect("]"); }
        else return e;
      }
    }
    function callArgs() {
      const args = [], keywords = []; let sawKw = false, sawStarStar = false, n = 0;
      while (!at(")")) {
        const t = peek(); n++;
        if (at("*")) { next(); if (sawStarStar) fail(t, "*参数 不能出现在 **参数 后面"); args.push(node("Starred", t, { value: test() })); }
        else if (at("**")) { next(); sawStarStar = true; keywords.push(node("keyword", t, { arg: null, value: test() })); }
        else if (t.t === "NAME" && !KW.has(t.v) && at("=", 1)) { next(); next(); sawKw = true; keywords.push(node("keyword", t, { arg: t.v, value: test() })); }
        else {
          const e = namedExpr();
          if (isKw(peek(), "for") || isKw(peek(), "async")) {
            const g = node("GeneratorExp", e, { elt: e, generators: comps() });
            if (n > 1 || at(",") && !at(")", 1)) fail(e, "生成器表达式要加括号");
            args.push(g);
          } else {
            if (at("=")) fail(e, "关键字参数的名字必须是简单变量名");
            if (sawKw || sawStarStar) fail(t, sawStarStar ? "位置参数不能出现在 **参数 后面" : "位置参数不能出现在关键字参数后面");
            args.push(e);
          }
        }
        if (!eat(",")) break;
      }
      expect(")", startsExpr(peek()) ? MSG.comma : MSG.syntax);
      return { args, keywords };
    }
    function subscripts() {
      const t = peek(), items = [];
      do { if (at("]")) break; items.push(slice()); } while (eat(","));
      if (!items.length) fail(peek());
      return items.length === 1 && !at(",", -1) ? items[0] : node("Tuple", t, { elts: items });
    }
    function slice() {
      const t = peek(); let lower = null;
      if (at("*")) return starExpr(bitor);
      if (!at(":")) { lower = namedExpr(); if (!at(":")) return lower; }
      next(); const upper = at(":") || at("]") || at(",") ? null : test(); let step = null;
      if (eat(":")) step = at("]") || at(",") ? null : test();
      return node("Slice", t, { lower, upper, step });
    }
    function exprList(inner) {
      const t = peek(), first = starExpr(inner || test);
      if (!at(",")) return first;
      const elts = [first];
      while (eat(",")) { if (!startsExpr(peek()) || isKw(peek(), "yield")) break; elts.push(starExpr(inner || test)); }
      return node("Tuple", t, { elts });
    }
    function yieldExpr() {
      const t = next();
      if (isKw(peek(), "from")) { next(); return node("YieldFrom", t, { value: test() }); }
      return node("Yield", t, { value: startsExpr(peek()) ? exprList() : null });
    }
    // ---- parameters ----
    function params(close, annotations) {
      const out = [], t0 = peek(); let sawDefault = false, star = null, starStar = false, slash = false;
      while (!at(close)) {
        const t = peek();
        if (starStar) fail(t, "**参数 后面不能再有参数");
        if (at("/")) { if (slash || star || !out.length) fail(t); next(); slash = true; }
        else if (at("**")) { next(); out.push(param(annotations, "kwarg")); starStar = true; if (star && star.bare && !star.after) fail(star.tok, "单独的 * 后面必须跟命名参数"); }
        else if (at("*")) {
          if (star) fail(t); next();
          if (at(",") || at(close)) star = { bare: true, tok: t }; else { out.push(param(annotations, "vararg")); star = { bare: false }; }
        } else {
          const a = param(annotations, star ? "kwonly" : "arg");
          if (eat("=")) { a.default = test(); sawDefault = true; }
          else if (sawDefault && !star) fail(t, "没有默认值的参数不能放在有默认值的参数后面");
          if (star) star.after = true; out.push(a);
        }
        if (!eat(",")) break;
      }
      if (star && star.bare && !star.after) fail(star.tok, "单独的 * 后面必须跟命名参数");
      return out;
      function param(ann, kind) { const n = nameTok(); const a = node("arg", n, { arg: n.v, kind }); if (ann && eat(":")) a.annotation = test(); return a; }
    }
    // ---- statements ----
    function block(header) {
      if (!at(":")) { const k = peek(), m = "缺少 ':'（" + header.v + " 语句要以冒号结尾）"; if (k.t !== "ERR" && k.line === header.line && !unclosed) throw new SyntaxErr(header.line, header.col, header.v.length, m); fail(k, m); }
      next();
      if (peek().t !== "NEWLINE") return simpleStmts();
      const nl = next();
      if (peek().t !== "INDENT") { const k = peek(); fail(k.t === "ERR" ? k : k.t === "END" || k.t === "DEDENT" && k.line === nl.line ? nl : k, "缺少缩进的代码块（第 " + header.line + " 行以 ':' 结尾）"); }
      next(); const body = [];
      while (peek().t !== "DEDENT" && peek().t !== "END") body.push(...statement());
      if (peek().t === "DEDENT") next();
      return body;
    }
    function statement() {
      const t = peek();
      if (t.t === "INDENT") fail(t, "意外的缩进", t.ecol);
      if (t.t === "NAME") {
        switch (t.v) {
          case "if": return [ifStmt()];
          case "while": { next(); const test_ = namedExpr(); const body = block(t); return [node("While", t, { test: test_, body, orelse: elseBlock() })]; }
          case "for": return [forStmt(t, false)];
          case "try": return [tryStmt()];
          case "with": return [withStmt(t, false)];
          case "def": return [funcDef([], false)];
          case "class": return [classDef([])];
          case "async": {
            const k = peek(1);
            if (isKw(k, "def")) { next(); return [funcDef([], true, t)]; }
            if (isKw(k, "for")) { next(); return [forStmt(t, true)]; }
            if (isKw(k, "with")) { next(); return [withStmt(t, true)]; }
            fail(k);
          }
          case "match": { const m = matchStmt(); if (m) return [m]; break; }
          case "elif": case "else": case "except": case "finally": fail(t);
        }
      }
      if (t.t === "OP" && t.v === "@") return [decorated()];
      return simpleStmts();
    }
    function elseBlock() { if (isKw(peek(), "else")) { const t = next(); return block(t); } return []; }
    function ifStmt() {
      const t = next(); const test_ = namedExpr(); const body = block(t); let orelse = [];
      if (isKw(peek(), "elif")) orelse = [ifStmt()];
      else orelse = elseBlock();
      return node("If", t, { test: test_, body, orelse });
    }
    function forStmt(t, isAsync) {
      const k = next(); const target = targetList(); setStore(target, "for");
      if (!isKw(peek(), "in")) fail(peek()); next();
      const iter = exprList(); const body = block(k);
      return node("For", t, { target, iter, body, orelse: elseBlock(), isAsync });
    }
    function tryStmt() {
      const t = next(); const body = block(t), handlers = [];
      while (isKw(peek(), "except")) {
        const k = next(); let type = null, nm = null;
        if (at("*")) next();
        if (!at(":")) { type = exprList(); if (isKw(peek(), "as")) { next(); nm = name("store"); } }
        handlers.push(node("ExceptHandler", k, { exType: type, name: nm, body: block(k) }));
      }
      const orelse = handlers.length ? elseBlock() : [];
      let finalbody = [];
      if (isKw(peek(), "finally")) { const k = next(); finalbody = block(k); }
      if (!handlers.length && !finalbody.length) fail(peek(), "try 后面需要 except 或 finally");
      return node("Try", t, { body, handlers, orelse, finalbody });
    }
    function withStmt(t, isAsync) {
      const k = next(), items = [];
      const save = p;
      if (at("(")) {
        try {
          next();
          while (!at(")")) { items.push(withItem()); if (!eat(",")) break; }
          expect(")"); if (!at(":")) throw 0;
        } catch (e) { p = save; items.length = 0; }
      }
      if (!items.length) do items.push(withItem()); while (eat(","));
      return node("With", t, { items, body: block(k), isAsync });
    }
    function withItem() { const e = test(); let v = null; if (isKw(peek(), "as")) { next(); v = targetList1(); setStore(v, "with"); } return { context: e, vars: v }; }
    function targetList1() { return starExpr(bitor); }
    function decorated() {
      const decs = [];
      while (at("@")) { next(); decs.push(namedExpr()); if (peek().t !== "NEWLINE") fail(peek()); next(); }
      const t = peek();
      if (isKw(t, "def")) return funcDef(decs, false);
      if (isKw(t, "class")) return classDef(decs);
      if (isKw(t, "async") && isKw(peek(1), "def")) { next(); return funcDef(decs, true, t); }
      return fail(t);
    }
    function funcDef(decorators, isAsync, at0) {
      const k = next(); const n = nameTok(); expect("(", MSG.syntax); const args = params(")", true); expect(")");
      let returns = null; if (eat("->")) returns = test();
      const d = node("FunctionDef", at0 || k, { name: n.v, nameLine: n.line, nameCol: n.col, args, returns, decorators, isAsync });
      d.body = block(k); return d;
    }
    function classDef(decorators) {
      const k = next(); const n = nameTok(); let bases = { args: [], keywords: [] };
      if (eat("(")) bases = callArgs();
      const d = node("ClassDef", k, { name: n.v, nameLine: n.line, nameCol: n.col, bases: bases.args, keywords: bases.keywords, decorators });
      d.body = block(k); return d;
    }
    // match (soft keyword): commit only if "match <subject>:" NEWLINE parses
    function matchStmt() {
      const save = p, t = next(); let subject;
      try {
        if (!startsExpr(peek())) throw 0;
        subject = exprList(namedExpr);
        if (!at(":") || peek(1).t !== "NEWLINE") throw 0;
      } catch (e) { p = save; return null; }
      next(); next();
      if (peek().t !== "INDENT") fail(peek().t === "END" ? peek(-1) : peek(), "缺少缩进的代码块（第 " + t.line + " 行以 ':' 结尾）");
      next(); const cases = [];
      while (isKw(peek(), "case")) {
        const k = next(); const pattern = openPattern(); let guard = null;
        if (isKw(peek(), "if")) { next(); guard = namedExpr(); }
        cases.push(node("match_case", k, { pattern, guard, body: block(k) }));
      }
      if (!cases.length) fail(peek());
      if (peek().t === "DEDENT") next(); else if (peek().t !== "END") fail(peek());
      return node("Match", t, { subject, cases });
    }
    function openPattern() {
      const t = peek(), first = maybeStarPattern();
      if (!at(",")) return first;
      const pats = [first]; while (eat(",")) { if (at(":") || isKw(peek(), "if")) break; pats.push(maybeStarPattern()); }
      return node("MatchSequence", t, { patterns: pats });
    }
    function maybeStarPattern() { const t = peek(); if (at("*")) { next(); const n = name("store"); return node("MatchStar", t, { name: n }); } return asPattern(); }
    function asPattern() {
      const t = peek(); let pt = orPattern();
      if (isKw(peek(), "as")) { next(); pt = node("MatchAs", t, { pattern: pt, name: name("store") }); }
      return pt;
    }
    function orPattern() {
      const t = peek(), pats = [closedPattern()];
      while (at("|")) { next(); pats.push(closedPattern()); }
      return pats.length > 1 ? node("MatchOr", t, { patterns: pats }) : pats[0];
    }
    function closedPattern() {
      const t = peek();
      if (t.t === "NUMBER" || t.t === "STRING" || at("-") || isKw(t, "None") || isKw(t, "True") || isKw(t, "False")) return node("MatchValue", t, { value: bitor() });
      if (t.t === "NAME" && !KW.has(t.v)) {
        let e = name(), dotted = false;
        while (at(".")) { next(); const n = nameTok(); e = node("Attribute", n, { value: e, attr: n.v }); dotted = true; }
        if (at("(")) {
          next(); const pats = [];
          while (!at(")")) {
            if (peek().t === "NAME" && at("=", 1)) { const kn = next(); next(); pats.push(node("MatchKw", kn, { arg: kn.v, pattern: asPattern() })); }
            else pats.push(asPattern());
            if (!eat(",")) break;
          }
          expect(")"); return node("MatchClass", t, { cls: e, patterns: pats });
        }
        if (!dotted && e.id !== "_") { e.ctx = "store"; return node("MatchAs", t, { name: e }); }
        return node(dotted ? "MatchValue" : "MatchAs", t, dotted ? { value: e } : {});
      }
      if (at("(") || at("[")) {
        const close = OPEN[next().v], pats = [];
        while (!at(close)) { pats.push(maybeStarPattern()); if (!eat(",")) break; }
        expect(close); return pats.length === 1 && close === ")" && !at(",", -1) ? pats[0] : node("MatchSequence", t, { patterns: pats });
      }
      if (at("{")) {
        next(); const keys = [], pats = []; let rest = null;
        while (!at("}")) {
          if (at("**")) { next(); rest = name("store"); }
          else { keys.push(closedPattern()); expect(":"); pats.push(asPattern()); }
          if (!eat(",")) break;
        }
        expect("}"); return node("MatchMapping", t, { keys, patterns: pats, rest });
      }
      return fail(t);
    }
    function simpleStmts() {
      const out = [];
      while (true) {
        out.push(smallStmt());
        if (!eat(";")) break;
        if (peek().t === "NEWLINE") break;
      }
      const t = peek();
      if (t.t !== "NEWLINE") fail(t, startsExpr(t) && t.t !== "OP" ? MSG.comma : MSG.syntax);
      next(); return out;
    }
    function dotted() { const t = nameTok(); let s = t.v; while (at(".")) { next(); s += "." + nameTok().v; } return { name: s, t }; }
    function smallStmt() {
      const t = peek();
      if (t.t === "NAME") {
        switch (t.v) {
          case "pass": case "break": case "continue": next(); return node(t.v[0].toUpperCase() + t.v.slice(1), t);
          case "return": next(); return node("Return", t, { value: startsExpr(peek()) ? exprList() : null });
          case "raise": { next(); let exc = null, cause = null; if (startsExpr(peek())) { exc = test(); if (isKw(peek(), "from")) { next(); cause = test(); } } return node("Raise", t, { exc, cause }); }
          case "global": case "nonlocal": { next(); const names = []; do names.push(name("store")); while (eat(",")); return node(t.v === "global" ? "Global" : "Nonlocal", t, { names }); }
          case "del": { next(); const target = exprList(bitor); setStore(target, "del"); return node("Delete", t, { targets: [target] }); }
          case "assert": { next(); const test_ = test(); let msg = null; if (eat(",")) msg = test(); return node("Assert", t, { test: test_, msg }); }
          case "import": {
            next(); const names = [];
            do { const d = dotted(); let as = null; if (isKw(peek(), "as")) { next(); as = nameTok(); } names.push(node("alias", d.t, { name: d.name, asname: as && as.v, bindLine: (as || d.t).line, bindCol: (as || d.t).col })); } while (eat(","));
            return node("Import", t, { names });
          }
          case "from": {
            next(); let level = 0, mod = null;
            while (at(".") || at("...")) level += next().v.length;
            if (!isKw(peek(), "import")) mod = dotted().name;
            if (!isKw(peek(), "import")) fail(peek());
            next(); const names = [];
            if (at("*")) { const s = next(); names.push(node("alias", s, { name: "*" })); }
            else {
              const paren = !!eat("(");
              do {
                if (paren && at(")")) break;
                const n = nameTok(); let as = null; if (isKw(peek(), "as")) { next(); as = nameTok(); }
                names.push(node("alias", n, { name: n.v, asname: as && as.v, bindLine: (as || n).line, bindCol: (as || n).col }));
              } while (eat(","));
              if (paren) expect(")");
            }
            return node("ImportFrom", t, { module: mod, level, names });
          }
        }
        if (t.v === "print") {
          const k = peek(1);
          if (k.line === t.line && (k.t === "STRING" || k.t === "NUMBER" || k.t === "NAME" && !KW.has(k.v))) fail(t, "print 要写成函数调用：print(...)", 5);
        }
      }
      const first = isKw(t, "yield") ? yieldExpr() : exprList(namedExpr);
      const o = peek();
      if (o.t === "OP" && AUG.has(o.v)) {
        if (first.type === "Tuple" && !first.paren) throw new SyntaxErr(first.line, first.col, 1, "增强赋值（如 +=）的左边不能是元组");
        setStore(first, "aug"); next();
        return node("AugAssign", t, { target: first, op: o.v, value: isKw(peek(), "yield") ? yieldExpr() : exprList() });
      }
      if (o.t === "OP" && o.v === ":" ) {
        if (first.type === "Tuple" && !first.paren) fail(first, "只能给单个目标加类型注解");
        if (!(first.type === "Name" || first.type === "Attribute" || first.type === "Subscript")) throw new SyntaxErr(first.line, first.col, 1, "这里不能加类型注解");
        setStore(first, "ann"); next(); const ann = test(); let value = null;
        if (eat("=")) value = isKw(peek(), "yield") ? yieldExpr() : exprList();
        return node("AnnAssign", t, { target: first, annotation: ann, value });
      }
      if (at("=")) {
        const chain = [first];
        while (eat("=")) chain.push(isKw(peek(), "yield") ? yieldExpr() : exprList(namedExpr));
        const value = chain.pop();
        for (const tg of chain) {
          if (tg.type === "Yield" || tg.type === "YieldFrom") throw new SyntaxErr(tg.line, tg.col, 5, "不能给 yield 表达式赋值");
          if (tg.type === "Call" || tg.type === "Compare") throw new SyntaxErr(tg.line, tg.col, 1, "不能给" + TARGET_NAMES[tg.type] + "赋值；是不是想写 '=='？");
          setStore(tg, "assign");
        }
        return node("Assign", t, { targets: chain, value });
      }
      if (first.type === "Starred") throw new SyntaxErr(first.line, first.col, 1, "不能单独使用带 * 的表达式");
      return node("Expr", t, { value: first });
    }
    const body = [];
    try {
      while (peek().t !== "END") {
        if (peek().t === "NEWLINE") { next(); continue; }
        if (peek().t === "DEDENT") { next(); continue; }
        body.push(...statement());
      }
      return { ast: node("Module", { line: 1, col: 0 }, { body }), error: null };
    } catch (e) {
      if (!(e instanceof SyntaxErr)) { const t = peek(); e = new SyntaxErr(t.line, t.col, 1, e instanceof RangeError ? "嵌套太深，无法解析" : MSG.syntax); }
      return { ast: node("Module", { line: 1, col: 0 }, { body }), error: { line: e.line, col: e.col, length: e.length, message: e.message } };
    }
  }

  // Calls fn(node, parent) for every AST node, depth-first in source order.
  function walk(n, fn, parent) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x, fn, parent); return; }
    if (n.type) fn(n, parent);
    for (const k in n) { const v = n[k]; if (v && typeof v === "object" && k !== "parent") walk(v, fn, n.type ? n : parent); }
  }

  const EditorParse = { parse, tokenize, walk, KEYWORDS: KW };
  if (typeof module !== "undefined" && module.exports) module.exports = { EditorParse };
  else root.EditorParse = EditorParse;
})(typeof window !== "undefined" ? window : globalThis);
