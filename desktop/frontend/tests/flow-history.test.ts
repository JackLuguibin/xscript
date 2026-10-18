import { describe, expect, it } from "vitest";
import { parse } from "../src/flow/dsl";
import { emptyUndo, mapOffset, pushUndo, redoEdit, textEdit, undoEdit, UNDO_CAP } from "../src/flow/history";
import { layoutFromGraph } from "../src/flow/layout";
import { SAMPLE_FLOW } from "../src/flow/sample";

function snap(label: string) {
  const graph = parse(SAMPLE_FLOW);
  graph.name = label;
  return { graph, text: label, layout: layoutFromGraph(graph) };
}

describe("undo stack", () => {
  it("drops the oldest entry once and still redoes the newest", () => {
    let stack = emptyUndo();
    let drops = 0;
    for (let i = 0; i < UNDO_CAP + 2; i += 1) {
      const result = pushUndo(stack, snap("s" + i));
      stack = result.stack;
      if (result.dropped) drops += 1;
    }
    expect(stack.past).toHaveLength(UNDO_CAP);
    expect(stack.past[0]?.text).toBe("s2");
    expect(drops).toBe(1);
    const undone = undoEdit(stack, snap("now"));
    expect(undone?.snapshot.text).toBe("s" + (UNDO_CAP + 1));
    const redone = undone ? redoEdit(undone.stack, undone.snapshot) : null;
    expect(redone?.snapshot.text).toBe("now");
  });

  it("keeps a caret that sits outside a replacement", () => {
    const edit = textEdit("hello world", "hello there world");
    expect(edit).toEqual({ start: 6, end: 6, text: "there " });
    if (!edit) return;
    expect(mapOffset(0, edit)).toBe(0);
    expect(mapOffset(6, edit)).toBe(6);
    expect(mapOffset(11, edit)).toBe(17);
  });
});
