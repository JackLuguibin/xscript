import type { FlowLayout } from "./layout";
export type AlignMode =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "horizontal"
  | "vertical";
/** Align node origins; measured widths/heights keep opposite edges aligned. */
export function alignNodes(
  layout: FlowLayout,
  ids: readonly string[],
  mode: AlignMode,
  sizes: Record<string, { width: number; height: number }> = {},
): FlowLayout {
  const selected = [...new Set(ids)].filter((id) => layout.nodes[id]);
  if (selected.length < (mode === "horizontal" || mode === "vertical" ? 3 : 2))
    return layout;
  const nodes = { ...layout.nodes };
  const axis =
    mode === "top" || mode === "bottom" || mode === "vertical" ? "y" : "x";
  const dimension = axis === "x" ? "width" : "height";
  const extent = (id: string) => sizes[id]?.[dimension] || 0;
  if (mode === "horizontal" || mode === "vertical") {
    selected.sort((a, b) => nodes[a][axis] - nodes[b][axis]);
    const start = nodes[selected[0]][axis];
    const end = nodes[selected[selected.length - 1]][axis];
    selected.forEach((id, index) => {
      nodes[id] = {
        ...nodes[id],
        [axis]: start + (index * (end - start)) / (selected.length - 1),
      };
    });
  } else {
    const opposite = mode === "right" || mode === "bottom";
    const boundary = opposite
      ? Math.max(...selected.map((id) => nodes[id][axis] + extent(id)))
      : Math.min(...selected.map((id) => nodes[id][axis]));
    for (const id of selected)
      nodes[id] = {
        ...nodes[id],
        [axis]: boundary - (opposite ? extent(id) : 0),
      };
  }
  return { ...layout, nodes };
}
