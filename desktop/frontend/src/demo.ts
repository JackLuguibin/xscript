import { MemoryTransport } from "./bridge/memory";
import type { Device } from "./api";
import { cloudDemoHandlers } from "./cloud-demo";
import { updateDemoHandlers } from "./update-demo";

// Demo backend for `npm run dev` in a plain browser. Shapes mirror the real /status of an emulator.
const status = {
  name: "demo-phone", model: "sdk_gphone64_arm64", brand: "google", sdk: 34, release: "14", width: 1080, height: 2209, density: 420,
  ip: "10.0.2.17", port: 9860, accessibility: false, root: false, channel: "none", capture: false, running: false,
  version: "0.2.6", device_id: "demo0123456789", app_id: "com.xscript.app", cloud: "未连接",
};

export function createDemoTransport(): MemoryTransport {
  const devices = new Map<string, Device>();
  const projects = new Map<string, Map<string, string>>([["demo", new Map([["__init__.py", "print('hello from demo')\n"]])]]);
  const logs: Array<{ seq: number; ts: number; stream: string; line: string }> = [];
  let running = "";
  const log = (line: string) => logs.push({ seq: logs.length + 1, ts: Date.now(), stream: "stdout", line });
  const proj = (p: Record<string, unknown>) => {
    const m = projects.get(String(p.project));
    if (!m) throw { code: "device.http", message: "missing project" };
    return m;
  };
  // demo debugger: walks the entry point line by line, pausing at breakpoints (mirrors the debug.state/debug.output events)
  type DemoBp = { line: number; condition?: string; hitCondition?: string; logMessage?: string };
  const specs = (raw: unknown): DemoBp[] => ((raw as Array<number | DemoBp>) ?? []).map((b) => (typeof b === "number" ? { line: b } : b));
  let dbg: { id: string; project: string; state: string; line: number; bps: Map<string, DemoBp[]>; hits: Map<number, number> } | null = null;
  const emit = (topic: string, data: unknown) => setTimeout(() => transport.push({ event: true, topic, data }), 0);
  const snap = () => {
    const d = dbg!;
    const frames = d.state === "stopped"
      ? [{ id: 1, name: "<module>", line: d.line, column: 1, path: "__init__.py", file: "__init__.py" }, { id: 2, name: "run", line: 1, column: 1, path: null, file: "runpy.py" }]
      : [];
    return { id: d.id, project: d.project, state: d.state, frames, path: frames[0]?.path ?? null, line: frames[0]?.line ?? null, reason: d.state === "stopped" ? "breakpoint" : "", error: "" };
  };
  const advance = (from: number, step: boolean) => {
    const d = dbg!;
    const n = (projects.get(d.project)?.get("__init__.py") ?? "").split("\n").length;
    const bps = d.bps.get("__init__.py") ?? [];
    for (let ln = from; ln <= n; ln++) {
      const bp = step ? undefined : bps.find((b) => b.line === ln);
      if (bp) {
        const hits = (d.hits.get(ln) ?? 0) + 1;
        d.hits.set(ln, hits);
        // the demo "evaluates" only the literals False / True; {line} is interpolated in logpoints
        if (bp.logMessage) {
          emit("debug.output", { id: d.id, category: "console", text: bp.logMessage.replace(/\{line\}/g, String(ln)) + "\n" });
          continue;
        }
        if (bp.condition?.trim() === "False") continue;
        if (bp.hitCondition && hits < Number(bp.hitCondition.replace(/[^0-9]/g, "") || 0)) continue;
      }
      if (step || bp) {
        d.state = "stopped";
        d.line = ln;
        emit("debug.state", snap());
        return;
      }
    }
    d.state = "ended";
    emit("debug.output", { id: d.id, category: "console", text: "[debug] 脚本已结束\n" });
    emit("debug.state", snap());
  };
  const live = (p: Record<string, unknown>) => {
    if (!dbg || dbg.id !== p.id || dbg.state === "ended") throw { code: "debug.no_session", message: "no active debug session on this device" };
    return dbg;
  };
  let configuredAdb: string | null = null;
  let autoReconnect = true;
  const secrets = new Map<string, string>();
  const transport = new MemoryTransport(
    {
      "app.ping": (p) => ({ pong: p.echo, version: "demo", python: "-", platform: "browser" }),
      "app.hello": () => ({ version: "demo", platform: "browser", adbPath: configuredAdb, methods: [] }),
      "app.settings.get": () => ({ adbPath: configuredAdb, autoReconnect }),
      "app.settings.set": (p) => {
        if ("adbPath" in p) configuredAdb = String(p.adbPath ?? "").trim() || null;
        if ("autoReconnect" in p) autoReconnect = Boolean(p.autoReconnect);
        return { adbPath: configuredAdb, autoReconnect };
      },
      "device.adb.list": () => ({
        adbPath: configuredAdb || "/demo/adb",
        devices: [{ serial: "emulator-5554", state: "device", model: "sdk_gphone64_arm64", product: "", device: "", transportId: "1", isEmulator: true }],
      }),
      "device.connect": (p) => {
        const serial = String(p.serial ?? p.address);
        const d: Device = {
          id: `${p.transport}:${serial}`, transport: p.transport as "adb" | "lan", address: "127.0.0.1:41000", serial: p.transport === "adb" ? serial : "",
          forwardPort: 41000, state: "online", error: "", warning: p.transport === "lan" ? "demo warning" : "", lastSeen: Date.now() / 1000,
          // like Python: a device's first connect opts it into auto-reconnect while the global switch is on (§14.5)
          saved: true, name: "", group: "", note: "", autoConnect: devices.get(`${p.transport}:${serial}`)?.autoConnect ?? autoReconnect, sortOrder: 0,
          info: { name: status.name, model: status.model, brand: status.brand, android: status.release, sdk: status.sdk, width: status.width, height: status.height,
            density: status.density, ip: status.ip, port: 9860, version: status.version, deviceId: status.device_id, appId: status.app_id, running: false,
            project: "", accessibility: false, root: false, capture: false, channel: "none", cloud: "未连接" },
          status,
        };
        devices.set(d.id, d);
        emit("device.state", d);
        return d;
      },
      "device.list": () => ({ devices: [...devices.values()] }),
      "device.refresh": (p) => devices.get(String(p.id)),
      "device.pair": (p) => {
        const d = devices.get(String(p.id));
        if (!d) throw { code: "device.not_found", message: "no such device" };
        if (String(p.code).replace(/[^0-9a-z]/gi, "").length !== 8) throw { code: "device.unpaired", message: "配对码不正确" };
        const paired: Device = { ...d, state: "online", error: "", errorCode: "" };
        devices.set(paired.id, paired);
        return paired;
      },
      "device.disconnect": (p) => {
        const d = devices.get(String(p.id));
        if (!d || d.state !== "online") return { removed: false };
        const offline: Device = { ...d, state: "offline", forwardPort: 0, saved: true };
        devices.set(d.id, offline);
        return { removed: true, device: offline };
      },
      "device.forget": (p) => {
        const forgotten = devices.delete(String(p.id));
        if (forgotten) emit("device.removed", { id: String(p.id) });
        return { forgotten };
      },
      "device.update": (p) => {
        const d = devices.get(String(p.id));
        if (!d) throw { code: "db.not_found", message: "没有这台已保存设备" };
        const next: Device = {
          ...d,
          name: p.name !== undefined ? String(p.name) : d.name,
          group: p.group !== undefined ? String(p.group) : d.group,
          note: p.note !== undefined ? String(p.note) : d.note,
          autoConnect: p.autoConnect !== undefined ? Boolean(p.autoConnect) : d.autoConnect,
          saved: true,
          info: { ...d.info, name: p.name !== undefined && String(p.name) ? String(p.name) : d.info.name },
        };
        devices.set(d.id, next);
        emit("device.state", next);
        return next;
      },
      "device.scan": (p) => {
        if (p.scanId) emit("device.scan.progress", { scanId: p.scanId, done: 1, total: 1 });
        return { found: [], cancelled: false, total: 1 };
      },
      "device.scan.cancel": () => ({ cancelled: false }),
      "project.list": () => ({ projects: [...projects.keys()].map((name) => ({ name })) }),
      "project.create": (p) => {
        const name = String(p.project);
        if (projects.has(name)) throw { code: "device.http", message: "工程已存在: " + name };
        projects.set(name, new Map([["__init__.py", "print('hello')\n"]]));
        return { ok: true };
      },
      "project.files": (p) => {
        const m = proj(p);
        return { project: p.project, files: [...m.entries()].sort().map(([path, c]) => ({ path, size: c.length })), dirs: [] };
      },
      "project.read": (p) => {
        const c = proj(p).get(String(p.path));
        if (c === undefined) throw { code: "device.http", message: "missing file" };
        return { path: p.path, encoding: "utf-8", content: c };
      },
      "project.write": (p) => {
        proj(p).set(String(p.path), String(p.content));
        return { ok: true };
      },
      "project.deleteFile": (p) => {
        if (p.path === "__init__.py") throw { code: "device.http", message: "entry point cannot be deleted" };
        if (!proj(p).delete(String(p.path))) throw { code: "device.http", message: "missing file" };
        return { ok: true };
      },
      "project.move": (p) => {
        const m = proj(p);
        const c = m.get(String(p.from));
        if (c === undefined) throw { code: "device.http", message: "missing file" };
        if (m.has(String(p.to))) throw { code: "device.http", message: "target exists" };
        m.delete(String(p.from));
        m.set(String(p.to), c);
        return { ok: true, from: p.from, to: p.to };
      },
      "project.run": (p) => {
        if (running) return { error: "already running", project: running };
        proj(p);
        running = String(p.project);
        log(`[demo] running ${running}\n`);
        return { ok: true, running: true, project: running };
      },
      "project.stop": () => {
        if (running) log(`[demo] stopped ${running}\n`);
        running = "";
        return { ok: true, running: false };
      },
      "device.logs": (p) => {
        const since = Number(p.since ?? 0);
        const entries = logs.filter((e) => e.seq > since);
        return { entries, next: logs.length ? logs[logs.length - 1].seq : since };
      },
      "device.action": () => ({ ok: true }),
      "device.eval": (p) => {
        const code = String(p.code ?? "");
        if (code.includes("raise")) return { ok: false, result: "", error: "demo: raised" };
        return { ok: true, result: "None", error: "" };
      },
      "debug.start": (p) => {
        if (dbg && dbg.state !== "ended") throw { code: "debug.already", message: "a debug session is already active on this device" };
        proj(p);
        dbg = { id: String(p.id), project: String(p.project), state: "running", line: 0, bps: new Map(Object.entries((p.breakpoints ?? {}) as Record<string, unknown>).map(([k, v]) => [k, specs(v)])), hits: new Map() };
        emit("debug.output", { id: dbg.id, category: "console", text: `[demo] debugging ${dbg.project}\n` });
        const s = snap();
        setTimeout(() => advance(1, false), 20);
        return s;
      },
      "debug.status": (p) => (dbg && dbg.id === p.id ? snap() : { id: p.id, state: "idle", frames: [] }),
      "debug.setBreakpoints": (p) => {
        const lines = specs(p.lines);
        if (dbg) dbg.bps.set(String(p.path), lines);
        return { breakpoints: lines.map((b) => ({ line: b.line, verified: true })) };
      },
      "debug.step": (p) => {
        const d = live(p);
        if (p.command === "pause") return { ok: true };
        if (d.state !== "stopped") throw { code: "debug.not_stopped", message: "the script is not paused" };
        d.state = "running";
        emit("debug.state", snap());
        setTimeout(() => advance(d.line + 1, p.command !== "continue"), 20);
        return { ok: true };
      },
      "debug.scopes": (p) => (live(p), { scopes: [{ name: "Locals", ref: 10, expensive: false }, { name: "Globals", ref: 20, expensive: true }] }),
      "debug.variables": (p) => {
        const d = live(p);
        if (p.ref === 10) return { variables: [{ name: "line", value: String(d.line), type: "int", ref: 0 }, { name: "cfg", value: "{'a': 1}", type: "dict", ref: 11 }] };
        if (p.ref === 11) return { variables: [{ name: "'a'", value: "1", type: "int", ref: 0 }] };
        return { variables: [{ name: "__name__", value: "'__main__'", type: "str", ref: 0 }] };
      },
      "debug.evaluate": (p) => (live(p), { result: `repr(${String(p.expression)})`, type: "str", ref: 0 }),
      "debug.stop": (p) => {
        if (!dbg || dbg.id !== p.id) return { stopped: false };
        if (dbg.state !== "ended") {
          dbg.state = "ended";
          emit("debug.state", { ...snap(), reason: p.terminate === false ? "已分离" : "已停止" });
        }
        return { stopped: true };
      },
      "app.pickDirectory": () => ({ path: "/demo/projects/demo" }),
      "sync.preview": () => ({ upload: ["__init__.py"], skipped: [], bytes: 24 }),
      "sync.upload": () => ({ upload: ["__init__.py"], skipped: [], bytes: 24, uploaded: 1 }),
      "sync.pull": () => ({ added: [], changed: ["__init__.py"], unchanged: [], written: 1 }),
      "mirror.subscribe": (p) => ({
        id: String(p.id), state: "streaming", reason: "", seq: 1, w: 1080, h: 2209,
        viewers: 1, fps: Number(p.fps ?? 12), scale: Number(p.scale ?? 0.5), quality: Number(p.quality ?? 60),
      }),
      "mirror.unsubscribe": () => ({ ok: true, viewers: 0 }),
      "mirror.retry": (p) => ({ id: String(p.id), state: "connecting", reason: "", seq: 1, w: 1080, h: 2209, viewers: 1, fps: 12, scale: 0.5, quality: 60 }),
      "secret.list": () => ({ slots: [...secrets.keys()].map((k) => ({ kind: k.split("\t")[0], name: k.split("\t")[1] })) }),
      "secret.set": (p) => {
        const kind = String(p.kind || "");
        const name = String(p.name || "").trim();
        const value = String(p.value ?? "");
        if (!["env", "backend", "device"].includes(kind) || !name || !value) throw { code: "rpc.bad_params", message: "bad credential" };
        secrets.set(`${kind}\t${name}`, value);
        return { ok: true, kind, name };
      },
      "secret.delete": (p) => ({ deleted: secrets.delete(`${String(p.kind)}\t${String(p.name)}`) }),
      "secret.has": (p) => ({ present: secrets.has(`${String(p.kind)}\t${String(p.name)}`) }),
      ...cloudDemoHandlers(),
      ...updateDemoHandlers(),
      "app.copyText": () => ({ ok: true }),
      "app.setUnsaved": (p) => ({ unsaved: p.unsaved === true }),
      "tools.open": (p) => {
        const page = String(p.page || "home");
        const path = { home: "/tools/", color: "/tools/ui/color.html", label: "/tools/ui/label.html", mirror: "/tools/ui/mirror.html" }[page];
        if (!path) throw { code: "rpc.bad_params", message: "unknown tool page" };
        return { url: `http://127.0.0.1:41000${path}`, page, warning: "" };
      },
      "device.uiTree": (p) => ({
        mode: Number(p.mode ?? 0),
        width: 1080,
        height: 2400,
        roots: [{
          path: "0/0", id: "com.android.settings:id/search", text: "Search", desc: "Search settings",
          type: "android.widget.TextView", rect: { l: 40, t: 80, r: 280, b: 160 }, clickable: true, children: [],
        }],
      }),
      "device.pixel": (p) => ({ color: "#336699", x: p.x, y: p.y }),
      "device.saveScreenshot": () => ({ saved: true, path: "/demo/screen.png", bytes: 8 }),
    },
    30,
  );
  return transport;
}
