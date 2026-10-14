/* XScript DAP client: transport is the device HTTP API. */
(function(root) {
  "use strict";
  class XScriptDebugger {
    constructor(api, hooks = {}) {
      this.api = api; this.hooks = hooks; this.epoch = 0; this.seq = 0;
      this.pending = new Map(); this.breakpoints = new Map(); this.active = false;
    }
    notify(state) { if (this.hooks.state) this.hooks.state(state); }
    relative(path) {
      if (typeof path !== "string" || !this.remoteRoot) return null;
      const prefix = this.remoteRoot + "/";
      const relative = path.startsWith(prefix) ? path.slice(prefix.length) : null;
      return relative && !relative.split("/").some(p => !p || p === "." || p === ".." || p.includes("\\")) ? relative : null;
    }
    source(path) {
      if (!path || path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === ".." || p.includes("\\"))) throw new Error("断点文件必须位于工程内");
      return { name:path.split("/").pop(), path:this.remoteRoot + "/" + path };
    }
    async start(project, remoteRoot) {
      await this.close();
      if (typeof remoteRoot !== "string" || !remoteRoot.startsWith("/")) throw new Error("调试器未返回工程路径");
      this.project = project; this.remoteRoot = remoteRoot.replace(/\/+$/, "");
      this.active = true; this.cursor = 0; this.initialized = false; this.configuring = false; this.attachSent = false;
      const epoch = this.epoch;
      this.notify("连接中");
      let connected = false;
      for (let i = 0; i < 40 && epoch === this.epoch; i++) {
        try { await this.api("POST", "/debug/connect", {}); connected = true; break; }
        catch (e) { if (i === 39) throw e; await new Promise(r => setTimeout(r, 250)); }
      }
      if (!connected || epoch !== this.epoch) return;
      this.transportConnected = true;
      this.loop(epoch);
      await this.request("initialize", {adapterID:"python", clientID:"xscript-web", linesStartAt1:true, columnsStartAt1:true, pathFormat:"path", supportsVariableType:true});
      if (epoch !== this.epoch) return;
      // The attach response may wait for configurationDone; do not await it here.
      this.attachSent = true;
      this.request("attach", {justMyCode:true}).then(() => { if (epoch === this.epoch) this.notify("运行中"); }).catch(e => this.fail(e, epoch));
      if (this.initialized) this.configure(epoch);
    }
    async configure(epoch) {
      if (!this.attachSent || this.configuring || epoch !== this.epoch) return;
      this.configuring = true;
      try {
        for (const [key, lines] of this.breakpoints) {
          const prefix = this.project + ":";
          if (key.startsWith(prefix)) await this.setBreakpoints(key.slice(prefix.length), lines);
        }
        if (epoch === this.epoch) await this.request("configurationDone", {});
      } catch(e) { this.fail(e, epoch); }
    }
    request(command, args = {}, timeoutMs = 15000) {
      if (!this.active) return Promise.reject(new Error("调试器未连接"));
      const seq = ++this.seq, epoch = this.epoch;
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error("调试请求超时: " + command)); }, timeoutMs);
        this.pending.set(seq, {resolve,reject,timer});
        Promise.resolve(this.api("POST", "/debug/request", {seq,type:"request",command,arguments:args})).catch(e => {
          if (epoch !== this.epoch) return;
          const entry = this.pending.get(seq); if (entry) { clearTimeout(timer); this.pending.delete(seq); reject(e); }
        });
      });
    }
    async loop(epoch) {
      while (this.active && epoch === this.epoch) {
        try {
          const result = await this.api("GET", "/debug/messages?since=" + this.cursor);
          if (epoch !== this.epoch) return;
          this.cursor = result.next;
          for (const item of result.messages || []) this.receive(item.message, epoch);
          if (epoch !== this.epoch) return;
          if (result.connected === false) {
            if (this.detaching) return;
            const status = await this.api("GET", "/status");
            if (epoch !== this.epoch) return;
            if (status.running === false) { this.close(false); this.notify("已结束"); return; }
            throw new Error("调试连接已断开");
          }
        } catch(e) { this.fail(e, epoch); return; }
        await new Promise(r => setTimeout(r, 120));
      }
    }
    receive(msg, epoch = this.epoch) {
      if (epoch !== this.epoch) return;
      if (msg.type === "response") {
        const entry = this.pending.get(msg.request_seq);
        if (entry) { clearTimeout(entry.timer); this.pending.delete(msg.request_seq); msg.success === false ? entry.reject(new Error(msg.message || msg.command + " 失败")) : entry.resolve(msg.body || {}); }
      } else if (msg.type === "event") {
        if (msg.event === "initialized") { this.initialized = true; this.notify("配置断点中"); this.configure(epoch); }
        if (msg.event === "stopped") { this.threadId = msg.body.threadId; this.notify("已暂停 · " + (msg.body.reason || "")); this.inspect(epoch).catch(e => this.fail(e, epoch)); }
        if (msg.event === "continued") { this.notify("运行中"); if (this.hooks.frames) this.hooks.frames([]); if (this.hooks.variables) this.hooks.variables([]); }
        if ((msg.event === "terminated" || msg.event === "exited") && !this.detaching) { this.close(false); this.notify("已结束"); }
      }
    }
    async inspect(epoch) {
      const body = await this.request("stackTrace", {threadId:this.threadId});
      if (epoch !== this.epoch) return;
      const frames = body.stackFrames || [];
      if (this.hooks.frames) this.hooks.frames(frames);
      if (frames.length) await this.selectFrame(frames[0], epoch);
    }
    async selectFrame(frame, epoch = this.epoch) {
      const path = frame.source && this.relative(frame.source.path);
      if (path && this.hooks.source) await this.hooks.source(path, frame.line);
      if (epoch !== this.epoch) return;
      const scopes = await this.request("scopes", {frameId:frame.id});
      if (epoch !== this.epoch) return;
      const groups = [];
      for (const scope of scopes.scopes || []) {
        if (scope.expensive) continue;
        const values = await this.request("variables", {variablesReference:scope.variablesReference});
        if (epoch !== this.epoch) return;
        groups.push({name:scope.name, variables:values.variables || []});
      }
      if (this.hooks.variables) this.hooks.variables(groups);
    }
    async toggle(path, line, project) {
      this.source(path); const key = project + ":" + path;
      const lines = new Set(this.breakpoints.get(key) || []);
      lines.has(line) ? lines.delete(line) : lines.add(line);
      this.breakpoints.set(key, [...lines].sort((a,b) => a-b));
      if (this.active && this.initialized && this.project === project) await this.setBreakpoints(path, this.breakpoints.get(key));
      return this.breakpoints.get(key);
    }
    async setBreakpoints(path, lines) {
      const result = await this.request("setBreakpoints", {source:this.source(path),breakpoints:lines.map(line => ({line}))});
      if ((result.breakpoints || []).some(b => !b.verified) && this.hooks.warning) this.hooks.warning("部分断点尚未验证，请检查行号或文件是否已保存");
      return result;
    }
    async control(command) {
      if (!this.threadId) { const threads = await this.request("threads"); this.threadId = threads.threads && threads.threads[0] && threads.threads[0].id; }
      if (!this.threadId) throw new Error("暂无可操作线程");
      return this.request(command, {threadId:this.threadId});
    }
    fail(error, epoch) { if (epoch !== this.epoch) return; this.close(false); this.notify(error.message); }
    close(disconnect = true) {
      if (this.closing) return this.closing;
      const wasActive = this.active;
      this.detaching = !!(disconnect && wasActive && this.transportConnected && this.attachSent);
      this.closing = (async () => {
        // A TCP close does not resume debugpy's suspended threads. Complete the
        // DAP detach while the reader is still active before removing transport.
        if (this.detaching) {
          try { await this.request("disconnect", {terminateDebuggee:false}, 1500); } catch (_) {}
        }
        this.active = false; this.transportConnected = false; this.epoch++; this.threadId = null;
        if (this.hooks.frames) this.hooks.frames([]);
        if (this.hooks.variables) this.hooks.variables([]);
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("调试会话已关闭")); }
        this.pending.clear();
        if (wasActive && disconnect) { try { await this.api("DELETE", "/debug"); } catch (_) {} }
      })();
      this.closing.finally(() => { this.closing = null; this.detaching = false; });
      return this.closing;
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = {XScriptDebugger};
  else root.XScriptDebugger = XScriptDebugger;
})(typeof globalThis !== "undefined" ? globalThis : this);
