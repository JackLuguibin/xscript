"use strict";
/*
 * 图色工具 host (AScript screen.html layout): snapshot tabs, selection, marks, and the plugin panel.
 * Plugins (plug-colors.js, plug-image.js) register in window.XS_PLUGINS before this file loads.
 *
 * Plugin contract:
 *   { id, name, icon, mount(panel, host), unmount?(),
 *     onRect?(rect|null), onPick?(pt) → bool, onSlotKey?(k, pt), onTab?(tab),
 *     marks?(tab) → {points: [{x, y, n, state, label}], rects: [{rect, n, state, label}]},
 *     clearResults?() }
 */

const $ = (id) => document.getElementById(id);
const PLUGINS = window.XS_PLUGINS || [];
const LS = { tabs: "xs-color-tabs", plug: "xs-color-plug", width: "xs-color-viewer-w", style: "xs-code-style" };
const MARK = { ok: "#12a150", bad: "#e5484d", warn: "#f59e0b", info: "#2f7cf6", accent: "#007acc" };
const ORI = [
  [1, "左上→右下 (纵向)"], [2, "左上→右下 (横向)"], [3, "右上→左下 (横向)"], [4, "右上→左下 (纵向)"],
  [5, "右下→左上 (纵向)"], [6, "右下→左上 (横向)"], [7, "左下→右上 (横向)"], [8, "左下→右上 (纵向)"],
];

const host = {
  tabs: [],
  active: -1,
  hover: null,      // {x, y, color} under the pointer
  highlight: null,  // {x, y} or {rect} flashed from a plugin list
  plugin: null,
  drag: null,
  zoomedToSel: false,
  get tab() {
    return this.tabs[this.active] || null;
  },
  get rect() {
    const t = this.tab;
    return t ? t.rect : null;
  },
  get codeStyle() {
    return localStorage.getItem(LS.style) === "xscript" ? "xscript" : "ascript";
  },
  ORI,
  MARK,
};

const view = new ImageView($("view"), { onDraw: drawOverlay, onPointer, onContext, onView: updateZoom });
const hud = new PixelHud();
let tabSeq = 0;

// ---------------------------------------------------------------- helpers

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function snapDate(id) {
  const ms = Number(String(id).split("_")[0]);
  return Number.isFinite(ms) && ms > 1e12 ? new Date(ms) : null;
}

function timeLabel(id) {
  const d = snapDate(id);
  return d ? d.toLocaleTimeString("zh-CN", { hour12: false }) : String(id);
}

function rectText(r) {
  return r ? "[" + r.join(", ") + "]" : "";
}

function busy(on, text) {
  $("loading").hidden = !on;
  if (text) $("loading-text").textContent = text;
}

function pluginCall(name, ...args) {
  const p = host.plugin;
  return p && typeof p[name] === "function" ? p[name](...args) : undefined;
}

function cropCanvas(tab, r) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, r[2] - r[0]);
  c.height = Math.max(1, r[3] - r[1]);
  c.getContext("2d").drawImage(tab.px.canvas, r[0], r[1], c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

function download(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------- tabs

async function openSnap(snap, name, { activate = true } = {}) {
  const found = host.tabs.findIndex((t) => t.snap.id === snap.id);
  if (found >= 0) {
    if (activate) activateTab(found);
    return host.tabs[found];
  }
  const px = await XS.loadPixels(snap.url);
  const tab = {
    key: ++tabSeq,
    snap: { id: snap.id, url: snap.url, width: px.width, height: px.height },
    name: name || "截图 " + timeLabel(snap.id),
    px,
    rect: null,
    vs: null,
  };
  host.tabs.push(tab);
  if (activate) activateTab(host.tabs.length - 1);
  else renderTabs();
  saveTabs();
  return tab;
}

function saveView() {
  const cur = host.tab;
  if (cur && view.img) cur.vs = { scale: view.scale, ox: view.ox, oy: view.oy, fitted: view.fitted };
}

/**
 * Tabs, selection, zoom and the plugin state survive a trip to another tool within this browser tab
 * (sessionStorage), so switching 图色 → 标注 → 图色 comes back to the same place.
 */
const SESSION = "xs-color-session";

function saveSession() {
  saveView();
  const tabs = host.tabs.map((t) => ({ id: t.snap.id, name: t.name, rect: t.rect, vs: t.vs }));
  const plugins = {};
  PLUGINS.forEach((p) => typeof p.saveState === "function" && (plugins[p.id] = p.saveState()));
  try {
    sessionStorage.setItem(SESSION, JSON.stringify({ tabs, active: host.tab ? host.tab.snap.id : null, plugins }));
  } catch (e) {
    /* quota: fall back to the tab list in localStorage */
  }
}

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION) || "null");
  } catch (e) {
    return null;
  }
}

