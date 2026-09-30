/* Shared helpers for the XScript device tools (no build step, no dependencies). */
"use strict";

// Feather-style icon paths (24×24, stroke). Used as <i data-i="name"></i> or XS.icon("name").
const ICONS = {
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  images: '<rect x="7" y="3" width="14" height="14" rx="2"/><path d="M3 7v12a2 2 0 0 0 2 2h12"/><polyline points="21 13 17 9 10 16"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  pencil: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  sun: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  left: '<polyline points="15 18 9 12 15 6"/>',
  right: '<polyline points="9 18 15 12 9 6"/>',
  down: '<polyline points="6 9 12 15 18 9"/>',
  up: '<polyline points="18 15 12 9 6 15"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  crosshair: '<circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1" fill="currentColor"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.02-.24-.27-.38-.62-.38-1.01 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-8.97-10-8.97z"/>',
  droplet: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  compare: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  box: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  slash: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="7" y1="17" x2="17" y2="7"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  shuffle: '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
  package: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  puzzle: '<path d="M19.44 13.3a2.5 2.5 0 1 0-3.5-3.5V6a2 2 0 0 0-2-2h-3.8a2.5 2.5 0 1 0-3.5 0H4v4.3a2.5 2.5 0 1 1 0 3.5V18a2 2 0 0 0 2 2h3.8a2.5 2.5 0 1 1 3.5 0H18a2 2 0 0 0 2-2v-4.7z"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  tags: '<path d="M9 5H2v7l6.29 6.29a1 1 0 0 0 1.42 0l5.58-5.58a1 1 0 0 0 0-1.42z"/><path d="M13 5h1l7 7-6 6"/><circle cx="5.5" cy="8.5" r=".5"/>',
  "folder-plus": '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
};

