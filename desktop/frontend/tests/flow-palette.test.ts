import { describe, expect, it } from "vitest";
import { parse, printFlow } from "../src/flow/dsl";
import { addUserFunction, dropPalette, paletteTree, rememberTemplate, userFunctions } from "../src/flow/palette";
import { SAMPLE_FLOW } from "../src/flow/sample";
import { builtinSpecs, menuSpecs } from "../src/flow/specs";

describe("component palette", () => {
  it("keeps action nodes in the action family and data nodes in the data family", () => {
    const tree = paletteTree(menuSpecs(), []);
    const action = tree.families.find((family) => family.id === "action");
    const data = tree.families.find((family) => family.id === "data");
    expect(action?.groups.some((group) => group.category === "action" && group.specs.some((spec) => spec.type === "action.sleep"))).toBe(true);
    expect(data?.groups.some((group) => group.category === "math")).toBe(true);
    expect(action?.groups.some((group) => group.category === "math")).toBe(false);
  });

  it("adds a function that round-trips and can be dropped as a call", () => {
    const made = addUserFunction(parse(SAMPLE_FLOW), "greet");
    expect(made).toBeTruthy();
    const text = printFlow(made as NonNullable<typeof made>);
    expect(text).toContain("def greet():");
    const again = parse(text);
    expect(userFunctions(again).map((item) => item.id)).toContain("greet");
    const dropped = dropPalette(again, builtinSpecs(), { kind: "call", type: "greet" });
    expect(dropped).toBeTruthy();
    expect(printFlow(dropped!.graph)).toContain("call greet()");
    expect(addUserFunction(again, "greet")).toBeNull();
    expect(rememberTemplate([{ name: "ping", title: "探测" }], "ping")).toHaveLength(1);
    expect(rememberTemplate([], "ping")[0]).toEqual({ name: "ping", title: "ping" });
  });
});
