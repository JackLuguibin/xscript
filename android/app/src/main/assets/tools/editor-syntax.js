/* XScript Web IDE: small self-contained Python highlighter (no dependencies, works offline).
 * tokenizePython(text) -> [{type, text}]; highlightPython(text) -> escaped HTML with <span class="tok-*">.
 * Concatenating token texts always reproduces the input exactly, so the overlay lines up with the textarea. */
(function (root) {
  "use strict";
  const KEYWORDS = new Set(("False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case").split(" "));
  const BUILTINS = new Set(("abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex " +
    "delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id " +
    "input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print " +
    "property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ " +
    "Exception BaseException ValueError TypeError KeyError IndexError RuntimeError StopIteration AttributeError " +
    "ImportError OSError NotImplementedError ZeroDivisionError TimeoutError AssertionError NameError").split(" "));
  const SELF = new Set(["self", "cls"]);
  // Order matters: strings/comments first so their content is never re-tokenized.
  const RULES = [
    ["comment", /#[^\n]*/y],
    ["string", /(?:[rRbBuUfF]{1,2})?(?:'''[\s\S]*?(?:'''|$(?![\s\S]))|"""[\s\S]*?(?:"""|$(?![\s\S])))/y],
    ["string", /(?:[rRbBuUfF]{1,2})?(?:'(?:\\.|[^'\\\n])*(?:'|(?=\n)|$)|"(?:\\.|[^"\\\n])*(?:"|(?=\n)|$))/y],
    ["decorator", /@[A-Za-z_][\w.]*/y],
    ["number", /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)/y],
    ["name", /[A-Za-z_\u00C0-\uFFFF][\w\u00C0-\uFFFF]*/y],
    ["operator", /[-+*/%=<>!&|^~:]+|->/y],
    ["punct", /[()[\]{},.;]/y],
    ["space", /\s+/y],
  ];
  function tokenizePython(text) {
    const src = String(text || ""), out = [];
    let i = 0, prev = "";
    const push = (type, value) => {
      const last = out[out.length - 1];
      if (last && last.type === type && (type === "plain" || type === "space")) last.text += value; else out.push({type, text: value});
    };
    while (i < src.length) {
      let matched = false;
      for (const [type, re] of RULES) {
        re.lastIndex = i;
        const m = re.exec(src);
        if (!m || !m[0]) continue;
        let kind = type, value = m[0];
        if (type === "name") {
          if (KEYWORDS.has(value)) kind = "keyword";
          else if (prev === "def" || prev === "class") kind = prev === "def" ? "function" : "class";
          else if (SELF.has(value)) kind = "self";
          else if (BUILTINS.has(value)) kind = "builtin";
          else kind = "plain";
        }
        push(kind, value);
        if (kind !== "space") prev = type === "name" ? value : "";
        i += value.length; matched = true; break;
      }
      if (!matched) { push("plain", src[i]); i++; prev = ""; }
    }
    return out;
  }
  const escapeHtml = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function highlightPython(text) {
    return tokenizePython(text).map(t => t.type === "plain" || t.type === "space" || t.type === "punct"
      ? escapeHtml(t.text) : '<span class="tok-' + t.type + '">' + escapeHtml(t.text) + "</span>").join("");
  }
  /** Highlight by file name; non-Python files and very large files fall back to escaped plain text. */
  function highlight(path, text, limit = 300000) {
    const value = String(text || "");
    return /\.pyw?$/i.test(path || "") && value.length <= limit ? highlightPython(value) : escapeHtml(value);
  }
  /** HTML for lines [from, to) only (joined with "\n"); tokens are still found on the whole text, so a string or
   *  comment that starts above `from` keeps its colour. Same fallback as highlight() for large / non-Python files. */
  function highlightLines(path, text, from, to) {
    const value = String(text || "");
    if (!(/\.pyw?$/i.test(path || "") && value.length <= 300000)) return escapeHtml(value.split("\n").slice(from, to).join("\n"));
    let line = 0, out = "";
    for (const t of tokenizePython(value)) {
      const parts = t.text.split("\n"), plain = t.type === "plain" || t.type === "space" || t.type === "punct";
      for (let k = 0; k < parts.length; k++) {
        if (k > 0) { if (line >= from && line < to - 1) out += "\n"; line++; }
        if (line >= to) return out;
        if (line >= from && parts[k]) out += plain ? escapeHtml(parts[k]) : '<span class="tok-' + t.type + '">' + escapeHtml(parts[k]) + "</span>";
      }
    }
    return out;
  }
  const api = { tokenizePython, highlightPython, highlight, highlightLines, escapeHtml };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.XSyntax = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
