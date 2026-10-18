export type BoxMode = "replace" | "add" | "sub";

/** Box selection. Shift adds to the previous selection. Alt removes the boxed nodes from it. */
export function mergeBoxSelection(base: readonly string[], inside: readonly string[], mode: BoxMode): string[] {
  if (mode === "add") return [...new Set([...base, ...inside])];
  if (mode === "sub") {
    const drop = new Set(inside);
    return base.filter((id) => !drop.has(id));
  }
  return [...inside];
}
