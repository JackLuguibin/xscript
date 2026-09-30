"use strict";
/* 图色工具 plugins: 多点找色 (FindColors) and 多点比色 (CompareColors), AScript gpui layout. */
(function () {
  const PLUGINS = (window.XS_PLUGINS = window.XS_PLUGINS || []);
  const SLOTS = 9;

  /**
   * saveState/loadState for page switches: copy the settings in `keys`, skip results (they belong to
   * one frame). Unknown or badly typed values are ignored so an old session cannot break the page.
   */
  function persist(state, keys) {
    return {
      saveState: () => JSON.parse(JSON.stringify(keys.reduce((o, k) => ((o[k] = state[k]), o), {}))),
      loadState(saved) {
        if (!saved || typeof saved !== "object") return;
        keys.forEach((k) => {
          if (saved[k] !== undefined && (state[k] === null || saved[k] === null || typeof saved[k] === typeof state[k])) state[k] = saved[k];
        });
      },
    };
  }
  const validSlots = (arr) => Array.from({ length: SLOTS }, (_, i) => {
    const s = arr && arr[i];
    return s && Number.isFinite(s.x) && Number.isFinite(s.y) && /^#[0-9A-F]{6}$/i.test(s.color) ? s : null;
  });
  window.XS_PERSIST = persist;

  // ------------------------------------------------------------ shared: color slots

  /** "#RRGGBB" per-channel |a - b|, the AScript 偏色 value between two colors. */
  function colorDiff(a, b) {
    const x = XS.rgb(a);
    const y = XS.rgb(b);
    return XS.hex(Math.abs(x[0] - y[0]), Math.abs(x[1] - y[1]), Math.abs(x[2] - y[2]));
  }

  /** Parse the 偏色 prompt: "" → null, "#101010" → itself, "#A,#B" → their difference. */
  function parseDiff(text) {
    const hex = String(text || "").match(/#?[0-9a-fA-F]{6}\b/g) || [];
    if (!String(text || "").trim()) return null;
    if (hex.length === 1) return "#" + hex[0].replace("#", "").toUpperCase();
    if (hex.length === 2) return colorDiff("#" + hex[0].replace("#", ""), "#" + hex[1].replace("#", ""));
    return undefined;
  }

  function slotString(s) {
    return s.x + "," + s.y + "," + s.color + (s.diff ? "-" + s.diff : "");
  }

  function colorString(slots) {
    return slots.filter(Boolean).map(slotString).join("|");
  }

  function fillNext(slots, pt) {
    const i = slots.findIndex((s) => !s);
    if (i < 0) {
      XS.toast("9 个槽位已满，删除一个或按数字键覆盖", "bad");
      return -1;
    }
    slots[i] = { x: pt.x, y: pt.y, color: pt.color, diff: null };
    return i;
  }

  /** Parse "x,y,#RRGGBB[-#DDDDDD]|..." into slots (for paste / import). */
  function parseColorString(text) {
    const out = [];
    for (const part of String(text || "").split("|")) {
      const m = part.trim().match(/^(-?\d+)\s*,\s*(-?\d+)\s*,\s*#?([0-9a-fA-F]{6})(?:\s*-\s*#?([0-9a-fA-F]{6}))?$/);
      if (!m) {
        if (part.trim()) return null;
        continue;
      }
      out.push({ x: +m[1], y: +m[2], color: "#" + m[3].toUpperCase(), diff: m[4] ? "#" + m[4].toUpperCase() : null });
    }
    return out.length && out.length <= SLOTS ? out : null;
  }

  /**
   * Render the 9 slot rows. `status(i)` may return {cls: "pass"|"fail", note} after a test.
   * Hover highlights the point on the image; click copies it.
   */
  function renderSlots(box, slots, host, { onChange, status }) {
    box.innerHTML = "";
    for (let i = 0; i < SLOTS; i++) {
      const s = slots[i];
      const row = document.createElement("div");
      row.className = "slot";
      row.dataset.k = i;
      if (!s) {
        row.innerHTML = '<span class="k">' + (i + 1) + '</span><span class="muted">按 ' + (i + 1) + " 键或单击截图取色</span>";
        box.appendChild(row);
        continue;
      }
      const st = status ? status(i) : null;
      row.classList.add("filled");
      if (st && st.cls) row.classList.add(st.cls);
      row.title = "单击复制 " + slotString(s);
      row.innerHTML =
        '<span class="k">' + (i + 1) + '</span><span class="swatch"></span><span class="hex"></span><span class="pos"></span>' +
        '<span class="dif"></span><span class="note"></span><span class="act">' +
        '<button type="button" class="icon-btn sm" data-a="diff" title="设置偏色">' + XS.icon("sliders") + "</button>" +
        '<button type="button" class="icon-btn sm danger" data-a="del" title="删除">' + XS.icon("x") + "</button></span>";
      row.querySelector(".swatch").style.background = s.color;
      row.querySelector(".hex").textContent = s.color;
      row.querySelector(".pos").textContent = s.x + ", " + s.y;
      row.querySelector(".dif").textContent = s.diff ? "-" + s.diff : "";
      if (st && st.note) {
        const n = row.querySelector(".note");
        n.textContent = st.note;
        n.className = "note " + (st.cls === "fail" ? "bad" : "ok");
      }
      row.querySelector('[data-a="diff"]').setAttribute("aria-label", "设置第 " + (i + 1) + " 个颜色的偏色");
      row.querySelector('[data-a="del"]').setAttribute("aria-label", "删除第 " + (i + 1) + " 个颜色");
      row.addEventListener("pointerenter", () => host.flash({ x: s.x, y: s.y }, { center: false, hold: true }));
      row.addEventListener("pointerleave", () => host.flash(null));
      row.addEventListener("click", async (e) => {
        const a = e.target.closest("[data-a]");
        if (!a) return XS.copy(slotString(s));
        if (a.dataset.a === "del") {
          slots[i] = null;
          host.flash(null);
          onChange();
          return;
        }
        const v = await XS.prompt("偏色（第 " + (i + 1) + " 个颜色 " + s.color + "）", s.diff || "#101010", {
          body: "每个通道允许的差值，如 #101010。输入两种颜色（#A,#B）会自动计算差值；留空则使用相似度。",
          placeholder: "#101010",
        });
        if (v === null) return;
        const d = parseDiff(v);
        if (d === undefined) return XS.toast("偏色格式不对，应为 #RRGGBB", "bad");
        s.diff = d;
        onChange();
      });
      box.appendChild(row);
    }
  }

  function slotsHeader(title, count) {
    return '<div class="panel-header">' + XS.icon("droplet") + "<span>" + title + '</span><span class="count">' + count + "/9</span>" +
      '<div class="actions">' +
      '<button type="button" class="icon-btn sm" data-a="paste" title="粘贴特征串" aria-label="粘贴特征串">' + XS.icon("download") + "</button>" +
      '<button type="button" class="icon-btn sm" data-a="copy-colors" title="复制特征串" aria-label="复制特征串">' + XS.icon("copy") + "</button>" +
      '<button type="button" class="icon-btn sm danger" data-a="reset" title="清空颜色" aria-label="清空颜色">' + XS.icon("trash") + "</button>" +
      "</div></div>";
  }

  async function pasteSlots(slots) {
    const text = await XS.prompt("粘贴多点颜色特征串", "", { body: "格式：x,y,#RRGGBB[-#偏色]|x,y,#RRGGBB|…（最多 9 个点）", placeholder: "100,200,#FF0000|110,200,#FFFFFF" });
    if (!text) return false;
    const list = parseColorString(text);
    if (!list) {
      XS.toast("特征串格式不对", "bad");
      return false;
    }
    for (let i = 0; i < SLOTS; i++) slots[i] = list[i] || null;
    return true;
  }

  /** Result rows: [{tag, text, conf, target, copy}]; hover highlights, click copies. */
  function renderResults(box, items, host, emptyText) {
    box.innerHTML = "";
    if (!items.length) {
      box.innerHTML = '<div class="empty-hint"></div>';
      box.firstChild.textContent = emptyText;
      return;
    }
    items.forEach((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "res-item";
      b.innerHTML = '<span class="tag"></span><span class="txt"></span>' + (it.conf !== undefined ? '<span class="conf"></span>' : "");
      b.querySelector(".tag").textContent = it.tag;
      b.querySelector(".txt").textContent = it.text;
      if (it.conf !== undefined) b.querySelector(".conf").textContent = it.conf;
      b.title = "单击复制：" + it.copy;
      b.addEventListener("pointerenter", () => host.flash(it.target, { hold: true }));
      b.addEventListener("focus", () => host.flash(it.target, { hold: true }));
      b.addEventListener("pointerleave", () => host.flash(null));
      b.addEventListener("blur", () => host.flash(null));
      b.onclick = () => XS.copy(it.copy);
      box.appendChild(b);
    });
  }

  const fmt = (v) => String(Math.round(v * 1000) / 1000);

  // ------------------------------------------------------------ 多点找色

  const fc = {
    slots: new Array(SLOTS).fill(null),
    rect: null,
    diff: 0.98,
    ori: 2,
    space: 5,
    all: false,
    results: null, // {points, truncated, ms}
  };

  const fcPersist = persist(fc, ["slots", "rect", "diff", "ori", "space", "all"]);

  PLUGINS.push({
    id: "FindColors",
    name: "多点找色",
    icon: "palette",
    saveState: fcPersist.saveState,
    loadState(s) {
      fcPersist.loadState(s);
      fc.slots = validSlots(fc.slots);
    },

    mount(panel, host) {
      const ui = host.ui;
      this.host = host;
      panel.innerHTML =
        '<div class="plug-view"><section class="p-left">' +
        '<div data-part="slots-head"></div><div class="slots" data-part="slots"></div>' +
        '<div class="cfg">' +
        '<div data-part="rect"></div>' +
        ui.row("颜色相似度", '<input type="range" min="0.5" max="1" step="0.01" id="fc-diff"><span class="val" id="fc-diff-v"></span>', "fc-diff") +
        ui.row("找色方向", '<select id="fc-ori">' + ui.options(host.ORI, fc.ori) + "</select>", "fc-ori") +
        ui.row("结果间隔", '<input type="number" id="fc-space" min="0" max="500" step="1">', "fc-space") +
        ui.row("查找模式", '<select id="fc-all">' + ui.options([["0", "查找一个 → FindColors.find"], ["1", "查找全部 → FindColors.find_all"]], fc.all ? 1 : 0) + "</select>", "fc-all") +
        '<div class="cfg-actions"><button type="button" class="primary" data-a="test">' + XS.icon("play") + " 测试</button></div></div>" +
        '<div class="panel-header">' + XS.icon("list") + '<span>找色结果</span><span class="count" data-part="res-count"></span>' +
        '<div class="actions"><button type="button" class="icon-btn sm" data-a="clear-res" title="清空结果" aria-label="清空结果">' + XS.icon("trash") + "</button></div></div>" +
        '<div class="res-summary" data-part="summary" hidden></div><div class="res" data-part="res"></div>' +
        '</section><section class="p-right" data-part="code"></section></div>';

      const q = (s) => panel.querySelector(s);
      const rectRow = ui.rectRow(panel, fc, "rect", () => code.update(), "fc-rect");
      q('[data-part="rect"]').outerHTML = rectRow.html;
      this.rectCtl = rectRow.bind();

      const diff = q("#fc-diff");
      diff.value = fc.diff;
      q("#fc-diff-v").textContent = fmt(fc.diff);
      diff.oninput = () => {
        fc.diff = ui.num(diff.value, 0.5, 1, 0.98);
        q("#fc-diff-v").textContent = fmt(fc.diff);
        code.update();
      };
      q("#fc-ori").onchange = (e) => {
        fc.ori = Number(e.target.value);
        code.update();
      };
      const space = q("#fc-space");
      space.value = fc.space;
      space.oninput = () => {
        fc.space = Math.round(ui.num(space.value, 0, 500, 5));
        code.update();
      };
      q("#fc-all").onchange = (e) => {
        fc.all = e.target.value === "1";
        code.update();
      };
      q('[data-a="test"]').onclick = (e) => ui.run(e.currentTarget, () => this.test());
      q('[data-a="clear-res"]').onclick = () => this.clearResults();

      const code = ui.code(q('[data-part="code"]'), (style) => this.code(style));
      this.codeCtl = code;
      this.q = q;
      this.render();
      this.renderResults();
    },

    unmount() {
      this.host = null;
    },

    render() {
      const host = this.host;
      if (!host) return;
      const q = this.q;
      const n = fc.slots.filter(Boolean).length;
      q('[data-part="slots-head"]').innerHTML = slotsHeader("颜色列表", n);
      const head = q('[data-part="slots-head"]');
      head.querySelector('[data-a="reset"]').onclick = () => {
        fc.slots.fill(null);
        this.changed();
      };
      head.querySelector('[data-a="copy-colors"]').onclick = () => {
        const s = colorString(fc.slots);
        if (s) XS.copy(s);
        else XS.toast("还没有颜色");
      };
      head.querySelector('[data-a="paste"]').onclick = async () => (await pasteSlots(fc.slots)) && this.changed();
      renderSlots(q('[data-part="slots"]'), fc.slots, host, { onChange: () => this.changed() });
      this.codeCtl.update();
      host.redraw();
    },

    changed() {
      fc.results = null;
      this.renderResults();
      this.render();
    },

    renderResults() {
      if (!this.host) return;
      const q = this.q;
      const r = fc.results;
      const sum = q('[data-part="summary"]');
      q('[data-part="res-count"]').textContent = r ? r.points.length : "";
      sum.hidden = !r;
      if (r) {
        sum.className = "res-summary " + (r.points.length ? "ok" : "bad");
        sum.textContent = (r.points.length ? "找到 " + r.points.length + " 处" + (r.truncated ? "（仅显示前 100 个）" : "") : "没有找到") + " · " + r.ms + " ms";
      }
      renderResults(q('[data-part="res"]'), r ? r.points.map((p, i) => ({
        tag: String(i + 1), text: p[0] + ", " + p[1], target: { x: p[0], y: p[1] }, copy: p[0] + "," + p[1],
      })) : [], this.host, r ? "没有找到匹配位置，可降低相似度或检查搜索范围" : "点击测试，结果在这里展示");
    },

    async test() {
      const colors = colorString(fc.slots);
      if (!colors) throw new Error("先在截图上单击或按 1-9 取色");
      const out = await this.host.vision({
        op: "find_colors", colors, rect: fc.rect, sim: fc.diff, ori: fc.ori, space: fc.space, max_num: fc.all ? 100 : 1,
      });
      fc.results = { points: out.points, truncated: out.truncated, ms: out.ms };
      this.renderResults();
      this.host.redraw();
      if (out.points.length) this.host.flash({ x: out.points[0][0], y: out.points[0][1] });
    },

    clearResults() {
      fc.results = null;
      this.renderResults();
    },

    onPick(pt) {
      if (fillNext(fc.slots, pt) >= 0) this.changed();
      return true;
    },

    onSlotKey(k, pt) {
      fc.slots[k - 1] = { x: pt.x, y: pt.y, color: pt.color, diff: null };
      this.changed();
    },

    onRect(r) {
      fc.rect = r ? r.slice() : null;
      if (this.rectCtl) this.rectCtl.show();
      if (this.codeCtl) this.codeCtl.update();
    },

    marks() {
      const points = [];
      fc.slots.forEach((s, i) => s && points.push({ x: s.x, y: s.y, n: i + 1, state: "bad" }));
      const rects = [];
      if (fc.results) {
        // Draw each hit as the pattern's bounding box, shifted from the first point.
        const filled = fc.slots.filter(Boolean);
        const x0 = filled[0].x;
        const y0 = filled[0].y;
        const xs = filled.map((s) => s.x - x0);
        const ys = filled.map((s) => s.y - y0);
        const bx = [Math.min(...xs), Math.min(...ys), Math.max(...xs) + 1, Math.max(...ys) + 1];
        fc.results.points.forEach((p, i) => {
          rects.push({ rect: [p[0] + bx[0] - 2, p[1] + bx[1] - 2, p[0] + bx[2] + 2, p[1] + bx[3] + 2], n: i + 1, state: "ok" });
        });
      }
      return { points, rects };
    },

    code(style) {
      const colors = colorString(fc.slots) || "x,y,#RRGGBB|x,y,#RRGGBB";
      const rect = fc.rect ? ", rect=[" + fc.rect.join(", ") + "]" : "";
      const extra = (fc.ori !== 2 ? ", ori=" + fc.ori : "") + (fc.space !== 5 ? ", space=" + fc.space : "");
      if (style === "xscript") {
        const fn = fc.all ? "find_all_colors" : "find_colors";
        let s = "from xscript.android import screen\n\n";
        s += (fc.all ? "points" : "p") + " = screen." + fn + "(" + JSON.stringify(colors) + rect + ", sim=" + fmt(fc.diff) + extra + ")\n";
        s += fc.all ? "for p in points:\n    print(p.x, p.y)" : "if p:\n    print(p.x, p.y)";
        return s;
      }
      let s = "from ascript.android.screen import FindColors\n\n";
      s += "res = FindColors." + (fc.all ? "find_all" : "find") + "(" + JSON.stringify(colors) + rect + extra + ", diff=" + fmt(fc.diff) + ")\n";
      s += fc.all ? "for r in res or []:\n    print(r.x, r.y)" : "if res:\n    print(res.x, res.y)";
      return s;
    },
  });

  // ------------------------------------------------------------ 多点比色

  const cc = {
    groups: [new Array(SLOTS).fill(null)],
    active: 0,
    diff: 0.9,
    sim: 1,
    results: null, // per group: {match, hits, need, details}
    ms: 0,
  };

  const ccPersist = persist(cc, ["groups", "active", "diff", "sim"]);

  PLUGINS.push({
    id: "CompareColors",
    name: "多点比色",
    icon: "compare",
    saveState: ccPersist.saveState,
    loadState(s) {
      ccPersist.loadState(s);
      cc.groups = (Array.isArray(cc.groups) && cc.groups.length ? cc.groups.slice(0, 9) : [null]).map(validSlots);
      cc.active = Math.min(Math.max(0, cc.active | 0), cc.groups.length - 1);
    },

    mount(panel, host) {
      const ui = host.ui;
      this.host = host;
      panel.innerHTML =
        '<div class="plug-view"><section class="p-left">' +
        '<div class="group-tabs" data-part="groups" role="tablist" aria-label="颜色组"></div>' +
        '<div data-part="slots-head"></div><div class="slots" data-part="slots"></div>' +
        '<div class="cfg">' +
        ui.row("颜色相似度", '<input type="range" min="0.5" max="1" step="0.01" id="cc-diff"><span class="val" id="cc-diff-v"></span>', "cc-diff") +
        ui.row("数量相似度", '<input type="range" min="0.1" max="1" step="0.05" id="cc-sim"><span class="val" id="cc-sim-v"></span>', "cc-sim") +
        '<div class="cfg-actions"><button type="button" class="primary" data-a="test">' + XS.icon("play") + " 测试</button></div></div>" +
        '<div class="panel-header">' + XS.icon("list") + "<span>比色结果</span>" +
        '<div class="actions"><button type="button" class="icon-btn sm" data-a="clear-res" title="清空结果" aria-label="清空结果">' + XS.icon("trash") + "</button></div></div>" +
        '<div class="res" data-part="res"></div>' +
        '</section><section class="p-right" data-part="code"></section></div>';
      const q = (s) => panel.querySelector(s);
      this.q = q;
      const bindRange = (id, key, min, max, def) => {
        const el = q("#" + id);
        el.value = cc[key];
        q("#" + id + "-v").textContent = fmt(cc[key]);
        el.oninput = () => {
          cc[key] = ui.num(el.value, min, max, def);
          q("#" + id + "-v").textContent = fmt(cc[key]);
          this.codeCtl.update();
        };
      };
      this.codeCtl = ui.code(q('[data-part="code"]'), (style) => this.code(style));
      bindRange("cc-diff", "diff", 0.5, 1, 0.9);
      bindRange("cc-sim", "sim", 0.1, 1, 1);
      q('[data-a="test"]').onclick = (e) => ui.run(e.currentTarget, () => this.test());
      q('[data-a="clear-res"]').onclick = () => this.clearResults();
      this.render();
    },

    unmount() {
      this.host = null;
    },

    get slots() {
      return cc.groups[cc.active];
    },

    render() {
      const host = this.host;
      if (!host) return;
      const q = this.q;
      this.renderGroups();
      const head = q('[data-part="slots-head"]');
      head.innerHTML = slotsHeader("颜色列表 · 组 " + (cc.active + 1), this.slots.filter(Boolean).length);
      head.querySelector('[data-a="reset"]').onclick = () => {
        this.slots.fill(null);
        this.changed();
      };
      head.querySelector('[data-a="copy-colors"]').onclick = () => {
        const s = colorString(this.slots);
        if (s) XS.copy(s);
        else XS.toast("还没有颜色");
      };
      head.querySelector('[data-a="paste"]').onclick = async () => (await pasteSlots(this.slots)) && this.changed();
      const res = cc.results && cc.results[cc.active];
      renderSlots(q('[data-part="slots"]'), this.slots, host, {
        onChange: () => this.changed(),
        status: (i) => {
          if (!res) return null;
          const s = this.slots[i];
          const d = res.details.find((x) => x.x === s.x && x.y === s.y && x.expected.toUpperCase() === s.color);
          if (!d) return null;
          return { cls: d.ok ? "pass" : "fail", note: d.ok ? "✓" : "实际 " + String(d.actual || "越界").toUpperCase() };
        },
      });
      this.renderResults();
      this.codeCtl.update();
      host.redraw();
    },

    renderGroups() {
      const box = this.q('[data-part="groups"]');
      box.innerHTML = "";
      cc.groups.forEach((g, i) => {
        const t = document.createElement("button");
        t.type = "button";
        t.className = "group-tab";
        t.setAttribute("role", "tab");
        t.setAttribute("aria-selected", String(i === cc.active));
        const r = cc.results && cc.results[i];
        t.innerHTML = (r ? '<span class="dot ' + (r.match ? "ok" : "bad") + '"></span>' : "") + "<span>组 " + (i + 1) + "</span>" +
          (cc.groups.length > 1 ? '<span class="x" data-a="del" role="button" aria-label="删除组 ' + (i + 1) + '">' + XS.icon("x") + "</span>" : "");
        t.onclick = (e) => {
          if (e.target.closest('[data-a="del"]')) {
            cc.groups.splice(i, 1);
            cc.active = Math.min(cc.active, cc.groups.length - 1);
            cc.results = null;
          } else cc.active = i;
          this.render();
        };
        box.appendChild(t);
      });
      if (cc.groups.length < 9) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "group-tab add";
        add.title = "添加颜色组（compare_multi 依次比对，返回第一个匹配的组号）";
        add.setAttribute("aria-label", "添加颜色组");
        add.innerHTML = XS.icon("plus");
        add.onclick = () => {
          cc.groups.push(new Array(SLOTS).fill(null));
          cc.active = cc.groups.length - 1;
          cc.results = null;
          this.render();
        };
        box.appendChild(add);
      }
    },

    changed() {
      cc.results = null;
      this.render();
    },

    renderResults() {
      const box = this.q('[data-part="res"]');
      if (!cc.results) {
        box.innerHTML = '<div class="empty-hint">点击测试，逐点对比当前截图的颜色</div>';
        return;
      }
      box.innerHTML = "";
      const first = cc.results.findIndex((r) => r && r.match);
      const sum = document.createElement("div");
      const multi = cc.groups.length > 1;
      sum.className = "res-summary " + (first >= 0 ? "ok" : "bad");
      sum.textContent = (multi ? (first >= 0 ? "compare_multi → " + first + "（组 " + (first + 1) + " 匹配）" : "compare_multi → -1（没有组匹配）")
        : first >= 0 ? "True · 颜色匹配" : "False · 颜色不匹配") + " · " + cc.ms + " ms";
      box.appendChild(sum);
      cc.results.forEach((r, gi) => {
        if (!r) return;
        r.details.forEach((d, i) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "res-item";
          b.innerHTML = '<span class="tag"></span><span class="swatch"></span><span class="txt"></span><span class="conf"></span>';
          b.querySelector(".tag").textContent = (multi ? gi + 1 + "." : "") + (i + 1);
          b.querySelector(".tag").style.background = d.ok ? "" : "rgba(229,72,77,.15)";
          b.querySelector(".tag").style.color = d.ok ? "" : "var(--bad)";
          b.querySelector(".swatch").style.background = d.actual || "transparent";
          b.querySelector(".txt").textContent = d.x + "," + d.y + "  期望 " + d.expected.toUpperCase() + "  实际 " + String(d.actual || "越界").toUpperCase();
          b.querySelector(".conf").textContent = d.ok ? "✓" : "✗";
          b.querySelector(".conf").className = "conf " + (d.ok ? "ok" : "bad");
          b.addEventListener("pointerenter", () => this.host.flash({ x: d.x, y: d.y }, { hold: true }));
          b.addEventListener("pointerleave", () => this.host.flash(null));
          b.onclick = () => XS.copy(d.x + "," + d.y + "," + String(d.actual || "").toUpperCase());
          box.appendChild(b);
        });
        if (multi) {
          const s = document.createElement("div");
          s.className = "res-summary muted";
          s.textContent = "组 " + (gi + 1) + "：" + r.hits + "/" + r.details.length + " 点匹配（需要 " + r.need + "）" + (r.match ? " ✓" : " ✗");
          box.appendChild(s);
        }
      });
    },

    async test() {
      const strs = cc.groups.map(colorString);
      if (!strs.some(Boolean)) throw new Error("先在截图上单击或按 1-9 取色");
      const results = [];
      let ms = 0;
      for (const colors of strs) {
        if (!colors) {
          results.push(null);
          continue;
        }
        const out = await this.host.vision({ op: "compare_colors", colors, sim: cc.diff, count_sim: cc.sim });
        ms += out.ms;
        results.push(out);
      }
      cc.results = results;
      cc.ms = ms;
      this.render();
    },

    clearResults() {
      cc.results = null;
      if (this.host) this.render();
    },

    onTab() {
      // Results belong to the frame they ran on.
      if (cc.results) this.clearResults();
    },

    onPick(pt) {
      if (fillNext(this.slots, pt) >= 0) this.changed();
      return true;
    },

    onSlotKey(k, pt) {
      this.slots[k - 1] = { x: pt.x, y: pt.y, color: pt.color, diff: null };
      this.changed();
    },

    marks() {
      const res = cc.results && cc.results[cc.active];
      const points = [];
      this.slots.forEach((s, i) => {
        if (!s) return;
        let state = "bad";
        if (res) {
          const d = res.details.find((x) => x.x === s.x && x.y === s.y);
          state = d && d.ok ? "ok" : "bad";
        }
        points.push({ x: s.x, y: s.y, n: i + 1, state: res ? state : "info" });
      });
      return { points };
    },

    code(style) {
      const strs = cc.groups.map(colorString).filter(Boolean);
      const list = strs.length ? strs : ["x,y,#RRGGBB|x,y,#RRGGBB"];
      const multi = list.length > 1;
      const simArg = cc.sim !== 1 ? ", sim=" + fmt(cc.sim) : "";
      if (style === "xscript") {
        const lib = cc.sim !== 1 ? "image" : "screen";
        const call = (c) => lib + ".compare_colors(" + c + ", sim=" + fmt(cc.diff) + (cc.sim !== 1 ? ", count_sim=" + fmt(cc.sim) : "") + ")";
        let s = "from xscript.android import " + lib + "\n\n";
        if (!multi) return s + "ok = " + call(JSON.stringify(list[0])) + "\nprint(ok)";
        s += "groups = [\n" + list.map((c) => "    " + JSON.stringify(c) + ",\n").join("") + "]\n";
        s += "# 第一个匹配的组号，没有匹配为 -1\n";
        s += "res = next((i for i, c in enumerate(groups) if " + call("c") + "), -1)\nprint(res)";
        return s;
      }
      let s = "from ascript.android.screen import CompareColors\n\n";
      if (!multi) return s + "res = CompareColors.compare(" + JSON.stringify(list[0]) + ", diff=" + fmt(cc.diff) + simArg + ")\nprint(res)";
      s += "res = CompareColors.compare_multi([\n" + list.map((c) => "    " + JSON.stringify(c) + ",\n").join("") + "], diff=" + fmt(cc.diff) + simArg + ")\n";
      return s + "print(res)  # 第一个匹配的组号，没有匹配为 -1";
    },
  });

  window.XS_COLOR_HELPERS = { renderResults, fmt };
})();
