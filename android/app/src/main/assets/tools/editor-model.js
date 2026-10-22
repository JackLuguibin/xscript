/* Independent Web IDE state: native XScript endpoints, no vendor service or bundle. */
(function (root) {
  "use strict";
  class EditorModel {
    constructor(api) {
      this.api = api;
      this.project = "";
      this.documents = new Map();
    }
    projectUrl(project = this.project) {
      if (!project) throw new Error("请先选择工程");
      return "/projects/" + encodeURIComponent(project);
    }
    key(path, project = this.project) { return project + ":" + path; }
    async listProjects() { return (await this.api("GET", "/projects")).projects || []; }
    async listTemplates() {
      try { const r = await this.api("GET", "/project-templates"); return {templates: r.templates || [], default: r.default || "empty"}; }
      catch (e) { return {templates: [], default: ""}; }  // older device firmware: plain empty project only
    }
    async createProject(name, template = "") {
      if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) throw new Error("工程名须以字母或下划线开头，仅包含字母、数字、下划线");
      const names = await this.listProjects();
      if (names.includes(name)) throw new Error("工程已存在：" + name);
      await this.api("POST", this.projectUrl(name), template ? {template} : {});
      this.project = name;
      return this.listFiles();
    }
    async listFiles() { return (await this.listTree()).files; }
    /** Files plus folders (folders may be empty, e.g. right after 新建文件夹). */
    async listTree(project = this.project) {
      const result = await this.api("GET", this.projectUrl(project) + "/files");
      return { files: result.files || [], dirs: result.dirs || [] };
    }
    static normalizePath(path, kind = "文件") {
      const normalized = String(path || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
      if (!normalized || normalized.startsWith("/") || normalized.split("/").some(p => !p || p === ".." || p === "." || p.includes("\0")))
        throw new Error(kind + "路径须位于工程目录内，不能包含 .. 、空段或以 / 开头");
      if (normalized.split("/").some(p => p === "__pycache__" || p.startsWith("."))) throw new Error("不能使用隐藏名称或 __pycache__");
      return normalized;
    }
    /** Parent folders of a path, outermost first: "a/b/c.py" -> ["a", "a/b"]. */
    static ancestors(path) {
      const parts = String(path || "").split("/").slice(0, -1), out = [];
      for (let i = 0; i < parts.length; i++) out.push(parts.slice(0, i + 1).join("/"));
      return out;
    }
    /** Folder a new item should go into for a selected tree node (a folder itself, or a file's parent). */
    static folderOf(node) {
      if (!node || !node.path) return "";
      return node.type === "dir" ? node.path : node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
    }
    /**
     * Nested tree from the flat device listing. Folders come from `dirs` (empty ones included)
     * and from file parents; within a folder, folders sort before files, then by name.
     */
    static buildTree(files = [], dirs = []) {
      const root = { type: "dir", name: "", path: "", children: [] }, index = new Map([["", root]]);
      const folder = path => {
        if (index.has(path)) return index.get(path);
        const cut = path.lastIndexOf("/"), parent = folder(cut < 0 ? "" : path.slice(0, cut));
        const node = { type: "dir", name: path.slice(cut + 1), path, children: [] };
        parent.children.push(node); index.set(path, node);
        return node;
      };
      for (const dir of dirs) if (dir) folder(String(dir).replace(/\/+$/, ""));
      for (const file of files) {
        const path = typeof file === "string" ? file : file.path;
        if (!path || index.has(path)) continue;
        const cut = path.lastIndexOf("/"), node = { type: "file", name: path.slice(cut + 1), path, size: file.size };
        folder(cut < 0 ? "" : path.slice(0, cut)).children.push(node); index.set(path, node);
      }
      const order = (a, b) => (a.type === b.type ? 0 : a.type === "dir" ? -1 : 1) || a.name.localeCompare(b.name, "zh-CN");
      const sort = node => { node.children.sort(order); node.children.forEach(c => c.type === "dir" && sort(c)); };
      sort(root);
      return root;
    }
    /** Rows to render: depth-first, children only under expanded folders. */
    static visibleRows(tree, expanded = new Set()) {
      const rows = [];
      const walk = (node, depth) => {
        for (const child of node.children) {
          const open = child.type === "dir" && expanded.has(child.path);
          rows.push({ node: child, depth, expanded: open, empty: child.type === "dir" && !child.children.length });
          if (open) walk(child, depth + 1);
        }
      };
      walk(tree, 0);
      return rows;
    }
    /**
     * Explorer keyboard behaviour (VS Code style) over the visible rows.
     * Returns {focus} to move focus/selection, plus {expand}/{collapse}/{open} actions.
     */
    static navigate(rows, path, key) {
      if (!rows.length) return {};
      const i = rows.findIndex(r => r.node.path === path), row = rows[i];
      if (i < 0) return { focus: rows[0].node.path };
      const at = n => ({ focus: rows[Math.max(0, Math.min(rows.length - 1, n))].node.path });
      const isDir = row.node.type === "dir";
      switch (key) {
        case "ArrowDown": return at(i + 1);
        case "ArrowUp": return at(i - 1);
        case "Home": return at(0);
        case "End": return at(rows.length - 1);
        case "ArrowRight":
          if (isDir && !row.expanded) return { focus: path, expand: path };
          if (isDir && rows[i + 1] && rows[i + 1].depth > row.depth) return at(i + 1);
          return { focus: path };
        case "ArrowLeft": {
          if (isDir && row.expanded) return { focus: path, collapse: path };
          const parents = EditorModel.ancestors(path);
          return { focus: parents.length ? parents[parents.length - 1] : path };
        }
        case "Enter": case " ":
          if (isDir) return row.expanded ? { focus: path, collapse: path } : { focus: path, expand: path };
          return { focus: path, open: path };
        default: return {};
      }
    }
    async open(path, project = this.project) {
      const key = this.key(path, project);
      if (this.documents.has(key)) return this.documents.get(key);
      const file = await this.api("GET", this.projectUrl(project) + "/file?path=" + encodeURIComponent(path));
      // Concurrent loads must never replace a document that is already being edited.
      if (this.documents.has(key)) return this.documents.get(key);
      const doc = { project, path, content: file.content || "", saved: file.content || "", binary: file.encoding === "base64" };
      this.documents.set(key, doc);
      return doc;
    }
    edit(doc, value) {
      if (doc.binary) throw new Error("二进制文件不能作为文本编辑");
      doc.content = value;
    }
    dirty(doc) { return doc.content !== doc.saved; }
    unsaved() { return Array.from(this.documents.values()).filter(d => this.dirty(d)); }
    async save(doc) {
      if (doc.binary) throw new Error("二进制文件不能作为文本保存");
      // Capture a revision; typing during the request must remain dirty afterward.
      const content = doc.content;
      await this.api("PUT", this.projectUrl(doc.project) + "/files", {path: doc.path, content, encoding: "utf-8"});
      doc.saved = content;
      doc.generated = await this.generateUi(doc.project, doc.path, content);
    }
    /** res/ui/<name>.ui.json was saved: write res/ui/<name>.html and ui_<name>.py next to the project entry, like
     *  the VS Code designer (shared generator tools/ui-form.js). Returns {files, error}; an invalid spec writes
     *  nothing. Open, unedited tabs of the generated files are refreshed; ones with unsaved edits are left alone. */
    async generateUi(project, path, text) {
      const F = EditorModel.uiForm(), name = F && F.formName(path);
      if (!name) return null;
      let spec;
      try { spec = F.parseSpec(text); } catch (e) { return {files: [], error: "不是有效的 JSON：" + e.message}; }
      const errors = F.validateSpec(spec);
      if (errors.length) return {files: [], error: errors.join("；")};
      const m = /^(.*\/)?res\/ui\/[^/]+$/.exec(path);
      const root = m ? m[1] || "" : path.slice(0, path.lastIndexOf("/") + 1);
      const files = [];
      for (const [rel, content] of Object.entries(F.outputs(spec, name))) {
        const target = root + rel, open = this.documents.get(this.key(target, project));
        if (open && this.dirty(open)) continue;
        await this.api("PUT", this.projectUrl(project) + "/files", {path: target, content, encoding: "utf-8"});
        if (open) { open.content = content; open.saved = content; }
        files.push(target);
      }
      return {files, error: ""};
    }
    static uiForm() {
      if (root.XSUiForm) return root.XSUiForm;
      try { return typeof require === "function" ? require("./ui-form.js") : null; } catch (e) { return null; }
    }
    async saveAll(project = this.project) {
      for (const doc of this.documents.values()) if (doc.project === project && this.dirty(doc)) await this.save(doc);
    }
    async createFile(path) {
      const normalized = EditorModel.normalizePath(path);
      const project = this.project;
      const tree = await this.listTree(project);
      if (tree.files.some(f => f.path === normalized)) throw new Error("文件已存在：" + normalized);
      if (tree.dirs.includes(normalized)) throw new Error("同名文件夹已存在：" + normalized);
      // create:true makes the device refuse (409) instead of overwriting if it appeared meanwhile.
      await this.api("PUT", this.projectUrl(project) + "/files", {path: normalized, content: "", encoding: "utf-8", create: true});
      const key = this.key(normalized, project);
      this.documents.set(key, { project, path: normalized, content: "", saved: "", binary: false });
      return this.documents.get(key);
    }
    async createFolder(path) {
      const normalized = EditorModel.normalizePath(path, "文件夹");
      const project = this.project;
      const tree = await this.listTree(project);
      if (tree.dirs.includes(normalized) || tree.files.some(f => f.path === normalized)) throw new Error("路径已存在：" + normalized);
      await this.api("POST", this.projectUrl(project) + "/dir", {path: normalized});
      return normalized;
    }
    async remove(doc) {
      if (doc.path === "__init__.py" || doc.path === "__init__.pyc") throw new Error("不能删除工程入口");
      try {
        await this.api("DELETE", this.projectUrl(doc.project) + "/file?path=" + encodeURIComponent(doc.path));
      } catch (e) {
        // Already gone on the device (deleted elsewhere): still drop the stale editor document.
        if (!/不存在|missing|404/.test(e.message)) throw e;
      }
      this.documents.delete(this.key(doc.path, doc.project));
    }
    /** `recursive` deletes the folder with everything in it; otherwise the device refuses a non-empty one. */
    async removeFolder(path, project = this.project, recursive = false) {
      return this.api("DELETE", this.projectUrl(project) + "/file?path=" + encodeURIComponent(path) + (recursive ? "&recursive=1" : ""));
    }
    /** Where `path` ends up after moving `from` to `to` (a file, or a folder with everything inside). */
    static movedPath(path, from, to) {
      if (path === from) return to;
      return path.startsWith(from + "/") ? to + path.slice(from.length) : path;
    }
    /** Rename / move a file or folder; open documents (including unsaved edits) follow it. */
    async move(from, to, project = this.project) {
      const src = EditorModel.normalizePath(from, "原路径");
      const dst = EditorModel.normalizePath(to, "新路径");
      if (src === dst) return dst;
      if (src === "__init__.py" || src === "__init__.pyc") throw new Error("不能移动工程入口");
      if (dst.startsWith(src + "/")) throw new Error("不能把文件夹移动到它自己里面");
      await this.api("POST", this.projectUrl(project) + "/move", {from: src, to: dst});
      for (const doc of Array.from(this.documents.values())) {
        if (doc.project !== project) continue;
        const next = EditorModel.movedPath(doc.path, src, dst);
        if (next === doc.path) continue;
        this.documents.delete(this.key(doc.path, project));
        doc.path = next;
        this.documents.set(this.key(next, project), doc);
      }
      return dst;
    }
    // ---- tabs ----
    /** Documents shown as tabs for a project (open order). */
    tabs(project = this.project) { return Array.from(this.documents.values()).filter(d => d.project === project); }
    /** Which tabs a close action removes. mode: "one" | "others" | "right" | "saved" | "all". */
    static tabsToClose(tabs, doc, mode, dirty) {
      const i = tabs.indexOf(doc);
      switch (mode) {
        case "one": return i < 0 ? [] : [doc];
        case "others": return tabs.filter(t => t !== doc);
        case "right": return i < 0 ? [] : tabs.slice(i + 1);
        case "saved": return tabs.filter(t => !dirty(t));
        case "all": return tabs.slice();
        default: return [];
      }
    }
    /** The tab to show after closing `closing` while `current` was active (neighbour to the left, else right). */
    static nextTab(tabs, current, closing) {
      if (!current || !closing.includes(current)) return current;
      const i = tabs.indexOf(current);
      const rest = tabs.filter(t => !closing.includes(t));
      for (let k = i - 1; k >= 0; k--) if (!closing.includes(tabs[k])) return tabs[k];
      return rest[0] || null;
    }
    close(doc) { this.documents.delete(this.key(doc.path, doc.project)); }

    // ---- project-wide search / replace ----
    static get MAX_UNDO_CHARS() { return 20 * 1024 * 1024; }
    /** Every .py file of the project as {path, content} for the symbol table (unsaved editor content wins). */
    async pythonSources(project = this.project) {
      const tree = await this.listTree(project), list = tree.files.filter(f => /\.py$/.test(f.path) && !(f.size > 400000)), out = [];
      let next = 0;
      const worker = async () => {
        for (;;) {
          const f = list[next++]; if (!f) return;
          const open = this.documents.get(this.key(f.path, project));
          if (open) { if (!open.binary) out.push({path: f.path, content: open.content}); continue; }
          try {
            const file = await this.api("GET", this.projectUrl(project) + "/file?path=" + encodeURIComponent(f.path));
            if (file.encoding !== "base64") out.push({path: f.path, content: file.content || ""});
          } catch (e) { /* unreadable file: left out of the index */ }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      return out.sort((a, b) => a.path < b.path ? -1 : 1);
    }
    static get search() { return root.EditorSearch || (typeof require === "function" ? require("./editor-search.js").EditorSearch : null); }
    /**
     * Search every text file of the project (unsaved editor content wins over the saved file).
     * opts: {regex, caseSensitive, word, include}. Returns {results:[{path, matches}], files, matches, truncated, skipped}.
     */
    async searchProject(query, opts = {}, project = this.project) {
      const S = EditorModel.search, re = S.compile(query, opts), keep = S.globFilter(opts.include);
      const guard = S.guard(opts);   // regex runs in a killable worker (timeout), literal searches inline
      try { return await this.searchWith(guard, S, re, keep, opts, project); } finally { guard.dispose(); }
    }
    async searchWith(guard, S, re, keep, opts, project) {
      const tree = await this.listTree(project);
      const names = tree.files.filter(f => keep(f.path));
      const results = []; let total = 0, truncated = false, skipped = 0, scanned = 0;
      const readText = async f => {
        const open = this.documents.get(this.key(f.path, project));
        if (open) return open.binary ? null : open.content;
        if (!S.isSearchable(f.path, f.size)) return null;
        const file = await this.api("GET", this.projectUrl(project) + "/file?path=" + encodeURIComponent(f.path));
        if (file.encoding === "base64") return null;
        return file.content || "";
      };
      let next = 0, failure = null;
      const worker = async () => {
        for (;;) {
          const f = names[next++]; if (!f || failure) return;
          if (total >= S.MAX_TOTAL) { truncated = true; return; }
          let text;
          try { text = await readText(f); } catch (e) { skipped++; continue; }
          if (text === null) { skipped++; continue; }
          scanned++;
          if (text.length > S.MAX_FILE) { skipped++; continue; }
          let matches;
          try { matches = await guard.find(text, new RegExp(re.source, re.flags), S.MAX_PER_FILE); }
          catch (e) { failure = failure || e; return; }
          if (!matches.length) continue;
          if (matches.length >= S.MAX_PER_FILE) truncated = true;
          total += matches.length; results.push({path: f.path, matches});
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (failure) throw failure;
      results.sort((a, b) => a.path < b.path ? -1 : 1);
      return {results, files: results.length, matches: total, truncated, skipped, scanned};
    }
    /**
     * Replace in the given files. A file with no unsaved edits is saved right away; one with unsaved edits is changed
     * in the editor only and stays unsaved. Returns {files, count, unsaved:[paths]}.
     */
    async replaceInFiles(paths, query, replacement, opts = {}, project = this.project) {
      const S = EditorModel.search, re = S.compile(query, opts);
      let files = 0, count = 0; const unsaved = [], changes = [];
      const guard = S.guard(opts);
      try {
        for (const path of paths) {
          const doc = await this.open(path, project);
          if (doc.binary) continue;
          const r = await guard.replaceAll(doc.content, new RegExp(re.source, re.flags), replacement, opts);
          if (!r.count) continue;
          const wasDirty = this.dirty(doc), before = doc.content;
          this.edit(doc, r.text);
          if (wasDirty) unsaved.push(path); else await this.save(doc);
          changes.push({path, before, after: r.text, saved: !wasDirty});
          files++; count += r.count;
        }
      } finally { guard.dispose(); this.rememberReplace(project, changes); }
      return {files, count, unsaved, undoable: !!this.lastReplace};
    }
    /**
     * Apply a symbol rename: `edits` [{path,line,col,length}] (from EditorSymbols.renameAt) each replace `oldName` by
     * `newName`. Every position is checked first; if any no longer holds `oldName` nothing is changed. Saving and undo
     * work like replaceInFiles (撤销替换 also undoes a rename). Returns {files, count, unsaved, undoable}.
     */
    async renameInFiles(edits, oldName, newName, project = this.project) {
      const byPath = new Map();
      for (const e of edits) { if (!byPath.has(e.path)) byPath.set(e.path, []); byPath.get(e.path).push(e); }
      const plans = [];
      for (const [path, list] of byPath) {
        const doc = await this.open(path, project);
        if (doc.binary) throw new Error(path + " 不是文本文件");
        const starts = [0]; for (let i = 0; i < doc.content.length; i++) if (doc.content[i] === "\n") starts.push(i + 1);
        const at = list.map(e => (starts[e.line - 1] ?? -1) + e.col).sort((a, b) => b - a);
        if (at.some(i => i < 0 || doc.content.slice(i, i + oldName.length) !== oldName)) throw new Error(path + " 在分析之后改过，请重试");
        let text = doc.content; for (const i of at) text = text.slice(0, i) + newName + text.slice(i + oldName.length);
        plans.push({path, doc, text, count: at.length});
      }
      let files = 0, count = 0; const unsaved = [], changes = [];
      try {
        for (const p of plans) {
          const wasDirty = this.dirty(p.doc), before = p.doc.content;
          this.edit(p.doc, p.text);
          if (wasDirty) unsaved.push(p.path); else await this.save(p.doc);
          changes.push({path: p.path, before, after: p.text, saved: !wasDirty});
          files++; count += p.count;
        }
      } finally { this.rememberReplace(project, changes); }
      return {files, count, unsaved, undoable: !!this.lastReplace};
    }
    // One-step undo of the latest 全部替换: the before/after text of every file it changed (bounded memory).
    rememberReplace(project, changes) {
      if (!changes.length) return;   // nothing changed: the previous undo still applies
      const size = changes.reduce((n, c) => n + c.before.length + c.after.length, 0);
      this.lastReplace = size <= EditorModel.MAX_UNDO_CHARS ? {project, changes, time: Date.now()} : null;
    }
    /**
     * Undo the latest replace. A file is restored only if it still holds exactly what the replace produced; files edited
     * since, renamed or deleted are left alone and reported. Files the replace had written to the device are written back.
     * Returns {restored:[paths], skipped:[{path, reason}]}.
     */
    async undoReplace() {
      const last = this.lastReplace;
      if (!last) throw new Error("没有可撤销的替换");
      const restored = [], skipped = [], keep = [];
      for (const c of last.changes) {
        let doc;
        try { doc = await this.open(c.path, last.project); } catch (e) { skipped.push({path: c.path, reason: "文件已不存在"}); continue; }
        if (doc.binary || doc.content !== c.after) { skipped.push({path: c.path, reason: "替换之后又被修改过"}); keep.push(c); continue; }
        this.edit(doc, c.before);
        if (c.saved) {
          try { await this.save(doc); } catch (e) { skipped.push({path: c.path, reason: "写回失败：" + e.message}); keep.push(c); continue; }
        }
        restored.push(c.path);
      }
      this.lastReplace = keep.length ? {project: last.project, changes: keep, time: last.time} : null;
      return {restored, skipped};
    }
    async run(mode = "run") {
      const project = this.project;
      await this.saveAll(project);
      // Do not run a half-saved revision if typing continued while saving.
      if (this.unsaved().some(d => d.project === project)) throw new Error("保存期间内容已变化，请再次运行");
      return this.api("POST", this.projectUrl(project) + (mode === "debug" ? "/debug" : "/run"), {});
    }
    async stop() { return this.api("POST", this.projectUrl() + "/stop", {}); }
    /** Status line after 运行: the reply's `missing` lists permissions the code uses but the phone has not granted. */
    static runMessage(project, reply) {
      const missing = reply && Array.isArray(reply.missing) ? reply.missing : [];
      if (!missing.length) return {text: "已请求运行 " + project, warn: false, a11y: false, fix: null};
      const a11y = missing.some(m => m.label === "无障碍");
      const first = a11y ? "无障碍" : (missing.find(m => EditorModel.PERM_FIX[m.label]) || {}).label;
      return {text: "已请求运行 " + project + " · 手机上还缺：" + missing.map(m => m.label + (m.where ? "（" + m.where + "）" : "")).join("、") + "，相关操作会失败，请在手机上的小程序详情页开启", warn: true, a11y,
        fix: first ? Object.assign({label: first}, EditorModel.PERM_FIX[first]) : null};
    }

    /** One-tap fix per missing permission (labels from PermissionNeeds.Kind): /eval `code` opens the phone's settings page
     * (`_result` "1": already granted), or `capture` asks the phone for the screen-capture grant (POST /capture/request). */
    static get PERM_FIX() {
      const req = key => "from xscript.android import permission\n_result = permission.request(permission." + key + ", 1)";
      // same table as protocol/permission-fix.json (scripts/tests/editor.test.cjs compares them)
      return {
        "无障碍": {button: "打开手机无障碍设置", code: req("ACCESSIBILITY_SERVICE"), opened: "已在手机上打开无障碍设置，开启 XScript 后再运行。", on: "无障碍服务已开启，可以再运行一次。", where: "设置 → 无障碍"},
        "图色权限（截图）": {button: "在手机上授权截图", capture: true, opened: "已在手机上弹出截图授权，点「立即开始」后再运行。", on: "截图权限已可用，可以再运行一次。", where: "手机上的 XScript → 图色权限"},
        "悬浮窗权限": {button: "打开手机悬浮窗设置", code: req("OVERLAY"), opened: "已在手机上打开悬浮窗设置，允许 XScript 后再运行。", on: "悬浮窗权限已开启，可以再运行一次。", where: "设置 → 应用 → XScript → 显示在其他应用的上层"},
        "通知使用权": {button: "打开手机通知使用权设置", code: req("NOTIFICATION_LISTENER"), opened: "已在手机上打开通知使用权设置，允许 XScript 后再运行。", on: "通知使用权已开启，可以再运行一次。", where: "设置 → 通知 → 设备和应用通知"},
        "文件访问权限": {button: "打开手机文件访问设置", code: req("MANAGE_EXTERNAL_STORAGE"), opened: "已在手机上打开文件访问设置，允许 XScript 后再运行。", on: "文件访问权限已开启，可以再运行一次。", where: "设置 → 应用 → 特殊应用权限 → 所有文件访问权限"},
      };
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { EditorModel };
  else root.EditorModel = EditorModel;
})(typeof globalThis !== "undefined" ? globalThis : this);