function activateTab(i) {
  if (i !== host.active) saveView();
  host.active = i;
  host.drag = null;
  host.zoomedToSel = false;
  host.hover = null;
  hud.hide();
  const t = host.tab;
  if (!t) {
    view.setImage(null);
  } else if (t.vs && !t.vs.fitted) {
    view.img = t.px.canvas;
    view.scale = t.vs.scale;
    view.ox = t.vs.ox;
    view.oy = t.vs.oy;
    view.fitted = false;
    view.draw();
  } else {
    view.setImage(t.px.canvas);
  }
  renderTabs();
  updateChrome();
  saveTabs();
  pluginCall("onTab", t);
  pluginCall("onRect", t ? t.rect : null);
}

function closeTab(i) {
  if (i < 0 || i >= host.tabs.length) return;
  saveView();
  const wasActive = i === host.active;
  host.tabs.splice(i, 1);
  let next = host.active;
  if (wasActive) next = Math.min(i, host.tabs.length - 1);
  else if (i < host.active) next = host.active - 1;
  host.active = -1;
  activateTab(next);
}

function closeTabsOf(snapId) {
  const i = host.tabs.findIndex((t) => t.snap.id === snapId);
  if (i >= 0) closeTab(i);
}

async function renameTab(i) {
  const t = host.tabs[i];
  const name = await XS.prompt("重命名标签", t.name);
  if (!name) return;
  t.name = name.slice(0, 40);
  renderTabs();
  saveTabs();
}

function renderTabs() {
  const box = $("tabs");
  box.innerHTML = "";
  host.tabs.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "tab";
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(i === host.active));
    el.tabIndex = i === host.active ? 0 : -1;
    el.title = t.name + " · " + t.snap.width + "×" + t.snap.height + "（双击重命名，中键关闭）";
    el.innerHTML = XS.icon("image") + '<span class="name"></span>' +
      '<button type="button" class="close" tabindex="-1">' + XS.icon("x") + "</button>";
    el.querySelector(".name").textContent = t.name;
    el.querySelector(".close").setAttribute("aria-label", "关闭 " + t.name);
    el.addEventListener("click", (e) => {
      if (e.target.closest(".close")) closeTab(i);
      else if (i !== host.active) activateTab(i);
    });
    el.addEventListener("auxclick", (e) => e.button === 1 && closeTab(i));
    el.addEventListener("dblclick", (e) => !e.target.closest(".close") && renameTab(i));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Delete") closeTab(i);
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const n = clamp(i + (e.key === "ArrowRight" ? 1 : -1), 0, host.tabs.length - 1);
        activateTab(n);
        box.children[n] && box.children[n].focus();
      } else return;
      e.preventDefault();
    });
    box.appendChild(el);
  });
  $("btn-close-tabs").hidden = host.tabs.length < 2;
  const a = box.children[host.active];
  if (a) a.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function saveTabs() {
  const data = { tabs: host.tabs.map((t) => ({ id: t.snap.id, name: t.name })), active: host.tab ? host.tab.snap.id : null };
  localStorage.setItem(LS.tabs, JSON.stringify(data));
}

/**
 * Reopen the tabs of the previous visit when the device still has those snapshots. Within the same
 * browser tab the session copy also brings back selections, zoom and plugin state; a `?snapshot=` link
 * (e.g. from 标注工具) opens that snapshot on top.
 */
async function restoreTabs(session, openId, openName) {
  let saved = session;
  if (!saved) {
    try {
      saved = JSON.parse(localStorage.getItem(LS.tabs) || "null");
    } catch (e) {
      saved = null;
    }
  }
  const want = (saved && saved.tabs) || [];
  if (!want.length && !openId) return;
  busy(true, "恢复标签…");
  try {
    const out = await XS.api("GET", "/tools/snapshots");
    const byId = new Map(out.snapshots.map((s) => [s.id, s]));
    for (const t of want) {
      const s = byId.get(t.id);
      if (!s) continue;
      const tab = await openSnap(s, t.name, { activate: false }).catch(() => null);
      if (tab && session) {
        tab.rect = t.rect ? normRect(t.rect, tab) : null;
        tab.vs = t.vs || null;
      }
    }
    let active = saved ? saved.active : null;
    if (openId) {
      const s = byId.get(openId);
      if (s) {
        await openSnap(s, openName, { activate: false }).catch(() => null);
        active = openId;
      } else XS.toast("截图 " + openId + " 已被设备清理", "bad");
    }
    const i = host.tabs.findIndex((t) => t.snap.id === active);
    if (host.tabs.length) activateTab(i >= 0 ? i : host.tabs.length - 1);
  } catch (e) {
    /* device offline: start empty */
  } finally {
    busy(false);
  }
}

// ---------------------------------------------------------------- capture / upload

