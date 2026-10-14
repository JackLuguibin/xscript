"use strict";
(() => {
  const el = id => document.getElementById(id);
  const model = new EditorModel((...args) => XS.api(...args));
  let current = null, files = [], pending = false, generation = 0, logCursor = 0, polling = false, closed = false;
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
    el("new-project").disabled = pending;
    el("projects").disabled = pending;
    el("delete-file").disabled = pending || !current || /^__init__\.pyc?$/.test(current.path);
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
    el("files").replaceChildren();
    for (const file of files) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = file.path; button.title = file.path;
      button.classList.toggle("active", !!current && file.path === current.path);
      button.onclick = () => load(file.path);
      el("files").append(button);
    }
    if (!files.length) {
      const note = document.createElement("p"); note.className = "muted";
      note.textContent = model.project ? "工程内暂无文件" : "新建或选择一个工程";
      el("files").append(note);
    }
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
  }
  function show(doc) {
    current = doc;
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
    const list = project ? await model.listFiles() : [];
    if (model.project === project) { files = list; render(); }
  }
  async function selectProject(project) {
    await debuggerClient.close(); el("debug-state").textContent = "未连接";
    el("debug-stack").replaceChildren(); el("debug-variables").textContent = "";
    ++generation; model.project = project; current = null; files = [];
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
    const name = prompt("工程名称（字母、数字、下划线）");
    if (name && name.trim()) operation(async () => { await model.createProject(name.trim()); await projects(name.trim()); });
  };
  el("new-file").onclick = () => {
    const path = prompt("文件相对路径，例如 utils.py 或 res/config.json");
    if (path && path.trim()) operation(async () => { const doc = await model.createFile(path.trim()); await refreshFiles(); show(doc); });
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
    const doc = current;
    if (doc && confirm("删除 " + doc.path + "？" + (model.dirty(doc) ? "未保存内容也将丢弃。" : ""))) operation(async () => {
      await model.remove(doc); current = null; el("editor").value = ""; el("editor").disabled = true;
      await refreshFiles(); if (files.length) await load(files[0].path); else { render(); cursor(); }
    });
  };
  el("editor").addEventListener("input", () => { if (!current || current.binary) return; model.edit(current, el("editor").value); message(current.path + " · 未保存"); cursor(); render(); });
  for (const name of ["click", "keyup", "scroll"]) el("editor").addEventListener(name, cursor);
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
