"use strict";
// Python syntax diagnostics for the Web IDE (no Python needed). Runs the EditorParse parser and reports the first
// syntax error at the line CPython's ast.parse would (unterminated strings, brackets, missing ':', indentation,
// Python 2 print, invalid targets/arguments, ...). The parser is checked against CPython error samples and all
// of the repository's Python sources (scripts/tests/editor-parse.test.cjs), which keeps false positives out.
(function (root) {
  const P = root.EditorParse || (typeof require === "function" ? require("./editor-parse.js").EditorParse : null);
  const MAX_TEXT = 400000;

  /**
   * @returns {Array<{line:number,col:number,length:number,message:string}>}  1-based lines, 0-based columns
   */
  function check(text) {
    if (!P || typeof text !== "string" || text.length > MAX_TEXT) return [];
    const e = P.parse(text).error;
    return e ? [{ line: e.line, col: e.col, length: Math.max(1, e.length), message: e.message }] : [];
  }

  const EditorCheck = { check };
  if (typeof module !== "undefined" && module.exports) module.exports = { EditorCheck };
  else root.EditorCheck = EditorCheck;
})(typeof window !== "undefined" ? window : globalThis);
