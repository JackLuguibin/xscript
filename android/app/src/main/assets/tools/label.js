"use strict";
/* 标注工具 (AScript label.html layout): datasets on the device, YOLO boxes, class picker. */

const $ = (id) => document.getElementById(id);
const PALETTE = ["#4ec9b0", "#e5484d", "#2f7cf6", "#f59e0b", "#a855f7", "#00b8d4", "#d6409f", "#84cc16", "#f97316", "#64748b",
  "#0d9488", "#b7791f", "#6366f1", "#ef4444", "#14b8a6", "#eab308"];
const NAME_RE = /^[\p{L}\p{N}_-]{1,64}$/u;
const MIN_BOX = 3;

const st = {
  datasets: [],
  ds: null,
  classes: [],
  counts: [],
  items: [],          // [{id, labeled, boxes}]
  filter: "all",
  index: -1,
  px: null,           // loaded pixels of the current image
  label: null,        // {width, height, boxes: [{cls, rect}]}
  loadedCls: [],      // class ids of the boxes as last saved (for class counts)
  selected: -1,
  hoverBox: -1,
  hover: null,
  drag: null,
  pending: null,      // {rect} new box waiting for a class, or {reclass: i}
  cls: 0,             // default class for the picker
  hidden: false,
  undo: [],
  saveTimer: null,
  saving: null,
  openSeq: 0,
  auto: null,
};

const view = new ImageView($("view"), { onDraw: draw, onPointer, onContext, onView: (v) => ($("st-zoom").textContent = st.px ? Math.round(v.zoom * 100) + "%" : "") });

// ---------------------------------------------------------------- helpers

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const color = (c) => PALETTE[((c % PALETTE.length) + PALETTE.length) % PALETTE.length];
const base = () => "/tools/datasets/" + encodeURIComponent(st.ds);
const cur = () => st.items[st.index] || null;
const labeledCount = () => st.items.filter((it) => it.labeled).length;

function busy(on, text) {
  $("loading").hidden = !on;
  if (text) $("loading-text").textContent = text;
}

function saveState(text, kind) {
  const el = $("st-save");
  el.textContent = text || "";
  el.className = "item" + (kind === "bad" ? " st-bad" : "");
  el.style.opacity = kind === "bad" ? "1" : "0.85";
}

function itemState(it) {
  if (!it.labeled) return { text: "未标注", cls: "" };
  if (!it.boxes) return { text: "负样本", cls: "ok" };
  return { text: "已标注", cls: "ok" };
}

function matchesFilter(it) {
  return st.filter === "all" || (st.filter === "labeled" ? it.labeled : !it.labeled);
}

/** Indices shown in the list: matching the filter, plus the open image so it never vanishes mid-edit. */
function visible() {
  const out = [];
  st.items.forEach((it, i) => (matchesFilter(it) || i === st.index) && out.push(i));
  return out;
}

// ---------------------------------------------------------------- datasets

async function loadDatasets(select) {
  const out = await XS.api("GET", "/tools/datasets");
  st.datasets = out.datasets;
  const want = select || localStorage.getItem("xs-dataset");
  const pick = st.datasets.find((d) => d.name === want) || st.datasets[0];
  if (pick) await openDataset(pick.name);
  else {
    st.ds = null;
    st.items = [];
    st.classes = [];
    st.counts = [];
    await openImage(-1);
  }
}

async function openDataset(name) {
  await flushSave();
  st.ds = name;
  localStorage.setItem("xs-dataset", name);
  const d = await XS.api("GET", base());
  st.classes = d.classes;
  st.counts = d.counts || d.classes.map(() => 0);
  st.items = d.items.map((it) => ({ id: it.id, labeled: it.labeled !== undefined ? it.labeled : it.boxes > 0, boxes: it.boxes }));
  st.cls = clamp(st.cls, 0, Math.max(0, st.classes.length - 1));
  const last = localStorage.getItem("xs-label-pos:" + name);
  let i = st.items.findIndex((it) => it.id === last);
  if (i < 0) i = st.items.findIndex((it) => !it.labeled);
  if (i < 0) i = st.items.length - 1;
  await openImage(i);
}

async function refreshDataset() {
  const d = await XS.api("GET", base());
  st.classes = d.classes;
  st.counts = d.counts || d.classes.map(() => 0);
  st.items = d.items.map((it) => ({ id: it.id, labeled: it.labeled !== undefined ? it.labeled : it.boxes > 0, boxes: it.boxes }));
  const ds = st.datasets.find((x) => x.name === st.ds);
  if (ds) {
    ds.images = st.items.length;
    ds.labeled = labeledCount();
  }
}

function renderDatasetMenu() {
  const m = $("ds-menu");
  m.innerHTML = "";
  st.datasets.forEach((d) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(d.name === st.ds));
    b.innerHTML = XS.icon("layers") + "<span></span><span class='meta'></span>";
    b.querySelector("span").textContent = d.name;
    b.querySelector(".meta").textContent = d.labeled + "/" + d.images;
    b.title = d.name + "：" + d.images + " 张图片，已标注 " + d.labeled;
    b.onclick = () => {
      closeDatasetMenu();
      if (d.name !== st.ds) openDataset(d.name).catch((e) => XS.toast(e.message, "bad"));
    };
    m.appendChild(b);
  });
  if (st.datasets.length) m.appendChild(document.createElement("hr"));
  const add = document.createElement("button");
  add.type = "button";
  add.innerHTML = XS.icon("plus") + "<span>新建数据集…</span>";
  add.onclick = () => {
    closeDatasetMenu();
    createDataset();
  };
  m.appendChild(add);
}

function openDatasetMenu() {
  renderDatasetMenu();
  $("ds-menu").hidden = false;
  $("ds-btn").setAttribute("aria-expanded", "true");
  const sel = $("ds-menu").querySelector('[aria-selected="true"]') || $("ds-menu").querySelector("button");
  if (sel) sel.focus();
}

function closeDatasetMenu() {
  $("ds-menu").hidden = true;
  $("ds-btn").setAttribute("aria-expanded", "false");
}

async function askName(title, value) {
  const name = await XS.prompt(title, value, { body: "字母、数字、中文、下划线或短横线，最多 64 个字符", placeholder: "buttons" });
  if (!name) return null;
  if (!NAME_RE.test(name)) {
    XS.toast("名称只能包含字母、数字、中文、_ 和 -", "bad");
    return null;
  }
  return name;
}

async function createDataset() {
  let n = st.datasets.length + 1;
  while (st.datasets.some((d) => d.name === "dataset" + n)) n++;
  const name = await askName("新建数据集", "dataset" + n);
  if (!name) return false;
  if (st.datasets.some((d) => d.name === name)) {
    XS.toast("数据集 " + name + " 已存在", "bad");
    return false;
  }
  try {
    await XS.api("POST", "/tools/datasets/" + encodeURIComponent(name));
    await loadDatasets(name);
    XS.toast("已创建数据集 " + name, "ok");
    return true;
  } catch (e) {
    XS.toast(e.message, "bad");
    return false;
  }
}

async function ensureDataset() {
  if (st.ds) return true;
  return createDataset();
}

