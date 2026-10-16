import { describe, expect, it } from "vitest";
import stubs from "../src/generated/stub-completions.json";
import { bindings, complete, StubIndex, type StubData } from "../src/editor/completions";

const index = new StubIndex(stubs as StubData);
const labels = (doc: string, before = doc.split("\n").pop() ?? "") => complete(index, doc, before).map((i) => i.label);

describe("stub completions (generated from ide/python-stubs)", () => {
  it("covers both the xscript and ascript packages", () => {
    expect(index.moduleNames).toContain("xscript.android.action");
    expect(index.moduleNames).toContain("ascript.android");
    expect(index.moduleNames.some((m) => m.split(".").some((p) => p.startsWith("_")))).toBe(false);
  });

  it("completes module paths after import / from", () => {
    const it = complete(index, "import xscript.android.ac", "import xscript.android.ac");
    expect(it.map((i) => i.label)).toContain("xscript.android.action");
    expect(it[0].replace).toBe("xscript.android.ac".length);
    expect(labels("from xscript.andr")).toContain("xscript.android");
  });

  it("completes names after `from m import`, including submodules and re-exports, with signatures", () => {
    const items = complete(index, "from xscript.android.action import cl", "from xscript.android.action import cl");
    const click = items.find((i) => i.label === "click")!;
    expect(click.kind).toBe("function");
    expect(click.detail).toBe("click(x, y=None, dur=20)");
    expect(click.doc).toMatch(/Tap/);
    expect(labels("from xscript.android import ")).toEqual(expect.arrayContaining(["action", "screen", "capture"]));
    expect(labels("from xscript.android.action import click, sw")).toEqual(["swipe"]);
    // `capture` is a re-export: the item shows the real signature
    expect(complete(index, "", "from xscript.android import capt")[0].kind).not.toBe("variable");
  });

  it("completes attributes through the document's imports and aliases", () => {
    const doc = "from xscript.android import action\nimport xscript.android.action as act\nimport xscript\n";
    expect(labels(doc, "action.sw")).toEqual(["swipe"]);
    expect(labels(doc, "    act.long")).toEqual(["long_click"]);
    expect(labels(doc, "xscript.android.")).toContain("action");
    expect(labels(doc, "unknown.")).toEqual([]);
  });

  it("completes class members (methods without self)", () => {
    const doc = "from xscript.android.action import Touch\n";
    const items = complete(index, doc, "Touch.");
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(["down", "move"]));
    expect(items.find((i) => i.label === "down")!.kind).toBe("method");
  });

  it("completes bound names at the start of a word and handles star imports", () => {
    const doc = "from xscript.android.action import *\nimport xscript.android.screen as scr\n";
    expect(labels(doc, "x = sw")).toContain("swipe");
    const s = complete(index, doc, "sc").find((i) => i.label === "scr")!;
    expect(s.kind).toBe("module");
    expect(labels(doc, "1 + ")).toEqual([]);
  });

  it("parses multi-name and parenthesised imports and ignores comments", () => {
    const b = bindings("from xscript.android import (action, screen as s)  # x\nimport xscript.android.node, xscript\n", index);
    expect(b.get("action")).toBe("xscript.android.action");
    expect(b.get("s")).toBe("xscript.android.screen");
    expect(b.get("xscript")).toBe("xscript");
  });

  it("resolve() is bounded and returns null for functions and unknown paths", () => {
    expect(index.resolve("")).toBeNull();
    expect(index.resolve("nope.x")).toBeNull();
    expect(index.resolve("xscript.android.action.click")).toBeNull();
    expect(index.members(null)).toEqual([]);
  });
});
