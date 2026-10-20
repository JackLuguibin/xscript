import type { CloudDevice, CloudRole, CloudStatus } from "./api";

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

export function cloudDemoHandlers(): Record<string, Handler> {
  let origin = "";
  let role: CloudRole | null = null;
  const fail = (code: string, message: string) => {
    throw { code, message };
  };
  const status = (): CloudStatus =>
    !origin || !role
      ? { state: "not_configured", origin: "" }
      : { state: "connected", origin, account: { username: role === "admin" ? "alice" : role === "operator" ? "olga" : "victor", role, canOperate: role !== "viewer", isAdmin: role === "admin" } };
  const devices = demoCloudDevices();
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
