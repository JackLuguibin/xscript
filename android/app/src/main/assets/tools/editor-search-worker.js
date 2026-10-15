"use strict";
// Web IDE: regex search / replace in a worker, so a catastrophic pattern can be killed by EditorSearch.guard().
importScripts("/tools/ui/editor-search.js");
self.onmessage = e => {
  const m = e.data;
  try {
    const re = new RegExp(m.source, m.flags);
    if (m.op === "replace") {
      const r = self.EditorSearch.replaceAll(m.text, re, m.replacement, {regex: m.regex});
      self.postMessage({id: m.id, text: r.text, count: r.count});
    } else {
      self.postMessage({id: m.id, matches: self.EditorSearch.find(m.text, re, m.limit)});
    }
  } catch (err) {
    self.postMessage({id: m.id, error: String(err && err.message || err)});
  }
};
