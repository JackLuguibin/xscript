import { describe, expect, it } from "vitest";
import { parse } from "../src/flow/dsl";
import {
  addComment,
  addGroup,
  clampDock,
  clipOffscreen,
  deleteComments,
  deleteGroups,
  deleteReroutes,
  insertReroute,
  layoutFromGraph,
  moveItem,
  nodesInside,
  nudgeSelection,
  pointOf,
  rekeyNode,
  renameComment,
  renameGroup,
  renameNodeTitle,
  retainLayout,
  segmentMidpoint,
  shiftGroup,
  toggleCollapsed,
  visualEdges,
  type FlowLayout,
} from "../src/flow/layout";

const graph = parse(["flow f  # xflow 1", "on start:", '  a: log(message="a")', '  b: log(message="b")', ""].join("\n"));
const edge = graph.edges.find((item) => item.from.startsWith("a."))!;
const key = edge.from + "->" + edge.to;

function base(): FlowLayout {
  return { xflowLayout: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: { a: { x: 0, y: 0 }, b: { x: 320, y: 0 } }, reroutes: [], groups: [], comments: [] };
}

describe("flow layout", () => {
  it("clamps the dock and decides when to clip off-screen nodes", () => {
    expect(clampDock(Number.NaN)).toBe(240);
    expect(clampDock(10)).toBe(120);
    expect(clampDock(999)).toBe(480);
    expect(clampDock(300.4)).toBe(300);
    expect(clipOffscreen(300)).toBe(false);
    expect(clipOffscreen(301)).toBe(true);
  });

  it("keeps dragged places and live reroutes, and places new nodes", () => {
    const placed = layoutFromGraph(graph);
    expect(Object.keys(placed.nodes).sort()).toEqual(expect.arrayContaining(["a", "b"]));
    const prev: FlowLayout = { ...base(), nodes: { a: { x: 5, y: 6 } }, reroutes: [{ id: "r1", at: [1, 1], edge: key }, { id: "r2", at: [1, 1], edge: "gone->x" }] };
    const kept = retainLayout(prev, graph);
    expect(kept.nodes.a).toEqual({ x: 5, y: 6 });
    expect(kept.nodes.b).toBeTruthy();
    expect(kept.reroutes?.map((item) => item.id)).toEqual(["r1"]);
    const bare = retainLayout({ xflowLayout: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: {} }, graph);
    expect(bare.groups).toEqual([]);
    expect(bare.comments).toEqual([]);
  });

  it("renames, rekeys and collapses nodes without losing their place", () => {
    let layout = renameNodeTitle(base(), "a", "打开");
    expect(layout.nodes.a.title).toBe("打开");
    expect(renameNodeTitle(layout, "missing", "x")).toBe(layout);
    expect(renameNodeTitle(layout, "a", null).nodes.a.title).toBeUndefined();
    layout = { ...layout, reroutes: [{ id: "r1", at: [0, 0], edge: "a.then->b.in" }, { id: "r2", at: [0, 0], edge: "start->x" }] };
    const moved = rekeyNode(layout, "a", "open");
    expect(moved.nodes.open).toEqual(layout.nodes.a);
    expect(moved.nodes.a).toBeUndefined();
    expect(moved.reroutes?.[0].edge).toBe("open.then->b.in");
    expect(moved.reroutes?.[1].edge).toBe("start->x");
    expect(rekeyNode(layout, "a", "a")).toBe(layout);
    expect(rekeyNode(layout, "missing", "x").nodes.x).toBeUndefined();
    const folded = toggleCollapsed(layout, ["a", "b", "missing"]);
    expect(folded.nodes.a.collapsed && folded.nodes.b.collapsed).toBe(true);
    expect(folded.nodes.a.title).toBe("打开");
    const opened = toggleCollapsed(folded, ["a", "b"]);
    expect(opened.nodes.a.collapsed).toBeUndefined();
    expect(toggleCollapsed(layout, ["missing"])).toBe(layout);
  });

  it("boxes nodes, moves the box with its members, and renames and deletes it", () => {
    expect(addGroup(base(), ["missing"])).toEqual(base());
    let layout = addGroup(base(), ["a"], "注释", { a: { width: 200, height: 80 } }, ["g1"]);
    const box = layout.groups![0];
    expect(box.id).toBe("g2");
    expect(nodesInside(layout, box)).toEqual(["a"]);
    expect(pointOf(layout, "g2")).toEqual({ x: box.rect[0], y: box.rect[1] });
    layout = nudgeSelection(layout, ["g2", "a"], 16, 0);
    expect(layout.nodes.a.x).toBe(16);
    expect(layout.groups![0].rect[0]).toBe(box.rect[0] + 16);
    expect(shiftGroup(layout, "missing", 0, 0, [])).toBe(layout);
    const same = shiftGroup(layout, "g2", layout.groups![0].rect[0], layout.groups![0].rect[1], ["a"]);
    expect(same.nodes.a.x).toBe(16);
    layout = moveItem(layout, "g2", 0, 0);
    expect(layout.groups![0].rect.slice(0, 2)).toEqual([0, 0]);
    layout = renameGroup(layout, "g2", "登录");
    expect(layout.groups![0].title).toBe("登录");
    expect(deleteGroups(layout, ["g2"]).groups).toEqual([]);
    expect(nudgeSelection(layout, ["a"], 0, 0)).toBe(layout);
  });

  it("adds, moves, renames and deletes point comments", () => {
    let layout = addComment(base(), 10, 20, undefined, ["c1"]);
    expect(layout.comments).toEqual([{ id: "c2", text: "备注", at: [10, 20] }]);
    layout = moveItem(layout, "c2", 30, 40);
    expect(pointOf(layout, "c2")).toEqual({ x: 30, y: 40 });
    layout = nudgeSelection(layout, ["c2", "missing"], 1, 1);
    expect(pointOf(layout, "c2")).toEqual({ x: 31, y: 41 });
    layout = renameComment(layout, "c2", "看这里");
    expect(layout.comments![0].text).toBe("看这里");
    expect(deleteComments(layout, ["c2"]).comments).toEqual([]);
    expect(pointOf(layout, "missing")).toBeNull();
  });

  it("splits an edge through ordered reroutes and finds segment midpoints", () => {
    let layout = insertReroute(base(), key, 100, 0);
    layout = insertReroute(layout, key, 50, 0, 0, ["r2"]);
    expect(layout.reroutes!.map((item) => item.id)).toEqual(["r3", "r1"]);
    layout = moveItem(layout, "r1", 200, 0);
    expect(pointOf(layout, "r1")).toEqual({ x: 200, y: 0 });
    const parts = visualEdges(graph, layout).filter((item) => item.semantic === key);
    expect(parts.map((item) => [item.source, item.target])).toEqual([["a", "r3"], ["r3", "r1"], ["r1", "b"]]);
    expect(parts[1].sourceHandle).toBe("out");
    expect(parts[1].targetHandle).toBe("in");
    expect(segmentMidpoint(layout, graph, key, 0)).toEqual([25, 0]);
    expect(segmentMidpoint(layout, graph, key, 2)).toEqual([260, 0]);
    expect(segmentMidpoint(layout, graph, "no->edge", 0)).toEqual([0, 0]);
    expect(deleteReroutes(layout, ["r3", "r1"]).reroutes).toEqual([]);
    expect(visualEdges(graph, base()).some((item) => item.source === "start")).toBe(false);
  });
});