async function capture() {
  if (host.capturing) return;
  host.capturing = true;
  $("btn-capture").classList.add("busy");
  busy(true, "截图中…");
  try {
    const snap = await XS.api("POST", "/tools/snapshots");
    await openSnap(snap);
  } catch (e) {
    const msg = /capture_unavailable/.test(e.message)
      ? "截图不可用：请在 XScript App 中开启录屏或无障碍截图权限"
      : "截图失败：" + e.message;
    XS.toast(msg, "bad", 4000);
  } finally {
    host.capturing = false;
    $("btn-capture").classList.remove("busy");
    busy(false);
  }
}

async function uploadFiles(files) {
  const list = Array.from(files || []).filter((f) => /^image\//.test(f.type));
  if (!list.length) return XS.toast("请选择图片文件", "bad");
  busy(true, "上传中…");
  try {
    for (const f of list) {
      const blob = await XS.toUploadable(f, true);
      const snap = await XS.api("POST", "/tools/snapshots", blob);
      await openSnap(snap, (f.name || "图片").replace(/\.[^.]+$/, "").slice(0, 40));
    }
  } catch (e) {
    XS.toast("上传失败：" + e.message, "bad", 3500);
  } finally {
    busy(false);
  }
}

host.uploadPng = async (file) => XS.api("POST", "/tools/snapshots", await XS.toUploadable(file, true));

// ---------------------------------------------------------------- gallery

function galleryOpen() {
  return !$("gallery").hidden;
}

async function openGallery() {
  $("gallery").hidden = false;
  $("btn-gallery").setAttribute("aria-pressed", "true");
  const grid = $("gallery-grid");
  grid.innerHTML = '<div class="empty-hint"><span class="spin"></span> 加载中…</div>';
  $("gallery-close").focus();
  try {
    const out = await XS.api("GET", "/tools/snapshots");
    renderGallery(out.snapshots);
  } catch (e) {
    grid.innerHTML = '<div class="empty-hint bad"></div>';
    grid.firstChild.textContent = "加载失败：" + e.message;
  }
}

function closeGallery() {
  $("gallery").hidden = true;
  $("btn-gallery").setAttribute("aria-pressed", "false");
}

function toggleGallery() {
  if (galleryOpen()) closeGallery();
  else openGallery();
}

function renderGallery(list) {
  const grid = $("gallery-grid");
  const count = () => {
    const n = grid.querySelectorAll(".g-item").length;
    $("gallery-count").textContent = n ? n + " 张" : "";
    $("gallery-clear").disabled = !n;
    if (!n) grid.innerHTML = '<div class="empty-hint">还没有缓存截图，点左侧相机图标截图</div>';
  };
  grid.innerHTML = "";
  list.forEach((s) => {
    const item = document.createElement("div");
    item.className = "g-item" + (host.tabs.some((t) => t.snap.id === s.id) ? " is-open" : "");
    item.innerHTML = '<button type="button" class="open"><img loading="lazy" alt=""><span class="meta"></span></button>' +
      '<button type="button" class="del">' + XS.icon("trash") + "</button>";
    const meta = timeLabel(s.id) + (s.width ? " · " + s.width + "×" + s.height : "");
    item.querySelector("img").src = s.url;
    item.querySelector(".meta").textContent = meta;
    item.querySelector(".open").title = "打开 " + meta;
    item.querySelector(".del").setAttribute("aria-label", "删除截图 " + meta);
    item.querySelector(".open").onclick = async () => {
      closeGallery();
      busy(true, "加载中…");
      try {
        await openSnap(s);
      } catch (e) {
        XS.toast("打开失败：" + e.message, "bad");
      } finally {
        busy(false);
      }
    };
    item.querySelector(".del").onclick = async () => {
      try {
        await XS.api("DELETE", "/tools/snapshots/" + encodeURIComponent(s.id));
        closeTabsOf(s.id);
        item.remove();
        count();
      } catch (e) {
        XS.toast("删除失败：" + e.message, "bad");
      }
    };
    grid.appendChild(item);
  });
  count();
}

async function clearGallery() {
  const ok = await XS.confirm("清空缓存截图", "设备上缓存的截图会全部删除，已打开的标签也会关闭。", { danger: true, okText: "清空" });
  if (!ok) return;
  try {
    const out = await XS.api("DELETE", "/tools/snapshots");
    host.tabs = [];
    host.active = -1;
    activateTab(-1);
    renderGallery([]);
    XS.toast("已删除 " + (out.deleted || 0) + " 张截图", "ok");
  } catch (e) {
    XS.toast("清空失败：" + e.message, "bad");
  }
}

// ---------------------------------------------------------------- selection

function normRect(r, tab) {
  const W = tab.px.width;
  const H = tab.px.height;
  let [l, t, rr, b] = r.map(Math.round);
  if (rr < l) [l, rr] = [rr, l];
  if (b < t) [t, b] = [b, t];
  l = clamp(l, 0, W);
  rr = clamp(rr, 0, W);
  t = clamp(t, 0, H);
  b = clamp(b, 0, H);
  return [l, t, rr, b];
}

function setRect(r, { silent = false } = {}) {
  const t = host.tab;
  if (!t) return;
  if (r) {
    r = normRect(r, t);
    if (r[2] - r[0] < 1 || r[3] - r[1] < 1) r = null;
  }
  t.rect = r;
  host.zoomedToSel = false;
  updateSel();
  view.draw();
  if (!silent) pluginCall("onRect", r);
}
host.setRect = (r) => setRect(r);

/** Which part of the selection a canvas point is over: handle name, "inside", or null. */
function handleAt(p) {
  const r = host.rect;
  if (!r) return null;
  const a = view.toCanvas(r[0], r[1]);
  const b = view.toCanvas(r[2], r[3]);
  const tol = 6 * view.dpr;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const near = (x, y) => Math.abs(p.cx - x) <= tol && Math.abs(p.cy - y) <= tol;
  const hs = { nw: [a.x, a.y], ne: [b.x, a.y], se: [b.x, b.y], sw: [a.x, b.y], n: [mx, a.y], e: [b.x, my], s: [mx, b.y], w: [a.x, my] };
  for (const k in hs) if (near(hs[k][0], hs[k][1])) return k;
  const inX = p.cx > a.x - tol && p.cx < b.x + tol;
  const inY = p.cy > a.y - tol && p.cy < b.y + tol;
  if (inX && Math.abs(p.cy - a.y) <= tol) return "n";
  if (inX && Math.abs(p.cy - b.y) <= tol) return "s";
  if (inY && Math.abs(p.cx - a.x) <= tol) return "w";
  if (inY && Math.abs(p.cx - b.x) <= tol) return "e";
  if (p.cx > a.x && p.cx < b.x && p.cy > a.y && p.cy < b.y) return "inside";
  return null;
}

const CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", inside: "move" };

function dragRect(d, p, tab) {
  const W = tab.px.width;
  const H = tab.px.height;
  const fx = clamp(Math.round(p.fx), 0, W);
  const fy = clamp(Math.round(p.fy), 0, H);
  if (d.kind === "new") {
    const sx = clamp(Math.round(d.start.fx), 0, W);
    const sy = clamp(Math.round(d.start.fy), 0, H);
    return [Math.min(sx, fx), Math.min(sy, fy), Math.max(sx, fx), Math.max(sy, fy)];
  }
  const o = d.orig;
  if (d.kind === "move") {
    const w = o[2] - o[0];
    const h = o[3] - o[1];
    const l = clamp(o[0] + Math.round(p.fx - d.start.fx), 0, W - w);
    const t = clamp(o[1] + Math.round(p.fy - d.start.fy), 0, H - h);
    return [l, t, l + w, t + h];
  }
  const r = o.slice();
  if (d.dir.includes("w")) r[0] = fx;
  if (d.dir.includes("e")) r[2] = fx;
  if (d.dir.includes("n")) r[1] = fy;
  if (d.dir.includes("s")) r[3] = fy;
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

// ---------------------------------------------------------------- pointer

function onPointer(kind, p, e) {
  const t = host.tab;
  if (!t) return;
  if (kind === "leave") {
    host.hover = null;
    hud.hide();
    updateHover();
    return;
  }
  if (kind === "cancel") {
    if (host.drag && host.drag.moved) t.rect = host.drag.orig;
    host.drag = null;
    updateSel();
    view.draw();
    return;
  }
  if (kind === "dblclick") {
    if (t.rect && !host.zoomedToSel) {
      view.zoomTo(t.rect);
      host.zoomedToSel = true;
    } else {
      view.fit();
      host.zoomedToSel = false;
    }
    return;
  }
  const inside = view.inside(p);
  host.hover = inside ? { x: p.x, y: p.y, color: t.px.at(p.x, p.y) } : null;
  if (inside) hud.show(e.clientX, e.clientY, t.px, p.x, p.y);
  else hud.hide();
  updateHover();

  const d = host.drag;
  if (kind === "down") {
    const h = handleAt(p);
    host.drag = {
      kind: !h ? "new" : h === "inside" ? "move" : "resize",
      dir: h,
      start: p,
      orig: t.rect ? t.rect.slice() : null,
      moved: false,
    };
    return;
  }
  if (kind === "move") {
    if (!d) {
      view.canvas.style.cursor = CURSORS[handleAt(p)] || "";
      return;
    }
    if (!d.moved && Math.hypot(p.cx - d.start.cx, p.cy - d.start.cy) > 3 * view.dpr) d.moved = true;
    if (d.moved) {
      t.rect = dragRect(d, p, t);
      updateSel();
      view.draw();
    }
    return;
  }
  if (kind === "up" && d) {
    host.drag = null;
    if (!d.moved) {
      if (inside) pick({ x: p.x, y: p.y, color: t.px.at(p.x, p.y) });
      return;
    }
    const r = t.rect;
    const tiny = !r || r[2] - r[0] < 2 || r[3] - r[1] < 2;
    setRect(tiny ? (d.kind === "new" ? null : d.orig) : r);
  }
}

function pick(pt) {
  if (!pluginCall("onPick", pt)) XS.copy(pt.x + "," + pt.y + "," + pt.color);
}

function onContext(p, e) {
  const t = host.tab;
  if (!t) return;
  const items = [];
  if (view.inside(p)) {
    const color = t.px.at(p.x, p.y);
    const pt = { x: p.x, y: p.y, color };
    items.push(
      { label: "复制坐标", hint: p.x + "," + p.y, icon: "crosshair", action: () => XS.copy(p.x + "," + p.y) },
      { label: "复制颜色", hint: color, icon: "droplet", action: () => XS.copy(color) },
      { label: "复制坐标 + 颜色", icon: "copy", action: () => XS.copy(p.x + "," + p.y + "," + color) },
    );
    if (host.plugin && host.plugin.onPick) {
      items.push({ label: "取色到下一个槽位", hint: "单击", icon: "plus", action: () => pick(pt) });
    }
  }
  if (t.rect) {
    const r = t.rect;
    if (items.length) items.push("-");
    items.push(
      { label: "复制选区", hint: r.join(","), icon: "box", action: () => XS.copy(rectText(r)) },
      { label: "放大到选区", hint: "双击", icon: "fit", action: () => { view.zoomTo(r); host.zoomedToSel = true; } },
      { label: "下载选区图片", icon: "download", action: () => download(cropCanvas(t, r).toDataURL("image/png"), "crop_" + r.join("_") + ".png") },
      { label: "清除选区", hint: "Delete", icon: "x", action: () => setRect(null) },
    );
  }
  if (items.length) XS.menu(e.clientX, e.clientY, items);
}

// ---------------------------------------------------------------- drawing

function badge(ctx, x, y, text, bg, d) {
  ctx.font = "600 " + 11 * d + "px ui-monospace, Menlo, monospace";
  const w = ctx.measureText(text).width + 8 * d;
  const h = 16 * d;
  ctx.fillStyle = bg;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 3 * d);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 4 * d, y + h / 2 + 0.5 * d);
  return w;
}

