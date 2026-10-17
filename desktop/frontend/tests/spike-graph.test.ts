import { describe, expect, it } from "vitest";
import { gridGraph, handlesCompatible, percentile } from "../src/spike/graph";

describe("react flow spike rules", () => {
  it("only connects an exec pin to an exec pin", () => {
    expect(handlesCompatible("exec-out", "exec-in")).toBe(true);
    expect(handlesCompatible("data-out", "data-in")).toBe(true);
    expect(handlesCompatible("exec-out", "data-in")).toBe(false);
    expect(handlesCompatible(null, "exec-in")).toBe(false);
  });

  it("builds a grid of the requested size without self-edges", () => {
    const g = gridGraph(200, 300);
    expect(g.nodes).toHaveLength(200);
    expect(g.edges).toHaveLength(300);
    expect(g.edges.every((e) => e.source !== e.target && e.sourceHandle === "exec-out")).toBe(true);
    expect(gridGraph(1, 10).edges).toHaveLength(0);
  });

  it("takes a nearest-rank percentile", () => {
    expect(percentile([10, 30, 20], 95)).toBe(30);
    expect(percentile([], 95)).toBe(0);
  });
});
