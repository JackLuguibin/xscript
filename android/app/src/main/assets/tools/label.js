"use strict";

const $ = (id) => document.getElementById(id);
const PALETTE = ["#e5484d", "#2f7cf6", "#12a150", "#f59e0b", "#8e44ad", "#00b8d4", "#d6409f", "#6b7785", "#b7791f", "#0d9488"];
const st = {
  ds: null,         // dataset name
  classes: [],
  items: [],        // [{id, file, boxes}]
  index: -1,
  img: null,
  label: null,      // {width, height, boxes: [{cls, rect}]}
  cls: 0,
  selected: -1,
  drag: null,       // {kind: "new"|"move", start, orig}
  saveTimer: null,
  openSeq: 0,
};

const view = new ImageView($("view"), { onDraw: draw, onPointer: pointer });

function base() {
  return "/tools/datasets/" + encodeURIComponent(st.ds);
}

function status(text, kind) {
  XS.status($("status"), text, kind);
}

async function loadDatasets(select) {
  const out = await XS.api("GET", "/tools/datasets");
  const sel = $("dataset");
  sel.innerHTML = "";
  for (const d of out.datasets) {
    const o = document.createElement("option");
    o.value = d.name;
    o.textContent = d.name + "（" + d.labeled + "/" + d.images + "）";
    sel.appendChild(o);
  }
  const want = select || localStorage.getItem("xs-dataset");
  if (want && out.datasets.some((d) => d.name === want)) sel.value = want;
  if (sel.value) await openDataset(sel.value);
  else {
    st.ds = null;
    renderAll();
  }
}

async function openDataset(name) {
  st.ds = name;
  localStorage.setItem("xs-dataset", name);
  const d = await XS.api("GET", base());
  st.classes = d.classes;
  st.items = d.items;
  st.cls = Math.min(st.cls, Math.max(0, st.classes.length - 1));
  $("export").href = base() + "/export";
  $("export").setAttribute("download", name + "_yolo.zip");
  await openImage(st.items.length ? st.items.length - 1 : -1);
}

async function openImage(i) {
  // Fast thumbnail clicks start overlapping loads; only the latest one may apply.
  const token = ++st.openSeq;
  await flushSave();
  if (token !== st.openSeq) return;
  st.index = i;
  st.selected = -1;
  if (i < 0 || i >= st.items.length) {
    st.img = null;
    st.label = null;
    view.setImage(null);
    renderAll();
    return;
  }
  const item = st.items[i];
  const img = new Image();
  img.src = base() + "/images/" + item.id;
  const [label] = await Promise.all([XS.api("GET", base() + "/labels/" + item.id), img.decode()]);
  if (token !== st.openSeq) return;
  st.img = img;
  if (!label.width) {
    label.width = img.naturalWidth;
    label.height = img.naturalHeight;
  }
  st.label = label;
  view.setImage(img);
  renderAll();
}

function renderAll() {
  renderThumbs();
  renderClasses();
  renderBoxes();
  $("hint").textContent = !st.ds
    ? "新建或选择一个数据集，再点“截图加入”。"
    : st.img ? "拖动画框；滚轮缩放，按住空格拖动平移。" : "点“截图加入”或上传图片。";
  view.draw();
}

function renderThumbs() {
  const box = $("thumbs");
  box.innerHTML = "";
  st.items.forEach((it, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "listitem");
    b.setAttribute("aria-pressed", String(i === st.index));
    b.setAttribute("aria-label", "图片 " + it.id + "，" + it.boxes + " 个框");
    b.innerHTML = "<img loading='lazy' alt='' src='" + base() + "/images/" + it.id + "'><span class='badge'>" + it.boxes + "</span>";
    b.onclick = () => openImage(i);
    box.appendChild(b);
  });
}

function renderClasses() {
  const box = $("classes");
  box.innerHTML = "";
  st.classes.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", String(i === st.cls));
    b.innerHTML = "<span class='dot' style='background:" + PALETTE[i % PALETTE.length] + "'></span> " +
      (i < 9 ? (i + 1) + " · " : "") + XS.esc(c);
    b.onclick = () => {
      st.cls = i;
      if (st.selected >= 0 && st.label) {
        st.label.boxes[st.selected].cls = i;
        scheduleSave();
      }
      renderClasses();
      renderBoxes();
      view.draw();
    };
    box.appendChild(b);
  });
  if (!st.classes.length) box.innerHTML = "<span class='status'>先添加至少一个类别</span>";
}

