"use strict";
/* 图色工具 plugins: 找图 (FindImages) and 文字识别 (Ocr), AScript gpui layout. */
(function () {
  const PLUGINS = (window.XS_PLUGINS = window.XS_PLUGINS || []);
  const H = () => window.XS_COLOR_HELPERS;
  const fmt = (v) => String(Math.round(v * 1000) / 1000);
  const pyList = (r) => "[" + r.join(", ") + "]";

  // ------------------------------------------------------------ 找图

  const fi = {
    tpls: [],          // [{snapId, rect, name, thumb, saved: "project:path"|null}]
    rect: null,
    confidence: 0.9,
    rgb: false,
    ori: 2,
    all: false,
    scale: false,
    scaleMin: 0.5,
    scaleMax: 2,
    project: localStorage.getItem("xs-fi-project") || "",
    results: null,     // {hits: [{tpl, rect, center_x, center_y, confidence}], ms}
  };
  let tplSeq = 0;

  const safeName = (s) => String(s || "").trim().replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^\.+/, "");

  const fiPersist = window.XS_PERSIST(fi, ["tpls", "rect", "confidence", "rgb", "ori", "all", "scale", "scaleMin", "scaleMax"]);
  const fiSave = fiPersist.saveState;
  // Thumbnails are data URLs (large); keep only what is needed to rebuild them.
  fiPersist.saveState = () => {
    const s = fiSave();
    s.tpls = s.tpls.map((t) => ({ snapId: t.snapId, rect: t.rect, name: t.name, saved: t.saved }));
    return s;
  };

  /** Rebuild a thumbnail by cropping the template's snapshot (fetched once per snapshot). */
  const thumbCache = new Map();
  async function rebuildThumb(t) {
    let p = thumbCache.get(t.snapId);
    if (!p) {
      p = XS.loadPixels("/tools/snapshots/" + encodeURIComponent(t.snapId) + ".png");
      thumbCache.set(t.snapId, p);
    }
    const px = await p;
    const c = document.createElement("canvas");
    c.width = t.rect[2] - t.rect[0];
    c.height = t.rect[3] - t.rect[1];
    c.getContext("2d").drawImage(px.canvas, t.rect[0], t.rect[1], c.width, c.height, 0, 0, c.width, c.height);
    t.thumb = c.toDataURL("image/png");
  }

  PLUGINS.push({
    id: "FindImages",
    name: "找图",
    icon: "image",
    saveState: fiPersist.saveState,
    loadState(s) {
      fiPersist.loadState(s);
      fi.tpls = (Array.isArray(fi.tpls) ? fi.tpls : []).filter((t) => t && t.snapId && Array.isArray(t.rect) && t.rect.length === 4 && t.name);
      tplSeq = fi.tpls.reduce((m, t) => Math.max(m, Number((/^img_(\d+)\.png$/.exec(t.name) || [])[1]) || 0), 0);
      // Templates whose snapshot is gone cannot be tested; drop them quietly.
      Promise.all(fi.tpls.map((t) => rebuildThumb(t).then(() => true, () => false))).then((ok) => {
        fi.tpls = fi.tpls.filter((_, i) => ok[i]);
        if (this.host) this.render();
      });
    },

    mount(panel, host) {
      const ui = host.ui;
      this.host = host;
      panel.innerHTML =
        '<div class="plug-view"><section class="p-left">' +
        '<div class="panel-header">' + XS.icon("box") + "<span>当前选区</span></div>" +
        '<div class="sel-preview" data-part="sel"></div>' +
        '<div class="panel-header">' + XS.icon("images") + '<span>模板图片</span><span class="count" data-part="tpl-count"></span>' +
        '<div class="actions"><button type="button" class="icon-btn sm danger" data-a="clear-tpls" title="清空模板" aria-label="清空模板">' + XS.icon("trash") + "</button></div></div>" +
        '<div class="tpls" data-part="tpls"></div>' +
        '<div class="cfg p-scroll">' +
        '<div data-part="rect"></div>' +
        ui.row("相似度", '<input type="range" min="0.5" max="1" step="0.01" id="fi-conf"><span class="val" id="fi-conf-v"></span>', "fi-conf") +
        ui.row("颜色模式", '<select id="fi-rgb">' + ui.options([["0", "灰度 — 速度快，忽略颜色差异"], ["1", "彩色 — 区分颜色"]], fi.rgb ? 1 : 0) + "</select>", "fi-rgb") +
        ui.row("查找方向", '<select id="fi-ori">' + ui.options(host.ORI, fi.ori) + "</select>", "fi-ori") +
        ui.row("跨分辨率", '<select id="fi-scale">' + ui.options([["0", "关闭 — 同分辨率精准匹配"], ["1", "多尺度 — 缩放模板匹配"]], fi.scale ? 1 : 0) + "</select>" +
          '<input type="number" id="fi-smin" step="0.1" min="0.1" max="5" class="short" aria-label="最小缩放"><span class="muted" id="fi-ssep">~</span>' +
          '<input type="number" id="fi-smax" step="0.1" min="0.1" max="5" class="short" aria-label="最大缩放">', "fi-scale") +
        ui.row("查找模式", '<select id="fi-all">' + ui.options([["0", "查找一个 → 返回第一个匹配"], ["1", "查找全部 → 返回所有匹配"]], fi.all ? 1 : 0) + "</select>", "fi-all") +
        ui.row("保存至", '<select id="fi-project"><option value="">加载工程…</option></select>' +
          '<button type="button" class="icon-btn sm" data-a="refresh-projects" title="刷新工程列表" aria-label="刷新工程列表">' + XS.icon("refresh") + "</button>", "fi-project") +
        '<div class="cfg-actions"><button type="button" data-a="save" title="把模板裁剪保存到工程 res/img/">' + XS.icon("save") + " 保存模板</button>" +
        '<button type="button" class="primary" data-a="test">' + XS.icon("play") + " 测试</button></div></div>" +
        '<div class="panel-header">' + XS.icon("list") + '<span>找图结果</span><span class="count" data-part="res-count"></span>' +
        '<div class="actions"><button type="button" class="icon-btn sm" data-a="clear-res" title="清空结果" aria-label="清空结果">' + XS.icon("trash") + "</button></div></div>" +
        '<div class="res-summary" data-part="summary" hidden></div><div class="res" data-part="res"></div>' +
        '</section><section class="p-right" data-part="code"></section></div>';
      const q = (s) => panel.querySelector(s);
      this.q = q;
      this.codeCtl = ui.code(q('[data-part="code"]'), (style) => this.code(style));
      // The selection is the template here, so the search range is only set explicitly.
      const rectRow = ui.rectRow(panel, fi, "rect", () => this.codeCtl.update(), "fi-rect", "全屏（点右侧按钮使用选区）");
      q('[data-part="rect"]').outerHTML = rectRow.html;
      this.rectCtl = rectRow.bind();

      const conf = q("#fi-conf");
      conf.value = fi.confidence;
      q("#fi-conf-v").textContent = fmt(fi.confidence);
      conf.oninput = () => {
        fi.confidence = ui.num(conf.value, 0.5, 1, 0.9);
        q("#fi-conf-v").textContent = fmt(fi.confidence);
        this.codeCtl.update();
      };
      q("#fi-rgb").onchange = (e) => ((fi.rgb = e.target.value === "1"), this.codeCtl.update());
      q("#fi-ori").onchange = (e) => ((fi.ori = Number(e.target.value)), this.codeCtl.update());
      q("#fi-all").onchange = (e) => ((fi.all = e.target.value === "1"), this.codeCtl.update());
      const smin = q("#fi-smin");
      const smax = q("#fi-smax");
      smin.value = fi.scaleMin;
      smax.value = fi.scaleMax;
      const scaleVis = () => {
        [smin, smax, q("#fi-ssep")].forEach((el) => (el.hidden = !fi.scale));
      };
      scaleVis();
      q("#fi-scale").onchange = (e) => {
        fi.scale = e.target.value === "1";
        scaleVis();
        this.codeCtl.update();
      };
      const scaleIn = () => {
        fi.scaleMin = ui.num(smin.value, 0.1, 5, 0.5);
        fi.scaleMax = ui.num(smax.value, 0.1, 5, 2);
        if (fi.scaleMax < fi.scaleMin) [fi.scaleMin, fi.scaleMax] = [fi.scaleMax, fi.scaleMin];
        this.codeCtl.update();
      };
      smin.oninput = scaleIn;
      smax.oninput = scaleIn;

      q("#fi-project").onchange = (e) => {
        fi.project = e.target.value;
        localStorage.setItem("xs-fi-project", fi.project);
      };
      q('[data-a="refresh-projects"]').onclick = () => this.loadProjects(true);
      q('[data-a="save"]').onclick = (e) => ui.run(e.currentTarget, () => this.saveAll());
      q('[data-a="test"]').onclick = (e) => ui.run(e.currentTarget, () => this.test());
      q('[data-a="clear-res"]').onclick = () => this.clearResults();
      q('[data-a="clear-tpls"]').onclick = () => {
        fi.tpls = [];
        fi.results = null;
        this.render();
      };
      this.loadProjects(false);
      this.render();
    },

    unmount() {
      this.host = null;
    },

    async loadProjects(refresh) {
      const list = await this.host.getProjects(refresh);
      if (!this.host) return;
      const sel = this.q("#fi-project");
      sel.innerHTML = list.length ? "" : '<option value="">设备上没有工程</option>';
      list.forEach((n) => {
        const o = document.createElement("option");
        o.value = o.textContent = n;
        sel.appendChild(o);
      });
      if (list.includes(fi.project)) sel.value = fi.project;
      else fi.project = list[0] || "";
      if (refresh) XS.toast("已刷新工程列表（" + list.length + " 个）");
    },

    render() {
      if (!this.host) return;
      this.renderSel();
      this.renderTpls();
      this.renderResults();
      this.codeCtl.update();
      this.host.redraw();
    },

    renderSel() {
      const box = this.q('[data-part="sel"]');
      const r = this.host.rect;
      if (!r) {
        box.innerHTML = XS.icon("box") + '<span class="grow muted">在截图上拖拽框选要查找的图片，再点“添加为模板”</span>';
        return;
      }
      box.innerHTML = '<img alt="选区预览"><div class="grow"><div class="mono"></div><div class="muted mono"></div></div>' +
        '<button type="button" class="primary" data-a="add">' + XS.icon("plus") + " 添加为模板</button>";
      box.querySelector("img").src = this.host.cropURL(r);
      box.querySelector(".mono").textContent = pyList(r);
      box.querySelector(".muted").textContent = r[2] - r[0] + "×" + (r[3] - r[1]);
      box.querySelector('[data-a="add"]').onclick = () => this.addTemplate();
    },

    addTemplate() {
      const host = this.host;
      const r = host.rect;
      if (!r) return XS.toast("先框选一个区域");
      if (r[2] - r[0] < 3 || r[3] - r[1] < 3) return XS.toast("选区太小，模板至少 3×3 像素", "bad");
      const dup = fi.tpls.find((t) => t.snapId === host.tab.snap.id && t.rect.join() === r.join());
      if (dup) return XS.toast("这个区域已经是模板了");
      let name;
      do name = "img_" + ++tplSeq + ".png";
      while (fi.tpls.some((t) => t.name === name));
      fi.tpls.push({ snapId: host.tab.snap.id, rect: r.slice(), name, thumb: host.cropURL(r), saved: null });
      fi.results = null;
      this.render();
    },

    renderTpls() {
      const box = this.q('[data-part="tpls"]');
      this.q('[data-part="tpl-count"]').textContent = fi.tpls.length || "";
      box.innerHTML = "";
      if (!fi.tpls.length) {
        box.innerHTML = '<div class="empty-hint">还没有模板。可以跨标签添加多张，测试时依次查找</div>';
        return;
      }
      fi.tpls.forEach((t, i) => {
        const el = document.createElement("div");
        el.className = "tpl" + (t.saved ? " saved" : "");
        el.innerHTML = '<img alt=""><button type="button" class="name"></button><span class="meta"></span>' +
          '<button type="button" class="del">' + XS.icon("x") + "</button>";
        if (t.thumb) el.querySelector("img").src = t.thumb;
        el.querySelector("img").alt = t.name;
        el.querySelector(".name").textContent = t.name;
        el.querySelector(".name").title = "重命名 " + t.name;
        el.querySelector(".meta").textContent = t.saved ? "已保存" : t.rect[2] - t.rect[0] + "×" + (t.rect[3] - t.rect[1]);
        el.querySelector(".del").setAttribute("aria-label", "删除模板 " + t.name);
        el.querySelector(".del").onclick = () => {
          fi.tpls.splice(i, 1);
          fi.results = null;
          this.render();
        };
        el.querySelector(".name").onclick = async () => {
          let v = await XS.prompt("模板文件名", t.name, { body: "保存到工程的 res/img/ 下，生成代码时用 R.img(\"文件名\")" });
          if (!v) return;
          v = safeName(v);
          if (!/\.png$/i.test(v)) v += ".png";
          if (fi.tpls.some((x) => x !== t && x.name === v)) return XS.toast("已有同名模板", "bad");
          if (v !== t.name) t.saved = null;
          t.name = v;
          this.render();
        };
        el.querySelector("img").onclick = () => {
          const tab = this.host.tab;
          if (tab && tab.snap.id === t.snapId) this.host.flash({ rect: t.rect });
          else XS.toast("模板来自另一张截图（" + t.snapId + "）");
        };
        box.appendChild(el);
      });
    },

    async saveAll() {
      if (!fi.tpls.length) throw new Error("先添加模板");
      if (!fi.project) throw new Error("设备上没有工程，先在 XScript 中创建或导入一个工程");
      for (const t of fi.tpls) {
        const out = await XS.api("POST", "/tools/snapshots/" + encodeURIComponent(t.snapId) + "/crop", {
          rect: t.rect, project: fi.project, path: "res/img/" + t.name,
        });
        t.saved = out.project + ":" + out.path;
      }
      XS.toast("已保存 " + fi.tpls.length + " 张模板到 " + fi.project + "/res/img/", "ok");
      this.render();
    },

    async test() {
      if (!fi.tpls.length) throw new Error("先框选区域并添加为模板");
      const hits = [];
      let ms = 0;
      for (const t of fi.tpls) {
        const out = await this.host.vision({
          op: "find_image",
          template_snapshot: t.snapId,
          template_rect: t.rect,
          rect: fi.rect,
          confidence: fi.confidence,
          rgb: fi.rgb,
          ori: fi.ori,
          maxcnt: fi.all ? 20 : 1,
          scale_range: fi.scale ? [fi.scaleMin, fi.scaleMax] : null,
        });
        ms += out.ms;
        out.hits.forEach((h) => hits.push(Object.assign({ tpl: t.name }, h)));
        if (!fi.all && out.hits.length) break;
      }
      fi.results = { hits, ms };
      this.renderResults();
      this.host.redraw();
      if (hits.length) this.host.flash({ rect: hits[0].rect });
    },

    clearResults() {
      fi.results = null;
      if (this.host) this.renderResults();
    },

    onTab() {
      fi.results = null;
      if (this.host) this.render();
    },

    renderResults() {
      const r = fi.results;
      const sum = this.q('[data-part="summary"]');
      this.q('[data-part="res-count"]').textContent = r ? r.hits.length : "";
      sum.hidden = !r;
      if (r) {
        sum.className = "res-summary " + (r.hits.length ? "ok" : "bad");
        sum.textContent = (r.hits.length ? "找到 " + r.hits.length + " 处，最高相似度 " + Math.max(...r.hits.map((h) => h.confidence)).toFixed(3) : "没有找到，可降低相似度或开启多尺度") + " · " + r.ms + " ms";
      }
      H().renderResults(this.q('[data-part="res"]'), r ? r.hits.map((h, i) => ({
        tag: String(i + 1),
        text: h.center_x + ", " + h.center_y + "  " + pyList(h.rect) + (fi.tpls.length > 1 ? "  " + h.tpl : ""),
        conf: h.confidence.toFixed(3),
        target: { rect: h.rect },
        copy: h.center_x + "," + h.center_y,
      })) : [], this.host, "点击测试，结果在这里展示");
    },

    onRect() {
      if (this.host) this.renderSel();
    },

    marks() {
      const rects = [];
      const tab = this.host && this.host.tab;
      if (tab) fi.tpls.forEach((t, i) => t.snapId === tab.snap.id && rects.push({ rect: t.rect, label: "模板" + (i + 1), state: "info" }));
      if (fi.results) fi.results.hits.forEach((h, i) => rects.push({ rect: h.rect, n: i + 1, label: h.confidence.toFixed(2), state: "ok" }));
      return { rects };
    },

    code(style) {
      const names = fi.tpls.length ? fi.tpls.map((t) => JSON.stringify(t.name)) : ['"模板.png"'];
      const img = "R.img(" + names.join(", ") + ")";
      let p = img + (fi.rect ? ", rect=" + pyList(fi.rect) : "");
      if (fi.confidence !== 0.9) p += ", confidence=" + fmt(fi.confidence);
      if (fi.rgb) p += ", rgb=True";
      const scale = fi.scale ? ", scale_range=(" + fmt(fi.scaleMin) + ", " + fmt(fi.scaleMax) + ")" : "";
      const note = fi.tpls.some((t) => !t.saved) ? "# 先点“保存模板”把图片保存到工程 res/img/\n" : "";
      if (style === "xscript") {
        let s = note + "from xscript.android import screen\nfrom xscript.android.system import R\n\n";
        if (fi.all || fi.tpls.length > 1) {
          s += "res = screen.find_all_images(" + p + (fi.all ? "" : ", maxcnt=1") + scale + ")\n";
          return s + "for r in res:\n    print(r[\"center_x\"], r[\"center_y\"], r[\"confidence\"])";
        }
        s += "res = screen.find_image(" + p + scale + ")\n";
        return s + "if res:\n    print(res[\"center_x\"], res[\"center_y\"], res[\"confidence\"])";
      }
      if (fi.ori !== 2) p += ", ori=" + fi.ori;
      p += scale;
      let s = note + "from ascript.android.screen import FindImages\nfrom ascript.android.system import R\n\n";
      if (fi.all) {
        s += "res = FindImages.find_all_template(" + p + ")\n";
        return s + "for r in res or []:\n    print(r[\"center_x\"], r[\"center_y\"], r[\"confidence\"])";
      }
      s += "res = FindImages.find_template(" + p + ")\n";
      return s + "if res:\n    print(res[\"center_x\"], res[\"center_y\"], res[\"confidence\"])";
    },
  });

  // ------------------------------------------------------------ 文字识别

  const PRESETS = [
    ["", "快捷选择"], ["\\d+", "纯数字"], ["[a-zA-Z]+", "纯英文"], ["[\\u4e00-\\u9fa5]+", "纯中文"],
    ["[\\d.]+", "数字+小数点"], ["[\\d,]+", "数字+逗号"], ["[\\u4e00-\\u9fa5a-zA-Z0-9]+", "中英数混合"],
  ];

  const oc = {
    rect: null,
    pattern: "",
    confidence: 0,
    binary: false,
    threshold: 128,
    results: null, // {lines, ms}
  };

  /** Python regex check in JS terms: \\u escapes are the same; reject what JS cannot parse. */
  function patternError(p) {
    if (!p) return null;
    try {
      new RegExp(p, "u");
      return null;
    } catch (e) {
      try {
        new RegExp(p);
        return null;
      } catch (e2) {
        return "正则表达式有误：" + e2.message;
      }
    }
  }

  const ocPersist = window.XS_PERSIST(oc, ["rect", "pattern", "confidence", "binary", "threshold"]);

  PLUGINS.push({
    id: "Ocr",
    name: "文字识别",
    icon: "type",
    saveState: ocPersist.saveState,
    loadState: ocPersist.loadState,

    mount(panel, host) {
      const ui = host.ui;
      this.host = host;
      panel.innerHTML =
        '<div class="plug-view"><section class="p-left">' +
        '<div class="cfg">' +
        ui.row("识别引擎", '<select id="oc-engine" disabled><option>Google ML Kit — 中英日韩 · 设备端</option></select>', "oc-engine") +
        '<div data-part="rect"></div>' +
        ui.row("正则过滤", '<input type="text" id="oc-pattern" class="mono" placeholder="留空 = 全部文字" spellcheck="false">' +
          '<select id="oc-preset" class="preset" aria-label="常用正则">' + ui.options(PRESETS, "") + "</select>", "oc-pattern") +
        ui.row("置信度", '<input type="range" min="0" max="1" step="0.05" id="oc-conf"><span class="val" id="oc-conf-v"></span>', "oc-conf") +
        ui.row("二值化", '<select id="oc-bin">' + ui.options([["0", "关闭"], ["1", "开启 — 去除复杂背景，提升识别率"]], oc.binary ? 1 : 0) + "</select>" +
          '<input type="number" id="oc-th" min="0" max="255" step="1" class="short" aria-label="二值化阈值">', "oc-bin") +
        '<div class="cfg-actions"><button type="button" class="primary" data-a="test">' + XS.icon("play") + " 测试</button></div></div>" +
        '<div class="panel-header">' + XS.icon("list") + '<span>识别结果</span><span class="count" data-part="res-count"></span>' +
        '<div class="actions"><button type="button" class="icon-btn sm" data-a="copy-all" title="复制全部文字" aria-label="复制全部文字">' + XS.icon("copy") + "</button>" +
        '<button type="button" class="icon-btn sm" data-a="clear-res" title="清空结果" aria-label="清空结果">' + XS.icon("trash") + "</button></div></div>" +
        '<div class="res-summary" data-part="summary" hidden></div><div class="res" data-part="res"></div>' +
        '</section><section class="p-right" data-part="code"></section></div>';
      const q = (s) => panel.querySelector(s);
      this.q = q;
      this.codeCtl = ui.code(q('[data-part="code"]'), (style) => this.code(style));
      const rectRow = ui.rectRow(panel, oc, "rect", () => this.codeCtl.update(), "oc-rect");
      q('[data-part="rect"]').outerHTML = rectRow.html;
      this.rectCtl = rectRow.bind();

      const pat = q("#oc-pattern");
      pat.value = oc.pattern;
      const patIn = () => {
        oc.pattern = pat.value.trim();
        const err = patternError(oc.pattern);
        pat.classList.toggle("field-bad", !!err);
        pat.title = err || "";
        this.codeCtl.update();
      };
      pat.oninput = patIn;
      q("#oc-preset").onchange = (e) => {
        if (e.target.value) pat.value = e.target.value;
        e.target.value = "";
        patIn();
      };
      const conf = q("#oc-conf");
      conf.value = oc.confidence;
      q("#oc-conf-v").textContent = fmt(oc.confidence);
      conf.oninput = () => {
        oc.confidence = ui.num(conf.value, 0, 1, 0);
        q("#oc-conf-v").textContent = fmt(oc.confidence);
        this.codeCtl.update();
      };
      const th = q("#oc-th");
      th.value = oc.threshold;
      th.hidden = !oc.binary;
      q("#oc-bin").onchange = (e) => {
        oc.binary = e.target.value === "1";
        th.hidden = !oc.binary;
        this.codeCtl.update();
      };
      th.oninput = () => {
        oc.threshold = Math.round(ui.num(th.value, 0, 255, 128));
        this.codeCtl.update();
      };
      q('[data-a="test"]').onclick = (e) => ui.run(e.currentTarget, () => this.test());
      q('[data-a="clear-res"]').onclick = () => this.clearResults();
      q('[data-a="copy-all"]').onclick = () => {
        if (!oc.results || !oc.results.lines.length) return XS.toast("还没有识别结果");
        XS.copy(oc.results.lines.map((l) => l.text).join("\n"), "已复制 " + oc.results.lines.length + " 行文字");
      };
      this.renderResults();
    },

    unmount() {
      this.host = null;
    },

    async test() {
      const err = patternError(oc.pattern);
      if (err) throw new Error(err);
      const out = await this.host.vision({
        op: "ocr", rect: oc.rect, pattern: oc.pattern || null, confidence: oc.confidence,
        binary: oc.binary ? oc.threshold : null,
      });
      oc.results = { lines: out.lines, ms: out.ms };
      this.renderResults();
      this.host.redraw();
    },

    clearResults() {
      oc.results = null;
      if (this.host) {
        this.renderResults();
        this.host.redraw();
      }
    },

    onTab() {
      this.clearResults();
    },

    onRect(r) {
      oc.rect = r ? r.slice() : null;
      if (this.rectCtl) this.rectCtl.show();
      if (this.codeCtl) this.codeCtl.update();
    },

    renderResults() {
      const r = oc.results;
      const sum = this.q('[data-part="summary"]');
      this.q('[data-part="res-count"]').textContent = r ? r.lines.length : "";
      sum.hidden = !r;
      if (r) {
        sum.className = "res-summary " + (r.lines.length ? "ok" : "bad");
        sum.textContent = (r.lines.length ? "识别到 " + r.lines.length + " 行" : "没有识别到文字" + (oc.pattern ? "（或都不匹配正则）" : "")) + " · " + r.ms + " ms";
      }
      H().renderResults(this.q('[data-part="res"]'), r ? r.lines.map((l, i) => ({
        tag: String(i + 1),
        text: l.text,
        conf: l.confidence ? Number(l.confidence).toFixed(2) : undefined,
        target: { rect: l.rect },
        copy: l.text,
      })) : [], this.host, "点击测试，识别结果在这里展示");
    },

    marks() {
      if (!oc.results) return {};
      return { rects: oc.results.lines.map((l, i) => ({ rect: l.rect, n: i + 1, state: "ok" })) };
    },

    code(style) {
      const pat = oc.pattern ? XS.pyStr(oc.pattern) : null;
      const rect = oc.rect ? pyList(oc.rect) : null;
      const confFilter = oc.confidence > 0 ? "res = [r for r in res or [] if r.confidence >= " + fmt(oc.confidence) + "]\n" : "";
      if (style === "xscript") {
        let s = "";
        const args = [];
        if (rect) args.push("rect=" + rect);
        if (oc.binary) {
          s += "import cv2\nfrom xscript.android import screen\n\n";
          s += "gray = cv2.cvtColor(screen.capture_cv(), cv2.COLOR_BGR2GRAY)\n";
          s += "_, bw = cv2.threshold(gray, " + oc.threshold + ", 255, cv2.THRESH_BINARY)\n";
          args.push("image=cv2.cvtColor(bw, cv2.COLOR_GRAY2BGR)");
        } else {
          s += "from xscript.android import screen\n\n";
        }
        s += pat ? "res = screen.ocr_find_all(" + [pat].concat(args).join(", ") + ")\n" : "res = screen.ocr(" + args.join(", ") + ")\n";
        return s + confFilter + "for r in res:\n    print(r.text, r.rect, r.confidence)";
      }
      const args = [];
      if (rect) args.push("rect=" + rect);
      if (pat) args.push("pattern=" + pat);
      if (oc.binary) args.push("binary=" + oc.threshold);
      let s = "from ascript.android.screen import Ocr\n\n";
      s += "res = Ocr.mlkitocr_v2(" + args.join(", ") + ")\n" + confFilter;
      return s + "for r in res or []:\n    print(r.text, r)";
    },
  });
})();
