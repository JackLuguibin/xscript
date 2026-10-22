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
    failed: (why: string, where: string) => "XScript：打开失败（" + why + "），请在手机的 " + where + " 里开启 XScript。",
  },
  en: {
    warn: (list: string) => "XScript: the phone is missing " + list + "; those calls will fail (the script started). Grant it on the project page in the phone app.",
    failed: (why: string, where: string) => "XScript: could not open it (" + why + "). On the phone, go to " + where + " and turn on XScript.",
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

/** One-tap fix for a missing permission: `code` runs through /eval and opens the phone's settings page (`_result` "1": already
 * granted), or `capture` asks the phone for the screen-capture grant (POST /capture/request). Same table as the Web IDE's. */
export interface PermFix {
  label: string;
  button: string;
  code?: string;
  capture?: boolean;
  opened: string;
  on: string;
  where: string;
}

const req = (key: string) => "from xscript.android import permission\n_result = permission.request(permission." + key + ", 1)";

const FIX: Record<string, { code?: string; capture?: boolean; zh: [string, string, string, string]; en: [string, string, string, string] }> = {
  "无障碍": { code: A11Y_CODE,
    zh: ["打开手机无障碍设置", "XScript：已在手机上打开无障碍设置，开启 XScript 后再运行。", "XScript：无障碍服务已开启，可以再运行一次。", "设置 → 无障碍"],
    en: ["Open Accessibility Settings on Phone", "XScript: accessibility settings are open on the phone. Turn on XScript there, then run again.", "XScript: the accessibility service is on now; run again.", "Settings → Accessibility"] },
  "悬浮窗权限": { code: req("OVERLAY"),
    zh: ["打开手机悬浮窗设置", "XScript：已在手机上打开悬浮窗设置，允许 XScript 后再运行。", "XScript：悬浮窗权限已开启，可以再运行一次。", "设置 → 应用 → XScript → 显示在其他应用的上层"],
    en: ["Open Overlay Settings on Phone", "XScript: overlay settings are open on the phone. Allow XScript there, then run again.", "XScript: the overlay permission is on now; run again.", "Settings → Apps → XScript → Display over other apps"] },
  "通知使用权": { code: req("NOTIFICATION_LISTENER"),
    zh: ["打开手机通知使用权设置", "XScript：已在手机上打开通知使用权设置，允许 XScript 后再运行。", "XScript：通知使用权已开启，可以再运行一次。", "设置 → 通知 → 设备和应用通知"],
    en: ["Open Notification Access on Phone", "XScript: notification access settings are open on the phone. Allow XScript there, then run again.", "XScript: notification access is on now; run again.", "Settings → Notifications → Device & app notifications"] },
  "文件访问权限": { code: req("MANAGE_EXTERNAL_STORAGE"),
    zh: ["打开手机文件访问设置", "XScript：已在手机上打开文件访问设置，允许 XScript 后再运行。", "XScript：文件访问权限已开启，可以再运行一次。", "设置 → 应用 → 特殊应用权限 → 所有文件访问权限"],
    en: ["Open File Access Settings on Phone", "XScript: file access settings are open on the phone. Allow XScript there, then run again.", "XScript: file access is on now; run again.", "Settings → Apps → Special app access → All files access"] },
  "图色权限（截图）": { capture: true,
    zh: ["在手机上授权截图", "XScript：已在手机上弹出截图授权，点「立即开始」后再运行。", "", "手机上的 XScript → 图色权限"],
    en: ["Grant Screen Capture on Phone", "XScript: the screen-capture prompt is up on the phone. Tap Start now, then run again.", "", "XScript app on the phone → Screen capture"] },
};

/** The fix for one permission label, or null when there is none. */
export function permFix(label: string, lang: Lang): PermFix | null {
  const f = FIX[label];
  if (!f) return null;
  const [button, opened, on, where] = f[lang];
  return { label, button, code: f.code, capture: f.capture, opened, on, where };
}

/** The warning after a run and the one-tap fix to offer (accessibility first, else the first one that has a fix); null when nothing is missing. */
export function missingWarning(list: MissingPerm[], lang: Lang): { text: string; a11y: boolean; fix: PermFix | null } | null {
  if (!list.length) return null;
  const names = list.map((m) => (lang === "en" ? EN_LABEL[m.label] ?? m.label : m.label) + (m.where ? (lang === "zh" ? "（" + m.where + "）" : " (" + m.where + ")") : "")).join(lang === "zh" ? "、" : ", ");
  const a11y = list.some((m) => m.label === "无障碍");
  const first = a11y ? "无障碍" : list.find((m) => FIX[m.label])?.label;
  return { text: TEXT[lang].warn(names), a11y, fix: first ? permFix(first, lang) : null };
}

export function missingText(lang: Lang) {
  return TEXT[lang];
}
