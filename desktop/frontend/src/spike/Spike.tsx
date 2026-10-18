import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { gridGraph, handlesCompatible, percentile, type SpikeEdge, type SpikeNode } from "./graph";

interface NodeData extends Record<string, unknown> {
  label: string;
}

function XNode({ data }: NodeProps<Node<NodeData>>) {
  return (
    <div className="xnode" tabIndex={0} aria-label={data.label}>
      <Handle type="target" position={Position.Left} id="exec-in" className="handle exec" />
      <Handle type="target" position={Position.Left} id="data-in" className="handle data" style={{ top: 36 }} />
      <div className="xnode-title">{data.label}</div>
      <Handle type="source" position={Position.Right} id="exec-out" className="handle exec" />
      <Handle type="source" position={Position.Right} id="data-out" className="handle data" style={{ top: 36 }} />
    </div>
  );
}

const NODE_TYPES = { x: XNode };

function toFlow(graph: { nodes: SpikeNode[]; edges: SpikeEdge[] }): { nodes: Node<NodeData>[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, type: "x", position: { x: n.x, y: n.y }, data: { label: n.label } })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
    })),
  };
}

export interface PanSample {
  count: number;
  edges: number;
  firstRenderMs: number;
  p95: number;
  frames: number;
}

interface SpikeApi {
  ready: boolean;
  nodes: () => number;
  edges: () => number;
  attribution: () => string;
  connect: (source: string, sourceHandle: string, target: string, targetHandle: string) => boolean;
  focusLabel: () => string | null;
  measure: (count: number, edges: number) => Promise<PanSample>;
  bridgeEvents: () => number;
}

declare global {
  interface Window {
    __spike?: SpikeApi;
  }
}

function Canvas({ api }: { api: React.MutableRefObject<SpikeApi | null> }) {
  const initial = useMemo(() => toFlow(gridGraph(2, 0)), []);
  const [nodes, setNodes] = useState<Node<NodeData>[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const { setViewport } = useReactFlow();
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  const isValid = useCallback((c: Connection | Edge) => handlesCompatible(c.sourceHandle, c.targetHandle), []);
  const onNodesChange = useCallback<OnNodesChange<Node<NodeData>>>((changes) => {
    setNodes((cur) => applyNodeChanges(changes, cur));
  }, []);

  const connect = useCallback(
    (source: string, sourceHandle: string, target: string, targetHandle: string) => {
      const ok = handlesCompatible(sourceHandle, targetHandle);
      if (!ok) return false;
      setEdges((cur) => [...cur, { id: `c${cur.length}`, source, target, sourceHandle, targetHandle }]);
      return true;
    },
    [],
  );

  const measure = useCallback(
    async (count: number, edgeCount: number): Promise<PanSample> => {
      const graph = toFlow(gridGraph(count, edgeCount));
      const t0 = performance.now();
      setNodes(graph.nodes);
      setEdges(graph.edges);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const firstRenderMs = performance.now() - t0;
      const deltas: number[] = [];
      let last = performance.now();
      const start = last;
      let x = 0;
      await new Promise<void>((resolve) => {
        const step = (now: number) => {
          deltas.push(now - last);
          last = now;
          x -= 12;
          void setViewport({ x, y: 0, zoom: 1 });
          if (now - start < 800) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      return { count, edges: edgeCount, firstRenderMs, p95: percentile(deltas, 95), frames: deltas.length };
    },
    [setViewport],
  );

  useEffect(() => {
    let bridgeEvents = 0;
    const apiObj: SpikeApi = {
      ready: true,
      nodes: () => nodesRef.current.length,
      edges: () => edgesRef.current.length,
      attribution: () => document.querySelector(".react-flow__attribution")?.textContent ?? "",
      connect,
      focusLabel: () => document.activeElement?.getAttribute("aria-label") ?? null,
      measure,
      bridgeEvents: () => bridgeEvents,
    };
    api.current = apiObj;
    window.__spike = apiObj;
    const qt = window.qt?.webChannelTransport;
    const Channel = window.QWebChannel;
    if (qt && Channel) {
      new Channel(qt, (channel) => {
        const xs = channel.objects.xs as { message?: { connect: (cb: (json: string) => void) => void } } | undefined;
        xs?.message?.connect((json) => {
          try {
            const msg = JSON.parse(json) as { event?: boolean; topic?: string };
            if (msg.event && msg.topic === "spike.tick") bridgeEvents += 1;
          } catch {
            /* ignore malformed bridge traffic */
          }
        });
      });
    }
    return () => {
      if (window.__spike === apiObj) delete window.__spike;
    };
  }, [api, connect, measure]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={() => {}}
      onConnect={(c) => {
        if (isValid(c)) connect(c.source, c.sourceHandle ?? "", c.target, c.targetHandle ?? "");
      }}
      isValidConnection={isValid}
      nodeTypes={NODE_TYPES}
      onlyRenderVisibleElements
      fitView
      proOptions={{ hideAttribution: false }}
    >
      <MiniMap />
      <Background />
    </ReactFlow>
  );
}

export function SpikeApp() {
  const api = useRef<SpikeApi | null>(null);
  return (
    <div className="spike">
      <ReactFlowProvider>
        <Canvas api={api} />
      </ReactFlowProvider>
    </div>
  );
}
