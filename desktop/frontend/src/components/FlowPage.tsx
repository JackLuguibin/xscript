import { Component, createContext, useContext, useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { keepDraft, readDraft } from "../flow/draft";
import { onCanvasPick, takeCanvasPicks } from "../flow/inbox";
import { dropTreeNode, type TreeDrop } from "../flow/tree-drop";
import { IconSidebar } from "./icons";
import { COMPACT_QUERY, focusTargets, inspectorShown, libraryShown, matchesNarrow, NARROW_QUERY, numberIssue, shouldAutoFit, startViewport, overflowEdges, toggleInspector, toggleLibrary, wheelShift, type CanvasFocus, type FieldIssue, type InspectorMode, type LibraryMode } from "../flow/panels";
import { Background, BaseEdge, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, useStore, useUpdateNodeInternals, type ConnectionLineComponentProps, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { CodeEditor } from "./CodeEditor";
import { codePins, createDslSync, danglingEdges, deleteNodes, duplicateNodes, foldGraph, mergeFlow, nodeStatement, applyNodeStatement, parse, printFlow, promoteFunction, renameInput, setCodeIo, setNodeInput, snippetFlow, unfoldGraph, type FlowGraph } from "../flow/dsl";
import { connectPins, connectionHint, diagnose, danglingNodeIds } from "../flow/diagnostics";
import { emptyUndo, pushUndo, redoEdit, undoEdit, type EditorSnapshot, type UndoStack } from "../flow/history";
import { addComment, addGroup, clampDock, clipOffscreen, deleteComments, deleteGroups, deleteReroutes, insertReroute, layoutFromGraph, moveItem, moveNode, nudgeSelection, pointOf, rekeyNode, renameComment, renameGroup, renameNodeTitle, retainLayout, segmentMidpoint, shiftGroup, toggleCollapsed, visualEdges, type FlowLayout } from "../flow/layout";
import { SAMPLE_FLOW } from "../flow/sample";
import { cycleBreakpoint, readBreakpoints, toggleBreakpoints, writeBreakpoints, type FlowBreakpoint } from "../flow/breakpoints";
import { addConnectedNode, findInGraph, jumpTargets, menuTree, searchNodes, specsForSource } from "../flow/search";
import { mergeBoxSelection, type BoxMode } from "../flow/select";
import { enterableScope, scopeNodeIds } from "../flow/scope";
import { dataPinClass, pinColor } from "../flow/pins";
import { wirePath, wireStroke } from "../flow/wire";
import { blame, mapGraph, type FlowSourceMap } from "../flow/map";
import { builtinSpecs, menuSpecs, nodeBadge } from "../flow/specs";
import { isTextEntry } from "../shortcuts";
import { emptyLogCursor, flowEdges, followLogs, LOG_POLL_MS, pictureOf, readTrace, RUN_KEEP_MS, runKept, seqGap, type LogCursor, type NodeRun } from "../flow/trace";
import { buildRun, readRuns, rememberRun, writeRuns, type FlowRun } from "../flow/runs";
import { literalPreview, rememberRuns, stepSnippet } from "../flow/step";
import { deployPlan, pushPlan } from "../flow/deploy";
import { errorLine } from "../errors";
import { drive, traceText, type FlowDebug } from "../flow/session";
import { statementRefs, xflowContext } from "../flow/xflow-language";
import { inspectPins, literalFromField, type InspectPin } from "../flow/inspect";
import { dropVariable, VAR_DRAG, type VarDrag } from "../flow/variables";
import { addUserFunction, dropPalette, NODE_DRAG, readTemplates, rememberTemplate, writeTemplates, type PaletteDrag, type UserTemplate } from "../flow/palette";
import { NodePalette } from "./NodePalette";
import { ServicesContext } from "../app-context";
import { useSharedDevice } from "../device-context";
import { getLanguage, t } from "../strings";
import { VariablePanel } from "./VariablePanel";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";

class CanvasBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return <p role="note">画布在这个环境里没有绘出来。</p>;
    return this.props.children;
  }
}

type PinFace = { name: string; type: string; wired: boolean };

type FlowNodeData = {
  label: string;
  heading?: string;
  customTitle?: string;
  category?: string;
  icon?: string;
  badge?: "partial" | "stub";
  color?: string;
  execIn: PinFace[];
  execOut: PinFace[];
  dataIn: PinFace[];
  dataOut: PinFace[];
  collapsed?: boolean;
  breakpoint?: "on" | "off";
  problem?: boolean;
  fault?: boolean;
  run?: NodeRun;
  reduced?: boolean;
  announce?: string;
  fields?: Array<{ name: string; ui: string; type?: string; value: string | number | boolean | null; min?: number; options?: string[] }>;
} & Record<string, unknown>;

function issueText(issue: FieldIssue): string {
  if (issue.kind === "required") return t.flow.fieldRequired;
  if (issue.kind === "integer") return t.flow.fieldInteger;
  if (issue.kind === "min") return t.flow.fieldMin(issue.min ?? 0);
  return t.flow.fieldNumber;
}

/**
 * A number property with inline validation: the draft is kept while it is not a valid value (empty, not an
 * integer for an int pin, below the pin's minimum) and the reason is shown under the field instead of the
 * keystroke being dropped. Only valid values reach the flow.
 */
function NumberField({ field, caption, label, committed, onChange }: { field: InspectPin; caption: ReactNode; label: string; committed: string; onChange: (value: string | number | boolean) => void }) {
  const [draft, setDraft] = useState(committed);
  const [seen, setSeen] = useState(committed);
  const [issue, setIssue] = useState<FieldIssue | null>(null);
  const hint = useId();
  if (seen !== committed) {
    // Changed from elsewhere (canvas field, text, undo): show the stored value again.
    setSeen(committed);
    setDraft(committed);
    setIssue(null);
  }
  return (
    <label className={issue ? "is-invalid" : undefined}>
      {caption}
      <Input
        aria-label={label}
        type="number"
        min={field.min}
        step={field.type === "int" ? 1 : "any"}
        value={draft}
        aria-invalid={issue ? true : undefined}
        aria-describedby={issue ? hint : undefined}
        onChange={(event) => {
          const raw = event.target.value;
          const next = numberIssue(raw, field.type, field.min);
          setDraft(raw);
          setIssue(next);
          if (next) return;
          const value = literalFromField(field, raw);
          if (value === null) return;
          setSeen(String(value));
          onChange(value);
        }}
      />
      {issue ? (
        <span className="flow-prop-error" id={hint} role="alert">
          {issueText(issue)}
        </span>
      ) : null}
    </label>
  );
}

