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
    async createProject(name) {
      if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) throw new Error("工程名须以字母或下划线开头，仅包含字母、数字、下划线");
      const names = await this.listProjects();
      if (names.includes(name)) throw new Error("工程已存在");
      await this.api("POST", this.projectUrl(name), {});
      this.project = name;
      return this.listFiles();
    }
    async listFiles() { return (await this.api("GET", this.projectUrl() + "/files")).files || []; }
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
    }
    async saveAll(project = this.project) {
      for (const doc of this.documents.values()) if (doc.project === project && this.dirty(doc)) await this.save(doc);
    }
    async createFile(path) {
      const normalized = path.replace(/\\/g, "/");
      if (!normalized || normalized.startsWith("/") || normalized.split("/").some(p => !p || p === ".." || p === ".")) throw new Error("文件路径须位于工程目录内");
      const project = this.project;
      const files = await this.listFiles();
      if (files.some(f => f.path === normalized)) throw new Error("文件已存在");
      await this.api("PUT", this.projectUrl(project) + "/files", {path: normalized, content: "", encoding: "utf-8"});
      return this.open(normalized, project);
    }
    async remove(doc) {
      if (doc.path === "__init__.py" || doc.path === "__init__.pyc") throw new Error("不能删除工程入口");
      await this.api("DELETE", this.projectUrl(doc.project) + "/file?path=" + encodeURIComponent(doc.path));
      this.documents.delete(this.key(doc.path, doc.project));
    }
    async run(mode = "run") {
      const project = this.project;
      await this.saveAll(project);
      // Do not run a half-saved revision if typing continued while saving.
      if (this.unsaved().some(d => d.project === project)) throw new Error("保存期间内容已变化，请再次运行");
      return this.api("POST", this.projectUrl(project) + (mode === "debug" ? "/debug" : "/run"), {});
    }
    async stop() { return this.api("POST", this.projectUrl() + "/stop", {}); }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { EditorModel };
  else root.EditorModel = EditorModel;
})(typeof globalThis !== "undefined" ? globalThis : this);
