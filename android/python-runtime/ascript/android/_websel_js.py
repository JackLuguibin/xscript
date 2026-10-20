"""In-page half of WebSelector, injected into a WebWindow with evaluateJavascript.

The JS between the markers is also loaded verbatim by scripts/tests/websel.test.cjs
in headless Chrome, so keep it self-contained ES2017.
"""
# --- JS BEGIN ---
JS = r"""
(function () {
  if (window.__xsWeb && window.__xsWeb.v === 1) return;
  var reg = [], ids = new Map();
  function idOf(el) { var i = ids.get(el); if (i === undefined) { i = reg.length; reg.push(el); ids.set(el, i); } return i; }
  function match(m, s) {
    s = s == null ? '' : String(s);
    if (m.re !== undefined) { try { return new RegExp(m.re, m.flags || '').test(s); } catch (e) { return false; } }
    return s === m.s;
  }
  function textOf(el) { return String(el.innerText != null ? el.innerText : el.textContent || '').trim(); }
  function valueOf(el) { return 'value' in el && typeof el.value !== 'function' ? String(el.value == null ? '' : el.value) : (el.getAttribute('value') || ''); }
  function kids(el) { return Array.prototype.slice.call(el.children || []); }
  function pick(list, args, self) {
    if (!args.length) return list;
    var out = [];
    args.forEach(function (n) {
      if (Number.isInteger(n)) { var i = n > 0 ? n - 1 : list.length + n; if (list[i]) out.push(list[i]); return; }
      var parts = String(Math.abs(n)).split('.'), a = +parts[0], b = +parts[1];
      if (self !== undefined && a === 0) {  // brother 0.1 / -0.1: next / previous sibling
        var sib = n > 0 ? self.nextElementSibling : self.previousElementSibling;
        for (var k = 1; sib && k < b; k++) sib = n > 0 ? sib.nextElementSibling : sib.previousElementSibling;
        if (sib) out.push(sib); return;
      }
      for (var j = Math.min(a, b); j <= Math.max(a, b); j++) { var e = n > 0 ? list[j - 1] : list[list.length - j]; if (e) out.push(e); }
    });
    return out;
  }
  function relate(set, st) {
    var out = [];
    set.forEach(function (el) {
      var got;
      if (st.k === 'child') got = pick(kids(el), st.args);
      else if (st.k === 'brother') got = pick(el.parentElement ? kids(el.parentElement).filter(function (x) { return x !== el; }) : [], st.args, el);
      else { var up = [], p = el.parentElement; while (p) { up.push(p); p = p.parentElement; } got = pick(up, st.args); }
      got.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
    });
    return out;
  }
  function filter(set, st) {
    var out = set.filter(function (el) {
      if (st.k === 'tag') return match(st.m, el.tagName.toLowerCase());
      if (st.k === 'text') return match(st.m, textOf(el));
      if (st.k === 'value') return match(st.m, valueOf(el));
      return el.hasAttribute(st.key) && match(st.m, el.getAttribute(st.key));
    });
    // text matches bubble up to every ancestor; keep the innermost ones
    if (st.k === 'text') {
      var outer = new Set();
      out.forEach(function (o) { for (var p = o.parentElement; p && !outer.has(p); p = p.parentElement) outer.add(p); });
      out = out.filter(function (el) { return !outer.has(el); });
    }
    return out;
  }
  function describe(el) {
    var r = el.getBoundingClientRect(), d = window.devicePixelRatio || 1, attrs = {};
    for (var i = 0; i < el.attributes.length; i++) attrs[el.attributes[i].name] = el.attributes[i].value;
    return {id: idOf(el), tag: el.tagName.toLowerCase(), text: textOf(el), value: valueOf(el), attrs: attrs,
            bounds: [Math.round(r.left * d), Math.round(r.top * d), Math.round(r.right * d), Math.round(r.bottom * d)]};
  }
  function fire(el, type, Ctor) {
    var r = el.getBoundingClientRect(), init = {bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2};
    var Ev = window[Ctor] || window.MouseEvent;
    try { el.dispatchEvent(new Ev(type, init)); } catch (e) { el.dispatchEvent(new MouseEvent(type, init)); }
  }
  function act(el, a) {
    if (el.scrollIntoView) el.scrollIntoView({block: 'center', inline: 'center'});
    if (a.k === 'click') { if (el.focus) el.focus(); el.click(); }
    else if (a.k === 'long_click') {
      fire(el, 'pointerdown', 'PointerEvent'); fire(el, 'mousedown', 'MouseEvent');
      setTimeout(function () { fire(el, 'contextmenu', 'MouseEvent'); fire(el, 'pointerup', 'PointerEvent'); fire(el, 'mouseup', 'MouseEvent'); }, 600);
    } else if (a.k === 'input') {
      if (el.focus) el.focus();
      var v = String(a.arg == null ? '' : a.arg);
      if (el.isContentEditable) el.textContent = v;
      else {
        var proto = Object.getPrototypeOf(el), desc = null;
        while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
        if (desc && desc.set) desc.set.call(el, v); else el.value = v;  // native setter keeps React/Vue in sync
      }
      el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true}));
    }
  }
  window.__xsWeb = {v: 1,
    query: function (spec) {
      var set = spec.base ? spec.base.map(function (i) { return reg[i]; }).filter(function (e) { return e && e.isConnected; })
                          : Array.prototype.slice.call(document.querySelectorAll('*'));
      spec.steps.forEach(function (st) { set = (st.k === 'child' || st.k === 'brother' || st.k === 'parent') ? relate(set, st) : filter(set, st); });
      if (spec.limit > 0) set = set.slice(0, spec.limit);
      (spec.actions || []).forEach(function (a) { set.forEach(function (el) { act(el, a); }); });
      return set.map(describe);
    }};
})();
"""
# --- JS END ---
