import { describe, expect, it } from "vitest";
import { FRAGILE_NOTE, flattenTree, hitTest, nodeXPath, pyStr, rectPercent, selectorChain, selectorCode, xpathStr, type UiNode } from "../src/ui-tree";

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

// Settings-style list: every title shares android:id/title; two rows even share their text.
const listRow = (path: string, text: string): UiNode => ({ path, id: "android:id/title", text, type: "android.widget.TextView" });
const listRoots: UiNode[] = [{ path: "0", type: "android.widget.FrameLayout", children: [
  listRow("0/0", "Network & internet"), listRow("0/1", "Apps"), listRow("0/2", "Battery"), listRow("0/3", "Battery"),
  { path: "0/4", id: "android:id/icon", desc: "Wi-Fi" }, { path: "0/5", id: "android:id/icon", desc: "Bluetooth" },
  { path: "0/6", id: "com.demo:id/ok", text: "OK", clickable: true },
] }];
const listAt = (p: string) => listRoots[0].children!.find((n) => n.path === p)!;

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
    // A shared resource id gets text, desc, then path added until only the picked node matches (selector and XPath).
    expect(selectorChain(listAt("0/1"), "node", listRoots)).toBe("node.Selector().id('android:id/title').text('Apps')");
    expect(selectorChain(listAt("0/3"), "node", listRoots)).toBe("node.Selector().id('android:id/title').text('Battery').path('0/3')");
    expect(selectorChain(listAt("0/5"), "node", listRoots)).toBe("node.Selector().id('android:id/icon').desc('Bluetooth')");
    expect(selectorChain(listAt("0/6"), "node", listRoots)).toBe("node.Selector().id('com.demo:id/ok').clickable()");
    expect(selectorCode(listAt("0/1"))).toBe("from xscript.android import node\nnode.Selector().id('android:id/title').find(timeout=5)");
    expect(nodeXPath(listAt("0/1"), listRoots)).toBe('//*[@resource-id="android:id/title"][@text="Apps"]');
    expect(nodeXPath(listAt("0/3"), listRoots)).toBe('//*[@resource-id="android:id/title"][@text="Battery"][@path="0/3"]');
    expect(nodeXPath(listAt("0/6"), listRoots)).toBe('//*[@resource-id="com.demo:id/ok"]');
    // code that only the path can pin says so; a unique id / text does not
    expect(selectorCode(listAt("0/3"), listRoots)).toBe("from xscript.android import node\n" + FRAGILE_NOTE + "node.Selector().id('android:id/title').text('Battery').path('0/3').find(timeout=5)");
    expect(selectorCode(listAt("0/1"), listRoots)).not.toContain("#");
    // a row without id / text: the code names its title as the more stable choice (children first, then parents)
    const rowTree: UiNode[] = [{ path: "0", type: "android.widget.FrameLayout", children: [
      { path: "0/0", type: "android.widget.LinearLayout", clickable: true, children: [{ path: "0/0/0", type: "android.widget.TextView", text: "Display" }] },
      { path: "0/1", id: "com.demo:id/share", type: "android.widget.Button", children: [{ path: "0/1/0", type: "android.widget.ImageView" }] },
    ] }];
    expect(selectorCode(rowTree[0].children![0], rowTree)).toBe("from xscript.android import node\n" + FRAGILE_NOTE + "# 更稳的选择：子节点「Display」\nnode.Selector().type('android.widget.LinearLayout').path('0/0').clickable().find(timeout=5)");
    expect(selectorCode(rowTree[0].children![1].children![0], rowTree)).toContain("# 更稳的选择：父节点「com.demo:id/share」\n");
    expect(selectorCode(listAt("0/3"), listRoots)).not.toContain("更稳的选择");
    // A clock's text changes every minute: never filter on it, pin a shared clock id with the path instead.
    const clock = (path: string): UiNode => ({ path, id: "com.android.systemui:id/clock", text: "1:57", desc: "1:57 AM", type: "android.widget.TextView" });
    const clocks: UiNode[] = [{ path: "0", children: [clock("0/0"), clock("0/1")] }];
    expect(selectorChain(clocks[0].children![1], "node", clocks)).toBe("node.Selector().id('com.android.systemui:id/clock').path('0/1')");
    expect(selectorChain({ path: "0/2", text: "00:12", type: "android.widget.Chronometer" }, "node", clocks)).toBe("node.Selector().type('android.widget.Chronometer').path('0/2')");
  });

  it("maps a rect onto the frame as percentages and flattens with a cap", () => {
    expect(rectPercent(child.rect!, { w: 400, h: 800 })).toEqual({ left: "25%", top: "25%", width: "20%", height: "5%" });
    expect(rectPercent(child.rect!, { w: 0, h: 0 })).toBeNull();
    const flat = flattenTree([parent], 1);
    expect(flat.some((row) => row.truncated)).toBe(true);
  });
});

