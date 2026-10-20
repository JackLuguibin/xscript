import type { CloudDevice, CloudLogLine, CloudRole, CloudStatus, CloudTask, CloudVersion } from "./api";

// Demo admin backend for plain-browser mode (`npm run dev`, screenshots). Same shapes as the Python cloud.* RPCs.
// Any `xsk_…` token works: one containing "view" signs in as a viewer, "op" as an operator, anything else as admin.
type Handler = (p: Record<string, unknown>) => unknown;

const MODELS: [string, string][] = [["google", "Pixel 7"], ["xiaomi", "Mi 11"], ["samsung", "SM-A546"], ["oppo", "Reno 8"]];

/** Twelve demo phones in three groups; a few offline, a few running a project. Deterministic for screenshots. */
export function demoCloudDevices(): CloudDevice[] {
  return Array.from({ length: 12 }, (_, i) => {
    const [brand, model] = MODELS[i % MODELS.length];
    const online = i % 5 !== 4;
    const running = online && i % 3 === 0;
    return {
      id: `farm-${String(i + 1).padStart(2, "0")}`,
      brand,
      model,
      app: i < 10 ? "com.xscript.app" : "com.xscript.app.perf",
      group: i < 6 ? "farm-1" : i < 10 ? "farm-2" : "lab",
      note: i === 0 ? "rack A · top" : i === 6 ? "rack B" : "",
      online,
      running,
      project: running ? "daily-signin" : null,
      version: i < 9 ? "0.4.0" : "0.3.9",
      release: String(12 + (i % 3)),
      width: 1080,
      height: 2400,
      last_seen: 1_792_000_000 - i * 3600,
    };
  });
}

export function demoLogs(id: string): CloudLogLine[] {
  if (!id) return [];
  return Array.from({ length: 360 }, (_, i) => ({
    id: i + 1,
    ts: 1_792_000_000_000 + i * 1500,
    stream: i % 9 === 8 ? "stderr" : i % 10 === 0 ? "system" : "stdout",
    line: i % 9 === 8 ? `[${id}] 找不到「签到」按钮，重试 ${(i + 1) / 9}` : i % 10 === 0 ? `[${id}] 工程 daily-signin 启动` : `[${id}] 第 ${i} 步 ok`,
  }));
}