async function renameDataset() {
  if (!st.ds) return XS.toast("先选择数据集");
  const name = await askName("重命名数据集", st.ds);
  if (!name || name === st.ds) return;
  try {
    await flushSave();
    localStorage.removeItem("xs-label-pos:" + st.ds);
    await XS.api("POST", base() + "/rename", { to: name });
    await loadDatasets(name);
    XS.toast("已重命名为 " + name, "ok");
  } catch (e) {
    XS.toast(e.message, "bad");
  }
}

async function deleteDataset() {
  if (!st.ds) return;
  const ok = await XS.confirm("删除数据集 " + st.ds, "该数据集的 " + st.items.length + " 张图片和全部标注都会从手机上删除，无法恢复。", { danger: true, okText: "删除" });
  if (!ok) return;
  try {
    clearTimeout(st.saveTimer);
    st.saveTimer = null;
    await XS.api("DELETE", base());
    localStorage.removeItem("xs-dataset");
    localStorage.removeItem("xs-label-pos:" + st.ds);
    st.ds = null;
    await loadDatasets();
  } catch (e) {
    XS.toast(e.message, "bad");
  }
}

// ---------------------------------------------------------------- images

async function openImage(i) {
  const token = ++st.openSeq;
  await flushSave();
  if (token !== st.openSeq) return;
  closeTagPop(false);
  st.index = i;
  st.selected = -1;
  st.hoverBox = -1;
  st.drag = null;
  st.undo = [];
  const it = cur();
  if (!it) {
    st.px = null;
    st.label = null;
    view.setImage(null);
    renderAll();
    return;
  }
  localStorage.setItem("xs-label-pos:" + st.ds, it.id);
  renderList();
  const slow = setTimeout(() => busy(true, "加载图片…"), 200);
  try {
    const [label, px] = await Promise.all([
      XS.api("GET", base() + "/labels/" + it.id),
      XS.loadPixels(base() + "/images/" + it.id),
    ]);
    if (token !== st.openSeq) return;
    label.width = px.width;
    label.height = px.height;
    label.boxes = (label.boxes || []).map((b) => ({ cls: b.cls, rect: b.rect.slice() }));
    st.px = px;
    st.label = label;
    st.loadedCls = label.boxes.map((b) => b.cls);
    view.setImage(px.canvas, true);
    saveState("");
  } catch (e) {
    if (token !== st.openSeq) return;
    st.px = null;
    st.label = null;
    view.setImage(null);
    XS.toast("图片加载失败：" + e.message, "bad");
  } finally {
    clearTimeout(slow);
    if (token === st.openSeq) busy(false);
  }
  renderAll();
}

function step(delta) {
  const vis = visible();
  if (!vis.length) return;
  let pos = vis.indexOf(st.index);
  pos = pos < 0 ? 0 : clamp(pos + delta, 0, vis.length - 1);
  if (vis[pos] !== st.index) openImage(vis[pos]);
  else XS.toast(delta > 0 ? "已经是最后一张" : "已经是第一张");
}

function addItem(id) {
  st.items.push({ id, labeled: false, boxes: 0 });
  const ds = st.datasets.find((x) => x.name === st.ds);
  if (ds) ds.images = st.items.length;
}

/** One screenshot into the dataset. The cached snapshot is removed so it does not pile up in 图色工具. */
async function captureOne() {
  const snap = await XS.api("POST", "/tools/snapshots");
  const out = await XS.api("POST", base() + "/images", { snapshot: snap.id });
  XS.api("DELETE", "/tools/snapshots/" + encodeURIComponent(snap.id)).catch(() => {});
  addItem(out.id);
  return out.id;
}

function captureError(e) {
  return /capture_unavailable/.test(e.message) ? "截图不可用：请在 XScript App 中开启录屏或无障碍截图权限" : "截图失败：" + e.message;
}

async function capture() {
  if (st.capturing || !(await ensureDataset())) return;
  st.capturing = true;
  $("fb-capture").disabled = true;
  busy(true, "截图中…");
  try {
    await captureOne();
    await openImage(st.items.length - 1);
    XS.toast("已加入第 " + st.items.length + " 张", "ok");
  } catch (e) {
    XS.toast(captureError(e), "bad", 4000);
  } finally {
    st.capturing = false;
    $("fb-capture").disabled = false;
    busy(false);
  }
}

async function uploadFiles(files) {
  const list = Array.from(files || []).filter((f) => /^image\/(png|jpeg|webp|bmp|gif)$/.test(f.type) || /\.(png|jpe?g|webp|bmp)$/i.test(f.name));
  if (!list.length) return XS.toast("没有可导入的图片（支持 PNG / JPEG / WebP / BMP）", "bad");
  if (!(await ensureDataset())) return;
  const first = st.items.length;
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    busy(true, "上传中 " + (i + 1) + " / " + list.length);
    try {
      const out = await XS.api("POST", base() + "/images", await XS.toUploadable(list[i], false));
      addItem(out.id);
    } catch (e) {
      failed++;
    }
  }
  busy(false);
  if (st.items.length > first) await openImage(first);
  else renderAll();
  XS.toast("已导入 " + (list.length - failed) + " 张" + (failed ? "，失败 " + failed + " 张" : ""), failed ? "bad" : "ok");
}

async function deleteImage(i) {
  const it = st.items[i];
  if (!it) return;
  if (it.boxes) {
    const ok = await XS.confirm("删除图片 #" + it.id, "这张图片有 " + it.boxes + " 个标注框，会一起删除。", { danger: true, okText: "删除" });
    if (!ok) return;
  }
  try {
    if (i === st.index) {
      clearTimeout(st.saveTimer);
      st.saveTimer = null;
    } else await flushSave();
    await XS.api("DELETE", base() + "/images/" + it.id);
    await refreshDataset();
    const next = i < st.index ? st.index - 1 : Math.min(st.index, st.items.length - 1);
    if (i === st.index) await openImage(Math.min(i, st.items.length - 1));
    else {
      st.index = next;
      renderAll();
    }
  } catch (e) {
    XS.toast("删除失败：" + e.message, "bad");
  }
}

async function deleteImages(pred, what) {
  const ids = st.items.filter(pred).map((it) => it.id);
  if (!ids.length) return XS.toast("没有" + what);
  const ok = await XS.confirm("删除" + what, "将从手机上删除 " + ids.length + " 张图片及其标注，无法恢复。", { danger: true, okText: "删除" });
  if (!ok) return;
  clearTimeout(st.saveTimer);
  st.saveTimer = null;
  const keep = cur() && !ids.includes(cur().id) ? cur().id : null;
  $("img-loading").hidden = false;
  try {
    for (let i = 0; i < ids.length; i++) {
      busy(true, "删除中 " + (i + 1) + " / " + ids.length);
      await XS.api("DELETE", base() + "/images/" + ids[i]);
    }
  } catch (e) {
    XS.toast("删除失败：" + e.message, "bad");
  } finally {
    busy(false);
    $("img-loading").hidden = true;
  }
  await refreshDataset();
  const k = st.items.findIndex((it) => it.id === keep);
  await openImage(k >= 0 ? k : st.items.length ? 0 : -1);
  XS.toast("已删除 " + ids.length + " 张", "ok");
}

// ---------------------------------------------------------------- auto capture

