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
  // 删除文件 acts on the file selected in the tree (keyboard selection may differ from the open file).
  const selectedFile = () => selected ? (selected.type === "file" ? selected.path : "") : current ? current.path : "";
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
    el("delete-file").disabled = pending || (selectedDir() ? false : !selectedFile() || /^__init__\.pyc?$/.test(selectedFile()));
    el("delete-file").textContent = selectedDir() ? "删除文件夹" : "删除文件";
    el("rename").disabled = pending || !renameTarget();
    el("export").hidden = !model.project;
    if (model.project) el("export").href = model.projectUrl() + "/zip";
    el("tabs").replaceChildren();
    for (const doc of model.tabs()) {
      const wrap = document.createElement("div"); wrap.className = "tab" + (doc === current ? " active" : ""); wrap.dataset.path = doc.path;
      const tab = document.createElement("button");
      tab.type = "button"; tab.role = "tab"; tab.textContent = doc.path + (model.dirty(doc) ? " ●" : "");
      tab.setAttribute("aria-selected", String(doc === current));
      tab.title = doc.path + "（中键或 × 关闭）";
      tab.onclick = () => show(doc);
      const x = document.createElement("button"); x.type = "button"; x.className = "tab-close"; x.textContent = "×";
      x.setAttribute("aria-label", "关闭 " + doc.path); x.title = "关闭";
      x.onclick = e => { e.stopPropagation(); closeTabs([doc]); };
      wrap.addEventListener("auxclick", e => { if (e.button === 1) { e.preventDefault(); closeTabs([doc]); } });
      wrap.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });   // no middle-click autoscroll
      wrap.addEventListener("contextmenu", e => { e.preventDefault(); openTabMenu(e.clientX, e.clientY, doc); });
      wrap.append(tab, x);
      el("tabs").append(wrap);
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
      item.addEventListener("contextmenu", e => {
        e.preventDefault(); focusPath = node.path; selected = {type: node.type, path: node.path}; render(); openMenu(e.clientX, e.clientY);
      });
      // Drag a row onto a folder (or empty tree space = project root) to move it there.
      if (!isEntryPath(node.path)) {
        item.draggable = true;
        item.addEventListener("dragstart", e => { dragging = node; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", node.path); });
        item.addEventListener("dragend", () => { dragging = null; clearDrop(); });
      }
      const dropDir = node.type === "dir" ? node.path : EditorModel.folderOf(node);
      item.addEventListener("dragover", e => {
        if (!dragging || !canDrop(dragging, dropDir)) return;
        e.preventDefault(); e.stopPropagation(); clearDrop();
        const target = dropDir ? box.querySelector('[data-path="' + CSS.escape(dropDir) + '"]') : null;
        (target || box).classList.add(target ? "drop-target" : "drop-root");
      });
      item.addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); dropOn(dropDir); });
      box.append(item);
    }
    if (hadFocus) { const again = box.querySelector('[data-path="' + CSS.escape(focusPath) + '"]'); if (again) again.focus({preventScroll: true}); }
    const sel = box.querySelector(".tree-row.selected"); if (sel && sel.scrollIntoView) sel.scrollIntoView({block: "nearest"});
  }
  // ---- Rename / move (重命名 / 移动): F2, the 重命名 button, the right-click menu, or drag and drop.
  const isEntryPath = path => /^__init__\.pyc?$/.test(path);
  let dragging = null;
  function renameTarget() {
    const node = selected || (current && {type: "file", path: current.path});
    return node && node.path && !isEntryPath(node.path) ? node : null;
  }
  const baseName = path => path.split("/").pop();
  const joinPath = (dir, name) => dir ? dir + "/" + name : name;
  function canDrop(node, dir) {
    if (!node) return false;
    const parent = EditorModel.ancestors(node.path).pop() || "";
    return dir !== parent && dir !== node.path && !(dir + "/").startsWith(node.path + "/");
  }
  function clearDrop() {
    el("files").classList.remove("drop-root");
    el("files").querySelectorAll(".drop-target").forEach(n => n.classList.remove("drop-target"));
  }
  function dropOn(dir) {
    const node = dragging; dragging = null; clearDrop();
    if (!canDrop(node, dir)) return;
    moveItem(node, joinPath(dir, baseName(node.path)));
  }
  el("files").addEventListener("dragover", e => { if (dragging && canDrop(dragging, "")) { e.preventDefault(); clearDrop(); el("files").classList.add("drop-root"); } });
  el("files").addEventListener("dragleave", e => { if (!el("files").contains(e.relatedTarget)) clearDrop(); });
  el("files").addEventListener("drop", e => { e.preventDefault(); dropOn(""); });
  /** Move `node` to `to`; tabs, unsaved edits, breakpoints, expanded folders and selection follow. */
  function moveItem(node, to) {
    const project = model.project, from = node.path;
    operation(async () => {
      const dst = await model.move(from, to, project);
      if (dst === from || model.project !== project) return;
      const moved = path => EditorModel.movedPath(path, from, dst);
      const open = expanded(), again = [...open].map(moved);
      open.clear(); again.forEach(p => open.add(p));
      if (node.type === "dir") open.add(dst);
      for (const [key, lines] of [...debuggerClient.breakpoints]) {
        if (!key.startsWith(project + ":")) continue;
        const next = moved(key.slice(project.length + 1));
        if (project + ":" + next !== key) { debuggerClient.breakpoints.delete(key); debuggerClient.breakpoints.set(project + ":" + next, lines); }
      }
      selected = {type: node.type, path: dst}; focusPath = dst; reveal(dst);
      await refreshFiles();
      if (current && current.project === project) { assist.setFile(current.binary ? null : current.path); cursor(); }
      render();
      message("已将 " + from + (node.type === "dir" ? "/" : "") + " 移动为 " + dst + (node.type === "dir" ? "/" : ""));
    });
  }
  function promptRename() {
    closeMenu();
    const node = renameTarget();
    if (!node) { message(selectedFile() && isEntryPath(selectedFile()) ? "不能重命名工程入口 __init__.py" : "请先在目录树中选中文件或文件夹", true); return; }
    const kind = node.type === "dir" ? "文件夹" : "文件";
    const to = prompt("重命名" + kind + "：输入新的相对路径（改上级目录即为移动，如 lib/" + baseName(node.path) + "）", node.path);
    if (to === null || to.trim() === node.path) return;
    if (!to.trim()) { message("新路径不能为空", true); return; }
    moveItem(node, to.trim().replace(/\/+$/, ""));
  }
  el("rename").onclick = promptRename;
  function openMenu(x, y) {
    const menu = el("tree-menu"), node = renameTarget();
    menu.querySelector('[data-act="rename"]').disabled = !node;
    menu.querySelector('[data-act="delete"]').disabled = el("delete-file").disabled;
    menu.hidden = false;
    menu.style.left = Math.min(x, innerWidth - menu.offsetWidth - 4) + "px";
    menu.style.top = Math.min(y, innerHeight - menu.offsetHeight - 4) + "px";
    menu.querySelector("button:not(:disabled)")?.focus();
  }
  function closeMenu() { el("tree-menu").hidden = true; }
  // (tab menu: see closeTabMenu below)
  el("tree-menu").addEventListener("click", e => {
    const act = e.target.closest("button")?.dataset.act; closeMenu();
    if (act === "rename") promptRename();
    if (act === "delete") el("delete-file").click();
  });
  el("tree-menu").addEventListener("keydown", e => { if (e.key === "Escape") { closeMenu(); el("files").querySelector(".tree-row.selected")?.focus(); } });
  document.addEventListener("mousedown", e => { if (!el("tree-menu").contains(e.target)) closeMenu(); });
  el("files").addEventListener("keydown", e => {
    if (e.key === "F2" && e.target.classList && e.target.classList.contains("tree-row")) { e.preventDefault(); promptRename(); return; }
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
  // Completion popup + syntax diagnostics (editor-assist.js).
  const assist = new EditorAssist({box: el("editor"), host: document.querySelector(".ide-code"), popup: el("complete"), layer: el("diag"),
    problems: el("problems"), toggle: el("auto-complete"), onMarks: () => cursor()});
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
    assist.syncScroll();
  }
  function cursor() {
    const value = el("editor").value, pos = el("editor").selectionStart;
    const before = value.slice(0, pos).split("\n");
    el("cursor").textContent = "行 " + before.length + "，列 " + (before[before.length - 1].length + 1);
    const breaks = new Set(current && debuggerClient.breakpoints.get(model.project + ":" + current.path) || []);
    const marks = assist.marks();
    el("line-numbers").replaceChildren();
    for (let line = 1; line <= value.split("\n").length; line++) {
      const number = document.createElement("span"); number.textContent = (breaks.has(line) ? "● " : "") + line + "\n";
      number.className = (breaks.has(line) ? "breakpoint-line " : "") + (marks.has(line) ? "diag-line" : "");
      if (marks.has(line)) number.title = marks.get(line);
      el("line-numbers").append(number);
    }
    el("line-numbers").scrollTop = el("editor").scrollTop;
    assist.renderProblems();
    schedulePaint();
  }
  // res/ui/<name>.ui.json opens in the form designer (tools/ui-designer.js, shared with the VS Code extension);
  // the document text stays the source of truth, so save / undo-by-reload / dirty state work as for any file.
  const uiForm = window.XSUiForm, designerBox = el("ui-designer");
  const designer = window.XSUiDesigner && uiForm ? XSUiDesigner.mount(designerBox, {lang: "zh", post: m => {
    if (m.type !== "edit" || !current || !isForm(current)) return;
    const text = uiForm.serializeSpec(m.spec);
    if (text === current.content) return;
    model.edit(current, text); el("editor").value = text;
    message(current.path + " · 未保存"); designer.receive(XSUiDesigner.messageFor(text, uiForm)); render();
  }}) : null;
  const isForm = doc => !!(designer && !doc.binary && uiForm.formName(doc.path));
  function showDesigner(doc) {
    const on = !!doc && isForm(doc) && doc.view !== "text";
    el("ui-mode").hidden = !doc || !isForm(doc);
    el("ui-mode").textContent = on ? "文本" : "设计";
    el("ui-mode").setAttribute("aria-pressed", String(on));
    designerBox.hidden = !on;
    document.querySelector(".ide-edit-area").hidden = on;
    if (on) designer.receive(XSUiDesigner.messageFor(doc.content, uiForm, "（切到「文本」修正）"));
  }
  el("ui-mode").onclick = () => { if (current && isForm(current)) { current.view = current.view === "text" ? "design" : "text"; showDesigner(current); } };
  function show(doc) {
    current = doc; selected = {type: "file", path: doc.path}; focusPath = doc.path; reveal(doc.path);
    el("editor").disabled = doc.binary;
    el("editor").value = doc.binary ? "此文件为二进制，请导出工程后查看。" : doc.content;
    message(doc.binary ? "二进制文件 · 只读" : doc.path + (model.dirty(doc) ? " · 未保存" : " · 已保存"));
    assist.setFile(doc.binary ? null : doc.path);
    showDesigner(doc);
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
    ++generation; model.project = project; current = null; files = []; dirs = []; selected = null; search.reset();
    el("editor").value = ""; el("editor").disabled = true; assist.setFile(null); showDesigner(null); render(); cursor();
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
  // ---- closing tabs ----
  // A tab is just an open document; closing drops it (and its unsaved edits, after a confirm).
  function closeTabs(docs) {
    docs = docs.filter(Boolean);
    if (!docs.length) return false;
    const dirty = docs.filter(d => model.dirty(d));
    if (dirty.length && !confirm(dirty.length === 1 ? dirty[0].path + " 有未保存的修改，关闭会丢弃这些修改。仍要关闭？"
      : dirty.length + " 个文件有未保存的修改（" + dirty.map(d => d.path).join("、") + "），关闭会丢弃这些修改。仍要关闭？")) return false;
    const tabs = model.tabs(), next = EditorModel.nextTab(tabs, current, docs), closingCurrent = current && docs.includes(current);
    docs.forEach(d => model.close(d));
    if (closingCurrent) {
      ++generation;
      if (next) show(next);
      else { current = null; el("editor").value = ""; el("editor").disabled = true; assist.setFile(null); showDesigner(null); cursor(); message("没有打开的文件"); }
    }
    render();
    return true;
  }
  let menuDoc = null;
  function openTabMenu(x, y, doc) {
    closeMenu(); menuDoc = doc;
    const menu = el("tab-menu"), tabs = model.tabs(), i = tabs.indexOf(doc);
    menu.querySelector('[data-act="others"]').disabled = tabs.length < 2;
    menu.querySelector('[data-act="right"]').disabled = i < 0 || i === tabs.length - 1;
    menu.querySelector('[data-act="saved"]').disabled = !tabs.some(t => !model.dirty(t));
    menu.hidden = false;
    menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth - 4)) + "px";
    menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight - 4)) + "px";
    menu.querySelector("button:not(:disabled)")?.focus();
  }
  function closeTabMenu() { el("tab-menu").hidden = true; menuDoc = null; }
  el("tab-menu").addEventListener("click", e => {
    const act = e.target.closest("button")?.dataset.act, doc = menuDoc; closeTabMenu();
    if (act && doc) closeTabs(EditorModel.tabsToClose(model.tabs(), doc, act, d => model.dirty(d)));
  });
  el("tab-menu").addEventListener("keydown", e => { if (e.key === "Escape") { closeTabMenu(); el("editor").focus(); } });
  document.addEventListener("mousedown", e => { if (!el("tab-menu").contains(e.target)) closeTabMenu(); });
  async function operation(fn) {
    if (pending) return;
    pending = true; render();
    try { await fn(); } catch (e) { message(e.message, true); }
    finally { pending = false; render(); }
  }
  el("projects").onchange = () => operation(() => selectProject(el("projects").value));
  // 新建工程: name + template picker (same templates as the VS Code extension and the phone app).
  function newProjectDialog(list) {
    return new Promise(resolve => {
      const prev = document.activeElement, back = document.createElement("div");
      back.className = "xs-dialog-backdrop";
      back.innerHTML = '<form class="xs-dialog new-project-dialog" role="dialog" aria-modal="true" aria-labelledby="np-title">' +
        '<h2 id="np-title">新建工程</h2><div class="body">' +
        '<label for="np-name">工程名称</label><input id="np-name" type="text" autocomplete="off" spellcheck="false" placeholder="例如 my_script">' +
        '<div class="np-hint">以字母或下划线开头，仅字母、数字、下划线；入口为 __init__.py</div>' +
        '<div class="np-label" id="np-tpl-label">模板</div><div class="tpl-list" role="radiogroup" aria-labelledby="np-tpl-label"></div>' +
        '<div class="np-error" role="alert"></div></div>' +
        '<div class="foot"><button type="button" data-a="cancel">取消</button><button type="submit" class="primary">创建</button></div></form>';
      const box = back.querySelector(".tpl-list"), name = back.querySelector("#np-name"), err = back.querySelector(".np-error");
      if (!list.templates.length) { box.remove(); back.querySelector(".np-label").remove(); }
      list.templates.forEach(t => {
        const row = document.createElement("label"); row.className = "tpl-item"; row.dataset.id = t.id;
        const r = document.createElement("input"); r.type = "radio"; r.name = "np-tpl"; r.value = t.id; r.checked = t.id === list.default;
        const txt = document.createElement("span"), b = document.createElement("b"), d = document.createElement("small");
        b.textContent = t.label; d.textContent = t.detail || ""; txt.append(b, d); row.append(r, txt); box.appendChild(row);
      });
      if (box.isConnected && !box.querySelector("input:checked")) box.querySelector("input").checked = true;
      const close = value => { back.remove(); if (prev && prev.focus) prev.focus(); resolve(value); };
      back.querySelector("form").addEventListener("submit", e => {
        e.preventDefault();
        const n = name.value.trim();
        if (!n) { err.textContent = "工程名称不能为空"; name.focus(); return; }
        if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(n)) { err.textContent = "工程名须以字母或下划线开头，仅包含字母、数字、下划线"; name.focus(); return; }
        const sel = back.querySelector('input[name="np-tpl"]:checked');
        close({name: n, template: sel ? sel.value : ""});
      });
      name.addEventListener("input", () => { err.textContent = ""; });
      back.addEventListener("click", e => { if (e.target === back || e.target.closest('[data-a="cancel"]')) close(null); });
      back.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(null); });
      document.body.appendChild(back); name.focus();
    });
  }
  el("new-project").onclick = async () => {
    if (pending) return;
    const choice = await newProjectDialog(await model.listTemplates());
    if (!choice) return;
    operation(async () => {
    await model.createProject(choice.name, choice.template);
    await projects(choice.name);
    message("已创建工程 " + choice.name + (choice.template && choice.template !== "empty" ? "（模板）" : "") + "，入口 __init__.py");
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
  const generatedNote = doc => !doc.generated ? "" : doc.generated.error ? "（表单有问题，未生成代码：" + doc.generated.error + "）" : doc.generated.files.length ? "，已生成 " + doc.generated.files.join("、") : "";
  el("save").onclick = () => operation(async () => {
    const doc = current; if (!doc || doc.binary) return;
    await model.save(doc); message(model.dirty(doc) ? "保存完成，仍有新编辑未保存" : "已保存 " + doc.path + generatedNote(doc));
    if (doc.generated && doc.generated.files.length) await refreshFiles();
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
      const inside = files.filter(f => f.path.startsWith(dir + "/")).map(f => f.path);
      const nonEmpty = inside.length > 0 || dirs.some(d => d.startsWith(dir + "/"));
      const dirtyInside = inside.filter(p => { const d = model.documents.get(model.key(p)); return d && model.dirty(d); });
      const ask = !nonEmpty ? "删除空文件夹 " + dir + "/？"
        : "删除文件夹 " + dir + "/ 及其中的 " + inside.length + " 个文件？此操作不可撤销。\n\n" +
          inside.slice(0, 15).join("\n") + (inside.length > 15 ? "\n…… 还有 " + (inside.length - 15) + " 个" : "") +
          (dirtyInside.length ? "\n\n其中 " + dirtyInside.length + " 个文件有未保存的修改，也将丢弃。" : "");
      if (confirm(ask)) operation(async () => {
        const r = await model.removeFolder(dir, project, nonEmpty); expanded().delete(dir);
        for (const p of inside) { model.documents.delete(model.key(p, project)); debuggerClient.breakpoints.delete(project + ":" + p); }
        const lost = current && current.project === project && current.path.startsWith(dir + "/");
        if (lost) { ++generation; current = null; el("editor").value = ""; el("editor").disabled = true; assist.setFile(null); showDesigner(null); cursor(); }
        selected = current ? {type: "file", path: current.path} : null;
        await refreshFiles();
        if (lost && model.project === project) {
          const next = files.find(f => f.path === "__init__.py") || files[0];
          if (next) await load(next.path); else render();
        }
        message("已删除文件夹 " + dir + "/" + (nonEmpty ? "（" + ((r && r.deleted) ?? inside.length) + " 个文件）" : ""));
      });
      return;
    }
    const path = selectedFile();
    if (!path) return;
    const doc = model.documents.get(model.key(path)) || {project: model.project, path, content: "", saved: "", binary: false};
    if (!confirm("确定删除 " + doc.path + "？此操作不可撤销。" + (model.dirty(doc) ? "\n未保存的修改也将丢弃。" : ""))) return;
    operation(async () => {
      await model.remove(doc);
      debuggerClient.breakpoints.delete(doc.project + ":" + doc.path);
      if (current && current.project === doc.project && current.path === doc.path) { ++generation; current = null; el("editor").value = ""; el("editor").disabled = true; assist.setFile(null); showDesigner(null); cursor(); }
      await refreshFiles();
      if (model.project !== doc.project) return;
      if (!current) {
        const next = files.find(f => f.path === "__init__.py") || files[0];
        if (next) await load(next.path); else render();
      }
      message("已删除 " + doc.path);
    });
  };
  el("editor").addEventListener("input", e => { if (!current || current.binary) return; model.edit(current, el("editor").value); message(current.path + " · 未保存"); assist.onInput(e); cursor(); render(); });
  for (const name of ["click", "keyup"]) el("editor").addEventListener(name, cursor);
  el("editor").addEventListener("scroll", () => { syncScroll(); assist.onScroll(); });
  el("editor").addEventListener("keydown", e => {
    if (e.key === "F12" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); (e.shiftKey ? findReferences : goToDefinition)(e.target.selectionStart); return; }
    if (e.key === "F2" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); renameSymbol(e.target.selectionStart); return; }
    if (assist.onKey(e)) return;
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault(); const box = e.target;
      box.setRangeText("    ", box.selectionStart, box.selectionEnd, "end"); box.dispatchEvent(new Event("input"));
    }
  });
  // Go to definition (F12, Ctrl/Cmd+click) and find references (Shift+F12) over the project's symbol table (editor-symbols.js).
  el("editor").addEventListener("click", e => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) goToDefinition(e.target.selectionStart); });
  let symbolToken = 0;
  async function symbolsAt(pos) {
    if (!current || current.binary || !/\.py$/.test(current.path) || !model.project) { message("跳转到定义只支持 Python 文件", true); return null; }
    const token = ++symbolToken, path = current.path, text = el("editor").value, before = text.slice(0, pos);
    const line = before.split("\n").length, col = pos - before.lastIndexOf("\n") - 1;
    let files;
    try { files = await model.pythonSources(); } catch (e) { message(e.message, true); return null; }
    if (token !== symbolToken || !current || current.path !== path) return null;
    const own = files.find(f => f.path === path); if (own) own.content = text; else files.push({path, content: text});
    return {index: EditorSymbols.build(files, window.XSDocs || null), path, line, col, pos};
  }
  async function revealAt(path, line, col, length) {
    if (!current || current.path !== path) await load(path);
    if (!current || current.path !== path) return;
    const box = el("editor"), lines = box.value.split("\n");
    let at = 0; for (let i = 0; i < line - 1 && i < lines.length; i++) at += lines[i].length + 1;
    at += Math.min(col, (lines[line - 1] || "").length);
    box.focus(); box.setSelectionRange(at, at + length); box.scrollTop = Math.max(0, (line - 6) * 21); syncScroll(); cursor();
  }
  async function goToDefinition(pos) {
    const s = await symbolsAt(pos); if (!s) return;
    const r = s.index.definitionAt(s.path, s.line, s.col);
    if (!r) { message("没有找到定义（内置函数、未知类型的参数或拼写有误）", true); return; }
    if (r.library) {
      const text = el("editor").value; let from = s.pos; while (from > 0 && /[\p{L}\p{N}_]/u.test(text[from - 1])) from--;
      if (!assist.showDoc(r.library, from)) { message("库符号 " + r.library + " 没有文档", true); return; }
      message("库符号 · " + r.library); return;
    }
    await revealAt(r.path, r.line, r.col, r.kind === "module" ? 0 : r.name.length);
    message("定义 · " + r.path + ":" + r.line);
  }
  async function findReferences(pos) {
    const s = await symbolsAt(pos); if (!s) return;
    const r = s.index.referencesAt(s.path, s.line, s.col);
    if (!r || !r.refs.length) { message("光标处没有可查找引用的名字", true); return; }
    refs.show(r.name, r.refs);
    message(r.name + " · " + r.refs.length + " 处引用");
  }
  // Hover on a project name: signature / inferred type from the symbol table. Other files are re-read at most every
  // 10 s; the open file's own text is always current.
  let hoverFiles = null, hoverIndex = null;
  assist.describe = async pos => {
    if (!current || current.binary || !/\.py$/.test(current.path) || !model.project) return null;
    const path = current.path, text = el("editor").value, project = model.project;
    if (!hoverFiles || hoverFiles.project !== project || Date.now() - hoverFiles.at > 10000) {
      hoverFiles = {project, at: Date.now(), files: await model.pythonSources(project)}; hoverIndex = null;
    }
    if (!current || current.path !== path || el("editor").value !== text) return null;
    if (!hoverIndex || hoverIndex.path !== path || hoverIndex.text !== text || hoverIndex.files !== hoverFiles) {
      const files = hoverFiles.files.filter(f => f.path !== path).concat([{path, content: text}]);
      hoverIndex = {path, text, files: hoverFiles, index: EditorSymbols.build(files, window.XSDocs || null)};
    }
    const before = text.slice(0, pos), line = before.split("\n").length, col = pos - before.lastIndexOf("\n") - 1;
    return hoverIndex.index.describeAt(path, line, col);
  };
  // Rename symbol (F2 in the editor): every occurrence of the same definition across the project, after a confirm.
  async function renameSymbol(pos) {
    if (pending) return;
    const s = await symbolsAt(pos); if (!s) return;
    const probe = s.index.renameAt(s.path, s.line, s.col);
    if (probe.error) { message(probe.error, true); return; }
    const to = prompt("重命名 " + probe.name + "：输入新名字（工程里指向同一定义的地方一起改）", probe.name);
    if (to === null || to.trim() === probe.name) return;
    const r = s.index.renameAt(s.path, s.line, s.col, to.trim());
    if (r.error) { message(r.error, true); return; }
    const dirty = new Set(r.edits.map(e => e.path).filter(p => { const d = model.documents.get(model.key(p)); return d && model.dirty(d); })).size;
    if (!confirm("把 " + r.files + " 个文件中的 " + r.edits.length + " 处 " + r.name + " 重命名为 " + r.newName + "？\n" +
      "没有未保存修改的文件会直接写入设备，可用「撤销替换」恢复" + (dirty ? "；有未保存修改的 " + dirty + " 个文件只改编辑器内容，仍需保存" : "") + "。")) return;
    await operation(async () => {
      const done = await model.renameInFiles(r.edits, r.name, r.newName);
      syncCurrent(); await refreshFiles(); search.syncUndo();
      message("已把 " + r.name + " 重命名为 " + r.newName + "：" + done.count + " 处（" + done.files + " 个文件）" + (done.unsaved.length ? "；未保存：" + done.unsaved.join("、") : ""));
    });
  }
  const refs = EditorPanels.initRefs({open: (path, line, col, length) => revealAt(path, line, col, length)});
  // Search / replace and screenshot panels (editor-panels.js).
  const selectionText = () => { const box = el("editor"), t = box.value.slice(box.selectionStart, box.selectionEnd); return t && !/\n/.test(t) && t.length <= 200 ? t : ""; };
  function syncCurrent() {                      // a replace changed documents behind the editor's back
    if (!current || current.binary || el("editor").value === current.content) { render(); return; }
    const box = el("editor"), at = Math.min(box.selectionStart, current.content.length), top = box.scrollTop;
    box.value = current.content; box.setSelectionRange(at, at); box.scrollTop = top;
    assist.runCheck(); cursor(); render();
  }
  const search = EditorPanels.initSearch({model, message, syncCurrent, refreshFiles: () => refreshFiles().then(render), selectionText,
    async openMatch(path, m) {
      await load(path);
      if (!current || current.path !== path) return;
      const box = el("editor"); box.focus(); box.setSelectionRange(m.index, m.index + m.length);
      box.scrollTop = Math.max(0, (m.line - 6) * 21); syncScroll(); cursor();
    }});
  EditorPanels.initShot({api: (...args) => XS.api(...args), model, message, refreshFiles: () => refreshFiles().then(render),
    insertAtCaret(text) {
      const box = el("editor"); if (box.disabled || !current) return message("先打开一个文件", true);
      box.focus(); box.setRangeText(text, box.selectionStart, box.selectionEnd, "end"); box.dispatchEvent(new Event("input"));
    }});
  window.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!el("save").disabled) el("save").click(); }
    if (e.key === "F6") { e.preventDefault(); el(e.shiftKey ? "stop" : "run").click(); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); search.open(selectionText()); }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyW" && current) { e.preventDefault(); closeTabs([current]); }
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
  // Narrow screens (≤600px): the explorer is a drawer opened by ☰ 文件; picking a file, Esc, or tapping the editor closes it.
  (function drawer() {
    const ide = document.querySelector(".ide"), btn = el("sidebar-toggle"), side = el("files-drawer");
    const set = open => { ide.classList.toggle("sidebar-open", open); btn.setAttribute("aria-expanded", String(open)); };
    btn.addEventListener("click", () => set(!ide.classList.contains("sidebar-open")));
    side.addEventListener("click", e => { if (e.target.closest('.tree-row[data-type="file"], .sr-match')) setTimeout(() => set(false), 0); });
    document.querySelector(".ide-workspace").addEventListener("pointerdown", () => { if (ide.classList.contains("sidebar-open")) set(false); }, true);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && ide.classList.contains("sidebar-open") && el("search-panel").hidden) set(false); });
  })();
  window.addEventListener("pageshow", e => { if (e.persisted) location.reload(); });
  document.addEventListener("visibilitychange", () => !document.hidden && poll());
  projects(new URLSearchParams(location.search).get("project") || "").catch(e => message(e.message, true));
  poll(); render();
})();