function stateColor(s) {
  return s === "ok" ? MARK.ok : s === "bad" ? MARK.bad : s === "warn" ? MARK.warn : s === "info" ? MARK.info : MARK.bad;
}

function drawOverlay(ctx, v) {
  const t = host.tab;
  if (!t) return;
  const d = v.dpr;
  const marks = pluginCall("marks", t) || {};

  (marks.rects || []).forEach((m) => {
    const a = v.toCanvas(m.rect[0], m.rect[1]);
    const b = v.toCanvas(m.rect[2], m.rect[3]);
    const col = stateColor(m.state || "ok");
    ctx.lineWidth = 2 * d;
    ctx.strokeStyle = col;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    const text = (m.n !== undefined ? m.n : "") + (m.label ? (m.n !== undefined ? " " : "") + m.label : "");
    if (text) badge(ctx, a.x - d, a.y - 17 * d < 0 ? b.y + d : a.y - 17 * d, text, col, d);
  });

  const r = t.rect;
  if (r) {
    const a = v.toCanvas(r[0], r[1]);
    const b = v.toCanvas(r[2], r[3]);
    const i0 = v.toCanvas(0, 0);
    const i1 = v.toCanvas(t.px.width, t.px.height);
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.rect(i0.x, i0.y, i1.x - i0.x, i1.y - i0.y);
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fill("evenodd");
    ctx.lineWidth = d;
    ctx.strokeStyle = "#fff";
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([5 * d, 4 * d]);
    ctx.strokeStyle = MARK.accent;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
    const hs = 6 * d;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    [[a.x, a.y], [mx, a.y], [b.x, a.y], [b.x, my], [b.x, b.y], [mx, b.y], [a.x, b.y], [a.x, my]].forEach(([x, y]) => {
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
      ctx.strokeStyle = MARK.accent;
      ctx.lineWidth = d;
      ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
    });
    const size = r[2] - r[0] + "×" + (r[3] - r[1]);
    badge(ctx, a.x, a.y - 20 * d < 0 ? b.y + 4 * d : a.y - 20 * d, size, MARK.accent, d);
    ctx.restore();
  }

  (marks.points || []).forEach((m) => {
    const c = v.toCanvas(m.x + 0.5, m.y + 0.5);
    const col = stateColor(m.state);
    ctx.beginPath();
    ctx.arc(c.x, c.y, 5 * d, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.lineWidth = 1.5 * d;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    const text = (m.n !== undefined ? m.n : "") + (m.label ? " " + m.label : "");
    if (text) badge(ctx, c.x + 7 * d, c.y - 20 * d, text, col, d);
  });

  const hl = host.highlight;
  if (hl) {
    ctx.lineWidth = 2 * d;
    ctx.strokeStyle = MARK.warn;
    if (hl.rect) {
      const a = v.toCanvas(hl.rect[0], hl.rect[1]);
      const b = v.toCanvas(hl.rect[2], hl.rect[3]);
      ctx.strokeRect(a.x - 3 * d, a.y - 3 * d, b.x - a.x + 6 * d, b.y - a.y + 6 * d);
    } else {
      const c = v.toCanvas(hl.x + 0.5, hl.y + 0.5);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 11 * d, 0, Math.PI * 2);
      ctx.moveTo(c.x - 18 * d, c.y);
      ctx.lineTo(c.x - 7 * d, c.y);
      ctx.moveTo(c.x + 7 * d, c.y);
      ctx.lineTo(c.x + 18 * d, c.y);
      ctx.moveTo(c.x, c.y - 18 * d);
      ctx.lineTo(c.x, c.y - 7 * d);
      ctx.moveTo(c.x, c.y + 7 * d);
      ctx.lineTo(c.x, c.y + 18 * d);
      ctx.stroke();
    }
  }
}