function renderBoxes() {
  const tb = $("boxes");
  tb.innerHTML = "";
  (st.label ? st.label.boxes : []).forEach((b, i) => {
    const tr = document.createElement("tr");
    if (i === st.selected) tr.style.background = "#e8f0fe";
    tr.innerHTML = "<td>" + (i + 1) + "</td><td>" + XS.esc(st.classes[b.cls] || b.cls) + "</td>" +
      "<td class='mono'>" + b.rect.join(",") + "</td>" +
      "<td><button type='button' aria-label='删除第 " + (i + 1) + " 个框'>删除</button></td>";
    tr.onclick = () => {
      st.selected = i;
      renderBoxes();
      view.draw();
    };
    tr.querySelector("button").onclick = (e) => {
      e.stopPropagation();
      removeBox(i);
    };
    tb.appendChild(tr);
  });
}

function draw(ctx, v) {
  if (!st.label) return;
  const s = v.scale;
  const boxes = st.label.boxes.slice();
  if (st.drag && st.drag.kind === "new") boxes.push({ cls: st.cls, rect: normRect(st.drag.start, st.drag.end), draft: true });
  boxes.forEach((b, i) => {
    const color = PALETTE[b.cls % PALETTE.length];
    const a = v.toCanvas(b.rect[0], b.rect[1]);
    const w = (b.rect[2] - b.rect[0]) * s;
    const h = (b.rect[3] - b.rect[1]) * s;
    ctx.lineWidth = i === st.selected ? 3 : 2;
    ctx.strokeStyle = color;
    ctx.setLineDash(b.draft ? [6, 4] : []);
    ctx.strokeRect(a.x, a.y, w, h);
    ctx.setLineDash([]);
    if (i === st.selected) {
      ctx.fillStyle = color + "33";
      ctx.fillRect(a.x, a.y, w, h);
    }
    const name = st.classes[b.cls] || String(b.cls);
    ctx.font = "12px sans-serif";
    const tw = ctx.measureText(name).width + 8;
    ctx.fillStyle = color;
    ctx.fillRect(a.x, a.y - 16, tw, 16);
    ctx.fillStyle = "#fff";
    ctx.fillText(name, a.x + 4, a.y - 4);
  });
}