function openAuto() {
  closePops();
  $("auto-pop").hidden = false;
  $("fb-auto").setAttribute("aria-pressed", "true");
  updateAutoText();
  $("ac-interval").focus();
}

function closeAuto() {
  $("auto-pop").hidden = true;
  $("fb-auto").setAttribute("aria-pressed", String(!!st.auto));
}

function updateAutoText() {
  const a = st.auto;
  const n = Math.round(clamp(Number($("ac-count").value) || 10, 1, 500));
  const s = clamp(Number($("ac-interval").value) || 2, 0.5, 600);
  if (!a) {
    $("ac-bar").style.width = "0";
    $("ac-text").textContent = "共 " + n + " 张，预计约 " + Math.ceil(n * (s + 1)) + " 秒";
    return;
  }
  $("ac-bar").style.width = (a.done / a.total) * 100 + "%";
  $("ac-text").textContent = "已截图 " + a.done + " / " + a.total + (a.failed ? "，失败 " + a.failed : "");
}

async function startAuto() {
  if (st.auto || !(await ensureDataset())) return;
  const total = Math.round(clamp(Number($("ac-count").value) || 10, 1, 500));
  const interval = clamp(Number($("ac-interval").value) || 2, 0.5, 600) * 1000;
  const a = (st.auto = { total, done: 0, failed: 0, stop: false });
  $("ac-start").hidden = true;
  $("ac-stop").hidden = false;
  $("fb-auto").classList.add("running");
  updateAutoText();
  while (!a.stop && a.done < a.total) {
    try {
      await captureOne();
      if (!cur()) await openImage(st.items.length - 1);
    } catch (e) {
      a.failed++;
      if (a.failed >= 3 && a.failed === a.done + a.failed) {
        XS.toast(captureError(e), "bad", 4000);
        break;
      }
    }
    a.done++;
    updateAutoText();
    renderList();
    renderCounts();
    if (a.done < a.total && !a.stop) await new Promise((r) => (a.wake = r, setTimeout(r, interval)));
  }
  st.auto = null;
  $("ac-start").hidden = false;
  $("ac-stop").hidden = true;
  $("fb-auto").classList.remove("running");
  $("fb-auto").setAttribute("aria-pressed", String(!$("auto-pop").hidden));
  $("ac-text").textContent = (a.stop ? "已停止，" : "完成，") + "加入 " + (a.done - a.failed) + " 张";
  XS.toast("自动截图" + (a.stop ? "已停止" : "完成") + "，加入 " + (a.done - a.failed) + " 张", "ok");
}

function stopAuto() {
  if (!st.auto) return;
  st.auto.stop = true;
  if (st.auto.wake) st.auto.wake();
}

// ---------------------------------------------------------------- boxes: editing

function snapshotBoxes() {
  st.undo.push(JSON.stringify(st.label.boxes));
  if (st.undo.length > 60) st.undo.shift();
}

function undo() {
  if (!st.label || !st.undo.length) return XS.toast("没有可撤销的操作");
  st.label.boxes = JSON.parse(st.undo.pop());
  st.selected = -1;
  changed();
}

function changed() {
  scheduleSave();
  renderBoxes();
  renderCounts();
  renderStatus();
  view.draw();
}

function normRect(r) {
  const W = st.label.width;
  const H = st.label.height;
  return [
    clamp(Math.round(Math.min(r[0], r[2])), 0, W), clamp(Math.round(Math.min(r[1], r[3])), 0, H),
    clamp(Math.round(Math.max(r[0], r[2])), 0, W), clamp(Math.round(Math.max(r[1], r[3])), 0, H),
  ];
}

function addBox(cls, rect) {
  snapshotBoxes();
  st.label.boxes.push({ cls, rect });
  st.selected = st.label.boxes.length - 1;
  st.cls = cls;
  changed();
  renderClasses();
}

function setBoxClass(i, cls) {
  const b = st.label.boxes[i];
  if (!b || b.cls === cls) return;
  snapshotBoxes();
  b.cls = cls;
  st.cls = cls;
  changed();
  renderClasses();
}

function removeBox(i) {
  if (!st.label.boxes[i]) return;
  snapshotBoxes();
  st.label.boxes.splice(i, 1);
  st.selected = -1;
  st.hoverBox = -1;
  changed();
}

function handlesOf(r) {
  const a = view.toCanvas(r[0], r[1]);
  const b = view.toCanvas(r[2], r[3]);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  return { a, b, pts: { nw: [a.x, a.y], n: [mx, a.y], ne: [b.x, a.y], e: [b.x, my], se: [b.x, b.y], s: [mx, b.y], sw: [a.x, b.y], w: [a.x, my] } };
}

/** {i, part} under canvas point: resize handles of the selected box first, then the smallest box containing it. */
function hitTest(p) {
  if (!st.label || st.hidden) return null;
  const tol = 6 * view.dpr;
  const sel = st.label.boxes[st.selected];
  if (sel) {
    const h = handlesOf(sel.rect);
    for (const k in h.pts) if (Math.abs(p.cx - h.pts[k][0]) <= tol && Math.abs(p.cy - h.pts[k][1]) <= tol) return { i: st.selected, part: k };
  }
  let best = null;
  st.label.boxes.forEach((b, i) => {
    const r = b.rect;
    if (p.fx >= r[0] && p.fx <= r[2] && p.fy >= r[1] && p.fy <= r[3]) {
      const area = (r[2] - r[0]) * (r[3] - r[1]);
      if (!best || area < best.area || (i === st.selected && area === best.area)) best = { i, part: "inside", area };
    }
  });
  return best;
}

const CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", inside: "move" };