const XS = {
  async api(method, path, body, opts = {}) {
    const init = { method, headers: { "X-XScript-Client": "tools" }, signal: opts.signal };
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      init.body = body;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    const r = await fetch(path, init);
    if (opts.raw) {
      if (!r.ok) throw new Error(await r.text());
      return r;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.status + " " + r.statusText);
    return data;
  },

  /** Legacy inline status line (home / 投屏 pages). */
  status(el, text, kind) {
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  },

  /** "#RRGGBB" (upper case, as AScript color strings use). */
  hex(r, g, b) {
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
  },

  rgb(hex) {
    const h = String(hex).replace(/^#/, "");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  },

  esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  },

  icon(name, cls) {
    return '<svg class="i' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      (ICONS[name] || "") + "</svg>";
  },

  /** Replace <i data-i="name"> placeholders with inline SVG. */
  hydrate(root = document) {
    root.querySelectorAll("i[data-i]").forEach((el) => {
      el.outerHTML = XS.icon(el.dataset.i, el.className);
    });
  },

  // ---- feedback ----

  toast(msg, kind, ms = 2200) {
    let el = document.getElementById("xs-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "xs-toast";
      el.className = "xs-toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    const icon = kind === "bad" ? "x" : kind === "ok" ? "check" : "help";
    el.innerHTML = XS.icon(icon) + "<span></span>";
    el.querySelector("span").textContent = msg;
    el.className = "xs-toast show" + (kind ? " " + kind : "");
    clearTimeout(XS._toastTimer);
    XS._toastTimer = setTimeout(() => el.classList.remove("show"), ms);
  },

  copy(text, label) {
    const done = () => XS.toast(label || "已复制：" + (text.length > 60 ? text.slice(0, 60) + "…" : text), "ok");
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => XS._fallbackCopy(text, done));
    } else {
      XS._fallbackCopy(text, done);
    }
  },

  // Plain http:// on a LAN IP is not a secure context, so the async clipboard API is absent.
  _fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch (e) {
      XS.toast("复制失败，请手动选择文本", "bad");
    } finally {
      ta.remove();
    }
  },

  // ---- dialogs (Promise based, keyboard friendly) ----

  _dialog({ title, body, input, placeholder, okText = "确定", cancelText = "取消", danger = false }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const back = document.createElement("div");
      back.className = "xs-dialog-backdrop";
      const id = "xs-dlg-" + Date.now();
      back.innerHTML =
        '<div class="xs-dialog" role="dialog" aria-modal="true" aria-labelledby="' + id + '">' +
        '<h2 id="' + id + '"></h2><div class="body"></div>' +
        '<div class="foot"><button type="button" data-a="cancel"></button>' +
        '<button type="button" data-a="ok" class="' + (danger ? "danger-primary" : "primary") + '"></button></div></div>';
      back.querySelector("h2").textContent = title;
      const bodyEl = back.querySelector(".body");
      if (body) {
        const p = document.createElement("div");
        p.textContent = body;
        bodyEl.appendChild(p);
      }
      let field = null;
      if (input !== undefined) {
        field = document.createElement("input");
        field.type = "text";
        field.value = input || "";
        field.placeholder = placeholder || "";
        field.setAttribute("aria-label", title);
        bodyEl.appendChild(field);
      }
      if (!bodyEl.childNodes.length) bodyEl.remove();
      back.querySelector('[data-a="ok"]').textContent = okText;
      back.querySelector('[data-a="cancel"]').textContent = cancelText;
      const close = (ok) => {
        back.remove();
        if (prev && prev.focus) prev.focus();
        resolve(ok ? (field ? field.value.trim() : true) : field ? null : false);
      };
      back.addEventListener("click", (e) => {
        if (e.target === back) close(false);
        const a = e.target.closest("[data-a]");
        if (a) close(a.dataset.a === "ok");
      });
      back.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") close(false);
        else if (e.key === "Enter" && !e.isComposing && (e.target === field || e.target.dataset.a === undefined)) close(true);
        else if (e.key === "Tab") {
          const f = Array.from(back.querySelectorAll("input,button"));
          const i = f.indexOf(document.activeElement);
          const next = f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length];
          e.preventDefault();
          next.focus();
        }
      });
      document.body.appendChild(back);
      (field || back.querySelector('[data-a="ok"]')).focus();
      if (field) field.select();
    });
  },

  confirm(title, body, opts = {}) {
    return XS._dialog({ title, body, danger: opts.danger, okText: opts.okText || "确定" });
  },

  prompt(title, value, opts = {}) {
    return XS._dialog({ title, body: opts.body, input: value || "", placeholder: opts.placeholder, okText: opts.okText });
  },

  /** Context menu at client coords. items: [{label, hint, action, disabled}] or "-". */
  menu(x, y, items) {
    XS.closeMenu();
    const m = document.createElement("div");
    m.className = "xs-menu";
    m.setAttribute("role", "menu");
    items.forEach((it) => {
      if (it === "-") {
        m.appendChild(document.createElement("hr"));
        return;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.disabled = !!it.disabled;
      b.innerHTML = (it.icon ? XS.icon(it.icon) : "") + "<span></span>" + (it.hint ? '<span class="hint"></span>' : "");
      b.querySelector("span").textContent = it.label;
      if (it.hint) b.querySelector(".hint").textContent = it.hint;
      b.onclick = () => {
        XS.closeMenu();
        it.action();
      };
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth - r.width - 4) + "px";
    m.style.top = Math.min(y, window.innerHeight - r.height - 4) + "px";
    const btns = () => Array.from(m.querySelectorAll("button:not(:disabled)"));
    m.addEventListener("keydown", (e) => {
      const list = btns();
      const i = list.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        list[(i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length].focus();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        XS.closeMenu();
      }
    });
    const first = btns()[0];
    if (first) first.focus({ preventScroll: true });
    XS._menu = m;
    setTimeout(() => {
      XS._menuOff = (e) => {
        if (!m.contains(e.target)) XS.closeMenu();
      };
      window.addEventListener("pointerdown", XS._menuOff, true);
      window.addEventListener("blur", XS.closeMenu);
    });
  },

  closeMenu() {
    if (!XS._menu) return;
    XS._menu.remove();
    XS._menu = null;
    window.removeEventListener("pointerdown", XS._menuOff, true);
    window.removeEventListener("blur", XS.closeMenu);
  },

  // ---- theme: auto (system) → light → dark ----

  theme: {
    mode() {
      const m = localStorage.getItem("xs-theme");
      return m === "light" || m === "dark" ? m : "auto";
    },
    apply() {
      const m = XS.theme.mode();
      const dark = m === "dark" || (m === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      const label = { auto: "主题：跟随系统", light: "主题：浅色", dark: "主题：深色" }[m];
      document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
        b.innerHTML = XS.icon(m === "light" ? "sun" : m === "dark" ? "moon" : "contrast");
        b.title = label + "（点击切换）";
        b.setAttribute("aria-label", label);
      });
      window.dispatchEvent(new Event("xs-theme"));
    },
    cycle() {
      const order = ["auto", "light", "dark"];
      const next = order[(order.indexOf(XS.theme.mode()) + 1) % order.length];
      if (next === "auto") localStorage.removeItem("xs-theme");
      else localStorage.setItem("xs-theme", next);
      XS.theme.apply();
      XS.toast({ auto: "主题：跟随系统", light: "主题：浅色", dark: "主题：深色" }[next]);
    },
  },

  // ---- code ----

  /** Minimal Python highlighter for the code previews. */
  highlightPy(src) {
    const re = /(#[^\n]*)|(r?"(?:[^"\\\n]|\\.)*"|r?'(?:[^'\\\n]|\\.)*')|\b(from|import|if|else|elif|for|in|not|and|or|None|True|False|return|def|while)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_]\w*)(?=\()/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      const cls = m[1] ? "c" : m[2] ? "s" : m[3] ? "k" : m[4] ? "n" : "f";
      out += XS.esc(src.slice(last, m.index)) + '<span class="' + cls + '">' + XS.esc(m[0]) + "</span>";
      last = re.lastIndex;
    }
    return out + XS.esc(src.slice(last));
  },

  /** Python string literal; raw string when the text has backslashes (regex patterns). */
  pyStr(s) {
    s = String(s);
    if (s.includes("\\") && !/["\n]/.test(s) && !s.endsWith("\\")) return 'r"' + s + '"';
    return JSON.stringify(s);
  },

  // ---- images ----

  /** Load an image URL into an offscreen canvas for exact pixel reads. */
  async loadPixels(url) {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = { img, canvas: c, ctx, width: c.width, height: c.height, data: null };
    px.at = (x, y) => XS.pixelAt(px, x, y);
    return px;
  },

  /** "#RRGGBB" at (x, y), or null outside the image. Reads the full buffer once. */
  pixelAt(px, x, y) {
    if (!px || x < 0 || y < 0 || x >= px.width || y >= px.height) return null;
    if (!px.data) px.data = px.ctx.getImageData(0, 0, px.width, px.height).data;
    const i = (y * px.width + x) * 4;
    return XS.hex(px.data[i], px.data[i + 1], px.data[i + 2]);
  },

  /** PNG/JPEG pass through; anything the browser can decode (webp, bmp, gif) becomes PNG. */
  async toUploadable(file, pngOnly) {
    if (file.type === "image/png" || (!pngOnly && file.type === "image/jpeg")) return file;
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    return await new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("图片转换失败"))), "image/png"));
  },

  /** "[l, t, r, b]" or null from free text like "1,2,3,4" / "[1, 2, 3, 4]" / "1 2 3 4". */
  parseRect(text) {
    const nums = String(text || "").split(/[\s,，\[\]()]+/).filter(Boolean).map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;
    const r = nums.map(Math.round);
    return r[2] > r[0] && r[3] > r[1] ? r : null;
  },

  isTyping() {
    const a = document.activeElement;
    return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
  },
};