host.redraw = () => view.draw();

/** Highlight a point / rect from a plugin list; bring it into view if it is off-screen. */
host.flash = (target, { center = true, hold = false } = {}) => {
  host.highlight = target || null;
  clearTimeout(host._flashTimer);
  if (target && center) {
    const r = target.rect || [target.x, target.y, target.x + 1, target.y + 1];
    const a = view.toCanvas(r[0], r[1]);
    const b = view.toCanvas(r[2], r[3]);
    const off = a.x < 0 || a.y < 0 || b.x > view.canvas.width || b.y > view.canvas.height;
    if (off) {
      if (target.rect && (b.x - a.x > view.canvas.width || b.y - a.y > view.canvas.height)) view.zoomTo(r);
      else view.centerOn((r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
    }
  }
  if (target && !hold) host._flashTimer = setTimeout(() => ((host.highlight = null), view.draw()), 1400);
  view.draw();
};

// ---------------------------------------------------------------- chrome

function updateZoom(v) {
  const z = Math.round(v.zoom * 100) + "%";
  $("zoom-text").textContent = z;
  $("st-zoom").textContent = host.tab ? z : "";
}

function updateSel() {
  const r = host.rect;
  $("sel-info").hidden = !r;
  $("st-sel").textContent = r ? rectText(r) + "  " + (r[2] - r[0]) + "×" + (r[3] - r[1]) : "-";
  if (r) $("sel-text").textContent = rectText(r) + "  " + (r[2] - r[0]) + "×" + (r[3] - r[1]);
}

function updateHover() {
  const h = host.hover;
  $("st-cursor").textContent = h ? h.x + ", " + h.y + "  " + h.color : "-";
  $("st-swatch").style.background = h ? h.color : "transparent";
}

function updateChrome() {
  const t = host.tab;
  $("empty").hidden = !!t;
  $("help").hidden = !t;
  $("zoom-bar").hidden = !t;
  $("st-size").textContent = t ? t.snap.width + "×" + t.snap.height : "-";
  $("btn-fit").disabled = !t;
  $("btn-clear-marks").disabled = !t;
  $("btn-to-label").disabled = !t;
  updateSel();
  updateHover();
  updateZoom(view);
}

// ---------------------------------------------------------------- plugins

function renderPlugList() {
  const box = $("plug-list");
  box.innerHTML = "";
  PLUGINS.forEach((pl) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "plug";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(host.plugin === pl));
    b.innerHTML = '<span class="n">' + XS.icon(pl.icon) + "<span></span></span><span class='en'></span>";
    b.querySelector(".n span").textContent = pl.name;
    b.querySelector(".en").textContent = pl.id;
    b.onclick = () => selectPlugin(pl.id);
    box.appendChild(b);
  });
}

