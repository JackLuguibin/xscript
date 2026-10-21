import type { Lang } from "./connectCheck";

/** Why the phone cannot capture the screen; same rules as the desktop's 截图状态 card and the PyCharm status bar. */
export type CaptureProblem = "lost" | "none" | null;

/** null when capture works or the app is too old to say (no capture_via: then only capture === false counts). */
export function captureProblem(s: Record<string, unknown>): CaptureProblem {
  const via = s.capture_via;
  if (typeof via !== "string") return s.capture === false ? "none" : null;
  if (via) return null;
  return s.capture_lost === true ? "lost" : "none";
}

const TEXT = {
  zh: {
    lost: "截图权限已失效",
    none: "不能截图",
    tipLost: "手机的录屏授权已失效（重启或被系统收回）：投屏、找图找色、OCR 都会找不到。点击处理。",
    tipNone: "手机现在不能截图（没有录屏授权，也没有无障碍 / Root 截图）。点击处理。",
    ask: "要在手机上弹出录屏授权窗口吗？",
    grant: "在手机上授权",
    help: "排查文档",
    requested: "已在手机上弹出录屏授权窗口：请在手机上选「立即开始」（Android 14 起选「整个屏幕」）。没看到窗口时点手机通知栏里的「电脑端请求开启图色权限」。",
    old: "手机上的 XScript 版本较旧，不支持从电脑发起授权。请在手机上打开 XScript 点「图色权限」，或升级手机 App。",
  },
  en: {
    lost: "Screen capture lost",
    none: "Cannot capture",
    tipLost: "The phone lost its screen-recording grant (restart or revoked): mirroring, image/color search and OCR find nothing. Click to fix.",
    tipNone: "The phone cannot capture the screen (no screen-recording grant, no accessibility or root capture). Click to fix.",
    ask: "Show the screen-recording permission prompt on the phone?",
    grant: "Grant on Phone",
    help: "Troubleshooting",
    requested: "The screen-recording prompt is open on the phone: choose Start now there (Entire screen on Android 14+). If it did not appear, tap the XScript notification on the phone.",
    old: "The XScript app on the phone is too old to be asked from here. Open XScript on the phone and tap Screen capture, or update the app.",
  },
};

export function captureText(lang: Lang) {
  return TEXT[lang];
}

/** Status bar suffix and tooltip for a capture problem ("" / undefined when there is none). */
export function captureBadge(p: CaptureProblem, lang: Lang): { suffix: string; tooltip?: string } {
  if (!p) return { suffix: "" };
  const t = TEXT[lang];
  return { suffix: " $(warning) " + (p === "lost" ? t.lost : t.none), tooltip: p === "lost" ? t.tipLost : t.tipNone };
}