/**
 * Zoomable, pannable view of an image on a <canvas>, with an overlay draw callback.
 * Points handed to callers carry image pixels (x, y floored; fx, fy exact) and canvas
 * pixels (cx, cy, already multiplied by devicePixelRatio).
 *
 * Left button → tool (onPointer), right / middle button or Space + drag → pan,
 * right click without moving → onContext, wheel / pinch → zoom around the cursor.
 */
class ImageView {
  constructor(canvas, { onDraw, onPointer, onContext, onView } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onDraw = onDraw || (() => {});
    this.onPointer = onPointer || (() => {});
    this.onContext = onContext || null;
    this.onView = onView || (() => {});
    this.img = null;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.fitted = true;
    this._pan = null;
    this._tool = false;
    this._touches = new Map();
    this._pinch = null;
    this._raf = 0;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  setImage(img, keepView) {
    const same = keepView && this.img && img && this.img.width === img.width && this.img.height === img.height;
    this.img = img;
    if (same) this.draw();
    else this.fit();
  }

  resize() {
    const p = this.canvas.parentElement;
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(p.clientWidth * this.dpr));
    const h = Math.max(1, Math.floor(p.clientHeight * this.dpr));
    if (w === this.canvas.width && h === this.canvas.height) return;
    // Keep the image point at the centre stable across resizes when the user has zoomed.
    const c = this.img && !this.fitted ? this.toImageF(this.canvas.width / 2, this.canvas.height / 2) : null;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = p.clientWidth + "px";
    this.canvas.style.height = p.clientHeight + "px";
    if (this.fitted) this.fit();
    else {
      if (c) this.centerOn(c.x, c.y);
      this.draw();
    }
  }