function selectPlugin(id) {
  const pl = PLUGINS.find((p) => p.id.toLowerCase() === String(id || "").toLowerCase()) || PLUGINS[0];
  if (!pl || host.plugin === pl) return;
  pluginCall("unmount");
  host.plugin = pl;
  host.highlight = null;
  localStorage.setItem(LS.plug, pl.id);
  const u = new URL(location.href);
  u.searchParams.set("plug", pl.id);
  history.replaceState(null, "", u);
  const panel = $("plug-panel");
  panel.innerHTML = "";
  pl.mount(panel, host);
  pluginCall("onRect", host.rect);
  renderPlugList();
  document.title = pl.name + " · 图色工具 · XScript";
  view.draw();
}

// ---- helpers shared by plugins ----

host.vision = async (req, tab = host.tab) => {
  if (!tab) throw new Error("请先截图或打开一张图片");
  try {
    return await XS.api("POST", "/tools/vision", Object.assign({ snapshot: tab.snap.id }, req));
  } catch (e) {
    if (/missing snapshot/.test(e.message)) throw new Error("截图已被设备清理，请重新截图");
    if (e.message === "timeout") throw new Error("执行超时，请缩小搜索范围后重试");
    throw e;
  }
};

host.cropURL = (r, tab = host.tab) => cropCanvas(tab, r).toDataURL("image/png");
host.download = download;

