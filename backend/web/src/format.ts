import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";

dayjs.extend(relativeTime);
dayjs.locale("zh-cn");

export function fmtTime(t?: number | null): string {
  return t ? dayjs.unix(t).format("YYYY-MM-DD HH:mm") : "-";
}

export function fmtAgo(t?: number | null): string {
  return t ? dayjs.unix(t).fromNow() : "-";
}

export function fmtSize(n?: number | null): string {
  if (!n) return "-";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

export function fmtDays(d: number): string {
  if (!d) return "永久";
  if (d < 1) return Math.round(d * 24 * 10) / 10 + " 小时";
  return (Number.isInteger(d) ? d : d.toFixed(1)) + " 天";
}

export function fmtDuration(from?: number | null, to?: number | null): string {
  if (!from) return "-";
  const s = Math.max(0, (to ?? Date.now() / 1000) - from);
  if (s < 60) return Math.round(s) + " 秒";
  if (s < 3600) return Math.floor(s / 60) + " 分 " + Math.round(s % 60) + " 秒";
  return Math.floor(s / 3600) + " 小时 " + Math.round((s % 3600) / 60) + " 分";
}

export function describeTarget(t: string): string {
  if (t === "all") return "全部设备";
  if (t.startsWith("group:")) return "分组 " + t.slice(6);
  if (t.startsWith("app:")) return "应用 " + t.slice(4);
  const n = t.split(",").filter(Boolean).length;
  return n > 1 ? n + " 台设备" : "设备 " + t;
}

export const COMMAND_LABELS: Record<string, string> = {
  app_run: "启动小程序",
  app_stop: "停止",
  screen_shot: "截图",
  device_info: "设备信息",
  device_action: "设备操作",
  app_list: "工程列表",
  message: "发消息",
};

export const ROLE_LABELS: Record<string, string> = { viewer: "只读", operator: "操作员", admin: "管理员", reseller: "代理" };

export function copy(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  // Plain-HTTP fallback (clipboard API needs a secure context).
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}
