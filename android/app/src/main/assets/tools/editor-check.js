"use strict";
// Lightweight Python syntax diagnostics for the Web IDE (no Python needed): unterminated strings, bracket
// mismatches, missing ':' after block statements, bad indentation and Python 2 print statements. It is
// deliberately conservative: it reports only what CPython would also reject, and it is checked against the
// repo's own sources and the standard library to stay free of false positives. Not a full parser.
(function (root) {
  const BLOCK = new Set(["if", "elif", "else", "for", "while", "def", "class", "try", "except", "finally", "with"]);
  const PAIRS = {")": "(", "]": "[", "}": "{"};
  const OPEN = {"(": ")", "[": "]", "{": "}"};
  const NAME_START = /[A-Za-z_\u0080-\uffff]/;
  const NAME_PART = /[A-Za-z_0-9\u0080-\uffff]/;
  const MAX_TEXT = 400000;

  /**
   * @returns {Array<{line:number,col:number,length:number,message:string}>}  1-based lines, 0-based columns
   */
  function check(text) {
    const out = [];
    if (text.length > MAX_TEXT) return out;
    const n = text.length;
    let i = 0, line = 1, lineBegin = 0;
    const stack = [];                       // open brackets: {ch, line, col}
    const indents = [0];                    // indentation stack of logical lines
    let prev = null;                        // previous logical line {indent, colonEnd, line, col, first}
    let cur = null;                         // logical line being read
    let expectIndent = null;                // the line that ended with ':' and needs a body
    let stop = false;

    const err = (l, col, length, message) => { out.push({line: l, col, length: Math.max(1, length), message}); };
    const startLogical = () => { cur = {indent: 0, first: null, firstTok: null, second: null, tokens: 0, depthColon: false, last: null, line, col: 0}; };

    // Indentation of the physical line starting at `lineBegin` (tabs advance to the next multiple of 8, as CPython does).
    const measure = () => {
      let k = lineBegin, width = 0;
      while (k < n && (text[k] === " " || text[k] === "\t" || text[k] === "\f")) { width = text[k] === "\t" ? (Math.floor(width / 8) + 1) * 8 : text[k] === "\f" ? 0 : width + 1; k++; }
      return {width, end: k};
    };

    const finishLogical = () => {
      if (!cur || cur.tokens === 0) { cur = null; return; }
      const l = cur;
      cur = null;
      // block statements need a ':' at bracket depth 0
      if (BLOCK.has(l.first) && !l.depthColon && !(l.first === "else" && false)) {
        err(l.line, l.firstCol, l.first.length, "缺少 ':'（" + l.first + " 语句要以冒号结尾）");
      }
      // Python 2 print statement
      if (l.first === "print" && l.second && (l.second.type === "str" || l.second.type === "num" ||
          (l.second.type === "name" && !["if", "else", "and", "or", "in", "is", "not", "for"].includes(l.second.text)))) {
        err(l.line, l.firstCol, 5, "print 要写成函数调用：print(...)");
      }
      // A block header that lacks its ':' is reported once; its body is still expected, so no cascade of indent errors.
      if (BLOCK.has(l.first) && !l.depthColon) { l.soft = true; expectIndent = l; }
      else if (l.last === ":" && BLOCK.has(l.first)) expectIndent = l; else if (l.last === ":" && /^(async|match|case|lambda)$/.test(l.first)) expectIndent = l;
      prev = l;
    };

    startLogical();
    cur.indent = 0;
    let atLineStart = true;
    while (i < n && !stop) {
      if (atLineStart && stack.length === 0) {
        // new physical line: classify blank / comment-only / code
        const {width, end} = measure();
        const c = text[end];
        if (end >= n || c === "\n" || c === "\r" || c === "#") {
          // blank or comment-only: ignored for indentation
          if (c === "#") { while (end < n && i < n && text[i] !== "\n") i++; }
          const nl = text.indexOf("\n", Math.max(i, end));
          if (nl < 0) { i = n; break; }
          i = nl + 1; line++; lineBegin = i; continue;
        }
        // real code line
        if (cur && cur.tokens === 0) {
          if (expectIndent) {
            if (width <= expectIndent.indent) {
              if (!expectIndent.soft) err(expectIndent.line, expectIndent.firstCol, expectIndent.first.length, "缺少缩进的代码块（第 " + expectIndent.line + " 行以 ':' 结尾）");
              expectIndent = null;
            }
          }
          if (width > indents[indents.length - 1]) {
            if (!expectIndent) { err(line, 0, end - lineBegin || 1, "意外的缩进"); }
            indents.push(width);
          } else if (width < indents[indents.length - 1]) {
            while (indents.length > 1 && width < indents[indents.length - 1]) indents.pop();
            if (width !== indents[indents.length - 1]) { err(line, 0, end - lineBegin || 1, "缩进与外层任何一级都不一致"); indents.push(width); }
          }
          expectIndent = null;
          cur.indent = width; cur.line = line; cur.col = end - lineBegin;
        }
        i = end; atLineStart = false;
        if (i >= n) break;
      }
      const c = text[i];
      if (c === "\n") {
        if (stack.length === 0) { finishLogical(); startLogical(); atLineStart = true; }
        i++; line++; lineBegin = i; continue;
      }
      if (c === "\r" || c === " " || c === "\t" || c === "\f") { i++; continue; }
      if (c === "\\" && (text[i + 1] === "\n" || (text[i + 1] === "\r" && text[i + 2] === "\n"))) {
        i += text[i + 1] === "\r" ? 3 : 2; line++; lineBegin = i; continue;     // explicit line continuation
      }
      if (c === "#") { while (i < n && text[i] !== "\n") i++; continue; }

      const col = i - lineBegin;
      const tok = (type, textVal, length) => {
        cur.tokens++;
        if (cur.first === null) { cur.first = type === "name" ? textVal : "\u0000"; cur.firstCol = col; cur.line = line; }
        else if (cur.second === null) cur.second = {type, text: textVal};
        cur.last = type === "op" ? textVal : "\u0001";
      };

      // string literal (with optional prefix)
      let m = null;
      if (c === "'" || c === '"' || (NAME_START.test(c) && (m = /^(?:[rRbBuUfF]{1,2})(?=['"])/.exec(text.slice(i, i + 3))))) {
        const prefix = m ? m[0] : "";
        const qpos = i + prefix.length;
        const q = text[qpos];
        const triple = text.startsWith(q + q + q, qpos);
        const quote = triple ? q + q + q : q;
        let j = qpos + quote.length, closed = false;
        const startLine = line, startCol = col;
        while (j < n) {
          const d = text[j];
          if (d === "\\") { if (text[j + 1] === "\n") { line++; lineBegin = j + 2; } j += 2; continue; }
          if (!triple && d === "\n") break;
          if (d === "\n") { line++; lineBegin = j + 1; j++; continue; }
          if (text.startsWith(quote, j)) { j += quote.length; closed = true; break; }
          j++;
        }
        if (!closed) {
          err(startLine, startCol, (triple ? 3 : 1) + prefix.length, triple ? "三引号字符串没有结束" : "字符串没有结束（缺少 " + q + "）");
          if (triple) { stop = true; break; }
        }
        tok("str", "", j - i);
        i = j;
        continue;
      }
      if (NAME_START.test(c)) {
        let j = i + 1;
        while (j < n && NAME_PART.test(text[j])) j++;
        tok("name", text.slice(i, j), j - i);
        i = j; continue;
      }
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] || ""))) {
        let j = i + 1;
        while (j < n && /[0-9A-Za-z_.]/.test(text[j]) || (j < n && (text[j] === "+" || text[j] === "-") && /[eE]/.test(text[j - 1]) && !/^0[xX]/.test(text.slice(i, j)))) j++;
        tok("num", text.slice(i, j), j - i);
        i = j; continue;
      }
      if (OPEN[c]) { stack.push({ch: c, line, col}); tok("op", c, 1); i++; continue; }
      if (PAIRS[c]) {
        const top = stack[stack.length - 1];
        if (!top) { err(line, col, 1, "多余的 '" + c + "'"); }
        else if (top.ch !== PAIRS[c]) {
          err(line, col, 1, "括号不匹配：'" + top.ch + "'（第 " + top.line + " 行）需要 '" + OPEN[top.ch] + "'，这里是 '" + c + "'");
          stack.pop();
        } else stack.pop();
        tok("op", c, 1); i++; continue;
      }
      if (c === ":") {
        if (stack.length === 0 && cur.tokens > 0) cur.depthColon = true;
        // walrus ':=' is not a block colon
        if (text[i + 1] === "=" && stack.length === 0) { tok("op", ":=", 2); i += 2; continue; }
        tok("op", ":", 1); i++; continue;
      }
      // everything else: operators, ',', ';', '@', '$' (invalid but ignored here), '?', '!'
      if (c === "$" || c === "?" || c === "`") { err(line, col, 1, "无效字符 '" + c + "'"); }
      tok("op", c, 1);
      i++;
    }

    if (!stop) {
      for (const o of stack) err(o.line, o.col, 1, "'" + o.ch + "' 没有闭合");
      if (cur && cur.tokens > 0) finishLogical(); else cur = null;
      if (expectIndent && !expectIndent.soft) err(expectIndent.line, expectIndent.firstCol, expectIndent.first.length, "缺少缩进的代码块（第 " + expectIndent.line + " 行以 ':' 结尾）");
    }
    out.sort((a, b) => a.line - b.line || a.col - b.col);
    return out;
  }

  const EditorCheck = { check };
  if (typeof module !== "undefined" && module.exports) module.exports = { EditorCheck };
  else root.EditorCheck = EditorCheck;
})(typeof window !== "undefined" ? window : globalThis);