function onPointer(kind, p, e) {
  if (!st.label) return;
  if (kind === "leave") {
    st.hover = null;
    st.hoverBox = -1;
    renderStatus();
    view.draw();
    return;
  }
  if (kind === "cancel") {
    if (st.drag && st.drag.orig && st.drag.moved) st.label.boxes[st.drag.i].rect = st.drag.orig;
    st.drag = null;
    view.draw();
    return;
  }
  const inside = view.inside(p);
  st.hover = inside ? { x: p.x, y: p.y, color: st.px.at(p.x, p.y) } : null;

  if (kind === "dblclick") {
    const h = hitTest(p);
    if (h) {
      st.selected = h.i;
      openTagPop({ reclass: h.i });
    } else view.fit();
    return;
  }
  if (kind === "down") {
    if (st.pending) closeTagPop(false);
    if (st.hidden) return XS.toast("标注框已隐藏，按 H 显示后再编辑");
    const h = hitTest(p);
    const W = st.label.width;
    const H = st.label.height;
    const pt = { x: clamp(p.fx, 0, W), y: clamp(p.fy, 0, H) };
    if (h) {
      st.selected = h.i;
      st.drag = { kind: h.part === "inside" ? "move" : "resize", dir: h.part, i: h.i, start: pt, orig: st.label.boxes[h.i].rect.slice(), moved: false };
      renderBoxes();
    } else {
      st.selected = -1;
      st.drag = { kind: "new", start: pt, end: pt, moved: false };
      renderBoxes();
    }
    view.draw();
    return;
  }
  const d = st.drag;
  if (kind === "move") {
    if (!d) {
      const h = hitTest(p);
      const hb = h ? h.i : -1;
      view.canvas.style.cursor = h ? CURSORS[h.part] : "";
      if (hb !== st.hoverBox) {
        st.hoverBox = hb;
        renderBoxes(true);
      }
      renderStatus();
      view.draw();
      return;
    }
    if (!d.moved && Math.hypot(p.cx - view.toCanvas(d.start.x, d.start.y).x, p.cy - view.toCanvas(d.start.x, d.start.y).y) > 3 * view.dpr) {
      d.moved = true;
      if (d.kind !== "new") snapshotBoxes();
    }
    if (!d.moved) return;
    const W = st.label.width;
    const H = st.label.height;
    const q = { x: clamp(p.fx, 0, W), y: clamp(p.fy, 0, H) };
    if (d.kind === "new") d.end = q;
    else if (d.kind === "move") {
      const o = d.orig;
      const w = o[2] - o[0];
      const h = o[3] - o[1];
      const l = clamp(Math.round(o[0] + q.x - d.start.x), 0, W - w);
      const t = clamp(Math.round(o[1] + q.y - d.start.y), 0, H - h);
      st.label.boxes[d.i].rect = [l, t, l + w, t + h];
    } else {
      const r = d.orig.slice();
      if (d.dir.includes("w")) r[0] = q.x;
      if (d.dir.includes("e")) r[2] = q.x;
      if (d.dir.includes("n")) r[1] = q.y;
      if (d.dir.includes("s")) r[3] = q.y;
      st.label.boxes[d.i].rect = normRect(r);
    }
    renderStatus();
    view.draw();
    return;
  }
  if (kind === "up" && d) {
    st.drag = null;
    if (d.kind === "new") {
      const r = normRect([d.start.x, d.start.y, d.end.x, d.end.y]);
      if (d.moved && r[2] - r[0] >= MIN_BOX && r[3] - r[1] >= MIN_BOX) openTagPop({ rect: r });
      else view.draw();
    } else if (d.moved) {
      const r = st.label.boxes[d.i].rect;
      if (r[2] - r[0] < MIN_BOX || r[3] - r[1] < MIN_BOX) st.label.boxes[d.i].rect = d.orig;
      changed();
    }
    renderBoxes();
  }
}

function onContext(p, e) {
  if (!st.label) return;
  const h = hitTest(p);
  const items = [];
  if (h) {
    const b = st.label.boxes[h.i];
    st.selected = h.i;
    renderBoxes();
    view.draw();
    items.push(
      { label: "更改类别", hint: "双击", icon: "tag", action: () => openTagPop({ reclass: h.i }) },
      { label: "复制区域", hint: b.rect.join(","), icon: "copy", action: () => XS.copy("[" + b.rect.join(", ") + "]") },
      { label: "放大到此框", icon: "fit", action: () => view.zoomTo(b.rect) },
      "-",
      { label: "删除", hint: "Delete", icon: "trash", action: () => removeBox(h.i) },
    );
  }
  if (view.inside(p)) {
    const c = st.px.at(p.x, p.y);
    if (items.length) items.push("-");
    items.push(
      { label: "复制坐标", hint: p.x + "," + p.y, icon: "crosshair", action: () => XS.copy(p.x + "," + p.y) },
      { label: "复制颜色", hint: c, icon: "droplet", action: () => XS.copy(c) },
    );
  }
  if (items.length) XS.menu(e.clientX, e.clientY, items);
}

// ---------------------------------------------------------------- drawing

function tag(ctx, x, y, text, bg, d) {
  ctx.font = "600 " + 11 * d + "px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  const w = ctx.measureText(text).width + 10 * d;
  const h = 16 * d;
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 5 * d, y + h / 2 + 0.5 * d);
}

