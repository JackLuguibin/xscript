import type { Lang } from "./connectCheck";

/** One permission the project's code uses but the phone has not granted: `missing` in the POST /projects/<name>/run reply. */
export interface MissingPerm {
  label: string;
  where: string;
}

/** Same code the Web IDE uses: opens the phone's accessibility settings (nonblocking). */
export const A11Y_CODE = "from xscript.android import permission\n_result = permission.request(permission.ACCESSIBILITY_SERVICE, 1)";

export function missingPerms(reply: Record<string, unknown> | undefined): MissingPerm[] {
  const list = reply && Array.isArray(reply.missing) ? reply.missing : [];
  return list
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({ label: String(m.label ?? ""), where: String(m.where ?? "") }))
    .filter((m) => m.label);
}

const TEXT = {
  zh: {
    warn: (list: string) => "XScript：手机上还缺 " + list + "，相关操作会失败（脚本已启动）。请在手机上的小程序详情页开启。",
    open: "打开手机无障碍设置",
    opened: "XScript：已在手机上打开无障碍设置，开启 XScript 后再运行。",
    on: "XScript：无障碍服务已开启，可以再运行一次。",
    failed: (why: string) => "XScript：打开失败（" + why + "），请在手机的 设置 → 无障碍 里开启 XScript。",
  },
  en: {
    warn: (list: string) => "XScript: the phone is missing " + list + "; those calls will fail (the script started). Grant it on the project page in the phone app.",
    open: "Open Accessibility Settings on Phone",
    opened: "XScript: accessibility settings are open on the phone. Turn on XScript there, then run again.",
    on: "XScript: the accessibility service is on now; run again.",
    failed: (why: string) => "XScript: could not open them (" + why + "). On the phone, go to Settings → Accessibility and turn on XScript.",
  },
};

/** The phone names permissions in Chinese (PermissionNeeds.Kind.label); English names for the English UI. */
const EN_LABEL: Record<string, string> = {
  "无障碍": "Accessibility",
  "图色权限（截图）": "Screen capture",
  "悬浮窗权限": "Overlay",
  "通知使用权": "Notification access",
  "文件访问权限": "File access",
};

/** The warning after a run, and whether to offer the one-tap accessibility fix; null when nothing is missing. */
export function missingWarning(list: MissingPerm[], lang: Lang): { text: string; a11y: boolean } | null {
  if (!list.length) return null;
  const names = list.map((m) => (lang === "en" ? EN_LABEL[m.label] ?? m.label : m.label) + (m.where ? (lang === "zh" ? "（" + m.where + "）" : " (" + m.where + ")") : "")).join(lang === "zh" ? "、" : ", ");
  return { text: TEXT[lang].warn(names), a11y: list.some((m) => m.label === "无障碍") };
}

export function missingText(lang: Lang) {
  return TEXT[lang];
}
