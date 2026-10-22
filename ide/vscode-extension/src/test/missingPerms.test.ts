import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { A11Y_CODE, fixDone, missingPerms, missingText, missingWarning, permFix } from "../missingPerms";

test("run reply: missing permissions become a warning, with the accessibility fix only when it is missing", () => {
  assert.deepEqual(missingPerms({ ok: true }), []);
  assert.deepEqual(missingPerms(undefined), []);
  assert.deepEqual(missingPerms({ missing: [{ label: "无障碍", why: "x", where: "__init__.py:4" }, null, { where: "a" }] }), [{ label: "无障碍", where: "__init__.py:4" }]);
  assert.equal(missingWarning([], "zh"), null);
  const list = [{ label: "悬浮窗权限", where: "" }, { label: "无障碍", where: "__init__.py:4" }];
  const zh = missingWarning(list, "zh");
  assert.equal(zh?.text, "XScript：手机上还缺 悬浮窗权限、无障碍（__init__.py:4），相关操作会失败（脚本已启动）。请在手机上的小程序详情页开启。");
  assert.equal(zh?.a11y, true);
  assert.equal(zh?.fix?.label, "无障碍");
  assert.equal(zh?.fix?.button, "打开手机无障碍设置");
  assert.equal(zh?.fix?.code, A11Y_CODE);
  assert.equal(missingWarning(list, "en")?.text, "XScript: the phone is missing Overlay, Accessibility (__init__.py:4); those calls will fail (the script started). Grant it on the project page in the phone app.");
  assert.equal(missingWarning(list, "en")?.fix?.button, "Open Accessibility Settings on Phone");
  assert.equal(A11Y_CODE, "from xscript.android import permission\n_result = permission.request(permission.ACCESSIBILITY_SERVICE, 1)");
});

test("per-permission one-tap fix: the first missing permission with a fix, same codes as the Web IDE", () => {
  const overlay = missingWarning([{ label: "未知", where: "" }, { label: "悬浮窗权限", where: "a.py:2" }], "zh");
  assert.equal(overlay?.a11y, false);
  assert.deepEqual([overlay?.fix?.label, overlay?.fix?.button, overlay?.fix?.code],
    ["悬浮窗权限", "打开手机悬浮窗设置", "from xscript.android import permission\n_result = permission.request(permission.OVERLAY, 1)"]);
  assert.match(permFix("通知使用权", "en")?.code ?? "", /permission\.NOTIFICATION_LISTENER, 1\)$/);
  assert.equal(permFix("通知使用权", "en")?.button, "Open Notification Access on Phone");
  assert.match(permFix("文件访问权限", "zh")?.code ?? "", /permission\.MANAGE_EXTERNAL_STORAGE, 1\)$/);
  const cap = permFix("图色权限（截图）", "en");
  assert.deepEqual([cap?.capture, cap?.code, cap?.button], [true, undefined, "Grant Screen Capture on Phone"]);
  assert.equal(permFix("未知", "zh"), null);
  assert.equal(missingWarning([{ label: "未知", where: "" }], "zh")?.fix, null);
  for (const label of ["无障碍", "悬浮窗权限", "通知使用权", "文件访问权限", "图色权限（截图）"]) {
    for (const lang of ["zh", "en"] as const) {
      const f = permFix(label, lang);
      assert.ok(f && f.button && f.opened && f.where, label + " " + lang);
    }
  }
  // same table as protocol/permission-fix.json (shared with the Web IDE and PyCharm); opened / on carry the "XScript" prefix
  const shared = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../protocol/permission-fix.json"), "utf8")).permissions as
    { label: string; permission?: string; captureRequest?: boolean; zh: Record<string, string>; en: Record<string, string> }[];
  assert.equal(shared.length, 5);
  for (const e of shared) assert.equal(e.zh.name, e.label);
  for (const e of shared) {
    for (const lang of ["zh", "en"] as const) {
      const f = permFix(e.label, lang);
      const prefix = lang === "zh" ? "XScript：" : "XScript: ";
      assert.deepEqual([f?.button, f?.opened, f?.on, f?.where], [e[lang].button, prefix + e[lang].opened, prefix + e[lang].on, e[lang].where], e.label + " " + lang);
      // the permission name in the warning is exactly the shared one (zh: the phone's own label)
      assert.equal(missingWarning([{ label: e.label, where: "" }], lang)?.text, missingText(lang).warn(e[lang].name), e.label + " name " + lang);
    }
    const f = permFix(e.label, "zh");
    if (e.permission) assert.equal(f?.code, "from xscript.android import permission\n_result = permission.request(permission." + e.permission + ", 1)");
    else assert.deepEqual([e.captureRequest, f?.capture, f?.code], [true, true, undefined]);
  }
  // all fixes in order for Next: accessibility first, no repeats, unknown ones dropped
  const all = missingWarning([{ label: "通知使用权", where: "" }, { label: "未知", where: "" }, { label: "无障碍", where: "" }, { label: "通知使用权", where: "" }, { label: "图色权限（截图）", where: "" }], "en");
  assert.deepEqual(all?.fixes.map((f) => f.label), ["无障碍", "通知使用权", "图色权限（截图）"]);
  assert.equal(all?.fix, all?.fixes[0]);
  assert.deepEqual(missingWarning([{ label: "未知", where: "" }], "zh")?.fixes, []);
  const rest = all?.fixes.slice(1) ?? [];
  assert.deepEqual(fixDone("Opened.", rest, "en"), { text: "Opened. 2 more to go: click Next.", next: "Next: Open Notification Access on Phone" });
  assert.deepEqual(fixDone("已打开。", missingWarning([{ label: "文件访问权限", where: "" }], "zh")?.fixes ?? [], "zh"), { text: "已打开。 还有 1 项，点「下一项」继续。", next: "下一项：打开手机文件访问设置" });
  assert.deepEqual(fixDone("Opened.", [], "en"), { text: "Opened.", next: null });
  assert.equal(missingText("zh").failed("timeout", "设置 → 无障碍"), "XScript：打开失败（timeout），请在手机的 设置 → 无障碍 里开启 XScript。");
});