function draw(ctx, v) {
  if (!st.label) return;
  const d = v.dpr;
  const W = st.label.width;
  const H = st.label.height;

  // Crosshair guides help line boxes up with edges.
  const hv = st.hover;
  if (hv && (!st.drag || st.drag.kind === "new") && !st.pending) {
    const c = v.toCanvas(hv.x + 0.5, hv.y + 0.5);
    const a = v.toCanvas(0, 0);
    const b = v.toCanvas(W, H);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = d;
    ctx.setLineDash([4 * d, 4 * d]);
    ctx.beginPath();
    ctx.moveTo(a.x, c.y);
    ctx.lineTo(b.x, c.y);
    ctx.moveTo(c.x, a.y);
    ctx.lineTo(c.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  if (!st.hidden) {
    st.label.boxes.forEach((bx, i) => {
      const col = color(bx.cls);
      const a = v.toCanvas(bx.rect[0], bx.rect[1]);
      const b = v.toCanvas(bx.rect[2], bx.rect[3]);
      const sel = i === st.selected;
      const hov = i === st.hoverBox;
      ctx.fillStyle = col + (sel ? "38" : hov ? "24" : "12");
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.lineWidth = (sel ? 2.5 : 2) * d;
      ctx.strokeStyle = col;
      ctx.setLineDash(hov && !sel ? [6 * d, 3 * d] : []);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.setLineDash([]);
      const name = st.classes[bx.cls] !== undefined ? st.classes[bx.cls] : "#" + bx.cls;
      tag(ctx, a.x - (sel ? 1.25 : 1) * d, a.y - 16 * d < 0 ? a.y : a.y - 16 * d, name, col, d);
      if (sel) {
        const hs = 7 * d;
        Object.values(handlesOf(bx.rect).pts).forEach(([x, y]) => {
          ctx.fillStyle = "#fff";
          ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.5 * d;
          ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
        });
      }
    });
  }

  let draft = null;
  if (st.drag && st.drag.kind === "new" && st.drag.moved) draft = normRect([st.drag.start.x, st.drag.start.y, st.drag.end.x, st.drag.end.y]);
  else if (st.pending && st.pending.rect) draft = st.pending.rect;
  if (draft) {
    const a = v.toCanvas(draft[0], draft[1]);
    const b = v.toCanvas(draft[2], draft[3]);
    const col = color(st.cls);
    ctx.fillStyle = col + "22";
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.lineWidth = 2 * d;
    ctx.strokeStyle = col;
    ctx.setLineDash([6 * d, 4 * d]);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
    tag(ctx, a.x - d, a.y - 16 * d < 0 ? b.y : a.y - 16 * d, draft[2] - draft[0] + "×" + (draft[3] - draft[1]), col, d);
  }
}

// ---------------------------------------------------------------- saving

function scheduleSave() {
  clearTimeout(st.saveTimer);
  saveState("未保存");
  st.saveTimer = setTimeout(() => save(), 500);
}

async function flushSave() {
  if (st.saveTimer) {
    clearTimeout(st.saveTimer);
    st.saveTimer = null;
    await save();
  } else if (st.saving) {
    await st.saving;
  }
}

/** PUT the boxes; an image with no boxes goes back to "unlabeled" unless `negative` is set. */
async function save(negative) {
  st.saveTimer = null;
  const it = cur();
  const label = st.label;
  if (!it || !label) return;
  const ds = st.ds;
  const boxes = label.boxes.map((b) => ({ cls: b.cls, rect: b.rect.slice() }));
  const run = (async () => {
    saveState("保存中…");
    try {
      if (!boxes.length && !negative) {
        if (it.labeled) await XS.api("DELETE", "/tools/datasets/" + encodeURIComponent(ds) + "/labels/" + it.id);
        it.labeled = false;
      } else {
        await XS.api("PUT", "/tools/datasets/" + encodeURIComponent(ds) + "/labels/" + it.id, { width: label.width, height: label.height, boxes });
        it.labeled = true;
      }
      it.boxes = boxes.length;
      if (ds === st.ds) {
        // Keep per-class counts in step without re-reading every label.
        st.loadedCls.forEach((c) => st.counts[c] !== undefined && st.counts[c]--);
        boxes.forEach((b) => (st.counts[b.cls] = (st.counts[b.cls] || 0) + 1));
        st.loadedCls = boxes.map((b) => b.cls);
        const d = st.datasets.find((x) => x.name === ds);
        if (d) d.labeled = labeledCount();
      }
      saveState("已保存");
    } catch (e) {
      saveState("保存失败", "bad");
      XS.toast("保存失败：" + e.message, "bad", 4000);
    }
  })();
  st.saving = run;
  await run;
  if (st.saving === run) st.saving = null;
  renderList();
  renderCounts();
  renderClasses();
}

// ---------------------------------------------------------------- classes

async function putClasses(next) {
  await flushSave();
  const d = await XS.api("PUT", base() + "/classes", { classes: next });
  st.classes = d.classes;
  st.counts = d.counts || st.classes.map((_, i) => st.counts[i] || 0);
  renderClasses();
  renderTagMgr();
  view.draw();
}

async function addClass(name) {
  name = String(name || "").trim();
  if (!name) return -1;
  if (name.length > 64) {
    XS.toast("类别名最多 64 个字符", "bad");
    return -1;
  }
  const i = st.classes.indexOf(name);
  if (i >= 0) return i;
  try {
    await putClasses(st.classes.concat([name]));
    return st.classes.indexOf(name);
  } catch (e) {
    XS.toast(e.message, "bad");
    return -1;
  }
}

async function renameClass(i) {
  const name = await XS.prompt("重命名类别", st.classes[i]);
  if (!name || name === st.classes[i]) return;
  if (st.classes.includes(name)) return XS.toast("已有同名类别", "bad");
  const next = st.classes.slice();
  next[i] = name;
  try {
    await putClasses(next);
  } catch (e) {
    XS.toast(e.message, "bad");
  }
}

/** DELETE shifts later class indices; reload the open label so boxes point at the right names. */
async function deleteClassAt(i, ask = true) {
  const n = st.counts[i] || 0;
  if (ask) {
    const ok = await XS.confirm("删除类别 " + st.classes[i], n ? "有 " + n + " 个标注框使用这个类别，会一起删除。" : "没有标注框使用这个类别。", { danger: !!n, okText: "删除" });
    if (!ok) return false;
  }
  await flushSave();
  const d = await XS.api("DELETE", base() + "/classes/" + i);
  st.classes = d.classes;
  st.counts = d.counts;
  st.items = d.items.map((it) => ({ id: it.id, labeled: it.labeled, boxes: it.boxes }));
  st.cls = clamp(st.cls, 0, Math.max(0, st.classes.length - 1));
  return true;
}

async function reloadCurrentLabel() {
  const it = cur();
  if (!it || !st.label) return renderAll();
  const label = await XS.api("GET", base() + "/labels/" + it.id);
  st.label.boxes = (label.boxes || []).map((b) => ({ cls: b.cls, rect: b.rect.slice() }));
  st.loadedCls = st.label.boxes.map((b) => b.cls);
  st.selected = -1;
  st.undo = [];
  renderAll();
}

async function cleanClasses() {
  await flushSave();
  const unused = st.counts.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
  if (!unused.length) return XS.toast("所有类别都有标注框在使用");
  const ok = await XS.confirm("清理未引用的类别", "将删除 " + unused.map((i) => st.classes[i]).join("、") + "。");
  if (!ok) return;
  try {
    for (const i of unused.reverse()) await deleteClassAt(i, false);
    await reloadCurrentLabel();
    XS.toast("已删除 " + unused.length + " 个类别", "ok");
  } catch (e) {
    XS.toast(e.message, "bad");
  }
}

// ---------------------------------------------------------------- class picker (after drawing)

const pop = { list: [], active: 0 };

function openTagPop(p) {
  closePops(true);
  st.pending = p;
  const el = $("tag-pop");
  $("tag-pop-title").textContent = p.reclass !== undefined
    ? "更改类别（当前：" + (st.classes[st.label.boxes[p.reclass].cls] || "?") + "）"
    : "选择类别";
  $("tag-pop-input").value = "";
  el.hidden = false;
  const rect = p.rect || st.label.boxes[p.reclass].rect;
  const cr = view.canvas.getBoundingClientRect();
  const b = view.toCanvas(rect[2], rect[3]);
  const a = view.toCanvas(rect[0], rect[1]);
  const bw = el.offsetWidth;
  const bh = el.offsetHeight;
  let x = cr.left + b.x / view.dpr + 8;
  let y = cr.top + a.y / view.dpr;
  if (x + bw > window.innerWidth - 8) x = cr.left + a.x / view.dpr - bw - 8;
  x = clamp(x, 8, window.innerWidth - bw - 8);
  y = clamp(y, 8, window.innerHeight - bh - 8);
  el.style.left = x + "px";
  el.style.top = y + "px";
  renderTagPop();
  $("tag-pop-input").focus();
  view.draw();
}

function closeTagPop(keepFocus) {
  if (!st.pending) return;
  st.pending = null;
  $("tag-pop").hidden = true;
  if (!keepFocus) view.canvas.focus();
  view.draw();
}

function renderTagPop() {
  const f = $("tag-pop-input").value.trim().toLowerCase();
  pop.list = st.classes.map((name, i) => ({ name, i })).filter((c) => !f || c.name.toLowerCase().includes(f));
  const want = st.pending && st.pending.reclass !== undefined ? st.label.boxes[st.pending.reclass].cls : st.cls;
  const at = pop.list.findIndex((c) => c.i === want);
  pop.active = f ? 0 : at >= 0 ? at : 0;
  const box = $("tag-pop-list");
  box.innerHTML = "";
  pop.list.forEach((c, k) => {
    const row = document.createElement("div");
    row.className = "tag-item";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(k === pop.active));
    row.innerHTML = '<span class="k"></span><span class="dot"></span><span class="name"></span><span class="c"></span>';
    row.querySelector(".k").textContent = c.i < 9 ? c.i + 1 : "";
    row.querySelector(".dot").style.background = color(c.i);
    row.querySelector(".name").textContent = c.name;
    row.querySelector(".c").textContent = st.counts[c.i] || 0;
    row.onpointerdown = (e) => e.preventDefault();
    row.onclick = () => chooseClass(c.i);
    box.appendChild(row);
  });
  if (!pop.list.length) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = f ? "回车新建类别 “" + $("tag-pop-input").value.trim() + "”" : "还没有类别，输入名称后回车新建";
    box.appendChild(hint);
  }
}

