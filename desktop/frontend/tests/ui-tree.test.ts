import { describe, expect, it } from "vitest";
import { flattenTree, hitTest, nodeXPath, pyStr, rectPercent, selectorCode, xpathStr, type UiNode } from "../src/ui-tree";

const child: UiNode = {
  path: "0/0/1",
  text: "签到",
  type: "android.widget.Button",
  rect: { l: 100, t: 200, r: 180, b: 240 },
  clickable: true,
  children: [],
};
const parent: UiNode = {
  path: "0/0",
  id: "com.example:id/panel",
  type: "android.widget.FrameLayout",
  rect: { l: 0, t: 0, r: 400, b: 800 },
  children: [child],
};

describe("ui tree", () => {
  it("picks the deepest node that contains the point", () => {
    expect(hitTest([parent], 120, 210)).toBe(child);
    expect(hitTest([parent], 10, 10)?.id).toBe("com.example:id/panel");
    expect(hitTest([parent], 999, 999)).toBeNull();
    expect(hitTest([parent], 180, 210)).toBe(parent); // right edge is exclusive
  });

  it("builds a Selector snippet and an XPath without dropping quotes", () => {
    expect(selectorCode(child)).toBe("from xscript.android import node\nnode.Selector().text('签到').clickable().find(timeout=5)");
    expect(selectorCode(parent)).toContain(".id('com.example:id/panel')");
    expect(nodeXPath(child)).toBe('//Button[@text="签到"]');
    expect(nodeXPath({ id: 'a"b\'c', type: "android.widget.View" })).toContain("concat(");
    expect(pyStr("a'b")).toBe("'a\\'b'");
    expect(xpathStr("a'b")).toBe(`"a'b"`);
  });

  it("maps a rect onto the frame as percentages and flattens with a cap", () => {
    expect(rectPercent(child.rect!, { w: 400, h: 800 })).toEqual({ left: "25%", top: "25%", width: "20%", height: "5%" });
    expect(rectPercent(child.rect!, { w: 0, h: 0 })).toBeNull();
    const flat = flattenTree([parent], 1);
    expect(flat.some((row) => row.truncated)).toBe(true);
  });
});
