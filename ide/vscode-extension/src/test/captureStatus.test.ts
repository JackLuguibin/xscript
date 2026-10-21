import { test } from "node:test";
import * as assert from "node:assert/strict";
import { captureBadge, captureProblem, captureText } from "../captureStatus";

test("capture problem follows capture_via / capture_lost; older apps only count capture=false", () => {
  assert.equal(captureProblem({ capture_via: "", capture_lost: true }), "lost");
  assert.equal(captureProblem({ capture_via: "", capture_lost: false }), "none");
  assert.equal(captureProblem({ capture_via: "accessibility", capture_lost: true }), null);
  assert.equal(captureProblem({ capture_via: "projection" }), null);
  assert.equal(captureProblem({ capture: false }), "none");
  assert.equal(captureProblem({ capture: true }), null);
  assert.equal(captureProblem({}), null);
});

test("status bar suffix and tooltip in both languages", () => {
  assert.deepEqual(captureBadge(null, "zh"), { suffix: "" });
  const zh = captureBadge("lost", "zh");
  assert.equal(zh.suffix, " $(warning) 截图权限已失效");
  assert.match(zh.tooltip ?? "", /点击处理/);
  assert.equal(captureBadge("none", "en").suffix, " $(warning) Cannot capture");
  for (const lang of ["zh", "en"] as const) {
    const t = captureText(lang);
    for (const v of Object.values(t)) assert.ok(v.length > 0);
  }
});