  get fitScale() {
    if (!this.img) return 1;
    const pad = 16 * this.dpr;
    const s = Math.min((this.canvas.width - 2 * pad) / this.img.width, (this.canvas.height - 2 * pad) / this.img.height);
    return s > 0 && Number.isFinite(s) ? s : 1;
  }

  /** Zoom as a share of device pixels (100% = one image pixel per screen pixel). */
  get zoom() {
    return this.scale / this.dpr;
  }

  fit() {
    this.fitted = true;
    if (this.img) {
      this.scale = this.fitScale;
      this.ox = (this.canvas.width - this.img.width * this.scale) / 2;
      this.oy = (this.canvas.height - this.img.height * this.scale) / 2;
    }
    this.draw();
  }

  /** Fit an image rect [l, t, r, b] into the view with some padding. */
  zoomTo(r, pad = 48) {
    if (!this.img) return;
    const p = pad * this.dpr;
    const w = Math.max(1, r[2] - r[0]);
    const h = Math.max(1, r[3] - r[1]);
    this.scale = Math.min(64 * this.dpr, Math.max(0.02, Math.min((this.canvas.width - 2 * p) / w, (this.canvas.height - 2 * p) / h)));
    this.centerOn((r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
  }

  centerOn(x, y) {
    this.fitted = false;
    this.ox = this.canvas.width / 2 - x * this.scale;
    this.oy = this.canvas.height / 2 - y * this.scale;
    this.draw();
  }

  zoomAt(factor, cx, cy) {
    if (!this.img) return;
    const min = Math.min(this.fitScale * 0.5, 0.05);
    const next = Math.min(64 * this.dpr, Math.max(min, this.scale * factor));
    this.ox = cx - (cx - this.ox) * (next / this.scale);
    this.oy = cy - (cy - this.oy) * (next / this.scale);
    this.scale = next;
    this.fitted = false;
    this.draw();
  }

  zoomBy(factor) {
    this.zoomAt(factor, this.canvas.width / 2, this.canvas.height / 2);
  }

  toImageF(cx, cy) {
    return { x: (cx - this.ox) / this.scale, y: (cy - this.oy) / this.scale };
  }

  /** Canvas pixel → image pixel (floored). */
  toImage(cx, cy) {
    const f = this.toImageF(cx, cy);
    return { x: Math.floor(f.x), y: Math.floor(f.y) };
  }

  /** Image pixel → canvas pixel. */
  toCanvas(x, y) {
    return { x: this.ox + x * this.scale, y: this.oy + y * this.scale };
  }

  eventPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { cx: (e.clientX - r.left) * this.dpr, cy: (e.clientY - r.top) * this.dpr };
  }

  inside(p) {
    return !!this.img && p.x >= 0 && p.y >= 0 && p.x < this.img.width && p.y < this.img.height;
  }

  /** Coalesce redraws into one frame. */
  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.paint();
    });
  }

  paint() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.img) {
      const w = this.img.width * this.scale;
      const h = this.img.height * this.scale;
      ctx.imageSmoothingEnabled = this.scale < 1;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.img, this.ox, this.oy, w, h);
      if (this.scale >= 14 * this.dpr) this._grid();
      this.onDraw(ctx, this);
    }
    this.onView(this);
  }

  /** Pixel grid at high zoom, only over the visible part of the image. */
  _grid() {
    const { ctx, canvas, scale } = this;
    const x0 = Math.max(0, Math.floor(-this.ox / scale));
    const y0 = Math.max(0, Math.floor(-this.oy / scale));
    const x1 = Math.min(this.img.width, Math.ceil((canvas.width - this.ox) / scale));
    const y1 = Math.min(this.img.height, Math.ceil((canvas.height - this.oy) / scale));
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      const cx = Math.round(this.ox + x * scale) + 0.5;
      ctx.moveTo(cx, this.oy + y0 * scale);
      ctx.lineTo(cx, this.oy + y1 * scale);
    }
    for (let y = y0; y <= y1; y++) {
      const cy = Math.round(this.oy + y * scale) + 0.5;
      ctx.moveTo(this.ox + x0 * scale, cy);
      ctx.lineTo(this.ox + x1 * scale, cy);
    }
    ctx.strokeStyle = "rgba(128,128,128,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  _pt(pt) {
    const f = this.toImageF(pt.cx, pt.cy);
    return { x: Math.floor(f.x), y: Math.floor(f.y), fx: f.x, fy: f.y, cx: pt.cx, cy: pt.cy };
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener("wheel", (e) => {
      if (!this.img) return;
      e.preventDefault();
      const { cx, cy } = this.eventPoint(e);
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      this.zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), cx, cy);
    }, { passive: false });

    c.addEventListener("pointerdown", (e) => {
      if (!this.img) return;
      const pt = this.eventPoint(e);
      if (e.pointerType === "touch") {
        this._touches.set(e.pointerId, pt);
        if (this._touches.size === 2) {
          if (this._tool) {
            this._tool = false;
            this.onPointer("cancel", this._pt(pt), e);
          }
          const [a, b] = Array.from(this._touches.values());
          const mid = { cx: (a.cx + b.cx) / 2, cy: (a.cy + b.cy) / 2 };
          this._pinch = { d: Math.hypot(a.cx - b.cx, a.cy - b.cy) || 1, scale: this.scale, anchor: this.toImageF(mid.cx, mid.cy) };
          c.setPointerCapture(e.pointerId);
          return;
        }
        if (this._touches.size > 2) return;
      }
      if (e.button === 1 || e.button === 2 || ImageView.spaceDown) {
        this._pan = { x: pt.cx, y: pt.cy, ox: this.ox, oy: this.oy, moved: false, button: e.button };
        c.setPointerCapture(e.pointerId);
        c.style.cursor = "grabbing";
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      this._tool = true;
      this.onPointer("down", this._pt(pt), e);
    });

    c.addEventListener("pointermove", (e) => {
      if (!this.img) return;
      const pt = this.eventPoint(e);
      if (this._touches.has(e.pointerId)) {
        this._touches.set(e.pointerId, pt);
        if (this._pinch && this._touches.size >= 2) {
          const [a, b] = Array.from(this._touches.values());
          const mid = { cx: (a.cx + b.cx) / 2, cy: (a.cy + b.cy) / 2 };
          const d = Math.hypot(a.cx - b.cx, a.cy - b.cy) || 1;
          this.scale = Math.min(64 * this.dpr, Math.max(0.02, this._pinch.scale * (d / this._pinch.d)));
          this.ox = mid.cx - this._pinch.anchor.x * this.scale;
          this.oy = mid.cy - this._pinch.anchor.y * this.scale;
          this.fitted = false;
          this.draw();
          return;
        }
      }
      if (this._pan) {
        const dx = pt.cx - this._pan.x;
        const dy = pt.cy - this._pan.y;
        if (Math.hypot(dx, dy) > 3 * this.dpr) this._pan.moved = true;
        this.ox = this._pan.ox + dx;
        this.oy = this._pan.oy + dy;
        this.fitted = false;
        this.draw();
        return;
      }
      this.onPointer("move", this._pt(pt), e);
    });

    const end = (e) => {
      if (this._touches.has(e.pointerId)) {
        this._touches.delete(e.pointerId);
        if (this._pinch) {
          if (this._touches.size < 2) this._pinch = null;
          return;
        }
      }
      if (this._pan) {
        const p = this._pan;
        this._pan = null;
        c.style.cursor = "";
        if (!p.moved && p.button === 2 && this.onContext && e.type === "pointerup") this.onContext(this._pt(this.eventPoint(e)), e);
        return;
      }
      if (!this._tool) return;
      this._tool = false;
      this.onPointer(e.type === "pointercancel" ? "cancel" : "up", this._pt(this.eventPoint(e)), e);
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("pointerleave", (e) => {
      if (!this._tool && !this._pan) this.onPointer("leave", null, e);
    });
    c.addEventListener("dblclick", (e) => {
      if (this.img) this.onPointer("dblclick", this._pt(this.eventPoint(e)), e);
    });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
  }
}
ImageView.spaceDown = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !XS.isTyping() && !e.repeat) {
    ImageView.spaceDown = true;
    document.body.classList.add("space-pan");
  }
  if (e.code === "Space" && !XS.isTyping() && document.activeElement.tagName !== "BUTTON") e.preventDefault();
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    ImageView.spaceDown = false;
    document.body.classList.remove("space-pan");
  }
});
window.addEventListener("blur", () => {
  ImageView.spaceDown = false;
  document.body.classList.remove("space-pan");
});