function moveTagPop(delta) {
  if (!pop.list.length) return;
  pop.active = (pop.active + delta + pop.list.length) % pop.list.length;
  const rows = $("tag-pop-list").querySelectorAll(".tag-item");
  rows.forEach((r, k) => r.setAttribute("aria-selected", String(k === pop.active)));
  rows[pop.active].scrollIntoView({ block: "nearest" });
}

function chooseClass(i) {
  const p = st.pending;
  if (!p || i < 0) return;
  st.pending = null;
  $("tag-pop").hidden = true;
  if (p.reclass !== undefined) setBoxClass(p.reclass, i);
  else addBox(i, p.rect);
  view.canvas.focus();
}

async function confirmTagPop() {
  const text = $("tag-pop-input").value.trim();
  const exact = st.classes.indexOf(text);
  if (exact >= 0) return chooseClass(exact);
  if (pop.list.length) return chooseClass(pop.list[pop.active].i);
  if (!text) return;
  const i = await addClass(text);
  if (i >= 0) chooseClass(i);
}

// ---------------------------------------------------------------- class manager

function openTagMgr() {
  closePops();
  $("tag-mgr").hidden = false;
  $("btn-tags").setAttribute("aria-pressed", "true");
  renderTagMgr();
  $("tag-mgr-input").focus();
}

function closeTagMgr() {
  $("tag-mgr").hidden = true;
  $("btn-tags").setAttribute("aria-pressed", "false");
}

function renderTagMgr() {
  if ($("tag-mgr").hidden) return;
  const box = $("tag-mgr-list");
  box.innerHTML = "";
  st.classes.forEach((name, i) => {
    const row = document.createElement("div");
    row.className = "tag-item";
    row.innerHTML = '<span class="k"></span><span class="dot"></span><span class="name"></span><span class="c"></span><span class="acts">' +
      '<button type="button" class="icon-btn sm" data-a="ren">' + XS.icon("pencil") + "</button>" +
      '<button type="button" class="icon-btn sm danger" data-a="del">' + XS.icon("trash") + "</button></span>";
    row.querySelector(".k").textContent = i < 9 ? i + 1 : "";
    row.querySelector(".dot").style.background = color(i);
    row.querySelector(".name").textContent = name;
    row.querySelector(".c").textContent = (st.counts[i] || 0) + " 框";
    row.querySelector('[data-a="ren"]').setAttribute("aria-label", "重命名 " + name);
    row.querySelector('[data-a="del"]').setAttribute("aria-label", "删除 " + name);
    row.querySelector('[data-a="ren"]').onclick = () => renameClass(i);
    row.querySelector('[data-a="del"]').onclick = async () => {
      try {
        if (await deleteClassAt(i)) await reloadCurrentLabel();
      } catch (e) {
        XS.toast(e.message, "bad");
      }
    };
    box.appendChild(row);
  });
  if (!st.classes.length) box.innerHTML = '<div class="empty-hint">' + (st.ds ? "还没有类别" : "先新建数据集") + "</div>";
  $("tag-mgr-count").textContent = st.classes.length + " 个类别";
}

async function mgrAdd() {
  if (!(await ensureDataset())) return;
  const input = $("tag-mgr-input");
  const name = input.value.trim();
  if (!name) return input.focus();
  if (st.classes.includes(name)) return XS.toast("已有同名类别", "bad");
  if ((await addClass(name)) >= 0) {
    input.value = "";
    input.focus();
  }
}

function closePops(keepTag) {
  closeDatasetMenu();
  closeTagMgr();
  closeAuto();
  if (!keepTag) closeTagPop(true);
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderHeader();
  renderList();
  renderBoxes();
  renderClasses();
  renderCounts();
  renderStatus();
  renderTagMgr();
  view.draw();
}

function renderHeader() {
  $("ds-name").textContent = st.ds || "选择数据集";
  $("ds-count").textContent = st.ds ? labeledCount() + "/" + st.items.length : "";
  $("btn-rename-ds").disabled = !st.ds;
  $("btn-del-ds").disabled = !st.ds;
  const exp = $("btn-export");
  exp.href = st.ds ? base() + "/export" : "#";
  exp.setAttribute("download", (st.ds || "dataset") + "_yolo.zip");
  exp.setAttribute("aria-disabled", String(!st.ds || !labeledCount() || !st.classes.length));
  const has = !!st.px;
  $("btn-to-color").disabled = !has;
  $("empty").hidden = has;
  $("float-bar").hidden = !st.ds;
  $("help").hidden = !has;
  $("empty-title").textContent = !st.ds ? "先新建一个数据集，然后截图或上传图片" : st.items.length ? "选择右侧列表中的图片开始标注" : "还没有图片，从设备截图或上传开始";
  $("empty-capture").innerHTML = XS.icon(st.ds ? "camera" : "plus") + (st.ds ? " 截图" : " 新建数据集");
  const vis = visible();
  const pos = vis.indexOf(st.index);
  $("fb-pos").textContent = st.items.length ? (pos >= 0 ? pos + 1 : "-") + " / " + vis.length : "0 / 0";
  $("fb-prev").disabled = pos <= 0;
  $("fb-next").disabled = pos < 0 || pos >= vis.length - 1;
  $("fb-hide").setAttribute("aria-pressed", String(st.hidden));
  $("fb-hide").innerHTML = XS.icon(st.hidden ? "eye-off" : "eye");
}

function renderCounts() {
  const all = st.items.length;
  const lab = labeledCount();
  $("cnt-all").textContent = all;
  $("cnt-labeled").textContent = lab;
  $("cnt-unlabeled").textContent = all - lab;
  renderHeader();
}

function renderList() {
  const box = $("img-list");
  const vis = visible();
  box.innerHTML = "";
  if (!vis.length) {
    box.innerHTML = '<div class="empty-hint">' + (!st.ds ? "没有数据集" : st.items.length ? "没有符合筛选条件的图片" : "还没有图片") + "</div>";
    renderHeader();
    return;
  }
  const frag = document.createDocumentFragment();
  vis.forEach((i) => {
    const it = st.items[i];
    const s = itemState(it);
    const row = document.createElement("div");
    row.className = "img-row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === st.index));
    row.dataset.i = i;
    row.innerHTML = '<img loading="lazy" alt=""><div><div class="name"></div><div class="state"></div></div><span class="n"></span>' +
      '<button type="button" class="row-del">' + XS.icon("x") + "</button>";
    row.querySelector("img").src = base() + "/images/" + it.id;
    row.querySelector(".name").textContent = "#" + it.id;
    const se = row.querySelector(".state");
    se.textContent = s.text;
    se.className = "state " + s.cls;
    const n = row.querySelector(".n");
    n.textContent = it.boxes;
    n.className = "n" + (it.boxes ? " has" : "");
    row.querySelector(".row-del").setAttribute("aria-label", "删除图片 #" + it.id);
    row.onclick = (e) => {
      if (e.target.closest(".row-del")) deleteImage(i);
      else if (i !== st.index) openImage(i);
    };
    frag.appendChild(row);
  });
  box.appendChild(frag);
  locate(false);
  renderHeader();
}

function locate(smooth) {
  const row = $("img-list").querySelector('[aria-selected="true"]');
  if (row) row.scrollIntoView({ block: "nearest", behavior: smooth ? "smooth" : "auto" });
}

