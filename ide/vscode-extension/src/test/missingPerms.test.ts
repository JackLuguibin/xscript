import { test } from "node:test";
import * as assert from "node:assert/strict";
import { A11Y_CODE, missingPerms, missingText, missingWarning } from "../missingPerms";

test("run reply: missing permissions become a warning, with the accessibility fix only when it is missing", () => {
  assert.deepEqual(missingPerms({ ok: true }), []);
  assert.deepEqual(missingPerms(undefined), []);
  assert.deepEqual(missingPerms({ missing: [{ label: "无障碍", why: "x", where: "__init__.py:4" }, null, { where: "a" }] }), [{ label: "无障碍", where: "__init__.py:4" }]);
  assert.equal(missingWarning([], "zh"), null);
  const list = [{ label: "无障碍", where: "__init__.py:4" }, { label: "悬浮窗权限", where: "" }];
  assert.deepEqual(missingWarning(list, "zh"), {
    text: "XScript：手机上还缺 无障碍（__init__.py:4）、悬浮窗权限，相关操作会失败（脚本已启动）。请在手机上的小程序详情页开启。",
    a11y: true,
  });
  assert.equal(missingWarning(list, "en")?.text, "XScript: the phone is missing Accessibility (__init__.py:4), Overlay; those calls will fail (the script started). Grant it on the project page in the phone app.");
  assert.equal(missingWarning([{ label: "悬浮窗权限", where: "" }], "zh")?.a11y, false);
  assert.equal(A11Y_CODE, "from xscript.android import permission\n_result = permission.request(permission.ACCESSIBILITY_SERVICE, 1)");
  assert.equal(missingText("zh").open, "打开手机无障碍设置");
});
