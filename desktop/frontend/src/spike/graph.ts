// Pure rules for the React Flow spike (design §14.10). No DOM, no xyflow types.

export interface SpikeNode {
  id: string;
  x: number;
  y: number;
  label: string;
}

export interface SpikeEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
}

/** exec handles only meet exec handles; data handles only meet data handles. */
export function handlesCompatible(sourceHandle: string | null | undefined, targetHandle: string | null | undefined): boolean {
  const kind = (id: string | null | undefined) => (id?.startsWith("exec") ? "exec" : id?.startsWith("data") ? "data" : "");
  const a = kind(sourceHandle);
  const b = kind(targetHandle);
  return a !== "" && a === b;
}

/** Deterministic grid. `edgeCount` edges run from node i to node (i * 7 + 1) mod n, all on the exec handles. */
export function gridGraph(nodeCount: number, edgeCount: number): { nodes: SpikeNode[]; edges: SpikeEdge[] } {
  const n = Math.max(0, Math.floor(nodeCount));
  const nodes: SpikeNode[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: "n" + i, x: (i % 20) * 180, y: Math.floor(i / 20) * 100, label: "节点 " + i });
  }
  const edges: SpikeEdge[] = [];
  const m = n < 2 ? 0 : Math.max(0, Math.floor(edgeCount));
  for (let i = 0; i < m; i++) {
    const source = i % n;
    let target = (i * 7 + 1) % n;
    if (target === source) target = (target + 1) % n;
    edges.push({
      id: "e" + i,
      source: "n" + source,
      target: "n" + target,
      sourceHandle: "exec-out",
      targetHandle: "exec-in",
    });
  }
  return { nodes, edges };
}

export function percentile(samples: readonly number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