export function cloudDemoHandlers(): Record<string, Handler> {
  let origin = "";
  let role: CloudRole | null = null;
  const fail = (code: string, message: string): never => {
    throw { code, message };
  };
  const status = (): CloudStatus =>
    !origin || !role
      ? { state: "not_configured", origin: "" }
      : { state: "connected", origin, account: { username: role === "admin" ? "alice" : role === "operator" ? "olga" : "victor", role, canOperate: role !== "viewer", isAdmin: role === "admin" } };
  const devices = demoCloudDevices();
  const tasks: CloudTask[] = [
    { id: 1, name: "早班签到", target: "group:farm-1", path: "app_run", project: "daily-signin", daily: "08:30", every: null, enabled: true, lastRun: 1_791_990_000, nextRun: 1_792_076_400, lastResult: null, createdBy: "alice" },
    { id: 2, name: "夜间停止", target: "all", path: "app_stop", project: "", daily: "23:00", every: null, enabled: false, lastRun: null, nextRun: null, lastResult: null, createdBy: "alice" },
  ];
  const scripts = new Map<string, { id: number; versions: CloudVersion[] }>();
  const installOn = (group: string, run: boolean) => {
    const rows = devices.filter((d) => d.online && d.group === group).map((d) => ({ id: d.id, ok: true, offline: false, msg: run ? "已安装并启动" : "已安装" }));
    return { rows, ok: rows.length, total: rows.length };
  };
  const needConn = () => {
    if (!role) fail("backend.not_configured", "还没有连接后台");
  };
  return {
    "cloud.status": () => status(),
    "cloud.devices": (p) => {
      needConn();
      const q = String(p.q ?? "").toLowerCase();
      const rows = devices.filter(
        (d) =>
          (!q || `${d.id} ${d.model} ${d.brand} ${d.note}`.toLowerCase().includes(q)) &&
          (!p.group || d.group === p.group) &&
          (!p.app || d.app === p.app) &&
          (p.online === undefined || d.online === p.online),
      );
      const page = Number(p.page ?? 1);
      const pageSize = Number(p.pageSize ?? 50);
      return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
    },
    "cloud.command": (p) => {
      needConn();
      if (role === "viewer") fail("backend.forbidden", "当前账号没有权限：权限不足");
      const ids = [...new Set((p.ids as string[]) ?? [])];
      if (!ids.length) fail("backend.bad_request", "先在设备表里勾选设备");
      if (p.action === "run" && !String(p.project ?? "").trim()) fail("backend.bad_request", "填写要运行的工程名");
      const rows = ids.map((id) => {
        const d = devices.find((x) => x.id === id);
        if (!d?.online) return { id, ok: false, offline: true, msg: "离线，未下发" };
        d.running = p.action === "run";
        d.project = d.running ? String(p.project) : null;
        return { id, ok: true, offline: false, msg: p.action === "run" ? "已启动" : "已停止" };
      });
      return { rows, ok: rows.filter((r) => r.ok).length, total: rows.length };
    },
    "cloud.logs": (p) => {
      needConn();
      const q = String(p.q ?? "");
      const rows = demoLogs(String(p.id ?? "")).filter((l) => (!q || l.line.includes(q)) && (!p.stream || l.stream === p.stream) && (!p.before || l.id < Number(p.before)));
      const limit = Number(p.limit ?? 300);
      return { items: rows.slice(-limit), more: rows.length > limit };
    },
    "cloud.tasks": () => (needConn(), { tasks }),
    "cloud.taskCreate": (p) => {
      needConn();
      if (role === "viewer") fail("backend.forbidden", "当前账号没有权限：权限不足");
      const task: CloudTask = {
        id: Math.max(0, ...tasks.map((x) => x.id)) + 1,
        name: String(p.name ?? ""),
        target: String(p.target ?? "all"),
        path: String(p.path),
        project: p.path === "app_run" ? String(p.project ?? "") : "",
        daily: (p.daily as string) || null,
        every: (p.every as number) ?? null,
        enabled: true,
        lastRun: null,
        nextRun: null,
        lastResult: null,
        createdBy: "alice",
      };
      tasks.push(task);
      return task;
    },
    "cloud.taskUpdate": (p) => {
      if (role === "viewer") fail("backend.forbidden", "当前账号没有权限：权限不足");
      const task = tasks.find((x) => x.id === p.id) ?? fail("backend.not_found", "任务不存在");
      if (typeof p.enabled === "boolean") task.enabled = p.enabled;
      return task;
    },
    "cloud.taskRun": (p) => {
      const task = tasks.find((x) => x.id === p.id) ?? fail("backend.not_found", "任务不存在");
      const hit = devices.filter((d) => d.online && (task.target === "all" || task.target === `group:${d.group}` || task.target.split(",").includes(d.id)));
      return { devices: hit.length, ok: hit.length };
    },
    "cloud.taskDelete": (p) => {
      const i = tasks.findIndex((x) => x.id === p.id);
      if (i < 0) fail("backend.not_found", "任务不存在");
      tasks.splice(i, 1);
      return { ok: true };
    },
    "cloud.flowVersions": (p) => {
      needConn();
      const s = scripts.get(String(p.project));
      return s ? { scriptId: s.id, versions: [...s.versions].reverse() } : { scriptId: null, versions: [] };
    },
    "cloud.flowDeploy": (p) => {
      needConn();
      if (role !== "admin") fail("backend.forbidden", "当前账号没有权限：权限不足");
      const project = String(p.project);
      const s = scripts.get(project) ?? { id: scripts.size + 1, versions: [] as CloudVersion[] };
      scripts.set(project, s);
      const version = String(p.version || "") || `1.0.${s.versions.length}`;
      if (s.versions.some((v) => v.version === version)) fail("backend.http", `后台返回 409：版本 ${version} 已存在`);
      const v: CloudVersion = { id: s.id * 100 + s.versions.length + 1, version, code: s.versions.length + 1, notes: String(p.notes ?? ""), createdBy: "alice", createdAt: 1_792_000_000 + s.versions.length * 600, current: false };
      s.versions.push(v);
      return { ...installOn(String(p.group), p.run !== false), scriptId: s.id, versionId: v.id, version };
    },
    "cloud.flowRollback": (p) => {
      needConn();
      if (role !== "admin") fail("backend.forbidden", "当前账号没有权限：权限不足");
      const v = [...scripts.values()].flatMap((s) => s.versions).find((x) => x.id === p.versionId) ?? fail("backend.not_found", "版本不存在");
      return { ...installOn(String(p.group), p.run !== false), scriptId: Number(p.scriptId), versionId: v.id, version: v.version };
    },
    "cloud.groups": () => {
      needConn();
      const names = [...new Set(devices.map((d) => d.group as string))].sort();
      return {
        groups: names.map((name) => ({ name, total: devices.filter((d) => d.group === name).length, online: devices.filter((d) => d.group === name && d.online).length })),
        apps: [...new Set(devices.map((d) => d.app as string))].sort(),
      };
    },
    "cloud.connect": (p) => {
      const o = String(p.origin ?? "").trim().replace(/\/+$/, "").toLowerCase();
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o))
        fail("backend.bad_origin", "backend address must be https, or http on localhost");
      const token = String(p.token ?? "").trim();
      if (!/^xsk_\S+$/.test(token)) fail("backend.unauthorized", "后台令牌无效或已过期");
      origin = o;
      role = token.includes("view") ? "viewer" : token.includes("op") ? "operator" : "admin";
      return status();
    },
    "cloud.disconnect": () => {
      origin = "";
      role = null;
      return status();
    },
  };
}
