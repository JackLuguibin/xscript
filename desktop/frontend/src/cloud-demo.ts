import type { CloudRole, CloudStatus } from "./api";

// Demo admin backend for plain-browser mode (`npm run dev`, screenshots). Same shapes as the Python cloud.* RPCs.
// Any `xsk_…` token works: one containing "view" signs in as a viewer, "op" as an operator, anything else as admin.
type Handler = (p: Record<string, unknown>) => unknown;

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
  return {
    "cloud.status": () => status(),
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