host.getProjects = async (refresh) => {
  if (!host._projects || refresh) {
    try {
      host._projects = (await XS.api("GET", "/projects")).projects || [];
    } catch (e) {
      host._projects = [];
    }
  }
  return host._projects;
};

host.ui = {
  esc: XS.esc,

  row(label, inner, forId) {
    return '<div class="cfg-row"><label class="l"' + (forId ? ' for="' + forId + '"' : "") + ">" + label +
      '</label><div class="c">' + inner + "</div></div>";
  },

  options(list, value) {
    return list.map(([v, l]) => "<option value=\"" + XS.esc(v) + "\"" + (String(v) === String(value) ? " selected" : "") + ">" +
      XS.esc(l) + "</option>").join("");
  },

  /** "搜索范围" row: text input bound to state[key]; buttons take the selection or clear it. */
  rectRow(panel, state, key, onChange, id, placeholder = "全屏（框选后自动填入）") {
    const html = host.ui.row("搜索范围",
      '<input type="text" id="' + id + '" class="mono" placeholder="' + XS.esc(placeholder) + '" spellcheck="false">' +
      '<button type="button" class="icon-btn sm" data-a="rect-sel" title="使用当前选区" aria-label="使用当前选区">' + XS.icon("box") + "</button>" +
      '<button type="button" class="icon-btn sm" data-a="rect-clr" title="全屏" aria-label="清空搜索范围（全屏）">' + XS.icon("x") + "</button>", id);
    return {
      html,
      bind() {
        const input = panel.querySelector("#" + id);
        const show = () => {
          input.value = state[key] ? state[key].join(", ") : "";
          input.classList.remove("field-bad");
        };
        show();
        input.oninput = () => {
          const s = input.value.trim();
          const r = s ? XS.parseRect(s) : null;
          input.classList.toggle("field-bad", !!s && !r);
          if (!s || r) {
            state[key] = r;
            onChange();
          }
        };
        panel.querySelector('[data-a="rect-sel"]').onclick = () => {
          if (!host.rect) return XS.toast("先在截图上拖拽框选一个区域");
          state[key] = host.rect.slice();
          show();
          onChange();
        };
        panel.querySelector('[data-a="rect-clr"]').onclick = () => {
          state[key] = null;
          show();
          onChange();
        };
        return { show };
      },
    };
  },

  /** Run an async action with a spinner on the button; errors become a toast. */
  async run(btn, fn) {
    if (btn.disabled) return;
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 执行中…';
    try {
      await fn();
    } catch (e) {
      XS.toast(e.message, "bad", 3800);
    } finally {
      btn.disabled = false;
      btn.innerHTML = html;
    }
  },

  num(value, min, max, def) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? clamp(n, min, max) : def;
  },

  /** Code preview panel with AScript / XScript style switch and copy button. */
  code(container, build) {
    container.innerHTML =
      '<div class="panel-header">' + XS.icon("code") + "<span>代码预览</span>" +
      '<div class="actions"><select class="code-style" aria-label="代码风格">' +
      host.ui.options([["ascript", "AScript 接口"], ["xscript", "XScript 接口"]], host.codeStyle) +
      '</select><button type="button" class="ghost" data-a="copy" title="复制代码">' + XS.icon("copy") + " 复制</button></div></div>" +
      '<pre class="code" tabindex="0" aria-label="生成的代码"></pre>';
    const pre = container.querySelector("pre");
    let text = "";
    const update = () => {
      text = build(host.codeStyle);
      pre.innerHTML = XS.highlightPy(text);
    };
    container.querySelector(".code-style").onchange = (e) => {
      localStorage.setItem(LS.style, e.target.value);
      update();
    };
    container.querySelector('[data-a="copy"]').onclick = () => XS.copy(text, "已复制代码");
    update();
    return { update, get text() { return text; } };
  },
};

// ---------------------------------------------------------------- wiring