function normRect(a, b) {
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

function clampPt(p) {
  return { x: Math.min(Math.max(p.x, 0), st.label.width), y: Math.min(Math.max(p.y, 0), st.label.height) };
}

function hitBox(p) {
  const boxes = st.label.boxes;
  for (let i = boxes.length - 1; i >= 0; i--) {
    const r = boxes[i].rect;
    if (p.x >= r[0] && p.x <= r[2] && p.y >= r[1] && p.y <= r[3]) return i;
  }
  return -1;
}

function pointer(kind, p, e) {
  if (!st.label) return;
  if (kind === "down" && e.button === 0) {
    const hit = hitBox(p);
    if (hit >= 0) {
      st.selected = hit;
      st.drag = { kind: "move", start: p, orig: st.label.boxes[hit].rect.slice() };
    } else {
      if (!st.classes.length) return status("先添加类别", "bad");
      st.selected = -1;
      st.drag = { kind: "new", start: clampPt(p), end: clampPt(p) };
    }
    renderBoxes();
    view.draw();
  } else if (kind === "move" && st.drag) {
    if (st.drag.kind === "new") {
      st.drag.end = clampPt(p);
    } else {
      const dx = p.x - st.drag.start.x;
      const dy = p.y - st.drag.start.y;
      const o = st.drag.orig;
      const w = o[2] - o[0];
      const h = o[3] - o[1];
      const l = Math.min(Math.max(o[0] + dx, 0), st.label.width - w);
      const t = Math.min(Math.max(o[1] + dy, 0), st.label.height - h);
      st.label.boxes[st.selected].rect = [l, t, l + w, t + h];
    }
    view.draw();
  } else if (kind === "up" && st.drag) {
    const d = st.drag;
    st.drag = null;
    if (d.kind === "new") {
      const r = normRect(d.start, clampPt(p));
      if (r[2] - r[0] >= 3 && r[3] - r[1] >= 3) {
        st.label.boxes.push({ cls: st.cls, rect: r });
        st.selected = st.label.boxes.length - 1;
        scheduleSave();
      }
    } else if (st.label.boxes[st.selected].rect.join() !== d.orig.join()) {
      scheduleSave();
    }
    renderBoxes();
    view.draw();
  }
}

function removeBox(i) {
  st.label.boxes.splice(i, 1);
  st.selected = -1;
  scheduleSave();
  renderBoxes();
  view.draw();
}

function scheduleSave() {
  clearTimeout(st.saveTimer);
  status("未保存…");
  st.saveTimer = setTimeout(save, 400);
}

async function flushSave() {
  if (st.saveTimer) {
    clearTimeout(st.saveTimer);
    await save();
  }
}

async function save() {
  st.saveTimer = null;
  if (!st.label || st.index < 0) return;
  const item = st.items[st.index];
  try {
    const out = await XS.api("PUT", base() + "/labels/" + item.id, st.label);
    item.boxes = out.boxes.length;
    status("已保存", "ok");
    renderThumbs();
  } catch (e) {
    status("保存失败：" + e.message, "bad");
  }
}

async function refreshItems(selectLast) {
  const d = await XS.api("GET", base());
  st.items = d.items;
  await openImage(selectLast ? st.items.length - 1 : Math.min(st.index, st.items.length - 1));
}

// ---- actions ----

$("dataset").onchange = (e) => openDataset(e.target.value).catch((err) => status(err.message, "bad"));

$("new-ds").onclick = async () => {
  const name = prompt("数据集名称（字母、数字、下划线、中文）", "dataset");
  if (!name) return;
  try {
    await XS.api("POST", "/tools/datasets/" + encodeURIComponent(name.trim()));
    await loadDatasets(name.trim());
  } catch (e) {
    status(e.message, "bad");
  }
};

$("del-ds").onclick = async () => {
  if (!st.ds || !confirm("删除数据集 " + st.ds + "？图片和标注都会被删除，无法恢复。")) return;
  try {
    await XS.api("DELETE", base());
    localStorage.removeItem("xs-dataset");
    await loadDatasets();
  } catch (e) {
    status(e.message, "bad");
  }
};

$("add-class").onclick = async () => {
  const name = $("new-class").value.trim();
  if (!st.ds || !name) return;
  try {
    const d = await XS.api("PUT", base() + "/classes", { classes: st.classes.concat([name]) });
    st.classes = d.classes;
    st.cls = st.classes.length - 1;
    $("new-class").value = "";
    renderClasses();
  } catch (e) {
    status(e.message, "bad");
  }
};
$("new-class").addEventListener("keydown", (e) => e.key === "Enter" && $("add-class").click());

$("add-snap").onclick = async () => {
  if (!st.ds) return status("先新建数据集", "bad");
  const btn = $("add-snap");
  btn.disabled = true;
  status("截图中…");
  try {
    const snap = await XS.api("POST", "/tools/snapshots");
    await XS.api("POST", base() + "/images", { snapshot: snap.id });
    await refreshItems(true);
    status("已加入", "ok");
  } catch (e) {
    status(e.message, "bad");
  } finally {
    btn.disabled = false;
  }
};

$("upload").onchange = async (e) => {
  if (!st.ds) return status("先新建数据集", "bad");
  const files = Array.from(e.target.files || []);
  for (const f of files) {
    try {
      await XS.api("POST", base() + "/images", f);
    } catch (err) {
      status(f.name + "：" + err.message, "bad");
    }
  }
  e.target.value = "";
  await refreshItems(true);
};

$("del-img").onclick = async () => {
  if (st.index < 0 || !confirm("删除这张图片及其标注？")) return;
  const id = st.items[st.index].id;
  clearTimeout(st.saveTimer);
  st.saveTimer = null;
  await XS.api("DELETE", base() + "/images/" + id);
  await refreshItems(false);
};

$("prev").onclick = () => st.index > 0 && openImage(st.index - 1);
$("next").onclick = () => st.index < st.items.length - 1 && openImage(st.index + 1);

$("export").onclick = (e) => {
  if (!st.ds) {
    e.preventDefault();
    status("先选择数据集", "bad");
  }
};

window.addEventListener("keydown", (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if ((e.key === "Delete" || e.key === "Backspace") && st.selected >= 0) {
    e.preventDefault();
    removeBox(st.selected);
  } else if (e.key === "a" || e.key === "ArrowLeft") {
    $("prev").click();
  } else if (e.key === "d" || e.key === "ArrowRight") {
    $("next").click();
  } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= st.classes.length) {
    st.cls = Number(e.key) - 1;
    renderClasses();
  }
});

window.addEventListener("beforeunload", () => {
  if (st.saveTimer) save();
});

loadDatasets().catch((e) => status(e.message, "bad"));
