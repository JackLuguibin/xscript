import { describe, expect, it } from "vitest";
import { wirePath, wireStroke } from "../src/flow/wire";

describe("wire path", () => {
  it("keeps an adjacent horizontal run on a short tangent", () => {
    expect(wirePath(0, 10, 180, 14, "right", "left")).toBe("M0,10 C32,10 148,14 180,14");
  });

  it("drops beside the source instead of arcing across the row", () => {
    const path = wirePath(0, 20, 800, 200, "right", "left");
    expect(path.includes("C")).toBe(false);
    expect(path).toContain("24,200");
    expect(path.endsWith("L800,200")).toBe(true);
  });

  it("routes a back-edge in a lane clear of the pins", () => {
    const path = wirePath(500, 40, 120, 48, "right", "left");
    expect(path.startsWith("M500,40")).toBe(true);
    expect(path.endsWith("L120,48")).toBe(true);
    expect(path).toContain(",194");
  });

  it("turns a steep drop instead of kinking at the pin", () => {
    const path = wirePath(100, 20, 108, 140, "right", "left");
    expect(path.includes("Q")).toBe(true);
    expect(path.includes("C")).toBe(false);
  });

  it("paints exec wires with the text color and keeps data colors", () => {
    expect(wireStroke("exec")).toBe("var(--text)");
    expect(wireStroke(undefined)).toBe("var(--text)");
    expect(wireStroke("string")).toBe("#d24b9a");
    expect(wireStroke("node", "invalid")).toBe("var(--danger-dot)");
  });
});