/** A collapsible inspector section (Figma / Unreal style); the header button carries aria-expanded. */
function InspectGroup({ title, count, open, onToggle, children }: { title: string; count?: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  const body = useId();
  return (
    <section className="flow-group" aria-label={title}>
      <h3 className="flow-group-head">
        <button type="button" className="flow-group-toggle flow-twist" aria-expanded={open} aria-controls={body} onClick={onToggle}>
          <span className="flow-group-title">{title}</span>
          {count !== undefined ? <span className="flow-group-count">{count}</span> : null}
        </button>
      </h3>
      {open ? (
        <div className="flow-group-body" id={body}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

const editPin = createContext<(id: string, pin: string, value: string | number | boolean | null) => void>(() => undefined);
const cycleBp = createContext<(id: string) => void>(() => undefined);

function PropertyField({ field, onChange }: { field: InspectPin; onChange: (value: string | number | boolean) => void }) {
  const label = t.flow.properties + " " + field.name;
  const caption = (
    <span className="flow-prop-name">
      <span>{field.name}</span>
      <span className="flow-prop-type">{field.wired ? t.flow.wired : field.type}</span>
    </span>
  );
  if (field.wired) {
    return (
      <label>
        {caption}
        <Input aria-label={label} readOnly title={t.flow.wired} value={field.wired} />
      </label>
    );
  }
  if (field.ui === "bool") {
    return (
      <label className="flow-prop-bool">
        <input aria-label={label} type="checkbox" checked={field.value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.name}</span>
        <span className="flow-prop-type">{field.type}</span>
      </label>
    );
  }
  if (field.ui === "select" && field.options?.length) {
    const current = String(field.value ?? "");
    const options = field.options.includes(current) || current === "" ? field.options : [current, ...field.options];
    return (
      <label>
        {caption}
        <Select aria-label={label} value={current} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </Select>
      </label>
    );
  }
  const shown = field.value == null ? "" : String(field.value);
  const numeric = field.ui === "number" && (shown === "" || Number.isFinite(Number(shown)));
  if (numeric) return <NumberField field={field} caption={caption} label={label} committed={shown} onChange={onChange} />;
  const kind = field.ui === "color" && /^#[0-9a-fA-F]{6}$/.test(shown) ? "color" : "text";
  return (
    <label>
      {caption}
      <Input
        aria-label={label}
        type={kind}
        min={field.min}
        value={shown}
        onChange={(event) => {
          const next = literalFromField(field, event.target.value);
          if (next === null) return;
          onChange(next);
        }}
      />
    </label>
  );
}

function PinField({ id, field }: { id: string; field: NonNullable<FlowNodeData["fields"]>[number] }) {
  const edit = useContext(editPin);
  const label = id + " " + field.name;
  if (field.ui === "bool") {
    return (
      <label className="xflow-field">
        <span>{field.name}</span>
        <input
          aria-label={label}
          className="nodrag nopan"
          type="checkbox"
          checked={field.value === true}
          onChange={(event) => edit(id, field.name, event.target.checked)}
        />
      </label>
    );
  }
  if (field.ui === "select" && field.options?.length) {
    return (
      <label className="xflow-field">
        <span>{field.name}</span>
        <Select aria-label={label} className="nodrag nopan" value={String(field.value ?? "")} onChange={(event) => edit(id, field.name, event.target.value)}>
          {field.options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </Select>
      </label>
    );
  }
  const kind = field.ui === "number" ? "number" : field.ui === "color" ? "color" : "text";
  return (
    <label className="xflow-field">
      <span>{field.name}</span>
      <input
        aria-label={label}
        className="nodrag nopan"
        type={kind}
        min={field.min}
        value={field.value == null ? "" : String(field.value)}
        onChange={(event) => {
          if (kind === "number") {
            const parsed = field.type === "float" ? Number(event.target.value) : Number.parseInt(event.target.value, 10);
            if (!Number.isFinite(parsed)) return;
            edit(id, field.name, parsed);
            return;
          }
          edit(id, field.name, event.target.value);
        }}
      />
    </label>
  );
}

const renameFlowTitle = createContext<(id: string, title: string | null) => void>(() => undefined);

const CAT_PATH: Record<string, string> = {
  action: "M8 5v14l12-7z",
  flow: "M4 7h6v4H4zM14 13h6v4h-6zM10 9h2a2 2 0 0 1 2 2v2",
  data: "M5 6h14v4H5zM5 10h14v4H5zM5 14h14v4H5z",
  math: "M12 5v14M5 12h14",
  code: "M9 7L4 12l5 5M15 7l5 5-5 5",
  event: "M13 3L5 13h6l-1 8 8-10h-6z",
  sleep: "M12 7v5l3 2M6 12H4M20 12h-2M12 4v2M12 20v-2",
  move: "M4 12h14M14 7l5 5-5 5",
  text: "M5 6h14M5 12h14M5 18h9",
  key: "M8 14a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm4-4h8l-2 2 2 2",
  home: "M4 11l8-7 8 7v9H4z",
  back: "M15 6l-6 6 6 6",
  image: "M4 6h16v12H4zM8 14l3-3 5 5",
  color: "M12 4l6 9H6z",
  shell: "M5 6l6 6-6 6M13 18h6",
  toast: "M5 6h14v9H8l-3 3z",
  app: "M8 3h8v18H8zM11 18h2",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
};

function CatGlyph({ name }: { name: string }) {
  if (name === "find" || name === "search") {
    return (
      <svg className="xflow-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
        <circle cx="10.5" cy="10.5" r="5.5" />
        <path d="M15 15l5 5" />
      </svg>
    );
  }
  return (
    <svg className="xflow-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={CAT_PATH[name] ?? CAT_PATH.flow} />
    </svg>
  );
}
function PinHandle({ pin, kind, side }: { pin: PinFace; kind: "exec" | "data"; side: "in" | "out" }) {
  const wired = pin.wired ? "is-wired" : "is-open";
  return (
    <Handle
      id={pin.name}
      type={side === "in" ? "target" : "source"}
      position={side === "in" ? Position.Left : Position.Right}
      style={{ color: pinColor(kind === "exec" ? "exec" : pin.type) }}
      className={kind === "exec" ? "handle-exec " + wired : dataPinClass(pin.type, pin.wired)}
      aria-label={pin.name + " " + pin.type}
      title={pin.name + " " + pin.type}
    />
  );
}

type PinSlot = { pin: PinFace; kind: "exec" | "data"; caption: string | null };

/** A lone exec/then pin sits on the title row. Named exec pins stay in the body so each name lines up with its arrow. */
function quietExec(pins: PinFace[], outgoing: boolean): boolean {
  if (pins.length !== 1) return false;
  const name = pins[0].name;
  return outgoing ? name === "then" || name === "exec" : name === "exec";
}

function pinSlots(pins: PinFace[], kind: "exec" | "data"): PinSlot[] {
  return pins.map((pin) => ({ pin, kind, caption: kind === "data" || pins.length > 1 ? pin.name : null }));
}

function runWord(status: NodeRun["status"]): string {
  if (status === "queued") return t.flow.runQueued;
  if (status === "running") return t.flow.runRunning;
  if (status === "success") return t.flow.runSuccess;
  if (status === "error") return t.flow.runError;
  if (status === "skipped") return t.flow.runSkipped;
  return t.flow.runPaused;
}

function XFlowNode({ id, data }: NodeProps<Node<FlowNodeData>>) {
  const update = useUpdateNodeInternals();
  const cycle = useContext(cycleBp);
  const rename = useContext(renameFlowTitle);
  useEffect(() => {
    update(id);
  }, [id, data.collapsed, data.fields?.length, update]);
  useEffect(() => {
    if (data.announce) document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)?.setAttribute("aria-label", data.announce);
  }, [id, data.announce]);
  const collapsed = Boolean(data.collapsed);
  const category = data.category || "flow";
  const shown = data.customTitle !== undefined ? data.customTitle : data.heading || data.label;
  const tip = [data.label, data.heading || data.label, category].join(" ");
  const fields = data.fields ?? [];
  const headIn = quietExec(data.execIn, false);
  const headOut = quietExec(data.execOut, true);
  const inputs = [...pinSlots(headIn ? [] : data.execIn, "exec"), ...(collapsed ? [] : pinSlots(data.dataIn, "data"))];
  const outputs = [...pinSlots(headOut ? [] : data.execOut, "exec"), ...(collapsed ? [] : pinSlots(data.dataOut, "data"))];
  const rows = Math.max(inputs.length, outputs.length);
  const marks = Boolean(data.badge || data.run || data.problem || data.fault);
  return (
    <div className={(collapsed ? "xflow-node is-collapsed " : "xflow-node ") + "cat-" + category + (data.run ? " is-run-" + data.run.status : "") + (data.fault ? " is-fault" : "")}>
      <button
        type="button"
        className={data.breakpoint === "off" ? "xflow-bp is-off nodrag nopan" : data.breakpoint === "on" ? "xflow-bp nodrag nopan" : "xflow-bp is-empty nodrag nopan"}
        aria-label={id + " " + t.flow.breakpoint}
        aria-pressed={data.breakpoint === "on"}
        onClick={(event) => {
          event.stopPropagation();
          cycle(id);
        }}
      />
      <div className="xflow-head">
        {headIn ? <PinHandle pin={data.execIn[0]} kind="exec" side="in" /> : null}
        <span className="xflow-glyph">
          <CatGlyph name={data.icon || category} />
        </span>
        <input
          className="xflow-title nodrag nopan"
          aria-label={id + " " + t.flow.displayName}
          title={tip}
          value={shown}
          onChange={(event) => rename(id, event.target.value)}
          onBlur={(event) => {
            if (!event.target.value.trim()) rename(id, null);
          }}
        />
        {marks ? (
          <span className="xflow-marks">
            {data.badge ? <span className={data.badge === "stub" ? "xflow-badge is-stub" : "xflow-badge"}>{data.badge === "partial" ? t.flow.experimental : t.flow.unavailable}</span> : null}
            {data.problem || data.fault ? <span className="xflow-bang" aria-label={id + " " + (data.fault ? t.flow.fault : t.flow.problemMark)}>!</span> : null}
            {data.run ? (
              <span className="xflow-run" aria-label={id + " " + runWord(data.run.status)}>
                {runWord(data.run.status)}
                {data.reduced || data.run.count > 0 ? " " + data.run.count : ""}
              </span>
            ) : null}
          </span>
        ) : null}
        {headOut ? <PinHandle pin={data.execOut[0]} kind="exec" side="out" /> : null}
      </div>
      {rows > 0 ? (
        <div className="xflow-body">
          {Array.from({ length: rows }, (_, index) => {
            const left = inputs[index];
            const right = outputs[index];
            return (
              <div className="xflow-row" key={(left?.pin.name ?? "") + ">" + (right?.pin.name ?? "") + index}>
                {left ? <PinCell id={id} slot={left} side="in" field={left.kind === "data" ? fields.find((field) => field.name === left.pin.name) : undefined} /> : <span className="xflow-pin is-empty" />}
                {right ? <PinCell id={id} slot={right} side="out" /> : <span className="xflow-pin is-empty" />}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function PinCell({ id, slot, side, field }: { id: string; slot: PinSlot; side: "in" | "out"; field?: NonNullable<FlowNodeData["fields"]>[number] }) {
  return (
    <div className={"xflow-pin is-" + side + (slot.kind === "exec" ? " is-exec" : "")}>
      {side === "in" ? <PinHandle pin={slot.pin} kind={slot.kind} side="in" /> : null}
      {field ? <PinField id={id} field={field} /> : slot.caption ? <span className="xflow-pin-name">{slot.caption}</span> : null}
      {side === "out" ? <PinHandle pin={slot.pin} kind={slot.kind} side="out" /> : null}
    </div>
  );
}

function RerouteNode({ id }: NodeProps) {
  return (
    <div className="xflow-reroute">
      <Handle id="in" type="target" position={Position.Left} className="handle-data tone-any is-wired" aria-label={id} style={{ color: pinColor("any") }} />
      <Handle id="out" type="source" position={Position.Right} className="handle-data tone-any is-wired" style={{ color: pinColor("any") }} />
    </div>
  );
}

/**
 * Frames each flow once, when React Flow reports every node measured (useNodesInitialized),
 * then frames `focus` once its nodes are measured.
 */
function AutoFit({ name, focus }: { name: string; focus: CanvasFocus | null }) {
  const ready = useNodesInitialized();
  const { getNodes, getNodesBounds, setViewport, fitView } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const fitted = useRef<string | null>(null);
  const focused = useRef(0);
  useEffect(() => {
    if (!width || !height || !ready) return;
    if (shouldAutoFit(fitted.current, name, ready)) {
      fitted.current = name;
      void setViewport(startViewport(getNodesBounds(getNodes()), width, height));
    }
    const ids = focusTargets(getNodes(), focus, focused.current);
    if (!ids || !focus) return;
    focused.current = focus.key;
    void fitView({ nodes: ids.map((id) => ({ id })), duration: 0, padding: 0.3, maxZoom: 1 });
  }, [name, ready, width, height, focus, getNodes, getNodesBounds, setViewport, fitView]);
  return null;
}

function Remeasure() {
  const update = useUpdateNodeInternals();
  const ids = useStore((state) => state.nodes.map((node) => node.id).join("\n"));
  useEffect(() => {
    for (const id of ids.split("\n")) {
      if (id) update(id);
    }
  }, [ids, update]);
  return null;
}

const renameGroupTitle = createContext<(id: string, title: string) => void>(() => undefined);
const renameNoteText = createContext<(id: string, text: string) => void>(() => undefined);

function NoteNode({ id, data }: NodeProps<Node<FlowNodeData>>) {
  const rename = useContext(renameNoteText);
  return <textarea aria-label={id} className="xflow-note nodrag nopan" value={data.label} onChange={(event) => rename(id, event.target.value)} />;
}

function CommentNode({ id, data }: NodeProps<Node<FlowNodeData>>) {
  const rename = useContext(renameGroupTitle);
  return (
    <div className="xflow-comment" style={{ borderColor: data.color, background: data.color ? data.color + "22" : undefined }}>
      <input aria-label={id} className="nodrag nopan" value={data.label} onChange={(event) => rename(id, event.target.value)} />
    </div>
  );
}

function WireEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, markerStart, interactionWidth }: EdgeProps) {
  return <BaseEdge path={wirePath(sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition)} style={style} markerEnd={markerEnd} markerStart={markerStart} interactionWidth={interactionWidth} />;
}

function WireConnection({ fromX, fromY, toX, toY, fromPosition, toPosition, fromNode, fromHandle, connectionStatus }: ConnectionLineComponentProps) {
  const data = fromNode.data as FlowNodeData;
  const pins = [...(data.execOut ?? []), ...(data.dataOut ?? []), ...(data.execIn ?? []), ...(data.dataIn ?? [])];
  const pin = pins.find((item) => item.name === fromHandle.id);
  return <path d={wirePath(fromX, fromY, toX, toY, fromPosition, toPosition)} fill="none" className="react-flow__connection-path" stroke={wireStroke(pin?.type, connectionStatus)} />;
}

const NODE_TYPES = { flow: XFlowNode, reroute: RerouteNode, comment: CommentNode, note: NoteNode };
const EDGE_TYPES = { wire: WireEdge };

function toCanvas(
  graph: FlowGraph,
  picked: readonly string[],
  layout: FlowLayout,
  specs: Map<string, import("../flow/dsl").NodeSpec>,
  measured: Record<string, { width: number; height: number }>,
  breaks: readonly FlowBreakpoint[],
  scope: string | null,
  run: { nodes: Record<string, NodeRun>; running: string | null } | null,
  reducedMotion: boolean,
  faultId: string | null,
): { nodes: Node<FlowNodeData>[]; edges: { id: string; type: "wire"; source: string; target: string; sourceHandle?: string; targetHandle?: string; className?: string; style: { stroke: string }; data: { semantic: string; segment: number } }[] } {
  const warn = new Set(danglingNodeIds(graph));
  const errorIds = new Set(diagnose(graph, undefined, specs).filter((item) => item.node && (item.severity === "error" || item.code === "W116")).map((item) => item.node as string));
  const visible = new Set(scopeNodeIds(graph, scope));
  const nodes: Node<FlowNodeData>[] = (layout.groups ?? []).map((box) => ({
    id: box.id,
    type: "comment",
    position: { x: box.rect[0], y: box.rect[1] },
    zIndex: -1,
    style: { width: box.rect[2], height: box.rect[3] },
    data: { label: box.title, color: box.color, execIn: [], execOut: [], dataIn: [], dataOut: [] },
    selectable: true,
    selected: picked.includes(box.id),
    measured: measured?.[box.id],
    initialWidth: box.rect[2],
    initialHeight: box.rect[3],
    draggable: true,
  }));
  for (const note of layout.comments ?? []) {
    nodes.push({
      id: note.id,
      type: "note",
      position: { x: note.at[0], y: note.at[1] },
      data: { label: note.text, execIn: [], execOut: [], dataIn: [], dataOut: [] },
      selectable: true,
      selected: picked.includes(note.id),
      measured: measured?.[note.id],
      initialWidth: 144,
      initialHeight: 64,
      draggable: true,
    });
  }
  const dash = flowEdges(run?.running ?? null, graph.nodes.length, reducedMotion);
  for (const node of graph.nodes) {
    if (node.id === "start" || !visible.has(node.id)) continue;
    const spec = specs.get(node.type);
    const mark = breaks.find((item) => item.node === node.id);
    const wiredIn = new Set(graph.edges.filter((edge) => edge.to.startsWith(node.id + ".")).map((edge) => edge.to.slice(node.id.length + 1)));
    const wiredOut = new Set(graph.edges.filter((edge) => edge.from.startsWith(node.id + ".")).map((edge) => edge.from.slice(node.id.length + 1)));
    const status = [
      node.id,
      t.flow.nodeExec + " " + ((spec?.exec.in.length ?? 0) + (spec?.exec.out.length ?? 0)),
      t.flow.nodeData + " " + ((spec?.inputs.length ?? 0) + (spec?.outputs.length ?? 0)),
      layout.nodes[node.id]?.collapsed ? t.flow.statusCollapsed : warn.has(node.id) ? t.flow.statusDangling : t.flow.statusIdle,
    ];
    if (mark) status.push(mark.enabled ? t.flow.breakpointOn : t.flow.breakpointOff);
    const nodeRun = run?.nodes[node.id];
    const declared = node.type === "code.python" ? codePins(node) : { inputs: [], outputs: [] };
    const origin = node.meta?.origin;
    const dataInPins = node.type === "code.python"
      ? (declared.inputs.length ? declared.inputs : (origin?.dataIn ?? []).map((pin) => ({ name: pin.codePin, type: "any" })))
      : (spec?.inputs ?? []).map((pin) => ({ name: pin.name, type: pin.type ?? "any" }));
    const dataOutPins = node.type === "code.python"
      ? (declared.outputs.length ? declared.outputs : (origin?.dataOut ?? []).map((pin) => ({ name: pin.codePin, type: "any" })))
      : (spec?.outputs ?? []).map((pin) => ({ name: pin.name, type: pin.type ?? "any" }));
    const execOutNames = node.type === "code.python" && origin?.execOut.length ? origin.execOut.map((pin) => pin.codePin) : (spec?.exec.out ?? []);
    if (nodeRun) status.push(runWord(nodeRun.status));
    if (node.id === faultId) status.push(t.flow.fault);
    nodes.push({
      id: node.id,
      type: "flow",
      position: layout.nodes[node.id] ?? { x: 0, y: 0 },
      data: {
        label: node.id,
        heading: spec?.title?.[getLanguage()] || spec?.title?.zh || node.id,
        customTitle: layout.nodes[node.id]?.title,
        category: spec?.category,
        icon: spec?.icon,
        badge: nodeBadge(spec?.availability) ?? undefined,
        execIn: (spec?.exec.in ?? []).map((name) => ({ name, type: "exec", wired: wiredIn.has(name) })),
        execOut: execOutNames.map((name) => ({ name, type: "exec", wired: wiredOut.has(name) })),
        dataIn: dataInPins.map((pin) => ({ name: pin.name, type: pin.type ?? "any", wired: wiredIn.has(pin.name) })),
        dataOut: dataOutPins.map((pin) => ({ name: pin.name, type: pin.type ?? "any", wired: wiredOut.has(pin.name) })),
        collapsed: layout.nodes[node.id]?.collapsed === true,
        breakpoint: mark ? (mark.enabled ? "on" : "off") : undefined,
        problem: errorIds.has(node.id),
        fault: node.id === faultId,
        run: nodeRun,
        reduced: reducedMotion,
        announce: status.join("，"),
        fields: (node.type === "code.python"
          ? dataInPins.map((pin) => ({ name: pin.name, type: pin.type, ui: undefined as string | undefined, default: undefined as string | number | boolean | null | undefined, min: undefined as number | undefined, options: undefined as string[] | undefined }))
          : (spec?.inputs ?? []))
          .filter((pin) => !graph.edges.some((edge) => edge.to === node.id + "." + pin.name))
          .map((pin) => ({
            name: pin.name,
            ui: pin.ui ?? (pin.type === "bool" ? "bool" : pin.type === "int" || pin.type === "float" ? "number" : "text"),
            type: pin.type,
            value: node.inputs?.[pin.name] ?? pin.default ?? "",
            min: pin.min,
            options: pin.options,
          })),
      },
      selectable: true,
      selected: picked.includes(node.id),
      measured: measured?.[node.id],
      initialWidth: 200,
      initialHeight: 72,
      style: errorIds.has(node.id) ? { outline: "2px solid #d23b3b" } : warn.has(node.id) ? { outline: "2px solid #e6a700" } : undefined,
    });
  }
  const edges = visualEdges(graph, layout).filter((edge) => {
    const [from, to] = edge.semantic.split("->");
    const source = from.slice(0, from.indexOf("."));
    const target = to.slice(0, to.indexOf("."));
    return visible.has(source) && visible.has(target);
  });
  const shown = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  for (const hop of layout.reroutes ?? []) {
    if (!shown.has(hop.id)) continue;
    nodes.push({
      id: hop.id,
      type: "reroute",
      position: { x: hop.at[0], y: hop.at[1] },
      data: { label: hop.id, execIn: [], execOut: [], dataIn: [], dataOut: [] },
      selectable: true,
      selected: picked.includes(hop.id),
      measured: measured?.[hop.id],
      initialWidth: 16,
      initialHeight: 16,
    });
  }
  return {
    nodes,
    edges: edges.map((edge) => {
      const from = edge.semantic.split("->")[0] ?? "";
      const dot = from.indexOf(".");
      const owner = graph.nodes.find((node) => node.id === from.slice(0, dot));
      const spec = specs.get(owner?.type ?? "");
      const pin = from.slice(dot + 1);
      const kind = spec?.exec.out.includes(pin) || spec?.exec.in.includes(pin) ? "exec" : spec?.outputs.find((item) => item.name === pin)?.type ?? spec?.inputs.find((item) => item.name === pin)?.type;
      const target = edge.target;
      return {
        id: edge.id,
        type: "wire",
        source: edge.source,
        target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        className: dash && kind === "exec" && target === run?.running ? "xflow-edge-flow" : undefined,
        style: { stroke: wireStroke(kind) },
        data: { semantic: edge.semantic, segment: edge.segment },
      };
    }),
  };
}

/** The flow kept from the last visit (its editor text, else its last valid text), or the sample. */
function bootFlow(): { sync: ReturnType<typeof createDslSync>; layout: FlowLayout | null } {
  const kept = readDraft();
  for (const source of kept ? [kept.text, kept.valid] : []) {
    try {
      const sync = createDslSync(parse(source));
      return { sync, layout: kept ? retainLayout(kept.layout, sync.graph) : null };
    } catch {
      // try the last valid text, then the sample
    }
  }
  return { sync: createDslSync(parse(SAMPLE_FLOW)), layout: null };
}

export function FlowPage({ initialLayout }: { initialLayout?: FlowLayout } = {}) {
  const services = useContext(ServicesContext);
  const specs = useMemo(() => builtinSpecs(), []);
  const [follow, setFollow] = useState(false);
  // In the shell the flow page follows the top-bar current device; rendered on its own it picks the first online one.
  const shared = useSharedDevice();
  const hasShared = shared !== null;
  const [ownDevId, setDevId] = useState("");
  const devId = shared ? shared.devId : ownDevId;
  const [userLog, setUserLog] = useState<string[]>([]);
  const [cache, setCache] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState<FlowRun[]>(() => readRuns());
  const cacheEdited = useRef(new Set<string>());
  const logCursor = useRef<LogCursor>(emptyLogCursor());
  const [boot] = useState(bootFlow);
  const sync = useRef(boot.sync);
  const [text, setText] = useState(sync.current.text);
  const [graph, setGraph] = useState<FlowGraph>(sync.current.graph);
  const [picked, setPicked] = useState<string[]>([]);
  const [focus, setFocus] = useState<CanvasFocus | null>(null);
  const [note, setNote] = useState("");
  const [parseError, setParseError] = useState("");
  const [layout, setLayout] = useState<FlowLayout>(() => initialLayout ?? boot.layout ?? layoutFromGraph(sync.current.graph));
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const [openCats, setOpenCats] = useState<string[]>([]);
  const [finder, setFinder] = useState<{ query: string; at: number } | null>(null);
  const [jump, setJump] = useState(false);
  const [fileText, setFileText] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [templates, setTemplates] = useState<UserTemplate[]>(() => readTemplates());
  const [link, setLink] = useState<{ from: string; pin: string } | null>(null);
  const entries = useMemo(() => menuSpecs(), []);
  const [stack, setStack] = useState<UndoStack>(() => emptyUndo());
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [breaks, setBreaks] = useState<FlowBreakpoint[]>(() => readBreakpoints(sync.current.graph.name));
  const [hint, setHint] = useState("");
  const hintRef = useRef("");
  const [scope, setScope] = useState<string | null>(null);
  const [traceLog, setTraceLog] = useState("");
  const [traceAt, setTraceAt] = useState<number | null>(null);
  const [traceNow, setTraceNow] = useState(() => Date.now());
  const [trial, setTrial] = useState<{ code: string; line: string; busy?: boolean } | null>(null);
  const stepTicket = useRef(0);
  const [onDevice, setOnDevice] = useState<{ project: string; devId: string } | null>(null);
  // The map of the traced build last sent to the device. Kept after the run ends (an error usually ends it) and
  // after later edits, because the device keeps running that build until the next deploy.
  const [deployedMap, setDeployedMap] = useState<FlowSourceMap | null>(null);
  const [deploying, setDeploying] = useState(false);
  const sawRunning = useRef(false);
  const [session, setSession] = useState<FlowDebug | null>(null);
  const [library, setLibrary] = useState<LibraryMode>("auto");
  const [inspector, setInspector] = useState<InspectorMode>("auto");
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [compact, setCompact] = useState(() => matchesNarrow(COMPACT_QUERY));
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const [narrow, setNarrow] = useState(matchesNarrow);
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barEdges, setBarEdges] = useState("");
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia(NARROW_QUERY);
    } catch {
      return;
    }
    const onChange = () => setNarrow(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia(COMPACT_QUERY);
    } catch {
      return;
    }
    const onChange = () => setCompact(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => {
      const next = overflowEdges(bar.scrollLeft, bar.clientWidth, bar.scrollWidth);
      setBarEdges((cur) => (cur === next ? cur : next));
    };
    measure();
    bar.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(bar);
    return () => {
      bar.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);
  const [bottomH, setBottomH] = useState(240);
  const [dock, setDock] = useState<"text" | "python" | "breaks" | "trace" | "problems">("text");
  const [lineDraft, setLineDraft] = useState("");
  const [lineEdit, setLineEdit] = useState(false);
  const reducedMotion = useMemo(() => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }, []);
  const traceRead = useMemo(() => readTrace(traceLog), [traceLog]);
  const traceLive = traceAt !== null && runKept(traceAt, traceNow);
  const tracePicture = useMemo(() => (traceLive ? pictureOf(traceRead.events) : null), [traceLive, traceRead]);
  const traceBroken = traceLive && seqGap(traceRead.seqs);
  const mapped = useMemo(() => {
    try {
      return mapGraph(graph, specs);
    } catch {
      return null;
    }
  }, [graph, specs]);
  const problems = useMemo(() => diagnose(graph, parseError, specs), [graph, parseError, specs]);
  // A device traceback is ordinary output, so it lands in the user log, not among the trace lines; read both.
  // A traceback from the deployed build is looked up in its own map, anything else in the editor's.
  const { fault, faultFile } = useMemo(() => {
    const log = userLog.length ? [traceLog, ...userLog].join("\n") : traceLog;
    for (const map of traceLive ? [deployedMap, mapped] : []) {
      const hit = map ? blame(log, map) : null;
      if (hit && map) return { fault: hit, faultFile: map.file };
    }
    return { fault: null, faultFile: "" };
  }, [traceLive, deployedMap, mapped, traceLog, userLog]);
  const canvas = useMemo(
    () => toCanvas(graph, picked, layout, specs, measured, breaks, scope, tracePicture, reducedMotion, fault?.node ?? null),
    [graph, picked, layout, specs, measured, breaks, scope, tracePicture, reducedMotion, fault],
  );
  useEffect(() => {
    if (!services?.inShell) return;
    let stop = false;
    void services.api.listRuns().then((page) => {
      if (!stop && page.runs.length) {
        const rows = page.runs.map((run) => ({
          id: run.id,
          flow: run.flow,
          started_at: run.started_at,
          ended_at: run.ended_at,
          status: run.status === "error" ? "error" as const : "success" as const,
          error_node: run.error_node,
          error_line: run.error_line,
          nodes: run.nodes,
        }));
        setRuns(rows);
        writeRuns(rows);
      }
    }).catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [services]);
  useEffect(() => {
    if (!services || hasShared) return;
    let stop = false;
    void services.api.listDevices().then((page) => {
      if (!stop) setDevId(page.devices.find((item) => item.state === "online")?.id ?? "");
    }).catch(() => undefined);
    const off = services.rpc.on("device.state", () => {
      void services.api.listDevices().then((page) => {
        if (!stop) setDevId(page.devices.find((item) => item.state === "online")?.id ?? "");
      }).catch(() => undefined);
    });
    return () => {
      stop = true;
      off();
    };
  }, [services, hasShared]);

  useEffect(() => {
    if (!follow || !services || !devId) return;
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const page = await services.api.logs(devId, logCursor.current.next ?? 0);
        if (stop) return;
        const next = followLogs(logCursor.current, page);
        logCursor.current = next;
        setTraceLog(next.trace);
        setTraceAt(Date.now());
        setTraceNow(Date.now());
        setUserLog(next.user);
      } catch {
        // The device can drop offline between polls. The next tick tries again.
      }
      if (!stop) timer = window.setTimeout(() => void tick(), LOG_POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [follow, services, devId]);

  const recordRun = () => {
    const events = readTrace(traceLog).events;
    if (!events.length) {
      setNote(t.flow.noTrace);
      return;
    }
    const now = Date.now();
    const next = rememberRun(runs, buildRun(graph.name, events, now, now, now));
    setRuns(next);
    writeRuns(next);
    if (services?.inShell) {
      const saved = next[0];
      if (saved) {
        void services.api.recordRun({
          flow: saved.flow,
          startedAt: saved.started_at,
          endedAt: saved.ended_at,
          status: saved.status,
          errorNode: saved.error_node,
          errorLine: saved.error_line,
          nodes: saved.nodes,
        }).catch(() => undefined);
      }
    }
    setNote("");
  };
  const runOnDevice = async () => {
    if (!services || !devId) {
      setNote(t.flow.noDevice);
      return;
    }
    const plan = deployPlan(graphRef.current, specs, layoutRef.current);
    if (!plan.ok) {
      setNote(plan.reason === "name" ? t.flow.deployBadName(plan.detail) : t.flow.deployCompile(plan.detail));
      return;
    }
    setDeploying(true);
    setNote(t.flow.deploying(plan.project));
    try {
      const pushed = await pushPlan(services.api, devId, plan);
      if (!pushed.ok) {
        setNote(t.flow.deployForeign(plan.project));
        return;
      }
      // Follow from the current end of the device log, so the trace shows this run only.
      const page = await services.api.logs(devId, 0);
      logCursor.current = { ...emptyLogCursor(), next: page.next };
      setTraceLog("");
      setUserLog([]);
      sawRunning.current = false;
      const ran = await services.api.run(devId, plan.project);
      if (ran.error) {
        setNote(t.flow.deployFailed(ran.error));
        return;
      }
      setDeployedMap(plan.map);
      setOnDevice({ project: plan.project, devId });
      setFollow(true);
      setNote(t.flow.deployed(plan.project));
    } catch (err) {
      setNote(t.flow.deployFailed(errorLine(err)));
    } finally {
      setDeploying(false);
    }
  };
  const stopOnDevice = async () => {
    if (!services || !onDevice) return;
    const { project, devId: target } = onDevice;
    try {
      await services.api.stop(target, project);
      setNote(t.flow.deployStopped(project));
    } catch (err) {
      setNote(t.flow.deployFailed(errorLine(err)));
    }
    setOnDevice(null);
  };
  useEffect(() => {
    if (!services || !onDevice) return;
    // The device pushes its status; once the project ran and stopped on its own, the stop button goes away.
    return services.rpc.on("device.state", (data) => {
      const state = data as { id?: string; status?: Record<string, unknown> };
      if (state.id !== onDevice.devId) return;
      if (state.status?.running) {
        sawRunning.current = true;
        return;
      }
      if (sawRunning.current && state.status && state.status.running === false) {
        setOnDevice(null);
        setNote(t.flow.deployEnded(onDevice.project));
      }
    });
  }, [services, onDevice]);
  const armFollow = () => {
    if (!services || !devId) {
      setNote(t.flow.noDevice);
      return;
    }
    setFollow((cur) => {
      if (!cur) logCursor.current = emptyLogCursor();
      return !cur;
    });
  };
  useEffect(() => {
    if (traceAt === null) return;
    const left = traceAt + RUN_KEEP_MS - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => setTraceNow(Date.now()), left);
    return () => window.clearTimeout(timer);
  }, [traceAt]);
  const graphRef = useRef(graph);
  const pickedRef = useRef(picked);
  const textRef = useRef(text);
  const layoutRef = useRef(layout);
  const stackRef = useRef(stack);
  const applyRef = useRef<(next: FlowGraph) => void>(() => undefined);
  const dropRef = useRef<(ids: readonly string[]) => void>(() => undefined);
  const commentRef = useRef<() => void>(() => undefined);
  const noteRef = useRef<() => void>(() => undefined);
  const duplicateRef = useRef<() => void>(() => undefined);
  const collapseRef = useRef<() => void>(() => undefined);
  const nudgeRef = useRef<(dx: number, dy: number) => void>(() => undefined);
  const findRef = useRef<() => void>(() => undefined);
  const jumpRef = useRef<() => void>(() => undefined);
  const fitRef = useRef<(all: boolean) => void>(() => undefined);
  const breakRef = useRef<() => void>(() => undefined);
  const debugRef = useRef<(mode: "run" | "step" | "stop") => void>(() => undefined);
  const sessionRef = useRef<FlowDebug | null>(null);
  const copyRef = useRef<() => void>(() => undefined);
  const cutRef = useRef<() => void>(() => undefined);
  const pasteRef = useRef<() => void>(() => undefined);
  const clipText = useRef("");
  const marquee = useRef<{ base: string[]; mode: BoxMode; inside: Set<string> } | null>(null);
  const undoRef = useRef<() => void>(() => undefined);
  const redoRef = useRef<() => void>(() => undefined);
  graphRef.current = graph;
  pickedRef.current = picked;
  textRef.current = text;
  layoutRef.current = layout;
  stackRef.current = stack;

  const pending = useRef<number | null>(null);
  const lineTimer = useRef<number | null>(null);
  const lineIdRef = useRef<string | null>(null);
  const panePoint = useRef({ x: 48, y: -64 });
  const stamp = useRef(0);
  const lastPane = useRef(0);
  const typing = useRef(false);
  const epoch = useRef(0);
  const dragBefore = useRef<EditorSnapshot | null>(null);
  const dragNodes = useRef<Array<{ id: string; position: { x: number; y: number } }>>([]);
  const dragStop = useRef(false);
  const groupMembers = useRef<Record<string, string[]>>({});
  const nudgeGesture = useRef(false);
  const inputGesture = useRef(false);
  const titleGesture = useRef(false);
  const breaksRef = useRef(breaks);
  breaksRef.current = breaks;
  const flow = useRef<{
    screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number };
    fitView: (options?: { nodes?: Array<{ id: string }>; duration?: number; padding?: number; maxZoom?: number }) => void;
  } | null>(null);

  const checkpoint = () => {
    const result = pushUndo(stackRef.current, {
      graph: graphRef.current,
      text: textRef.current,
      layout: layoutRef.current,
    });
    stackRef.current = result.stack;
    setStack(result.stack);
  };

  const restore = (snap: EditorSnapshot) => {
    if (pending.current) window.clearTimeout(pending.current);
    epoch.current += 1;
    typing.current = false;
    let next = snap.graph;
    let error = "";
    try {
      next = parse(snap.text);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const kept = retainLayout(snap.layout, next);
    sync.current = createDslSync(next);
    graphRef.current = next;
    textRef.current = snap.text;
    layoutRef.current = kept;
    setGraph(next);
    setText(snap.text);
    setLayout(kept);
    setPicked([]);
    setParseError(error);
    setNote(error ? t.flow.parseError : "");
  };

  const currentSnap = (): EditorSnapshot => ({
    graph: graphRef.current,
    text: textRef.current,
    layout: layoutRef.current,
  });

  const undo = () => {
    const result = undoEdit(stackRef.current, currentSnap());
    if (!result) return;
    stackRef.current = result.stack;
    setStack(result.stack);
    restore(result.snapshot);
  };

  const redo = () => {
    const result = redoEdit(stackRef.current, currentSnap());
    if (!result) return;
    stackRef.current = result.stack;
    setStack(result.stack);
    restore(result.snapshot);
  };
  undoRef.current = undo;
  redoRef.current = redo;

  const onText = (next: string) => {
    if (!typing.current) {
      checkpoint();
      typing.current = true;
    }
    textRef.current = next;
    setText(next);
    if (pending.current) window.clearTimeout(pending.current);
    const token = epoch.current;
    pending.current = window.setTimeout(() => {
      if (token !== epoch.current) return;
      const result = sync.current.fromText(next);
      setNote(result.error ? t.flow.parseError : "");
      setParseError(result.error ?? "");
      if (result.applied) {
        typing.current = false;
        graphRef.current = result.graph;
        setGraph(result.graph);
        setLayout((cur) => {
          const kept = retainLayout(cur, result.graph);
          layoutRef.current = kept;
          return kept;
        });
      }
    }, 150);
  };

  const apply = (next: FlowGraph) => {
    checkpoint();
    typing.current = false;
    const printed = sync.current.fromCanvas(next);
    const kept = retainLayout(layoutRef.current, sync.current.graph);
    graphRef.current = sync.current.graph;
    textRef.current = printed.text;
    layoutRef.current = kept;
    setGraph(sync.current.graph);
    setText(printed.text);
    setLayout(kept);
    setPicked([]);
  };
  applyRef.current = apply;

  useEffect(() => {
    keepDraft({ text, valid: sync.current.text, layout });
  }, [text, graph, layout]);

  useEffect(() => {
    const drain = () => {
      const picks = takeCanvasPicks();
      if (!picks.length) return;
      let next = graphRef.current;
      const ids: string[] = [];
      let last: TreeDrop | null = null;
      for (const pick of picks) {
        last = dropTreeNode(next, pick, specs);
        next = last.graph;
        ids.push(...last.ids);
      }
      applyRef.current?.(next);
      setPicked(ids);
      setFocus((prev) => ({ key: (prev?.key ?? 0) + 1, ids }));
      if (last) setNote(last.attached ? t.flow.treeAdded(last.label) : t.flow.treeFloating(last.label));
    };
    drain();
    return onCanvasPick(drain);
    // specs is memoised for the page's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lineId = picked.length === 1 && picked[0] !== "start" && graph.nodes.some((node) => node.id === picked[0]) ? picked[0] : null;
  const lineShown = lineId ? nodeStatement(graph, lineId) : "";
  const jumps = lineShown ? statementRefs(lineShown, graph.nodes.map((node) => node.id)) : [];
  const cacheIds = [...new Set([...Object.keys(cache), ...picked])].filter((id) => graph.nodes.some((node) => node.id === id)).sort();
  lineIdRef.current = lineId;
  useEffect(() => {
    if (!lineEdit) setLineDraft(lineShown);
  }, [lineShown, lineEdit]);

  const commitLine = (id: string, line: string) => {
    if (line.trim() === nodeStatement(graphRef.current, id)) return;
    const next = applyNodeStatement(graphRef.current, id, line);
    if (!next) {
      setNote(t.flow.parseError);
      return;
    }
    const label = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line.trim());
    const newId = label?.[1] && next.nodes.some((node) => node.id === label[1]) ? label[1] : id;
    checkpoint();
    typing.current = false;
    const printed = sync.current.fromCanvas(next);
    let kept = newId === id ? layoutRef.current : rekeyNode(layoutRef.current, id, newId);
    kept = retainLayout(kept, sync.current.graph);
    graphRef.current = sync.current.graph;
    textRef.current = printed.text;
    layoutRef.current = kept;
    setGraph(sync.current.graph);
    setText(printed.text);
    setLayout(kept);
    setPicked([newId]);
    if (newId !== id) {
      const nextBreaks = breaksRef.current.map((item) => (item.node === id ? { ...item, node: newId } : item));
      breaksRef.current = nextBreaks;
      writeBreakpoints(graphRef.current.name, nextBreaks);
      setBreaks(nextBreaks);
    }
    setParseError("");
    setNote("");
  };

  const onLine = (value: string) => {
    setLineDraft(value);
    setLineEdit(true);
    if (lineTimer.current) window.clearTimeout(lineTimer.current);
    const id = lineIdRef.current;
    if (!id) return;
    lineTimer.current = window.setTimeout(() => commitLine(id, value), 150);
  };

  const placeAt = (id: string, x: number, y: number, title?: string) => {
    let placed = moveNode(layoutRef.current, id, Math.round(x / 16) * 16, Math.round(y / 16) * 16);
    if (title) placed = renameNodeTitle(placed, id, title);
    layoutRef.current = placed;
    setLayout(placed);
    setPicked([id]);
  };

  const placeDropped = (id: string, event: DragEvent, title?: string) => {
    const point = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: event.clientX, y: event.clientY };
    placeAt(id, point.x, point.y, title);
  };

  const acceptPalette = (drag: PaletteDrag, x: number, y: number) => {
    const added = dropPalette(graphRef.current, specs, drag);
    if (!added) return false;
    apply(added.graph);
    if (drag.kind === "spec") setRecent((cur) => [drag.type, ...cur.filter((item) => item !== drag.type)].slice(0, 5));
    placeAt(added.id, x, y, added.title);
    return true;
  };

  const pickPalette = (drag: PaletteDrag) => {
    const n = stamp.current;
    stamp.current += 1;
    acceptPalette(drag, 80 + (n % 5) * 48, 72 + (n % 3) * 40);
  };

  const dropVar = (event: DragEvent) => {
    const raw = event.dataTransfer.getData(VAR_DRAG);
    if (!raw) return;
    event.preventDefault();
    const drag = JSON.parse(raw) as VarDrag;
    const added = dropVariable(graphRef.current, drag, event.altKey);
    apply(added.graph);
    placeDropped(added.id, event);
  };

  const dropNode = (event: DragEvent) => {
    const raw = event.dataTransfer.getData(NODE_DRAG);
    if (!raw) return false;
    event.preventDefault();
    const drag = JSON.parse(raw) as PaletteDrag;
    const point = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: event.clientX, y: event.clientY };
    acceptPalette(drag, point.x, point.y);
    return true;
  };

  const makeFunction = (name: string) => {
    const next = addUserFunction(graphRef.current, name);
    if (!next) {
      setNote(t.flow.parseError);
      return;
    }
    apply(next);
    setNote("");
  };

  const makeNode = (name: string) => {
    const next = rememberTemplate(templates, name);
    if (next.length === templates.length) {
      setNote(t.flow.parseError);
      return;
    }
    setTemplates(next);
    writeTemplates(next);
    setNote("");
  };

  const bend = (semantic: string, segment: number) => {
    const [x, y] = segmentMidpoint(layoutRef.current, graphRef.current, semantic, segment);
    checkpoint();
    const next = insertReroute(
      layoutRef.current,
      semantic,
      Math.round(x / 16) * 16,
      Math.round(y / 16) * 16,
      segment,
      graphRef.current.nodes.map((node) => node.id),
    );
    layoutRef.current = next;
    setLayout(next);
  };

  const dropPicked = (ids: readonly string[]) => {
    const hops = new Set((layoutRef.current.reroutes ?? []).map((item) => item.id));
    const boxes = new Set((layoutRef.current.groups ?? []).map((item) => item.id));
    const notes = new Set((layoutRef.current.comments ?? []).map((item) => item.id));
    const points = ids.filter((id) => hops.has(id));
    const groupIds = ids.filter((id) => boxes.has(id));
    const noteIds = ids.filter((id) => notes.has(id));
    const nodes = ids.filter((id) => !hops.has(id) && !boxes.has(id) && !notes.has(id));
    if (!points.length && !groupIds.length && !noteIds.length && !nodes.length) return;
    checkpoint();
    typing.current = false;
    let nextLayout = deleteComments(deleteGroups(deleteReroutes(layoutRef.current, points), groupIds), noteIds);
    if (nodes.length) {
      const printed = sync.current.fromCanvas(deleteNodes(graphRef.current, nodes));
      nextLayout = retainLayout(nextLayout, sync.current.graph);
      graphRef.current = sync.current.graph;
      textRef.current = printed.text;
      setGraph(sync.current.graph);
      setText(printed.text);
    }
    layoutRef.current = nextLayout;
    setLayout(nextLayout);
    setPicked([]);
  };
  dropRef.current = dropPicked;

  const boxSelection = () => {
    const ids = pickedRef.current.filter((id) => layoutRef.current.nodes[id]);
    if (!ids.length) return;
    checkpoint();
    const next = addGroup(layoutRef.current, ids, "注释", measured, graphRef.current.nodes.map((node) => node.id));
    layoutRef.current = next;
    setLayout(next);
  };
  commentRef.current = boxSelection;

  const placeNote = () => {
    checkpoint();
    const point = panePoint.current;
    const next = addComment(
      layoutRef.current,
      Math.round(point.x / 16) * 16,
      Math.round(point.y / 16) * 16,
      "备注",
      graphRef.current.nodes.map((node) => node.id),
    );
    layoutRef.current = next;
    setLayout(next);
  };
  noteRef.current = placeNote;

  const renameNote = (id: string, text: string) => {
    const next = renameComment(layoutRef.current, id, text);
    layoutRef.current = next;
    setLayout(next);
  };

  const retitle = (id: string, title: string | null) => {
    if (title !== null && !titleGesture.current) {
      checkpoint();
      titleGesture.current = true;
    }
    const next = renameNodeTitle(layoutRef.current, id, title);
    layoutRef.current = next;
    setLayout(next);
  };

  const duplicate = () => {
    const ids = pickedRef.current.filter((id) => graphRef.current.nodes.some((node) => node.id === id));
    if (!ids.length) return;
    const copied = duplicateNodes(graphRef.current, ids);
    if (!copied.copies.length) return;
    apply(copied.graph);
    let next = layoutRef.current;
    for (const copy of copied.copies) {
      const pos = next.nodes[copy.from];
      if (pos) next = moveNode(next, copy.id, pos.x + 32, pos.y + 32);
    }
    layoutRef.current = next;
    setLayout(next);
    setPicked(copied.copies.map((copy) => copy.id));
  };
  duplicateRef.current = duplicate;

  const collapseSelection = () => {
    const ids = pickedRef.current.filter((id) => layoutRef.current.nodes[id]);
    if (!ids.length) return;
    checkpoint();
    const next = toggleCollapsed(layoutRef.current, ids);
    layoutRef.current = next;
    setLayout(next);
  };
  collapseRef.current = collapseSelection;

  const nudge = (dx: number, dy: number) => {
    if (!nudgeGesture.current) {
      checkpoint();
      nudgeGesture.current = true;
    }
    const next = nudgeSelection(layoutRef.current, pickedRef.current, dx, dy);
    layoutRef.current = next;
    setLayout(next);
  };
  nudgeRef.current = nudge;

  const reveal = (ids: readonly string[]) => {
    if (!ids.length) return;
    setPicked([...ids]);
    try {
      flow.current?.fitView({ nodes: ids.map((id) => ({ id })), duration: 0, padding: 0.2 });
    } catch {
      // The canvas is absent in some test environments.
    }
  };

  const openFind = () => {
    setMenu(false);
    setJump(false);
    setFinder((cur) => cur ?? { query: "", at: 0 });
    window.setTimeout(() => document.querySelector<HTMLInputElement>(".flow-find input")?.focus(), 0);
  };
  findRef.current = openFind;

  const openJump = () => {
    setMenu(false);
    setFinder(null);
    setJump(true);
  };
  jumpRef.current = openJump;

  const fit = (all: boolean) => {
    const ids = all ? [] : pickedRef.current.filter((id) => graphRef.current.nodes.some((node) => node.id === id));
    try {
      if (ids.length) flow.current?.fitView({ nodes: ids.map((id) => ({ id })), duration: 0, padding: 0.2 });
      else flow.current?.fitView({ duration: 0, padding: 0.2 });
    } catch {
      // The canvas is absent in some test environments.
    }
    setNote(ids.length ? t.flow.fitSelection : t.flow.fitAll);
  };
  fitRef.current = fit;

  const commitBreaks = (next: FlowBreakpoint[]) => {
    breaksRef.current = next;
    writeBreakpoints(graphRef.current.name, next);
    setBreaks(next);
  };
  const togglePickedBreaks = () => {
    const ids = pickedRef.current.filter((id) => graphRef.current.nodes.some((node) => node.id === id));
    if (!ids.length) return;
    commitBreaks(toggleBreakpoints(breaksRef.current, ids));
  };
  breakRef.current = togglePickedBreaks;

  const locate = (id: string) => {
    if (!graphRef.current.nodes.some((node) => node.id === id)) return;
    setPicked([id]);
    setFocusId(id);
    try {
      flow.current?.fitView({ nodes: [{ id }], duration: 0, padding: 0.2 });
    } catch {
      // The canvas is absent in some test environments.
    }
  };
  xflowContext.locate = locate;
  xflowContext.runs = Object.fromEntries(
    Object.entries(tracePicture?.nodes ?? {})
      .filter((entry) => entry[1].summary)
      .map(([id, item]) => [id, item.summary]),
  );
  useEffect(() => {
    setCache((cur) => rememberRuns(cur, cacheEdited.current, xflowContext.runs));
  }, [tracePicture]);

  const editCode = (id: string, field: "inPins" | "outPins" | "source", value: string) => {
    const next = setCodeIo(graphRef.current, id, field, value);
    if (!inputGesture.current) {
      checkpoint();
      inputGesture.current = true;
    }
    const printed = sync.current.fromCanvas(next);
    const kept = retainLayout(layoutRef.current, sync.current.graph);
    graphRef.current = sync.current.graph;
    textRef.current = printed.text;
    layoutRef.current = kept;
    setGraph(sync.current.graph);
    setText(printed.text);
    setLayout(kept);
    setPicked([id]);
  };

  const editInput = (id: string, pin: string, value: string | number | boolean | null) => {
    const current = graphRef.current.nodes.find((node) => node.id === id)?.inputs?.[pin];
    if (current === value) return;
    if (!inputGesture.current) {
      checkpoint();
      inputGesture.current = true;
    }
    typing.current = false;
    const printed = sync.current.fromCanvas(setNodeInput(graphRef.current, id, pin, value));
    const kept = retainLayout(layoutRef.current, sync.current.graph);
    graphRef.current = sync.current.graph;
    textRef.current = printed.text;
    layoutRef.current = kept;
    setGraph(sync.current.graph);
    setText(printed.text);
    setLayout(kept);
  };

  const renameBox = (id: string, title: string) => {
    const next = renameGroup(layoutRef.current, id, title);
    layoutRef.current = next;
    setLayout(next);
  };

  const fold = () => {
    try {
      apply(foldGraph(graph, picked, "box", specs));
      setNote(t.flow.folded);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

  const unfold = () => {
    const result = unfoldGraph(graph, picked[0] ?? "", specs);
    if (!result.ok) {
      setNote(result.reason === "edited" ? t.flow.edited : result.reason);
      return;
    }
    apply(result.graph);
    setNote("");
  };

  const runStep = () => {
    const id = picked.find((item) => graph.nodes.some((node) => node.id === item));
    if (!id) return;
    const outcome = stepSnippet(graph, id, specs, cache);
    if (!outcome.ok) {
      const line = outcome.reason === "refused" ? t.flow.stepRefused : t.flow.stepMissing + " " + (outcome.pin ?? "");
      stepTicket.current += 1;
      setTrial({ code: "", line });
      return;
    }
    if (outcome.where === "device") {
      const ticket = ++stepTicket.current;
      if (!services || !devId) {
        setTrial({ code: outcome.code, line: t.flow.stepDevice + " · " + t.flow.noDevice });
        return;
      }
      setTrial({ code: outcome.code, line: t.flow.stepRunning + " " + devId, busy: true });
      const shown = (line: string) => {
        if (stepTicket.current === ticket) setTrial({ code: outcome.code, line });
      };
      services.api.evalCode(devId, outcome.code, outcome.timeoutMs).then(
        (answer) => {
          if (!answer.ok) {
            shown(t.flow.stepFailed + " " + (answer.error || "?"));
            return;
          }
          shown(t.flow.stepResult + " " + answer.result);
          if (stepTicket.current === ticket) setCache((cur) => (cacheEdited.current.has(id) ? cur : { ...cur, [id]: answer.result }));
        },
        (err: unknown) => shown(t.flow.stepFailed + " " + (err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err))),
      );
      return;
    }
    stepTicket.current += 1;
    const preview = literalPreview(outcome.code);
    setTrial({ code: outcome.code, line: preview === null ? t.flow.stepReady : t.flow.stepResult + " " + preview });
  };

  const applyDebug = (mode: "run" | "step" | "stop") => {
    if (mode === "stop" && sessionRef.current?.status !== "paused") return;
    const next = drive(sessionRef.current, graphRef.current, specs, breaksRef.current, mode);
    sessionRef.current = next;
    setSession(next);
    setTraceLog(traceText(next.events));
    setTraceAt(Date.now());
    setTraceNow(Date.now());
    setUserLog(next.log);
    setCache((cur) => rememberRuns(cur, cacheEdited.current, next.values));
    setDock("trace");
    if (next.at) reveal([next.at]);
  };
  debugRef.current = applyDebug;

  const choose = (type: string) => {
    const added = addConnectedNode(graph, type, specs, link ?? undefined);
    apply(added.graph);
    setRecent((cur) => [type, ...cur.filter((item) => item !== type)].slice(0, 5));
    setMenu(false);
    setQuery("");
    setLink(null);
    setNote("");
  };

  const openMenu = (next?: { from: string; pin: string }) => {
    setLink(next ?? null);
    setQuery("");
    setMenu(true);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const clip = (event.key === "c" || event.key === "C" || event.key === "x" || event.key === "X" || event.key === "v" || event.key === "V") && !event.shiftKey && !isTextEntry(event.target);
      if (mod && !event.altKey && !event.repeat && !event.isComposing) {
        const key = event.key.toLowerCase();
        const overlay = event.target instanceof Element ? event.target.closest("[role=dialog]") : null;
        const foreignDialog = overlay !== null && !overlay.classList.contains("flow-menu");
        if (!foreignDialog && !isTextEntry(event.target) && key === "i" && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          setInspector((cur) => toggleInspector(cur, compactRef.current, pickedRef.current.length > 0));
          return;
        }
        if (!foreignDialog && !isTextEntry(event.target) && key === "b" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          setLibrary((cur) => toggleLibrary(cur, narrowRef.current));
          return;
        }
        if (!foreignDialog && (key === "z" || key === "d" || key === "f" || key === "p" || clip || (key === "y" && !event.shiftKey))) {
          event.preventDefault();
          event.stopPropagation();
          if (key === "c" && clip) copyRef.current();
          else if (key === "x" && clip) cutRef.current();
          else if (key === "v" && clip) pasteRef.current();
          else if (key === "d" && !event.shiftKey) duplicateRef.current();
          else if (key === "f" && !event.shiftKey) findRef.current();
          else if (key === "p" && !event.shiftKey) jumpRef.current();
          else if (key === "z" && event.shiftKey) redoRef.current();
          else if (key === "z") undoRef.current();
          else if (key === "y") redoRef.current();
          return;
        }
      }
      if (event.key === "Alt") {
        setSnap(false);
        return;
      }
      if ((event.key === "F5" || event.key === "F10" || event.key === "F11") && !event.altKey && !event.metaKey && !event.ctrlKey && !event.repeat && !event.isComposing && !isTextEntry(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "F5" && event.shiftKey) debugRef.current("stop");
        else if (event.key === "F5") debugRef.current("run");
        else debugRef.current("step");
        return;
      }
      if (event.key === "F9" && !event.altKey && !event.metaKey && !event.ctrlKey && !event.repeat && !event.isComposing && !isTextEntry(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        breakRef.current();
        return;
      }
      const arrow: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const step = arrow[event.key];
      if (step && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing && !isTextEntry(event.target)) {
        if (event.target instanceof Element && event.target.closest(".flow-menu")) return;
        if (!pickedRef.current.length) return;
        event.preventDefault();
        event.stopPropagation();
        const cells = event.shiftKey ? 5 : 1;
        nudgeRef.current(step[0] * cells * 16, step[1] * cells * 16);
        return;
      }
      if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest(".flow-canvas")) return;
        const ids = graphRef.current.nodes.map((node) => node.id).filter((id) => id !== "start");
        if (!ids.length) return;
        event.preventDefault();
        event.stopPropagation();
        const current = target.closest(".react-flow__node")?.getAttribute("data-id") ?? "";
        const index = ids.indexOf(current);
        const startAt = index < 0 ? (event.shiftKey ? 0 : -1) : index;
        const next = ids[(startAt + (event.shiftKey ? -1 : 1) + ids.length) % ids.length];
        setPicked([next]);
        setFocusId(next);
        return;
      }
      if (event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape" && event.target instanceof Element) {
        const host = event.target.closest(".react-flow__node");
        if (host && event.target !== host && event.target.closest(".xflow-field")) {
          event.preventDefault();
          event.stopPropagation();
          inputGesture.current = false;
          (host as HTMLElement).focus();
          return;
        }
      }
      if (event.key === "Enter" && event.target instanceof Element) {
        const host = event.target.closest(".react-flow__node");
        if (host && event.target === host) {
          const field = host.querySelector<HTMLElement>(".xflow-field input, .xflow-field select");
          if (field) {
            event.preventDefault();
            event.stopPropagation();
            field.focus();
            return;
          }
        }
      }
      if (event.key === "Escape") {
        setMenu(false);
        setFinder(null);
        setJump(false);
        return;
      }
      if ((event.key === "f" || event.key === "F") && !isTextEntry(event.target)) {
        if (event.target instanceof Element && event.target.closest(".flow-menu, .xflow-comment")) return;
        event.preventDefault();
        fitRef.current(event.shiftKey || pickedRef.current.length === 0);
        return;
      }
      if ((event.key === "m" || event.key === "M") && !isTextEntry(event.target)) {
        if (event.target instanceof Element && event.target.closest(".flow-menu, .xflow-comment")) return;
        event.preventDefault();
        collapseRef.current();
        return;
      }
      if ((event.key === "n" || event.key === "N") && !isTextEntry(event.target)) {
        if (event.target instanceof Element && event.target.closest(".flow-menu, .xflow-note")) return;
        event.preventDefault();
        noteRef.current();
        return;
      }
      if ((event.key === "c" || event.key === "C") && !isTextEntry(event.target)) {
        if (event.target instanceof Element && event.target.closest(".flow-menu, .xflow-comment")) return;
        event.preventDefault();
        commentRef.current();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !isTextEntry(event.target)) {
        const ids = pickedRef.current;
        if (!ids.length) return;
        event.preventDefault();
        dropRef.current(ids);
        return;
      }
      if (event.key !== " " || isTextEntry(event.target)) return;
      if (event.target instanceof Element && event.target.closest(".flow-menu, .flow-actions")) return;
      event.preventDefault();
      setLink(null);
      setQuery("");
      setMenu(true);
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") setSnap(true);
      if (event.key.startsWith("Arrow")) nudgeGesture.current = false;
    };
    const onBlur = () => setSnap(true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Element && (event.target.closest(".xflow-field") || event.target.closest(".xflow-title") || event.target.closest(".flow-props"))) {
        inputGesture.current = false;
        titleGesture.current = false;
      }
    };
    window.addEventListener("focusin", onFocus);
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".react-flow__pane")) return;
      if (target.closest(".react-flow__node, .react-flow__edge")) return;
      marquee.current = {
        base: [...pickedRef.current],
        mode: event.altKey ? "sub" : event.shiftKey ? "add" : "replace",
        inside: new Set(),
      };
    };
    const onPointerUp = () => {
      marquee.current = null;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focusin", onFocus);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => {
    if (scope && !graph.nodes.some((node) => node.id === scope && (node.type === "flow.def" || node.type === "flow.macro"))) setScope(null);
  }, [graph, scope]);

  useEffect(() => {
    if (!focusId) return;
    document.querySelector<HTMLElement>(`.react-flow__node[data-id="${focusId}"]`)?.focus();
  }, [focusId]);

  useEffect(() => () => {
    if (pending.current) window.clearTimeout(pending.current);
  }, []);

  const pool = link ? specsForSource(specs.get(graph.nodes.find((node) => node.id === link.from)?.type ?? ""), link.pin, entries) : entries;
  const browsing = query.trim() === "";
  const visible = browsing ? [] : searchNodes(query, pool, recent);
  const tree = browsing ? menuTree(pool, recent) : null;
  const categoryName = (id: string) => (id in t.flow.categories ? t.flow.categories[id as keyof typeof t.flow.categories] : id);

  const paste = async () => {
    let raw = clipText.current;
    try {
      const fromBoard = await navigator.clipboard.readText();
      if (fromBoard.trim()) raw = fromBoard;
    } catch {
      // The page copy is still available when the browser blocks the clipboard.
    }
    if (!raw.trim()) {
      setNote(t.flow.paste);
      return;
    }
    try {
      apply(mergeFlow(graphRef.current, parse(raw)));
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };
  pasteRef.current = () => void paste();

  const copySelection = () => {
    const ids = pickedRef.current.filter((id) => graphRef.current.nodes.some((node) => node.id === id));
    if (!ids.length) return;
    const text = printFlow(snippetFlow(graphRef.current, ids));
    clipText.current = text;
    setNote(text);
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  copyRef.current = copySelection;

  const cutSelection = () => {
    const ids = [...pickedRef.current];
    if (!ids.length) return;
    copySelection();
    dropRef.current(ids);
  };
  cutRef.current = cutSelection;

  const chosen = graph.nodes.find((node) => node.id === picked[0]);
  const inspectorOpen = inspectorShown(inspector, compact, picked.length > 0);
  const flipInspector = () => setInspector((cur) => toggleInspector(cur, compactRef.current, pickedRef.current.length > 0));
  const foldGroup = (id: string) =>
    setFolded((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const chosenSpec = chosen ? specs.get(chosen.type) : undefined;
  const chosenTitle = chosen
    ? layout.nodes[chosen.id]?.title || chosenSpec?.title?.[getLanguage()] || chosenSpec?.title?.zh || chosen.id
    : "";
  const chosenDoc = chosenSpec?.doc?.[getLanguage()] || chosenSpec?.doc?.zh || chosen?.type || "";
  const chosenPins = chosen ? inspectPins(graph, chosen, chosenSpec) : null;
  const dangling = danglingEdges(graph);
  const togglePick = (id: string, on: boolean) => {
    setPicked((cur) => (on ? [...cur, id] : cur.filter((item) => item !== id)));
  };
  const outlineTitle = (id: string, type: string) => {
    const title = layout.nodes[id]?.title || specs.get(type)?.title?.[getLanguage()] || specs.get(type)?.title?.zh;
    return title && title !== id ? title : "";
  };
  return (
    <div className="flow-page" data-library={libraryShown(library, narrow) ? "open" : "closed"} data-inspector={inspectorOpen ? "open" : "closed"}>
      <div className="flow-canvas" aria-label={t.flow.nodes} data-snap={snap ? "on" : "off"} data-flowing={tracePicture && flowEdges(tracePicture.running, graph.nodes.length, reducedMotion) ? tracePicture.running ?? "" : ""}>
        <nav className="flow-scope" aria-label={t.flow.scope}>
          <Button type="button" onClick={() => setScope(null)} aria-current={scope ? undefined : "page"}>
            {graph.name}
          </Button>
          {scope ? (
            <Button type="button" aria-current="page">
              {scope}
            </Button>
          ) : null}
        </nav>
        <CanvasBoundary>
          <ReactFlowProvider>
            <editPin.Provider value={editInput}>
            <cycleBp.Provider value={(id) => commitBreaks(cycleBreakpoint(breaksRef.current, id))}>
            <renameGroupTitle.Provider value={renameBox}>
            <renameNoteText.Provider value={renameNote}>
            <renameFlowTitle.Provider value={retitle}>
            <ReactFlow
              nodes={canvas.nodes}
              edges={canvas.edges}
              nodesDraggable
              selectionOnDrag
              panOnDrag={[1, 2]}
              panActivationKeyCode="Space"
              minZoom={0.1}
              maxZoom={2}
              zoomOnScroll
              zoomOnPinch
              onlyRenderVisibleElements={clipOffscreen(graph.nodes.length)}
              onMove={(_event, viewport) => {
                setZoom((cur) => (Math.abs(cur - viewport.zoom) < 0.001 ? cur : viewport.zoom));
              }}
              multiSelectionKeyCode="Shift"
              onInit={(instance) => {
                flow.current = instance;
              }}
              onDragOver={(event) => {
                const types = [...event.dataTransfer.types];
                if (!types.includes(VAR_DRAG) && !types.includes(NODE_DRAG)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(event) => {
                if (!dropNode(event)) dropVar(event);
              }}
              onNodeDragStart={(_event, node) => {
                if (!dragBefore.current) dragBefore.current = currentSnap();
                const box = (layoutRef.current.groups ?? []).find((item) => item.id === node.id);
                if (box) groupMembers.current[node.id] = Object.keys(layoutRef.current.nodes).filter((id) => {
                  const pos = layoutRef.current.nodes[id];
                  return !!pos && pos.x >= box.rect[0] && pos.x < box.rect[0] + box.rect[2] && pos.y >= box.rect[1] && pos.y < box.rect[1] + box.rect[3];
                });
              }}
              onNodeDragStop={(_event, _node, nodes) => {
                dragNodes.current = nodes;
                if (dragStop.current) return;
                dragStop.current = true;
                queueMicrotask(() => {
                  dragStop.current = false;
                  const before = dragBefore.current;
                  dragBefore.current = null;
                  const group = dragNodes.current;
                  if (!before) return;
                  let next = layoutRef.current;
                  for (const node of group) {
                    const members = groupMembers.current[node.id];
                    next = members
                      ? shiftGroup(next, node.id, node.position.x, node.position.y, members)
                      : moveItem(next, node.id, node.position.x, node.position.y);
                  }
                  const moved = group.some((node) => {
                    const prev = pointOf(before.layout, node.id);
                    return !prev || prev.x !== node.position.x || prev.y !== node.position.y;
                  });
                  layoutRef.current = next;
                  setLayout(next);
                  if (!moved) return;
                  const result = pushUndo(stackRef.current, before);
                  stackRef.current = result.stack;
                  setStack(result.stack);
                  typing.current = false;
                });
              }}
              onNodesChange={(changes) => {
                const dimensions = changes.flatMap((change) =>
                  change.type === "dimensions" && change.dimensions ? [{ id: change.id, width: change.dimensions.width, height: change.dimensions.height }] : [],
                );
                if (dimensions.length) {
                  setMeasured((cur) => {
                    let next = cur;
                    for (const item of dimensions) {
                      const prev = next[item.id];
                      if (prev && prev.width === item.width && prev.height === item.height) continue;
                      if (next === cur) next = { ...cur };
                      next[item.id] = { width: item.width, height: item.height };
                    }
                    return next;
                  });
                }
                setLayout((cur) => {
                  let next = cur;
                  for (const change of changes) {
                    if (change.type !== "position" || !change.position) continue;
                    const prev = pointOf(next, change.id);
                    if (prev && prev.x === change.position.x && prev.y === change.position.y) continue;
                    const members = groupMembers.current[change.id];
                    next = members
                      ? shiftGroup(next, change.id, change.position.x, change.position.y, members)
                      : moveItem(next, change.id, change.position.x, change.position.y);
                  }
                  return next;
                });
                setPicked((cur) => {
                  const box = marquee.current;
                  if (box) {
                    for (const change of changes) {
                      if (change.type !== "select") continue;
                      if (change.selected) box.inside.add(change.id);
                      else box.inside.delete(change.id);
                    }
                    const next = mergeBoxSelection(box.base, [...box.inside], box.mode);
                    if (next.length === cur.length && next.every((id, index) => id === cur[index])) return cur;
                    return next;
                  }
                  let next = cur;
                  for (const change of changes) {
                    if (change.type !== "select") continue;
                    next = change.selected ? [...next.filter((id) => id !== change.id), change.id] : next.filter((id) => id !== change.id);
                  }
                  if (next === cur || (next.length === cur.length && next.every((id, index) => id === cur[index]))) return cur;
                  return next;
                });
              }}
              defaultViewport={{ x: 48, y: 56, zoom: 1 }}
              snapToGrid={snap}
              snapGrid={[16, 16]}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              connectionLineComponent={WireConnection}
              isValidConnection={(connection) => {
                if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return false;
                const text = connectionHint(graph, connection.source, connection.sourceHandle, connection.target, connection.targetHandle, specs);
                if (hintRef.current !== text) {
                  hintRef.current = text;
                  setHint(text);
                }
                return text.startsWith("✓");
              }}
              onEdgeDoubleClick={(event, edge) => {
                event.stopPropagation();
                const data = edge.data as { semantic?: string; segment?: number } | undefined;
                const semantic = data?.semantic ?? edge.id;
                bend(semantic, data?.segment ?? 0);
              }}
              onConnect={(connection) => {
                if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
                const result = connectPins(graph, connection.source, connection.sourceHandle, connection.target, connection.targetHandle, specs);
                if (!result.ok) {
                  setNote(result.code);
                  return;
                }
                apply(result.graph);
              }}
              onConnectEnd={(_event, state) => {
                hintRef.current = "";
                setHint("");
                if (state.toNode) return;
                const from = state.fromNode?.id;
                const pin = state.fromHandle?.id;
                if (from && pin) openMenu({ from, pin });
              }}
              onNodeDoubleClick={(_event, node) => {
                const next = enterableScope(graph, node.id);
                if (next) setScope(next);
              }}
              onPaneClick={(event) => {
                const point = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
                if (point) panePoint.current = point;
                if (event.target instanceof Element && event.target.closest(".react-flow__edge, .react-flow__node")) return;
                const now = Date.now();
                if (now - lastPane.current < 300) openMenu();
                lastPane.current = now;
              }}
              onPaneContextMenu={(event) => {
                event.preventDefault();
                openMenu();
              }}
              fitView={false}
              proOptions={{ hideAttribution: false }}
            >
              <Remeasure />
              <AutoFit name={graph.name} focus={focus} />
              <MiniMap ariaLabel={t.flow.minimap} pannable zoomable nodeBorderRadius={6} style={{ width: 148, height: 96 }} />
              <Background />
            </ReactFlow>
            <div className="flow-hud">
              <Button variant="ghost" type="button" onClick={() => fit(true)}>
                {t.flow.fitView}
              </Button>
              <p className="flow-zoom" aria-label={t.flow.zoom}>{Math.round(zoom * 100)}%</p>
            </div>
            {hint ? <p className="flow-hint" role="status" aria-label={t.flow.linkHint}>{hint}</p> : null}
            </renameFlowTitle.Provider>
            </renameNoteText.Provider>
            </renameGroupTitle.Provider>
            </cycleBp.Provider>
            </editPin.Provider>
          </ReactFlowProvider>
        </CanvasBoundary>
        {graph.nodes.every((node) => node.id === "start") ? (
          <div className="flow-empty">
            <p>{t.flow.emptyHint}</p>
            <Button type="button" onClick={() => apply(parse(SAMPLE_FLOW))}>
              {t.flow.emptyTemplate}
            </Button>
          </div>
        ) : null}
        <div
          className="flow-bar"
          role="toolbar"
          aria-label={t.flow.tools}
          ref={barRef}
          data-overflow={barEdges || undefined}
          title={barEdges ? t.flow.toolsMore : undefined}
          onWheel={(event) => {
            const shift = wheelShift(event.deltaX, event.deltaY);
            if (shift) event.currentTarget.scrollLeft += shift;
          }}
        >
          <Button
            variant="ghost"
            type="button"
            className="flow-bar-icon"
            aria-label={t.flow.toggleLibrary}
            title={t.flow.toggleLibrary}
            aria-pressed={libraryShown(library, narrow)}
            onClick={() => setLibrary((cur) => toggleLibrary(cur, narrowRef.current))}
          >
            <IconSidebar size={16} />
          </Button>
          <Button
            variant="ghost"
            type="button"
            className="flow-bar-icon flow-bar-icon-end"
            aria-label={t.flow.toggleInspector}
            title={t.flow.toggleInspector}
            aria-pressed={inspectorOpen}
            onClick={flipInspector}
          >
            <IconSidebar size={16} />
          </Button>
          <span className="flow-tool-gap" aria-hidden="true" />
          <Button variant="primary" type="button" onClick={() => openMenu()}>
            {t.flow.add}
          </Button>
          <span className="flow-tool-gap" aria-hidden="true" />
          <Button type="button" onClick={boxSelection} disabled={!picked.some((id) => layout.nodes[id])}>
            {t.flow.comment}
          </Button>
          <Button type="button" onClick={placeNote}>
            {t.flow.note}
          </Button>
          <Button type="button" onClick={() => { const next = chosen ? enterableScope(graph, chosen.id) : null; if (next) setScope(next); }} disabled={!chosen || !enterableScope(graph, chosen.id)}>
            {t.flow.enter}
          </Button>
          <Button
            type="button"
            onClick={() => {
              const scope = chosen ? enterableScope(graph, chosen.id) : null;
              if (!scope) return;
              const text = promoteFunction(graph, scope);
              if (!text) return;
              clipText.current = text;
              void navigator.clipboard?.writeText(text).catch(() => undefined);
              setFileText(text);
              setNote(t.flow.promoted);
            }}
            disabled={!chosen || !enterableScope(graph, chosen.id)}
          >
            {t.flow.promote}
          </Button>
          <Button type="button" onClick={collapseSelection} disabled={!picked.some((id) => layout.nodes[id])}>
            {t.flow.collapse}
          </Button>
          <Button type="button" onClick={fold} disabled={picked.length < 1}>
            {t.flow.fold}
          </Button>
          <Button type="button" onClick={unfold} disabled={picked.length !== 1 || chosen?.type !== "code.python"}>
            {t.flow.unfold}
          </Button>
          <span className="flow-tool-gap" aria-hidden="true" />
          <Button type="button" onClick={copySelection} disabled={!picked.some((id) => graph.nodes.some((node) => node.id === id))}>
            {t.flow.copy}
          </Button>
          <Button type="button" onClick={duplicate} disabled={!picked.some((id) => graph.nodes.some((node) => node.id === id))}>
            {t.flow.duplicate}
          </Button>
          <Button type="button" onClick={() => void paste()}>
            {t.flow.paste}
          </Button>
          <Button type="button" onClick={undo} disabled={stack.past.length === 0}>
            {t.flow.undo}
          </Button>
          <Button type="button" onClick={redo} disabled={stack.future.length === 0}>
            {t.flow.redo}
          </Button>
          <span className="flow-tool-gap" aria-hidden="true" />
          <Button variant="danger" type="button" onClick={() => dropPicked(picked)} disabled={picked.length < 1}>
            {t.flow.remove}
          </Button>
          <Button type="button" onClick={runStep} disabled={!chosen}>
            {t.flow.step}
          </Button>
          <span className="flow-tool-gap" aria-hidden="true" />
          <Button variant="primary" type="button" onClick={() => applyDebug("run")}>
            {t.flow.runFlow}
          </Button>
          <Button type="button" onClick={() => applyDebug("step")}>
            {t.flow.stepFlow}
          </Button>
          <Button type="button" onClick={() => applyDebug("stop")} disabled={session?.status !== "paused"}>
            {t.flow.stopFlow}
          </Button>
          {onDevice ? (
            <Button variant="danger" type="button" onClick={() => void stopOnDevice()}>
              {t.flow.stopOnDevice}
            </Button>
          ) : (
            <Button type="button" onClick={() => void runOnDevice()} disabled={deploying} aria-busy={deploying ? true : undefined}>
              {t.flow.runOnDevice}
            </Button>
          )}
          {session ? (
            <p className={"flow-debug" + (session.status === "paused" ? " is-paused" : session.status === "error" ? " is-error" : "")} role="status" aria-label={t.flow.debugState}>
              {session.status === "done"
                ? t.flow.runDone
                : session.status === "stopped"
                  ? t.flow.runStopped
                  : session.status === "error"
                    ? session.detail === "limit"
                      ? t.flow.runLimit
                      : t.flow.runFailed(session.detail)
                    : session.pause === "breakpoint"
                      ? t.flow.pausedBreak(session.at ?? "")
                      : t.flow.pausedStep(session.at ?? "")}
            </p>
          ) : null}
        </div>
      </div>
      <aside className="flow-library" aria-label={t.flow.library}>
        <h2 className="flow-side-head">{t.flow.library}</h2>
        <div className="flow-side-scroll">
          <NodePalette specs={entries} recent={recent} graph={graph} templates={templates} onCreateFunction={makeFunction} onCreateNode={makeNode} onPick={pickPalette} />
          <VariablePanel graph={graph} onChange={apply} />
        </div>
      </aside>
      <aside className="flow-inspector" aria-label={t.flow.inspector} hidden={!inspectorOpen}>
        <header className="flow-inspect-head">
          {chosen ? (
            <span className={"flow-inspect-mark cat-" + (chosenSpec?.category || "flow")}>
              <CatGlyph name={chosenSpec?.icon || chosenSpec?.category || "flow"} />
            </span>
          ) : null}
          <div className="flow-inspect-copy">
            <p className="flow-inspect-title">{chosen ? chosenTitle : t.flow.inspector}</p>
            {chosen ? (
              <p className="flow-inspect-id">
                <span>{chosen.id}</span>
                <span>{chosen.type}</span>
              </p>
            ) : null}
            {chosen ? <p className="flow-inspect-meta">{chosenDoc}</p> : null}
          </div>
          <Button variant="ghost" type="button" className="flow-bar-icon flow-inspect-close" aria-label={t.flow.hideInspector} title={t.flow.hideInspector} onClick={() => setInspector("closed")}>
            <span aria-hidden="true">×</span>
          </Button>
        </header>
        <div className="flow-inspect-body">
        {!chosen && picked.length === 0 ? <p className="flow-inspect-empty">{t.flow.pickNode}</p> : null}
        {(chosen && layout.nodes[chosen.id]) || lineShown ? (
          <InspectGroup title={t.flow.groupGeneral} open={!folded.has("general")} onToggle={() => foldGroup("general")}>
            {chosen && layout.nodes[chosen.id] ? (
              <label>
                <span>{t.flow.displayName}</span>
                <Input
                  aria-label={t.flow.displayName}
                  value={chosenTitle}
                  onChange={(event) => retitle(chosen.id, event.target.value)}
                  onBlur={(event) => {
                    if (!event.target.value.trim()) retitle(chosen.id, null);
                  }}
                />
              </label>
            ) : null}
            {lineShown ? (
              <label className="flow-node-line">
                <span>{t.flow.nodeLine}</span>
                <Textarea
                  aria-label={t.flow.nodeLine}
                  spellCheck={false}
                  rows={Math.min(6, Math.max(1, lineDraft.split("\n").length))}
                  value={lineDraft}
                  onChange={(event) => onLine(event.target.value)}
                />
              </label>
            ) : null}
            {jumps.length ? (
              <div className="flow-jumps">
                {jumps.map((id) => (
                  <Button type="button" size="sm" key={id} onClick={() => locate(id)}>
                    {t.flow.jumpTo} {id}
                  </Button>
                ))}
              </div>
            ) : null}
          </InspectGroup>
        ) : null}
        {chosen && chosenPins && chosenPins.inputs.length ? (
          <InspectGroup title={t.flow.groupInputs} count={chosenPins.inputs.length} open={!folded.has("inputs")} onToggle={() => foldGroup("inputs")}>
            <div className="flow-props" aria-label={t.flow.properties} role="group">
              {chosenPins.inputs.map((field) => (
                <PropertyField key={chosen.id + "." + field.name} field={field} onChange={(value) => editInput(chosen.id, field.name, value)} />
              ))}
            </div>
          </InspectGroup>
        ) : null}
        {chosen && chosenPins && chosenPins.outputs.length ? (
          <InspectGroup title={t.flow.outputs} count={chosenPins.outputs.length} open={!folded.has("outputs")} onToggle={() => foldGroup("outputs")}>
            <ul className="flow-prop-outs" aria-label={t.flow.outputs}>
              {chosenPins.outputs.map((pin) => (
                <li key={pin.name}>
                  <span>{pin.name}</span>
                  <span className="flow-prop-type">{pin.type}</span>
                </li>
              ))}
            </ul>
          </InspectGroup>
        ) : null}
        {chosen?.type === "code.python" && !chosen.meta?.origin ? (
          <InspectGroup title={t.flow.groupCode} open={!folded.has("code")} onToggle={() => foldGroup("code")}>
            <label>
              {t.flow.codeIn}
              <Input
                aria-label={t.flow.codeIn}
                value={String(chosen.config?.inPins ?? "")}
                onChange={(event) => editCode(chosen.id, "inPins", event.target.value)}
              />
            </label>
            <label>
              {t.flow.codeOut}
              <Input
                aria-label={t.flow.codeOut}
                value={String(chosen.config?.outPins ?? "")}
                onChange={(event) => editCode(chosen.id, "outPins", event.target.value)}
              />
            </label>
            <label>
              {t.flow.codeSource}
              <Textarea
                aria-label={t.flow.codeSource}
                spellCheck={false}
                value={String(chosen.config?.source ?? "")}
                onChange={(event) => editCode(chosen.id, "source", event.target.value)}
              />
            </label>
          </InspectGroup>
        ) : null}
        {cacheIds.length ? (
          <InspectGroup title={t.flow.cache} count={cacheIds.length > 1 ? cacheIds.length : undefined} open={!folded.has("cache")} onToggle={() => foldGroup("cache")}>
            {cacheIds.map((id) => (
              <label key={id}>
                {cacheIds.length > 1 ? t.flow.cache + " " + id : t.flow.cache}
                <Input
                  aria-label={t.flow.cache + " " + id}
                  value={cache[id] ?? ""}
                  onChange={(event) => {
                    cacheEdited.current.add(id);
                    const value = event.target.value;
                    setCache((cur) => ({ ...cur, [id]: value }));
                  }}
                />
              </label>
            ))}
          </InspectGroup>
        ) : null}
        </div>
        <fieldset className="flow-nodes">
          <legend>{t.flow.nodes}</legend>
          {graph.nodes
            .filter((node) => scopeNodeIds(graph, scope).includes(node.id))
            .map((node) => {
              const kind = outlineTitle(node.id, node.type);
              return (
                <label key={node.id} data-collapsed={layout.nodes[node.id]?.collapsed ? "true" : undefined}>
                  <input type="checkbox" aria-label={node.id} checked={picked.includes(node.id)} onChange={(event) => togglePick(node.id, event.target.checked)} />
                  <span className="flow-node-name">{kind || node.id}</span>
                  {kind ? <span className="flow-node-id">{node.id}</span> : null}
                </label>
              );
            })}
          {(layout.comments ?? []).map((note) => (
            <label key={note.id}>
              <input type="checkbox" aria-label={note.id} checked={picked.includes(note.id)} onChange={(event) => togglePick(note.id, event.target.checked)} />
              <span className="flow-node-id">{note.id}</span>
            </label>
          ))}
          {(layout.groups ?? []).map((box) => (
            <label key={box.id}>
              <input type="checkbox" aria-label={box.id} checked={picked.includes(box.id)} onChange={(event) => togglePick(box.id, event.target.checked)} />
              <span className="flow-node-id">{box.id}</span>
            </label>
          ))}
          {(layout.reroutes ?? []).map((hop) => (
            <label key={hop.id}>
              <input type="checkbox" aria-label={hop.id} checked={picked.includes(hop.id)} onChange={(event) => togglePick(hop.id, event.target.checked)} />
              <span className="flow-node-id">{hop.id}</span>
            </label>
          ))}
        </fieldset>
      </aside>
      <section className="flow-bottom" aria-label={t.flow.dock} style={{ height: bottomH }}>
        <button
          type="button"
          className="flow-dock-handle"
          aria-label={t.flow.dock}
          onPointerDown={(event) => {
            const startY = event.clientY;
            const start = bottomH;
            const move = (ev: PointerEvent) => setBottomH(clampDock(start + (startY - ev.clientY)));
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") setBottomH((cur) => clampDock(cur + 16));
            if (event.key === "ArrowDown") setBottomH((cur) => clampDock(cur - 16));
          }}
        />
        {(dangling.length || fault || trial || stack.noticedDrop || note) ? (
          <div className="flow-dock-status">
            {dangling.length ? <p role="status">{t.flow.dangling}</p> : null}
            {fault ? (
              <p role="alert" aria-label={t.flow.fault}>
                <Button type="button" onClick={() => locate(fault.node)}>
                  {fault.node} {fault.message}
                </Button>
              </p>
            ) : null}
            {trial ? (
              <section aria-label={t.flow.step} aria-busy={trial.busy ? true : undefined}>
                {trial.code ? <pre>{trial.code}</pre> : null}
                <p role="status">{trial.line}</p>
              </section>
            ) : null}
            {stack.noticedDrop ? <p role="status">{t.flow.undoDropped}</p> : null}
            {note ? <p role="status">{note}</p> : null}
          </div>
        ) : null}
        <div className="flow-dock-bar" role="tablist" aria-label={t.flow.dock}>
          {([
            ["text", t.flow.dsl],
            ["python", t.flow.python],
            ["breaks", t.flow.breakpoints],
            ["trace", t.flow.trace],
            ["problems", t.flow.problems],
          ] as const).map(([id, label]) => (
            <Button key={id} type="button" role="tab" aria-selected={dock === id} onClick={() => setDock(id)}>
              {label}
              {id === "problems" && problems.length + (fault ? 1 : 0) ? <span className="flow-dock-count">{problems.length + (fault ? 1 : 0)}</span> : null}
              {id === "breaks" && breaks.length ? <span className="flow-dock-count">{breaks.length}</span> : null}
            </Button>
          ))}
        </div>
        <div className="flow-dock-pane" role="tabpanel">
          {dock === "text" ? <CodeEditor path="daily_signin.xflow" value={text} label={t.flow.dsl} onChange={onText} onKeyDown={() => undefined} /> : null}
          {dock === "python" && mapped ? (
            <ol className="flow-map" aria-label={t.flow.python}>
              {Object.entries(mapped.lines)
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([line, mark]) => (
                  <li key={line}>
                    <Button type="button" onClick={() => locate(mark.split("(")[0])}>
                      {line} {mark}
                    </Button>
                  </li>
                ))}
            </ol>
          ) : null}
          {dock === "breaks" ? (
            <ul aria-label={t.flow.breakpoints}>
              {breaks.map((item) => (
                <li key={item.node}>
                  <Button type="button" onClick={() => { setPicked([item.node]); setFocusId(item.node); }}>
                    {item.node}
                  </Button>
                  <Button type="button" aria-pressed={item.enabled} onClick={() => commitBreaks(cycleBreakpoint(breaks, item.node))}>
                    {item.enabled ? t.flow.breakpointOn : t.flow.breakpointOff}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {dock === "trace" ? (
            <div className="flow-trace">
              <Button type="button" aria-pressed={follow} onClick={armFollow}>
                {t.flow.follow}
              </Button>
              <Button type="button" onClick={recordRun}>
                {t.flow.record}
              </Button>
              <Textarea
                aria-label={t.flow.traceLog}
                className="font-mono"
                value={traceLog}
                onChange={(event) => {
                  setTraceLog(event.target.value);
                  setTraceAt(Date.now());
                  setTraceNow(Date.now());
                }}
              />
              {traceBroken ? <p role="status">{t.flow.traceGap}</p> : null}
              <ol aria-label={t.flow.trace}>
                {Object.entries(tracePicture?.nodes ?? {}).map(([id, item]) => (
                  <li key={id}>
                    {id} {runWord(item.status)} {item.summary}
                  </li>
                ))}
              </ol>
              <ol aria-label={t.flow.userLog}>
                {userLog.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ol>
              <ol aria-label={t.flow.history}>
                {runs.map((run) => (
                  <li key={run.id}>
                    <Button type="button" onClick={() => locate(run.error_node || run.nodes[0]?.node || "")}>
                      {run.flow} {run.status} {run.nodes.map((node) => node.node).join(" ")}
                    </Button>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {dock === "problems" ? (
            <ul aria-label={t.flow.problems}>
              {fault ? (
                <li className="flow-fault-row">
                  <Button type="button" onClick={() => locate(fault.node)}>
                    {t.flow.faultAt(fault.node, faultFile, fault.line, fault.message)}
                  </Button>
                </li>
              ) : null}
              {problems.map((item) => (
                <li key={item.code + (item.node ?? "") + item.message}>
                  {item.node ? (
                    <Button type="button" onClick={() => locate(item.node as string)}>
                      {item.code} {item.message}
                    </Button>
                  ) : (
                    <>
                      {item.code} {item.message}
                    </>
                  )}
                  {item.node && item.fix ? (
                    <Button type="button" onClick={() => apply(renameInput(graph, item.node as string, item.fix?.from ?? "", item.fix?.to ?? ""))}>
                      {t.flow.usePin} {item.fix.to}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {menu ? (
          <div className="flow-menu" role="dialog" aria-label={t.flow.add}>
            <Input aria-label={t.flow.search} value={query} onChange={(event) => setQuery(event.target.value)} />
            {tree ? (
              <>
                {tree.recent.length ? (
                  <section aria-label={t.flow.recentNodes}>
                    <h3>{t.flow.recentNodes}</h3>
                    <ul>
                      {tree.recent.map((spec) => (
                        <li key={"recent-" + spec.type}>
                          <Button type="button" onClick={() => choose(spec.type)}>
                            {spec.title}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {tree.groups.map((group) => {
                  const open = openCats.includes(group.category);
                  const label = categoryName(group.category);
                  return (
                    <section key={group.category}>
                      <Button
                        type="button"
                        aria-expanded={open}
                        aria-label={t.flow.category + " " + label}
                        onClick={() => setOpenCats((cur) => (cur.includes(group.category) ? cur.filter((item) => item !== group.category) : [...cur, group.category]))}
                      >
                        {label}
                        <span aria-hidden="true"> {group.specs.length}</span>
                      </Button>
                      {open ? (
                        <ul className="flow-tree">
                          {group.specs.map((spec) => (
                            <li key={spec.type}>
                              <Button type="button" onClick={() => choose(spec.type)}>
                                {spec.title}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </section>
                  );
                })}
              </>
            ) : (
              <ul>
                {visible.map((spec) => (
                  <li key={spec.type}>
                    <Button type="button" onClick={() => choose(spec.type)}>
                      {categoryName(spec.category)} · {spec.title}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {finder ? (
          <div className="flow-menu flow-find" role="dialog" aria-label={t.flow.find}>
            <Input
              aria-label={t.flow.find}
              value={finder.query}
              onChange={(event) => {
                const next = event.target.value;
                const matches = findInGraph(graph, next);
                setFinder({ query: next, at: 0 });
                if (matches[0]) reveal([matches[0]]);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                const matches = findInGraph(graph, finder.query);
                if (!matches.length) return;
                const at = (finder.at + 1) % matches.length;
                setFinder({ ...finder, at });
                reveal([matches[at]]);
              }}
            />
            <p role="status">{findInGraph(graph, finder.query).length}</p>
          </div>
        ) : null}
        {fileText ? (
          <div className="flow-menu" role="dialog" aria-label={t.flow.file}>
            <Textarea readOnly aria-label={t.flow.file} className="font-mono" value={fileText} />
          </div>
        ) : null}
        {jump ? (
          <div className="flow-menu flow-jump" role="dialog" aria-label={t.flow.jump}>
            <ul>
              {jumpTargets(graph).map((item) => (
                <li key={item.kind + item.id}>
                  <Button
                    type="button"
                    onClick={() => {
                      if (item.kind === "def") reveal([item.id]);
                      else {
                        setPicked([]);
                        try {
                          flow.current?.fitView({ duration: 0, padding: 0.2 });
                        } catch {
                          // The canvas is absent in some test environments.
                        }
                      }
                      setJump(false);
                    }}
                  >
                    {item.kind === "flow" ? t.flow.jumpFlow : t.flow.jumpDef} {item.id}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}