function renderBoxes(hoverOnly) {
  const box = $("box-list");
  if (hoverOnly) {
    box.querySelectorAll(".box-row").forEach((r) => (r.style.background = Number(r.dataset.i) === st.hoverBox ? "var(--bg-hover)" : ""));
    return;
  }
  box.innerHTML = "";
  const boxes = st.label ? st.label.boxes : [];
  $("box-count").textContent = boxes.length || "";
  const it = cur();
  $("btn-negative").hidden = !it || !st.label || boxes.length > 0 || (it.labeled && !it.boxes);
  $("btn-del-boxes").disabled = !boxes.length;
  if (!boxes.length) {
    box.innerHTML = '<div class="empty-hint">' + (!st.label ? "" : it && it.labeled ? "负样本：没有目标，导出时保留为空标签" : "在图片上拖拽画框开始标注") + "</div>";
    return;
  }
  boxes.forEach((b, i) => {
    const row = document.createElement("div");
    row.className = "box-row";
    row.dataset.i = i;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === st.selected));
    row.innerHTML = '<span class="idx"></span><span class="dot"></span><span class="cls"></span><span class="r"></span>' +
      '<button type="button" class="row-del">' + XS.icon("x") + "</button>";
    row.querySelector(".idx").textContent = i + 1;
    row.querySelector(".dot").style.background = color(b.cls);
    row.querySelector(".cls").textContent = st.classes[b.cls] !== undefined ? st.classes[b.cls] : "#" + b.cls;
    row.querySelector(".r").textContent = b.rect.join(",");
    row.querySelector(".row-del").setAttribute("aria-label", "删除第 " + (i + 1) + " 个框");
    row.onpointerenter = () => ((st.hoverBox = i), view.draw());
    row.onpointerleave = () => ((st.hoverBox = -1), view.draw());
    row.onclick = (e) => {
      if (e.target.closest(".row-del")) return removeBox(i);
      st.selected = i;
      renderBoxes();
      view.draw();
    };
    row.ondblclick = () => openTagPop({ reclass: i });
    box.appendChild(row);
  });
  const sel = box.querySelector('[aria-selected="true"]');
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function renderClasses() {
  const box = $("cls-chips");
  box.innerHTML = "";
  $("cls-count").textContent = st.classes.length || "";
  st.classes.forEach((name, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cls-chip";
    b.setAttribute("aria-pressed", String(i === st.cls));
    b.title = (i < 9 ? "快捷键 " + (i + 1) + " · " : "") + (st.counts[i] || 0) + " 个框";
    b.innerHTML = (i < 9 ? '<span class="k">' + (i + 1) + "</span>" : "") + '<span class="dot"></span><span class="nm"></span><span class="c"></span>';
    b.querySelector(".dot").style.background = color(i);
    b.querySelector(".nm").textContent = name;
    b.querySelector(".c").textContent = st.counts[i] || 0;
    b.onclick = () => {
      st.cls = i;
      if (st.selected >= 0) setBoxClass(st.selected, i);
      renderClasses();
    };
    box.appendChild(b);
  });
  if (!st.classes.length) box.innerHTML = '<span class="muted small">画框后输入类别名即可新建</span>';
}

function renderStatus() {
  $("st-size").textContent = st.label ? st.label.width + "×" + st.label.height : "-";
  const h = st.hover;
  $("st-cursor").textContent = h ? h.x + ", " + h.y + "  " + h.color : "-";
  $("st-swatch").style.background = h ? h.color : "transparent";
  let r = null;
  if (st.drag && st.drag.kind === "new" && st.drag.moved) r = normRect([st.drag.start.x, st.drag.start.y, st.drag.end.x, st.drag.end.y]);
  else if (st.label && st.label.boxes[st.selected]) r = st.label.boxes[st.selected].rect;
  $("st-rect").textContent = r ? "[" + r.join(", ") + "]  " + (r[2] - r[0]) + "×" + (r[3] - r[1]) : "-";
}

// ---------------------------------------------------------------- wiring

$("btn-new-ds").onclick = createDataset;
$("btn-rename-ds").onclick = renameDataset;
$("btn-del-ds").onclick = deleteDataset;
$("ds-btn").onclick = () => ($("ds-menu").hidden ? openDatasetMenu() : closeDatasetMenu());
$("ds-menu").addEventListener("keydown", (e) => {
  const list = Array.from($("ds-menu").querySelectorAll("button"));
  const i = list.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    list[(i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length].focus();
  } else if (e.key === "Escape") {
    e.stopPropagation();
    closeDatasetMenu();
    $("ds-btn").focus();
  }
});
document.addEventListener("pointerdown", (e) => {
  if (!$("ds-menu").hidden && !e.target.closest(".ds-picker")) closeDatasetMenu();
  if (st.pending && !e.target.closest("#tag-pop") && e.target !== view.canvas) closeTagPop(true);
});

$("btn-upload-dir").onclick = () => $("dir").click();
$("empty-dir").onclick = () => $("dir").click();
$("fb-upload").onclick = () => $("file").click();
$("empty-upload").onclick = () => $("file").click();
$("file").onchange = (e) => {
  uploadFiles(e.target.files);
  e.target.value = "";
};
$("dir").onchange = (e) => {
  uploadFiles(e.target.files);
  e.target.value = "";
};
$("fb-capture").onclick = capture;
$("empty-capture").onclick = () => (st.ds ? capture() : createDataset());
$("fb-prev").onclick = () => step(-1);
$("fb-next").onclick = () => step(1);
$("fb-fit").onclick = () => view.fit();
$("fb-locate").onclick = () => locate(true);
$("fb-hide").onclick = () => {
  st.hidden = !st.hidden;
  if (st.hidden) st.selected = -1;
  renderHeader();
  renderBoxes();
  view.draw();
};
$("fb-auto").onclick = () => ($("auto-pop").hidden ? openAuto() : closeAuto());
$("auto-close").onclick = closeAuto;
$("ac-start").onclick = startAuto;
$("ac-stop").onclick = stopAuto;
$("ac-count").oninput = updateAutoText;
$("ac-interval").oninput = updateAutoText;

$("btn-export").onclick = async (e) => {
  if (!st.ds) {
    e.preventDefault();
    return XS.toast("先选择数据集");
  }
  if (!st.classes.length || !labeledCount()) {
    e.preventDefault();
    return XS.toast("还没有已标注的图片，无法导出", "bad");
  }
  if (st.saveTimer || st.saving) {
    // Make sure the zip includes the last edit, then start the download.
    e.preventDefault();
    await flushSave();
    const a = document.createElement("a");
    a.href = base() + "/export";
    a.download = st.ds + "_yolo.zip";
    a.click();
  }
  XS.toast("正在导出 " + labeledCount() + " 张已标注图片…", "ok");
};

