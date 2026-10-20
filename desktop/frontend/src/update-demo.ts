import type { UpdateInfo, UpdateStatus } from "./api";

// Demo auto-update for plain-browser mode (`npm run dev`, screenshots): 0.4.0 → 0.5.0, a download that completes in a
// few status polls, and an install that only reports "installing" (nothing quits). Same shapes as the Python update.* RPCs.
type Handler = (p: Record<string, unknown>) => unknown;

export const DEMO_UPDATE = {
  version: "0.5.0",
  published: "2026-10-20T20:00:00Z",
  notes: { zh: "桌面端：Windows 安装包、自动更新、诊断包。", en: "Desktop: Windows installer, auto-update, diagnostics bundle." },
  newer: true,
  asset: { name: "xscript-desktop-v0.5.0-macos-arm64.dmg", size: 218_000_000, sha256: "9f".repeat(32) },
};

export function updateDemoHandlers(): Record<string, Handler> {
  let s: UpdateStatus = { state: "idle", update: null, error: null, progress: { done: 0, total: 0 } };
  const snap = (): UpdateStatus => JSON.parse(JSON.stringify(s));
  return {
    "update.info": (): UpdateInfo => ({
      version: "0.4.0", platform: "macos-arm64", configured: true, canInstall: true, configError: "",
      feed: "https://github.com/JackLuguibin/xscript/releases/latest/download/desktop-update.json", ...snap(),
    }),
    "update.status": () => {
      if (s.state === "downloading") {
        const done = Math.min(s.progress.total, s.progress.done + s.progress.total / 3);
        s = { ...s, progress: { done, total: s.progress.total }, state: done >= s.progress.total ? "ready" : "downloading" };
      }
      return snap();
    },
    "update.check": () => {
      s = { state: "available", update: DEMO_UPDATE, error: null, progress: { done: 0, total: 0 } };
      return snap();
    },
    "update.download": () => {
      s = { ...s, state: "ready", progress: { done: DEMO_UPDATE.asset.size, total: DEMO_UPDATE.asset.size } };
      return snap();
    },
    "update.install": () => {
      if (s.state !== "ready") throw { code: "update.state", message: "nothing downloaded to install" };
      s = { ...s, state: "installing" };
      return { ...snap(), helperLog: "/demo/updates/update-helper.log" };
    },
  };
}