/** Floating magnifier next to the pointer: 11×11 pixels, coordinate and color. */
class PixelHud {
  constructor() {
    this.el = document.createElement("div");
    this.el.className = "hud";
    this.el.hidden = true;
    this.el.setAttribute("aria-hidden", "true");
    this.el.innerHTML = '<canvas width="11" height="11"></canvas><div><div class="pos"></div><div><span class="swatch"></span> <span class="hex"></span></div></div>';
    document.body.appendChild(this.el);
    this.ctx = this.el.querySelector("canvas").getContext("2d");
  }

  show(clientX, clientY, px, x, y) {
    const color = XS.pixelAt(px, x, y);
    if (!color) return this.hide();
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 11, 11);
    ctx.drawImage(px.canvas, x - 5, y - 5, 11, 11, 0, 0, 11, 11);
    ctx.strokeStyle = "#ff3b30";
    ctx.lineWidth = 0.16;
    ctx.strokeRect(5, 5, 1, 1);
    this.el.querySelector(".pos").textContent = x + ", " + y;
    this.el.querySelector(".swatch").style.background = color;
    this.el.querySelector(".hex").textContent = color;
    this.el.hidden = false;
    const r = this.el.getBoundingClientRect();
    let left = clientX + 18;
    let top = clientY + 18;
    if (left + r.width > window.innerWidth - 4) left = clientX - r.width - 18;
    if (top + r.height > window.innerHeight - 4) top = clientY - r.height - 18;
    this.el.style.left = left + "px";
    this.el.style.top = top + "px";
  }

  hide() {
    this.el.hidden = true;
  }
}