document.querySelectorAll(".filter-bar [data-filter]").forEach((b) => {
  b.onclick = () => {
    st.filter = b.dataset.filter;
    document.querySelectorAll(".filter-bar [data-filter]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    renderList();
  };
});
$("img-list").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    step(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Delete" && st.index >= 0) {
    e.preventDefault();
    e.stopPropagation();
    deleteImage(st.index);
  }
});
$("btn-del-unlabeled").onclick = () => deleteImages((it) => !it.labeled, "未标注的图片");
$("btn-del-all-img").onclick = () => deleteImages(() => true, "全部图片");
$("btn-del-boxes").onclick = () => {
  if (!st.label || !st.label.boxes.length) return;
  snapshotBoxes();
  st.label.boxes = [];
  st.selected = -1;
  changed();
  XS.toast("已删除当前图片的标注（Ctrl/⌘ + Z 撤销）");
};
$("btn-negative").onclick = async () => {
  clearTimeout(st.saveTimer);
  await save(true);
  renderBoxes();
  XS.toast("已标为负样本", "ok");
};
$("btn-add-cls").onclick = openTagMgr;
$("btn-tags").onclick = () => ($("tag-mgr").hidden ? openTagMgr() : closeTagMgr());
$("tag-mgr-close").onclick = closeTagMgr;
$("tag-mgr-add").onclick = mgrAdd;
$("tag-mgr-input").addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && mgrAdd());
$("tag-mgr-clean").onclick = cleanClasses;

$("tag-pop-close").onclick = () => closeTagPop(false);
$("tag-pop-add").onclick = async () => {
  const i = await addClass($("tag-pop-input").value);
  if (i >= 0) chooseClass(i);
  else $("tag-pop-input").focus();
};
$("tag-pop-input").addEventListener("input", renderTagPop);
$("tag-pop-input").addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  e.stopPropagation();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    moveTagPop(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    confirmTagPop();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeTagPop(false);
  } else if (/^[1-9]$/.test(e.key) && !e.target.value && Number(e.key) <= st.classes.length) {
    e.preventDefault();
    chooseClass(Number(e.key) - 1);
  }
});

// Drag & drop / paste images.
const stage = $("stage");
stage.addEventListener("dragover", (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
  e.preventDefault();
  stage.classList.add("dragover");
});
stage.addEventListener("dragleave", (e) => !stage.contains(e.relatedTarget) && stage.classList.remove("dragover"));
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
  if (e.defaultPrevented || XS._menu || document.querySelector(".xs-dialog-backdrop")) return;
  const k = e.key;
  if ((e.metaKey || e.ctrlKey) && (k === "z" || k === "Z") && !XS.isTyping()) {
    e.preventDefault();
    undo();
    return;
  }
  if (k === "Escape") {
    if (st.pending) closeTagPop(false);
    else if (!$("tag-mgr").hidden || !$("auto-pop").hidden || !$("ds-menu").hidden) closePops();
    else if (st.selected >= 0) {
      st.selected = -1;
      renderBoxes();
      renderStatus();
      view.draw();
    }
    return;
  }
  if (XS.isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
  const sel = st.label && st.label.boxes[st.selected];
  if (k === "a" || k === "A") step(-1);
  else if (k === "d" || k === "D") step(1);
  else if ((k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") && sel) {
    const s = e.shiftKey ? 10 : 1;
    const dx = k === "ArrowLeft" ? -s : k === "ArrowRight" ? s : 0;
    const dy = k === "ArrowUp" ? -s : k === "ArrowDown" ? s : 0;
    const r = sel.rect;
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    const l = clamp(r[0] + dx, 0, st.label.width - w);
    const t = clamp(r[1] + dy, 0, st.label.height - h);
    if (l !== r[0] || t !== r[1]) {
      if (!e.repeat) snapshotBoxes();
      sel.rect = [l, t, l + w, t + h];
      changed();
    }
  } else if (k === "ArrowLeft") step(-1);
  else if (k === "ArrowRight") step(1);
  else if ((k === "Delete" || k === "Backspace") && sel) removeBox(st.selected);
  else if (/^[1-9]$/.test(k) && Number(k) <= st.classes.length) {
    const c = Number(k) - 1;
    if (sel) setBoxClass(st.selected, c);
    st.cls = c;
    renderClasses();
  } else if (k === "h" || k === "H") $("fb-hide").click();
  else if (k === "f" || k === "F") view.fit();
  else if (k === "s" || k === "S") capture();
  else if (k === "+" || k === "=") view.zoomBy(1.25);
  else if (k === "-") view.zoomBy(0.8);
  else return;
  e.preventDefault();
});

window.addEventListener("beforeunload", (e) => {
  // XS.go already asked (guardLeave) and waited for the save.
  if (XS._leaving) return;
  if (st.auto) {
    e.preventDefault();
    e.returnValue = "";
  }
  if (!st.saveTimer || !cur() || !st.label) return;
  // The page is going away; keepalive lets the last edit reach the device.
  const it = cur();
  const url = base() + "/labels/" + it.id;
  if (!st.label.boxes.length) {
    if (it.labeled) fetch(url, { method: "DELETE", keepalive: true });
    return;
  }
  fetch(url, {
    method: "PUT",
    keepalive: true,
    headers: { "Content-Type": "application/json", "X-XScript-Client": "tools" },
    body: JSON.stringify({ width: st.label.width, height: st.label.height, boxes: st.label.boxes }),
  });
});

// ---- switching tools from the shared app bar ----

XS.guardLeave(async () => {
  if (!st.auto) return true;
  const ok = await XS.confirm("自动截图进行中", "离开页面会停止自动截图（已截的 " + (st.auto.done - st.auto.failed) + " 张会保留）。", { okText: "停止并离开" });
  if (ok) stopAuto();
  return ok;
});
XS.onLeave(() => flushSave());

/** Open the current image in 图色工具: upload it as a snapshot (PNG) and pass its id along. */
async function toColor() {
  const it = cur();
  if (!it || !st.px) return;
  const btn = $("btn-to-color");
  btn.disabled = true;
  try {
    const blob = await new Promise((ok, bad) => st.px.canvas.toBlob((b) => (b ? ok(b) : bad(new Error("图片转换失败"))), "image/png"));
    const snap = await XS.api("POST", "/tools/snapshots", blob);
    await XS.go("/tools/ui/color.html?snapshot=" + encodeURIComponent(snap.id) + "&name=" + encodeURIComponent(st.ds + " #" + it.id));
  } catch (e) {
    XS.toast("打开失败：" + e.message, "bad");
  } finally {
    btn.disabled = !cur();
  }
}
$("btn-to-color").onclick = toColor;

/** `?snapshot=<id>` from 图色工具: add that snapshot to the current (or a new) dataset and open it. */
async function importSnapshot(id) {
  if (!(await ensureDataset())) return;
  busy(true, "加入数据集…");
  try {
    const out = await XS.api("POST", base() + "/images", { snapshot: id });
    addItem(out.id);
    await openImage(st.items.length - 1);
    XS.toast("截图已加入数据集 " + st.ds + "（第 " + st.items.length + " 张）", "ok");
  } catch (e) {
    XS.toast("加入失败：" + (/missing snapshot/.test(e.message) ? "截图已被设备清理" : e.message), "bad", 4000);
  } finally {
    busy(false);
  }
}

view.canvas.tabIndex = 0;
renderAll();
const handoff = XS.takeParam("snapshot");
XS.takeParam("name");
loadDatasets()
  .then(() => handoff && importSnapshot(handoff))
  .catch((e) => {
    XS.toast("加载数据集失败：" + e.message, "bad", 4000);
    renderAll();
  });
