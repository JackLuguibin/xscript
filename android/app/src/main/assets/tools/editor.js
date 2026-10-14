"use strict";
(() => {
  const el = id => document.getElementById(id);
  const model = new EditorModel((...args) => XS.api(...args));
  let current = null, files = [], dirs = [], selected = null, pending = false, generation = 0, logCursor = 0, polling = false, closed = false;
  // Expanded folders per project survive refreshes, create/delete and project switches.
  const expandedByProject = new Map();
  const expanded = () => { if (!expandedByProject.has(model.project)) expandedByProject.set(model.project, new Set()); return expandedByProject.get(model.project); };
  const reveal = path => { for (const dir of EditorModel.ancestors(path)) expanded().add(dir); };
  const selectedDir = () => selected && selected.type === "dir" ? selected.path : "";
  const message = (text, error = false) => { el("message").textContent = text; el("message").classList.toggle("error", error); };
  const debuggerClient = new XScriptDebugger((...args) => XS.api(...args), {
    state: text => { el("debug-state").textContent = text; renderDebug(); },
    warning: text => message(text, true),
    frames: frames => {
      el("debug-stack").replaceChildren();
      for (const frame of frames) {
        const button = document.createElement("button"); button.type = "button";
        button.textContent = frame.name + " · " + (frame.source && (frame.source.name || debuggerClient.relative(frame.source.path) || String(frame.source.path || "").split("/").pop()) || "外部代码") + ":" + frame.line;
        button.onclick = () => debuggerClient.selectFrame(frame).catch(e => message(e.message, true));
        el("debug-stack").append(button);
      }
    },
    variables: groups => { el("debug-variables").textContent = groups.map(g => g.name + "\n" + g.variables.map(v => v.name + " = " + v.value).join("\n")).join("\n\n"); },
    source: async (path, line) => {
      const project = model.project, epoch = debuggerClient.epoch;
      if (project !== debuggerClient.project || !files.some(f => f.path === path)) return;
      await load(path);
      if (project !== model.project || epoch !== debuggerClient.epoch || !current || current.path !== path) return;
      const box = el("editor"), rows = box.value.split("\n");
      const position = rows.slice(0, Math.max(0, line - 1)).reduce((n, row) => n + row.length + 1, 0);
      box.focus(); box.setSelectionRange(position, position); box.scrollTop = Math.max(0, (line - 4) * 21); cursor();
    }
  });
  function renderDebug() {
    const connected = debuggerClient.active && debuggerClient.initialized && debuggerClient.project === model.project;
    document.querySelectorAll("[data-debug]").forEach(button => { button.disabled = !connected; });
    el("debug-disconnect").disabled = !debuggerClient.active;
    el("breakpoint").disabled = !current || current.binary || !current.path.endsWith(".py");
    const lines = current && debuggerClient.breakpoints.get(model.project + ":" + current.path) || [];
    el("breakpoint-list").textContent = lines.length ? "断点行：" + lines.join(", ") : "当前文件无断点";
  }
  function render() {
    el("save").disabled = pending || !current || current.binary || !model.dirty(current);
    el("run").disabled = pending || !model.project;
    el("debug-run").disabled = pending || !model.project;
    renderDebug();
    el("stop").disabled = pending || !model.project;
    el("new-file").disabled = pending || !model.project;
    el("new-folder").disabled = pending || !model.project;
    el("new-project").disabled = pending;
    el("projects").disabled = pending;
    el("delete-file").disabled = pending || (selectedDir() ? false : !current || /^__init__\.pyc?$/.test(current.path));
    el("delete-file").textContent = selectedDir() ? "删除文件夹" : "删除文件";
    el("export").hidden = !model.project;
    if (model.project) el("export").href = model.projectUrl() + "/zip";
    el("tabs").replaceChildren();
    for (const doc of model.documents.values()) {
      if (doc.project !== model.project) continue;
      const tab = document.createElement("button");
      tab.type = "button"; tab.role = "tab"; tab.textContent = doc.path + (model.dirty(doc) ? " ●" : "");
      tab.setAttribute("aria-selected", String(doc === current));
      tab.onclick = () => show(doc);
      el("tabs").append(tab);
    }
    renderTree();
  }
  // Explorer icons: small inline SVGs (no emoji, no extra assets), VS Code-like shapes and colours.
  const SVG = (cls, body, box = "0 0 16 16") => '<svg class="' + cls + '" viewBox="' + box + '" aria-hidden="true" focusable="false">' + body + "</svg>";
  const TREE_ICON = {
    chevron: SVG("chevron", '<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
    folder: SVG("ti folder", '<path d="M1.5 3.5h4.3l1.4 1.5h7.3v8.5h-13z" fill="currentColor"/>'),
    folderOpen: SVG("ti folder", '<path d="M1.5 3.5h4.3l1.4 1.5h6.3v2H4.2l-1.9 6.5H1.5z" fill="currentColor"/><path d="M4.6 7.5h10.6l-2 6H2.6z" fill="currentColor" opacity=".75"/>'),
    file: SVG("ti file", '<path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor"/><path d="M9.5 1.5v3h3" fill="none" stroke="currentColor"/>'),
    python: SVG("ti python", '<path d="M7.9 1.2c-3 0-2.8 1.3-2.8 1.3v1.4h2.9v.4H3.9S2 4.1 2 7.1s1.7 2.9 1.7 2.9h1V8.6s-.1-1.7 1.6-1.7h2.8s1.6 0 1.6-1.6V2.8S10.9 1.2 7.9 1.2zM6.3 2.1a.5.5 0 1 1 0 1 .5.5 0 0 1 0-1z" fill="#3572a5"/><path d="M8.1 14.8c3 0 2.8-1.3 2.8-1.3v-1.4H8v-.4h4.1s1.9.2 1.9-2.8-1.7-2.9-1.7-2.9h-1v1.4s.1 1.7-1.6 1.7H6.9s-1.6 0-1.6 1.6v2.6s-.2 1.5 2.8 1.5zm1.6-.9a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1z" fill="#f2c94c"/>'),
  };
  const INDENT = 12, BASE = 8;           // px per level, left padding of depth 0 (VS Code: 8 + 12*depth)
  let focusPath = "";                     // roving tabindex: the one row reachable with Tab
  const treeRows = () => EditorModel.visibleRows(EditorModel.buildTree(files, dirs), expanded());
  function toggleFolder(path, open) {
    const set = expanded();
    if (open === undefined) open = !set.has(path);
    open ? set.add(path) : set.delete(path);
  }
  function activate(node) {
    if (node.type === "dir") {
      toggleFolder(node.path);              // VS Code: every click on a folder row toggles it
      selected = {type: "dir", path: node.path};
      message("已选中文件夹 " + node.path + "/，新建文件/文件夹将放在此处");
      render();
    } else {
      selected = {type: "file", path: node.path};
      render(); load(node.path);
    }
  }
  function renderTree() {
    const box = el("files"), hadFocus = box.contains(document.activeElement);
    box.replaceChildren();
    const rows = treeRows();
    if (!rows.length) {
      const note = document.createElement("p"); note.className = "muted tree-empty";
      note.textContent = model.project ? "工程内暂无文件" : "新建或选择一个工程";
      box.append(note); return;
    }
    const isSelected = node => selected ? selected.type === node.type && selected.path === node.path : node.type === "file" && !!current && current.path === node.path;
    if (!rows.some(r => r.node.path === focusPath)) focusPath = (rows.find(r => isSelected(r.node)) || rows[0]).node.path;
    for (const row of rows) {
      const node = row.node, item = document.createElement("div");
      item.role = "treeitem"; item.dataset.path = node.path; item.dataset.type = node.type;
      item.className = "tree-row " + node.type; item.title = node.path + (node.type === "dir" ? "/" : "");
      item.style.paddingLeft = (BASE + row.depth * INDENT) + "px";
      item.setAttribute("aria-level", String(row.depth + 1));
      item.tabIndex = node.path === focusPath ? 0 : -1;
      for (let d = 0; d < row.depth; d++) {        // indent guides, one per ancestor level
        const guide = document.createElement("span"); guide.className = "guide";
        guide.style.left = (BASE + d * INDENT + 7) + "px"; item.append(guide);
      }
      const twisty = document.createElement("span"); twisty.className = "twisty";
      const label = document.createElement("span"); label.className = "label"; label.textContent = node.name;
      let icon;
      if (node.type === "dir") {
        item.setAttribute("aria-expanded", String(row.expanded));
        twisty.innerHTML = TREE_ICON.chevron; twisty.classList.toggle("open", row.expanded);
        twisty.title = row.expanded ? "折叠" : "展开";
        // Twisty only expands/collapses: selection and the open editor stay as they are.
        twisty.addEventListener("click", e => { e.stopPropagation(); focusPath = node.path; toggleFolder(node.path); render(); });
        icon = row.expanded ? TREE_ICON.folderOpen : TREE_ICON.folder;
      } else {
        icon = /\.pyw?$/.test(node.name) ? TREE_ICON.python : TREE_ICON.file;
      }
      const iconBox = document.createElement("span"); iconBox.className = "tree-icon"; iconBox.innerHTML = icon;
      item.append(twisty, iconBox, label);
      if (node.type === "file") {
        const doc = model.documents.get(model.key(node.path));
        if (doc && model.dirty(doc)) { const dot = document.createElement("span"); dot.className = "dirty"; dot.title = "未保存"; item.append(dot); }
      }
      const active = isSelected(node);
      item.classList.toggle("selected", active);
      item.setAttribute("aria-selected", String(active));
      item.addEventListener("click", () => { focusPath = node.path; activate(node); });
      box.append(item);
    }
    if (hadFocus) { const again = box.querySelector('[data-path="' + CSS.escape(focusPath) + '"]'); if (again) again.focus({preventScroll: true}); }
    const sel = box.querySelector(".tree-row.selected"); if (sel && sel.scrollIntoView) sel.scrollIntoView({block: "nearest"});
  }
  el("files").addEventListener("keydown", e => {
    if (!e.target.classList || !e.target.classList.contains("tree-row") || e.altKey || e.ctrlKey || e.metaKey) return;
    const rows = treeRows(), step = EditorModel.navigate(rows, e.target.dataset.path, e.key);
    if (!step.focus) return;
    e.preventDefault();
    focusPath = step.focus;
    if (step.expand) toggleFolder(step.expand, true);
    if (step.collapse) toggleFolder(step.collapse, false);
    const node = rows.map(r => r.node).find(n => n.path === step.focus);
    // Arrows move the selection like an explorer; files open with Enter / Space.
    if (node) selected = {type: node.type, path: node.path};
    if (step.open) load(step.open);
    render();
    const target = el("files").querySelector('[data-path="' + CSS.escape(focusPath) + '"]'); if (target) target.focus();
  });
  // Syntax overlay: a <pre> behind the transparent textarea, re-rendered at most once per frame.
  let paintQueued = false;
  function paint() {
    paintQueued = false;
    const box = el("editor"), pre = el("highlight");
    const plain = !current || current.binary || box.disabled;
    el("editor").classList.toggle("highlighted", !plain);
    // Trailing newline keeps the last (empty) line the same height as in the textarea.
    pre.innerHTML = plain ? "" : XSyntax.highlight(current.path, box.value) + "\n";
    syncScroll();
  }
  function schedulePaint() { if (!paintQueued) { paintQueued = true; requestAnimationFrame(paint); } }
  function syncScroll() {
    const box = el("editor");
    el("highlight").scrollTop = box.scrollTop; el("highlight").scrollLeft = box.scrollLeft;
    el("line-numbers").scrollTop = box.scrollTop;
  }
  function cursor() {
    const value = el("editor").value, pos = el("editor").selectionStart;
    const before = value.slice(0, pos).split("\n");
    el("cursor").textContent = "行 " + before.length + "，列 " + (before[before.length - 1].length + 1);
    const breaks = new Set(current && debuggerClient.breakpoints.get(model.project + ":" + current.path) || []);
    el("line-numbers").replaceChildren();
    for (let line = 1; line <= value.split("\n").length; line++) {
      const number = document.createElement("span"); number.textContent = (breaks.has(line) ? "● " : "") + line + "\n";
      number.className = breaks.has(line) ? "breakpoint-line" : "";
      el("line-numbers").append(number);
    }
    el("line-numbers").scrollTop = el("editor").scrollTop;
    schedulePaint();
  }
  function show(doc) {
    current = doc; selected = {type: "file", path: doc.path}; focusPath = doc.path; reveal(doc.path);
    el("editor").disabled = doc.binary;
    el("editor").value = doc.binary ? "此文件为二进制，请导出工程后查看。" : doc.content;
    message(doc.binary ? "二进制文件 · 只读" : doc.path + (model.dirty(doc) ? " · 未保存" : " · 已保存"));
    cursor(); render();
  }
  async function load(path) {
    const version = ++generation, project = model.project;
    try {
      const doc = await model.open(path, project);
      if (generation === version && project === model.project) show(doc);
    } catch (e) { if (generation === version) message(e.message, true); }
  }
  async function refreshFiles() {
    const project = model.project;
    const tree = project ? await model.listTree(project) : {files: [], dirs: []};
    if (model.project === project) {
      files = tree.files; dirs = tree.dirs;
      // Forget folders/selection that no longer exist (deleted here or elsewhere).
      for (const dir of [...expanded()]) if (!dirs.includes(dir)) expanded().delete(dir);
      if (selected && (selected.type === "dir" ? !dirs.includes(selected.path) : !files.some(f => f.path === selected.path))) selected = current && files.some(f => f.path === current.path) ? {type: "file", path: current.path} : null;
      render();
    }
  }
  async function selectProject(project) {
    await debuggerClient.close(); el("debug-state").textContent = "未连接";
    el("debug-stack").replaceChildren(); el("debug-variables").textContent = "";
    ++generation; model.project = project; current = null; files = []; dirs = []; selected = null;
    el("editor").value = ""; el("editor").disabled = true; render(); cursor();
    await refreshFiles();
    if (model.project !== project) return;
    const first = files.find(f => f.path === "__init__.py") || files[0];
    if (first) await load(first.path);
    else message(project ? "请选择或新建文件" : "新建一个工程开始编写脚本");
  }
  async function projects(preferred) {
    const list = await model.listProjects();
    el("projects").replaceChildren(new Option("选择工程…", ""), ...list.map(name => new Option(name, name)));
    const target = list.includes(preferred) ? preferred : list[0] || "";
    el("projects").value = target;
    await selectProject(target);
  }
  async function operation(fn) {
    if (pending) return;
    pending = true; render();
    try { await fn(); } catch (e) { message(e.message, true); }
    finally { pending = false; render(); }
  }
  el("projects").onchange = () => operation(() => selectProject(el("projects").value));
  el("new-project").onclick = () => {
    const name = prompt("新工程名称（以字母或下划线开头，仅字母、数字、下划线；入口为 __init__.py）");
    if (name === null) return;
    if (!name.trim()) { message("工程名称不能为空", true); return; }
    operation(async () => {
      const target = name.trim();
      await model.createProject(target);
      await projects(target);
      message("已创建工程 " + target + "，入口 __init__.py");
    });
  };
  // Default the prompt to the selected empty folder, or the folder of the open file.
  const folderHint = () => { const dir = EditorModel.folderOf(selected || (current && {type: "file", path: current.path})); return dir ? dir + "/" : ""; };
  el("new-file").onclick = () => {
    const path = prompt("文件相对路径，例如 utils.py 或 lib/config.json（不存在的文件夹会自动创建）", folderHint());
    if (path === null) return;
    if (!path.trim() || path.trim().endsWith("/")) { message("请输入文件名", true); return; }
    operation(async () => {
      const doc = await model.createFile(path.trim());
      ++generation; reveal(doc.path);
      await refreshFiles(); show(doc); el("editor").focus();
      message("已创建 " + doc.path + "，可直接编辑并保存");
    });
  };
  el("new-folder").onclick = () => {
    const path = prompt("文件夹相对路径，例如 lib 或 res/data", folderHint());
    if (path === null) return;
    if (!path.trim()) { message("请输入文件夹名", true); return; }
    operation(async () => {
      const dir = await model.createFolder(path.trim());
      reveal(dir); expanded().add(dir); selected = {type: "dir", path: dir};
      await refreshFiles(); render();
      message("已创建文件夹 " + dir + "/，新建文件将放在此处");
    });
  };
  el("refresh").onclick = () => operation(refreshFiles);
  el("save").onclick = () => operation(async () => {
    const doc = current; if (!doc || doc.binary) return;
    await model.save(doc); message(model.dirty(doc) ? "保存完成，仍有新编辑未保存" : "已保存 " + doc.path);
  });
  el("debug-run").onclick = () => operation(async () => {
    await debuggerClient.close();
    const project = model.project;
    const result = await model.run("debug");
    if (project !== model.project) return;
    try { await debuggerClient.start(project, result.debug && result.debug.remote_root); }
    catch(e) { await debuggerClient.close(); throw e; }
    message("已请求调试 " + project); poll();
  });
  el("breakpoint").onclick = async () => {
    if (!current || current.binary) return;
    const line = el("editor").value.slice(0, el("editor").selectionStart).split("\n").length;
    try { await debuggerClient.toggle(current.path, line, model.project); renderDebug(); cursor(); }
    catch(e) { message(e.message, true); }
  };
  document.querySelectorAll("[data-debug]").forEach(button => {
    button.onclick = () => debuggerClient.control(button.dataset.debug).catch(e => message(e.message, true));
  });
  el("debug-disconnect").onclick = async () => { await debuggerClient.close(); el("debug-state").textContent = "已断开，任务仍可运行"; renderDebug(); };
  el("run").onclick = () => operation(async () => { await debuggerClient.close(); await model.run(); message("已请求运行 " + model.project); poll(); });
  el("stop").onclick = () => operation(async () => { await model.stop(); await debuggerClient.close(); el("debug-state").textContent = "已停止"; message("已请求停止当前任务"); poll(); });
  el("delete-file").onclick = () => {
    if (selectedDir()) {
      const dir = selectedDir(), project = model.project;
      if (files.some(f => f.path.startsWith(dir + "/")) || dirs.some(d => d.startsWith(dir + "/"))) { message("文件夹 " + dir + "/ 非空，请先删除其中的文件和子文件夹", true); return; }
      if (confirm("删除空文件夹 " + dir + "/？")) operation(async () => {
        await model.removeFolder(dir, project); expanded().delete(dir);
        selected = current ? {type: "file", path: current.path} : null;
        await refreshFiles(); message("已删除文件夹 " + dir + "/");
      });
      return;
    }
    const doc = current;
    if (!doc) return;
    if (!confirm("确定删除 " + doc.path + "？此操作不可撤销。" + (model.dirty(doc) ? "\n未保存的修改也将丢弃。" : ""))) return;
    operation(async () => {
      await model.remove(doc);
      debuggerClient.breakpoints.delete(doc.project + ":" + doc.path);
      if (current === doc) { ++generation; current = null; el("editor").value = ""; el("editor").disabled = true; cursor(); }
      await refreshFiles();
      if (model.project !== doc.project) return;
      if (!current) {
        const next = files.find(f => f.path === "__init__.py") || files[0];
        if (next) await load(next.path); else render();
      }
      message("已删除 " + doc.path);
    });
  };
  el("editor").addEventListener("input", () => { if (!current || current.binary) return; model.edit(current, el("editor").value); message(current.path + " · 未保存"); cursor(); render(); });
  for (const name of ["click", "keyup"]) el("editor").addEventListener(name, cursor);
  el("editor").addEventListener("scroll", syncScroll);
  el("editor").addEventListener("keydown", e => {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault(); const box = e.target;
      box.setRangeText("    ", box.selectionStart, box.selectionEnd, "end"); box.dispatchEvent(new Event("input"));
    }
  });
  window.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!el("save").disabled) el("save").click(); }
    if (e.key === "F6") { e.preventDefault(); el(e.shiftKey ? "stop" : "run").click(); }
  });
  const mayLeave = () => !model.unsaved().length || confirm("存在未保存的文件，确定离开？");
  XS.guardLeave(mayLeave);
  window.addEventListener("beforeunload", e => { if (model.unsaved().length && !XS._leaving) { e.preventDefault(); e.returnValue = ""; } });
  function appendLogs(entries) {
    if (!entries.length) return;
    const lines = entries.map(e => "[" + e.stream + "] " + e.line).join("\n");
    el("logs").textContent = (el("logs").textContent + lines + "\n").split("\n").slice(-2001).join("\n");
    if (el("follow").checked) el("logs").scrollTop = el("logs").scrollHeight;
  }
  el("clear-logs").onclick = () => { el("logs").textContent = ""; };
  async function poll() {
    if (polling || closed || document.hidden) return;
    polling = true;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const [s, logs] = await Promise.all([
        XS.api("GET", "/status", undefined, {signal:ctl.signal}),
        XS.api("GET", "/logs?since=" + logCursor, undefined, {signal:ctl.signal}),
      ]);
      el("run-state").textContent = s.running ? "运行中 · " + s.project : "空闲";
      if (Number(logs.next) < logCursor) el("logs").textContent = "";
      appendLogs(logs.entries || []); logCursor = Number(logs.next) || 0;
    } catch (e) { el("run-state").textContent = "连接失败，正在重试"; }
    finally { clearTimeout(timer); polling = false; }
  }
  const timer = setInterval(poll, 1000);
  window.addEventListener("pagehide", () => { closed = true; clearInterval(timer); debuggerClient.close(); });
  window.addEventListener("pageshow", e => { if (e.persisted) location.reload(); });
  document.addEventListener("visibilitychange", () => !document.hidden && poll());
  projects(new URLSearchParams(location.search).get("project") || "").catch(e => message(e.message, true));
  poll(); render();
})();