// ---- shared top navigation (every tool page has <header class="xs-appbar" data-page="...">) ----

XS.TOOLS = [
  { id: "color", name: "图色工具", icon: "palette", href: "/tools/ui/color.html", desc: "找色 · 比色 · 找图 · 文字识别" },
  { id: "label", name: "标注工具", icon: "tag", href: "/tools/ui/label.html", desc: "YOLO 数据集标注与导出" },
  { id: "mirror", name: "投屏", icon: "phone", href: "/tools/ui/mirror.html", desc: "实时画面与远程操控" },
];
XS.IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "⌥1" on macOS, "Alt+1" elsewhere: the shortcut that opens tool n (1-based). */
XS.navKey = (n) => (XS.IS_MAC ? "⌥" : "Alt+") + n;

XS._guards = [];
XS._leave = [];
/** `fn()` → false (or Promise<false>) cancels an XS.go navigation, e.g. "auto capture is running". */
XS.guardLeave = (fn) => XS._guards.push(fn);
/** Run `fn` (may return a Promise) before XS.go leaves the page, e.g. to flush unsaved edits. */
XS.onLeave = (fn) => XS._leave.push(fn);

/** Navigate to another tool after the page's guards pass and leave hooks finish (hooks are capped at 2.5 s). */
XS.go = async (href) => {
  if (XS._going) return;
  XS._going = true;
  try {
    for (const g of XS._guards) {
      if ((await Promise.resolve().then(g).catch(() => true)) === false) return;
    }
    document.body.classList.add("xa-leaving");
    await Promise.race([
      Promise.all(XS._leave.map((f) => Promise.resolve().then(f).catch(() => {}))),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
    XS._leaving = true;
    location.href = href;
  } finally {
    // Stay usable if the navigation does not happen.
    setTimeout(() => {
      XS._going = false;
      XS._leaving = false;
      document.body.classList.remove("xa-leaving");
    }, XS._leaving ? 3000 : 0);
  }
};

/** One-shot query parameter: read it and drop it from the address bar so a reload does not repeat it. */
XS.takeParam = (name) => {
  const u = new URL(location.href);
  const v = u.searchParams.get(name);
  if (v !== null) {
    u.searchParams.delete(name);
    history.replaceState(null, "", u);
  }
  return v;
};

XS.device = null;

XS.appbar = {
  init() {
    const bar = document.querySelector("header.xs-appbar");
    if (!bar) return;
    const page = bar.dataset.page;
    const tabs = XS.TOOLS.map((t, i) =>
      '<a class="xa-tab" href="' + t.href + '"' + (t.id === page ? ' aria-current="page"' : "") +
      ' title="' + XS.esc(t.name + " · " + t.desc + "（" + XS.navKey(i + 1) + "）") + '">' +
      XS.icon(t.icon) + '<span class="n">' + t.name + '</span><kbd class="xa-key">' + XS.navKey(i + 1) + "</kbd></a>").join("");
    bar.innerHTML =
      '<a class="xa-brand" href="/tools/"' + (page === "home" ? ' aria-current="page"' : "") + ' title="XScript 开发工具首页（' + XS.navKey(0) + '）">' +
      XS.icon("code") + '<span class="n">XScript</span></a>' +
      '<nav class="xa-tabs" aria-label="开发工具">' + tabs + "</nav>" +
      '<span class="spacer"></span>' +
      '<button type="button" class="xa-dev" id="xa-dev" aria-haspopup="menu"><span class="dot"></span><span class="t">连接中…</span></button>' +
      '<button class="icon-btn" type="button" data-theme-toggle></button>';

    // Leave through XS.go so pages can save first; modified clicks keep their browser meaning.
    bar.addEventListener("click", (e) => {
      const a = e.target.closest("a[href]");
      if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (a.getAttribute("aria-current") !== "page") XS.go(a.href);
    });
    // Warm the cache for the other pages on hover.
    bar.addEventListener("pointerenter", (e) => {
      const a = e.target.closest && e.target.closest("a[href]");
      if (!a || a.dataset.pf) return;
      a.dataset.pf = "1";
      const l = document.createElement("link");
      l.rel = "prefetch";
      l.href = a.href;
      document.head.appendChild(l);
    }, true);
    document.getElementById("xa-dev").onclick = (e) => XS.appbar.deviceMenu(e.currentTarget);

    window.addEventListener("keydown", (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const m = /^Digit([0-9])$/.exec(e.code);
      if (!m) return;
      const n = Number(m[1]);
      const href = n === 0 ? "/tools/" : XS.TOOLS[n - 1] && XS.TOOLS[n - 1].href;
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = n === 0 ? page === "home" : XS.TOOLS[n - 1].id === page;
      if (!cur) XS.go(href);
    }, true);

    XS.appbar.poll();
    setInterval(() => !document.hidden && XS.appbar.poll(), 5000);
    document.addEventListener("visibilitychange", () => !document.hidden && XS.appbar.poll());
  },

  async poll() {
    const el = document.getElementById("xa-dev");
    if (!el || XS.appbar._polling) return;
    XS.appbar._polling = true;
    const ctl = window.AbortController ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), 4000);
    try {
      XS.device = await XS.api("GET", "/status", undefined, { signal: ctl && ctl.signal });
    } catch (e) {
      XS.device = null;
    } finally {
      clearTimeout(timer);
      XS.appbar._polling = false;
    }
    const s = XS.device;
    el.classList.toggle("off", !s);
    el.classList.toggle("run", !!(s && s.running));
    const t = el.querySelector(".t");
    if (!s) {
      t.textContent = "设备离线";
      el.title = "连不上设备的 HTTP 服务：确认手机上 XScript 已打开，USB 连接时执行 adb forward";
    } else {
      t.textContent = (s.model || s.name || "设备") + (s.running ? " · 运行中" : "");
      el.title = (s.model || "") + " · Android " + (s.release || "?") + " · " + s.width + "×" + s.height +
        (s.running ? "\n正在运行：" + (s.project || "") : "") + "\n点击查看详情";
    }
    window.dispatchEvent(new CustomEvent("xs-device", { detail: s }));
  },

  deviceMenu(btn) {
    const s = XS.device;
    const r = btn.getBoundingClientRect();
    const yes = (v) => (v ? "已开启" : "未开启");
    const items = s ? [
      { label: s.model || s.name || "设备", hint: "Android " + (s.release || "?"), icon: "phone", disabled: true },
      { label: "分辨率", hint: s.width + "×" + s.height, icon: "fit", disabled: true },
      { label: "无障碍", hint: yes(s.accessibility), icon: "check", disabled: true },
      { label: "截图", hint: s.capture ? "可用" : "不可用", icon: "camera", disabled: true },
      { label: s.running ? "运行中：" + (s.project || "") : "没有运行中的脚本", icon: s.running ? "play" : "stop", disabled: true },
      { label: "版本", hint: s.version || "-", icon: "package", disabled: true },
      "-",
      { label: "复制局域网地址", hint: s.ip ? s.ip + ":" + s.port : "", icon: "copy", disabled: !s.ip, action: () => XS.copy("http://" + s.ip + ":" + s.port + "/tools/") },
      { label: "刷新状态", icon: "refresh", action: () => XS.appbar.poll() },
    ] : [
      { label: "设备离线", icon: "x", disabled: true },
      { label: "重试连接", icon: "refresh", action: () => XS.appbar.poll() },
    ];
    XS.menu(r.right - 190, r.bottom + 4, items);
  },
};

XS.appbar.init();
XS.hydrate();
XS.theme.apply();
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-theme-toggle]")) XS.theme.cycle();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => XS.theme.mode() === "auto" && XS.theme.apply());
