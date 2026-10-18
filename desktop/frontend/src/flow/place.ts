import type { FlowGraph } from "./dsl";

const STEPS = new Set(["then", "body", "completed", "else", "joined", "handler"]);

function successors(g: FlowGraph, id: string): string[] {
  const out: string[] = [];
  for (const edge of g.edges) {
    if (!edge.from.startsWith(id + ".")) continue;
    const pin = edge.from.slice(id.length + 1);
    if (!STEPS.has(pin) && !/^b\d+$/.test(pin) && !/^c\d+$/.test(pin)) continue;
    out.push(edge.to.slice(0, edge.to.indexOf(".")));
  }
  return out;
}

const COLUMN = 320;
const ROW = 200;

/** Lay nodes out along the exec chain. A second exec output starts on the next row at the same column, so its wire stays short. */
export function placeNodes(g: FlowGraph): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  const seen = new Set<string>();
  let column = 0;
  const walk = (id: string | undefined, row: number) => {
    let current = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      pos[current] = { x: column * COLUMN, y: row * ROW };
      column += 1;
      const next = successors(g, current);
      if (next.length > 1) {
        const at = column;
        let furthest = column;
        for (let index = 0; index < next.length; index++) {
          column = at;
          walk(next[index], row + index);
          if (column > furthest) furthest = column;
        }
        column = furthest;
        current = undefined;
      } else {
        current = next[0];
      }
    }
  };
  walk(successors(g, "start")[0], 0);
  let extra = 0;
  for (const node of g.nodes) {
    if (node.id === "start" || pos[node.id]) continue;
    pos[node.id] = { x: extra * COLUMN, y: ROW * 3 };
    extra += 1;
  }
  return pos;
}
