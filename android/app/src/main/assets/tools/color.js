"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  snap: null,      // {id, width, height, url}
  pixels: null,    // offscreen canvas with the snapshot
  points: [],      // [{x, y, color}]
  rect: null,      // [l, t, r, b]
  drag: null,
  hover: null,
  hits: [],        // [{x, y}] or [{rect}] from the last test
};

const view = new ImageView($("view"), {
  onDraw: drawOverlay,
  onPointer: pointer,
});

function colorAt(x, y) {
  if (!state.pixels || x < 0 || y < 0 || x >= state.pixels.width || y >= state.pixels.height) return null;
  const d = state.pixels.ctx.getImageData(x, y, 1, 1).data;
  return XS.hex(d[0], d[1], d[2]);
}

async function snapshot() {
  const btn = $("snap");
  btn.disabled = true;
  XS.status($("snap-info"), "截图中…");
  try {
    const snap = await XS.api("POST", "/tools/snapshots");
    state.snap = snap;
    state.pixels = await XS.loadPixels(snap.url);
    state.points = [];
    state.rect = null;
    state.hits = [];
    view.setImage(state.pixels.canvas);
    $("hint").textContent = "点击取色；切到“框选区域”拖动选择范围。滚轮缩放，空格拖动平移。";
    XS.status($("snap-info"), snap.width + "×" + snap.height, "ok");
    render();
  } catch (e) {
    XS.status($("snap-info"), "截图失败：" + e.message, "bad");
  } finally {
    btn.disabled = false;
  }
}

function pointer(kind, p, e) {
  if (kind === "move") {
    state.hover = view.inside(p) ? p : null;
    updateLoupe();
  }
  const mode = $("mode").value;
  if (mode === "pick") {
    if (kind === "up" && view.inside(p) && e.button === 0) {
      state.points.push({ x: p.x, y: p.y, color: colorAt(p.x, p.y) });
      render();
    }
    return;
  }
  // rect mode
  const clamp = (q) => ({
    x: Math.min(Math.max(q.x, 0), state.pixels.width),
    y: Math.min(Math.max(q.y, 0), state.pixels.height),
  });
  if (kind === "down" && e.button === 0) state.drag = { start: clamp(p), end: clamp(p) };
  if (kind === "move" && state.drag) {
    state.drag.end = clamp(p);
    view.draw();
  }
  if (kind === "up" && state.drag) {
    const a = state.drag.start;
    const b = clamp(p);
    state.drag = null;
    const r = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
    state.rect = r[2] - r[0] >= 2 && r[3] - r[1] >= 2 ? r : null;
    render();
  }
}