$("btn-capture").onclick = capture;
$("empty-capture").onclick = capture;
$("btn-upload").onclick = () => $("file").click();
$("empty-upload").onclick = () => $("file").click();
$("file").onchange = (e) => {
  uploadFiles(e.target.files);
  e.target.value = "";
};
$("btn-gallery").onclick = toggleGallery;
$("empty-gallery").onclick = openGallery;
$("gallery-close").onclick = closeGallery;
$("gallery-clear").onclick = clearGallery;
$("btn-fit").onclick = () => view.fit();
// Hand the open snapshot to 标注工具, which adds it to its current dataset.
$("btn-to-label").onclick = () => host.tab && XS.go("/tools/ui/label.html?snapshot=" + encodeURIComponent(host.tab.snap.id));
$("zoom-text").onclick = () => view.fit();
$("zoom-in").onclick = () => view.zoomBy(1.25);
$("zoom-out").onclick = () => view.zoomBy(0.8);
$("btn-clear-marks").onclick = () => {
  pluginCall("clearResults");
  host.highlight = null;
  view.draw();
};
$("btn-close-tabs").onclick = () => {
  host.tabs = [];
  host.active = -1;
  activateTab(-1);
};
$("sel-copy").onclick = () => host.rect && XS.copy(rectText(host.rect));
$("sel-clear").onclick = () => setRect(null);

// Drag & drop / paste images onto the stage.
const stage = $("stage");
stage.addEventListener("dragover", (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
  e.preventDefault();
  stage.classList.add("dragover");
});
stage.addEventListener("dragleave", (e) => {
  if (!stage.contains(e.relatedTarget)) stage.classList.remove("dragover");
});
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  stage.classList.remove("dragover");
  uploadFiles(e.dataTransfer.files);
});
document.addEventListener("paste", (e) => {
  if (XS.isTyping()) return;
  const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
  if (files.length) {
    e.preventDefault();
    uploadFiles(files);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || XS.isTyping() || XS._menu || document.querySelector(".xs-dialog-backdrop")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === "Escape") {
    toggleGallery();
    e.preventDefault();
    return;
  }
  if (k === "s" || k === "S") {
    capture();
    e.preventDefault();
    return;
  }
  const t = host.tab;
  if (!t || galleryOpen()) return;
  if (/^[1-9]$/.test(k)) {
    if (host.hover) pluginCall("onSlotKey", Number(k), Object.assign({}, host.hover));
    else XS.toast("把鼠标移到截图上再按数字键取色");
  } else if (k === "f" || k === "F" || k === "0") {
    view.fit();
  } else if (k === "+" || k === "=") {
    view.zoomBy(1.25);
  } else if (k === "-" || k === "_") {
    view.zoomBy(0.8);
  } else if ((k === "Delete" || k === "Backspace") && t.rect) {
    setRect(null);
  } else if (k.startsWith("Arrow") && t.rect) {
    const s = e.shiftKey ? 10 : 1;
    const dx = k === "ArrowLeft" ? -s : k === "ArrowRight" ? s : 0;
    const dy = k === "ArrowUp" ? -s : k === "ArrowDown" ? s : 0;
    const r = t.rect;
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    const l = clamp(r[0] + dx, 0, t.px.width - w);
    const tp = clamp(r[1] + dy, 0, t.px.height - h);
    setRect([l, tp, l + w, tp + h]);
  } else return;
  e.preventDefault();
});

// Resizable viewer column (drag the splitter, arrow keys, double-click to reset).
(function splitter() {
  const sp = $("splitter");
  const app = document.querySelector(".app");
  const viewer = document.querySelector(".viewer");
  const setW = (w) => {
    const max = Math.max(300, window.innerWidth - 44 - 132 - 420);
    w = clamp(w, 280, max);
    app.style.setProperty("--viewer-w", Math.round(w) + "px");
    localStorage.setItem(LS.width, Math.round(w));
  };
  const saved = Number(localStorage.getItem(LS.width));
  if (saved) setW(saved);
  sp.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add("drag");
    const x0 = e.clientX;
    const w0 = viewer.getBoundingClientRect().width;
    const move = (ev) => setW(w0 + ev.clientX - x0);
    const up = () => {
      sp.classList.remove("drag");
      sp.removeEventListener("pointermove", move);
      sp.removeEventListener("pointerup", up);
      sp.removeEventListener("pointercancel", up);
    };
    sp.addEventListener("pointermove", move);
    sp.addEventListener("pointerup", up);
    sp.addEventListener("pointercancel", up);
  });
  sp.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setW(viewer.getBoundingClientRect().width + (e.key === "ArrowRight" ? 24 : -24));
  });
  sp.addEventListener("dblclick", () => {
    app.style.removeProperty("--viewer-w");
    localStorage.removeItem(LS.width);
  });
})();

// ---------------------------------------------------------------- boot

const session = loadSession();
if (session && session.plugins) {
  PLUGINS.forEach((p) => session.plugins[p.id] && typeof p.loadState === "function" && p.loadState(session.plugins[p.id]));
}
XS.onLeave(saveSession);
window.addEventListener("pagehide", saveSession);

renderPlugList();
selectPlugin(new URLSearchParams(location.search).get("plug") || localStorage.getItem(LS.plug) || (PLUGINS[0] && PLUGINS[0].id));
updateChrome();
const handoffName = XS.takeParam("name");
restoreTabs(session, XS.takeParam("snapshot"), handoffName ? handoffName.slice(0, 40) : null);