function drawOverlay(ctx, v) {
  const s = v.scale;
  ctx.lineWidth = 2;
  // Test hits.
  ctx.strokeStyle = "#12a150";
  for (const h of state.hits) {
    if (h.rect) {
      const a = v.toCanvas(h.rect[0], h.rect[1]);
      ctx.strokeRect(a.x, a.y, (h.rect[2] - h.rect[0]) * s, (h.rect[3] - h.rect[1]) * s);
    } else {
      const c = v.toCanvas(h.x + 0.5, h.y + 0.5);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // Region.
  const r = state.drag
    ? [Math.min(state.drag.start.x, state.drag.end.x), Math.min(state.drag.start.y, state.drag.end.y),
       Math.max(state.drag.start.x, state.drag.end.x), Math.max(state.drag.start.y, state.drag.end.y)]
    : state.rect;
  if (r) {
    const a = v.toCanvas(r[0], r[1]);
    ctx.strokeStyle = "#2f7cf6";
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(a.x, a.y, (r[2] - r[0]) * s, (r[3] - r[1]) * s);
    ctx.setLineDash([]);
  }
  // Color points.
  state.points.forEach((pt, i) => {
    const c = v.toCanvas(pt.x + 0.5, pt.y + 0.5);
    ctx.strokeStyle = "#fff";
    ctx.fillStyle = "#e5484d";
    ctx.beginPath();
    ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText(String(i + 1), c.x + 7, c.y - 7);
  });
}

function updateLoupe() {
  const lc = $("loupe");
  const lctx = lc.getContext("2d");
  lctx.clearRect(0, 0, 11, 11);
  const p = state.hover;
  if (!p || !state.pixels) {
    $("cur-pos").textContent = "x -, y -";
    $("cur-color").textContent = "#------";
    return;
  }
  lctx.drawImage(state.pixels.canvas, p.x - 5, p.y - 5, 11, 11, 0, 0, 11, 11);
  lctx.strokeStyle = "rgba(255,0,0,0.9)";
  lctx.lineWidth = 0.15;
  lctx.strokeRect(5, 5, 1, 1);
  $("cur-pos").textContent = "x " + p.x + ", y " + p.y;
  $("cur-color").textContent = colorAt(p.x, p.y);
}

function colorString() {
  const delta = $("delta").value.trim().replace(/^#/, "");
  const suffix = /^[0-9a-fA-F]{6}$/.test(delta) ? "-#" + delta.toUpperCase() : "";
  return state.points.map((p) => p.x + "," + p.y + "," + p.color.toUpperCase() + suffix).join("|");
}

function render() {
  const tbody = $("points");
  tbody.innerHTML = "";
  state.points.forEach((p, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + (i + 1) + "</td><td class='mono'>" + p.x + "," + p.y + "</td>" +
      "<td class='swatch mono'><span style='background:" + XS.esc(p.color) + "'></span> " + XS.esc(p.color) + "</td>" +
      "<td><button type='button' aria-label='删除第 " + (i + 1) + " 个点'>删除</button></td>";
    tr.querySelector("button").onclick = () => {
      state.points.splice(i, 1);
      render();
    };
    tbody.appendChild(tr);
  });
  $("colors").value = colorString();
  $("rect-text").textContent = state.rect ? "[" + state.rect.join(", ") + "]  " +
    (state.rect[2] - state.rect[0]) + "×" + (state.rect[3] - state.rect[1]) : "未框选";
  view.draw();
}

function rectArg() {
  return $("use-rect").checked && state.rect ? state.rect : null;
}

function pyRect() {
  const r = rectArg();
  return r ? ", rect=[" + r.join(", ") + "]" : "";
}

async function test(op) {
  if (!state.snap) return XS.status($("test-status"), "请先截图", "bad");
  const colors = $("colors").value.trim();
  const sim = parseFloat($("sim").value) || 0.9;
  const req = { op, snapshot: state.snap.id, rect: rectArg(), sim };
  if (op === "find_colors" || op === "compare_colors") {
    if (!colors) return XS.status($("test-status"), "先添加颜色点", "bad");
    req.colors = colors;
  }
  if (op === "find_image") {
    if (!state.rect) return XS.status($("test-status"), "先框选模板区域", "bad");
    req.template_rect = state.rect;
    req.rect = null;
    req.confidence = sim;
  }
  XS.status($("test-status"), "执行中…");
  $("test-out").textContent = "";
  try {
    const out = await XS.api("POST", "/tools/vision", req);
    state.hits = [];
    let summary = "";
    if (op === "find_colors") {
      state.hits = out.points.map((p) => ({ x: p[0], y: p[1] }));
      summary = out.points.length ? "找到 " + out.points.length + " 处" + (out.truncated ? "（已截断）" : "") : "未找到";
    } else if (op === "compare_colors") {
      summary = out.match ? "全部匹配" : "不匹配";
      state.hits = out.details.filter((d) => d.ok).map((d) => ({ x: d.x, y: d.y }));
    } else if (op === "find_image") {
      state.hits = out.hits.map((h) => ({ rect: h.rect }));
      summary = out.hits.length ? "找到 " + out.hits.length + " 处，最高 " + out.hits[0].confidence : "未找到";
    } else if (op === "ocr") {
      state.hits = out.lines.map((l) => ({ rect: l.rect }));
      summary = "识别 " + out.lines.length + " 行";
    }
    XS.status($("test-status"), summary + " · " + out.ms + " ms", state.hits.length || out.match ? "ok" : "bad");
    delete out.ok;
    $("test-out").textContent = JSON.stringify(out, null, 1);
    view.draw();
  } catch (e) {
    XS.status($("test-status"), e.message, "bad");
  }
}

async function loadProjects() {
  try {
    const out = await XS.api("GET", "/projects");
    const sel = $("project");
    sel.innerHTML = "";
    for (const name of out.projects) {
      const o = document.createElement("option");
      o.value = o.textContent = name;
      sel.appendChild(o);
    }
  } catch (e) {
    /* project list is optional */
  }
}

async function crop() {
  if (!state.snap || !state.rect) return XS.status($("test-status"), "先截图并框选区域", "bad");
  const project = $("project").value;
  if (!project) return XS.status($("test-status"), "设备上没有工程", "bad");
  try {
    const out = await XS.api("POST", "/tools/snapshots/" + state.snap.id + "/crop", {
      rect: state.rect, project, path: $("crop-path").value.trim(),
    });
    XS.status($("test-status"), "已保存 " + out.project + "/" + out.path, "ok");
    $("test-out").textContent = "from xscript.android import screen\nfrom xscript.android.system import R\n" +
      "hit = screen.find_image(R.root(" + JSON.stringify(out.path) + "), confidence=0.85)";
  } catch (e) {
    XS.status($("test-status"), e.message, "bad");
  }
}

$("snap").onclick = snapshot;
$("fit").onclick = () => view.fit();
$("clear").onclick = () => {
  state.points = [];
  state.hits = [];
  render();
};
$("clear-rect").onclick = () => {
  state.rect = null;
  render();
};
$("delta").oninput = () => ($("colors").value = colorString());
$("copy-colors").onclick = () => XS.copy($("colors").value, $("test-status"));
$("copy-find").onclick = () => XS.copy(
  "from ascript.android.screen import FindColors\npoint = FindColors.find(" +
  JSON.stringify($("colors").value) + pyRect() + ", diff=" + $("sim").value + ")", $("test-status"));
$("copy-compare").onclick = () => XS.copy(
  "from ascript.android.screen import CompareColors\nok = CompareColors.compare(" +
  JSON.stringify($("colors").value) + ", diff=" + $("sim").value + ")", $("test-status"));
$("copy-rect").onclick = () => state.rect && XS.copy("[" + state.rect.join(", ") + "]", $("test-status"));
$("crop").onclick = crop;
$("t-find").onclick = () => test("find_colors");
$("t-compare").onclick = () => test("compare_colors");
$("t-image").onclick = () => test("find_image");
$("t-ocr").onclick = () => test("ocr");
$("mode").onchange = () => ($("view").style.cursor = $("mode").value === "rect" ? "cell" : "crosshair");

loadProjects();
