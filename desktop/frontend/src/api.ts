import type { RpcClient } from "./bridge/client";

export interface AdbDevice {
  serial: string;
  state: string;
  model: string;
  product: string;
  device: string;
  transportId: string;
  isEmulator: boolean;
}

export interface DeviceInfo {
  name: string;
  model: string;
  brand: string;
  android: string;
  sdk: number | null;
  width: number | null;
  height: number | null;
  density: number | null;
  ip: string;
  port: number | null;
  version: string;
  deviceId: string;
  appId: string;
  running: boolean;
  project: string;
  accessibility: boolean;
  root: boolean;
  capture: boolean;
  channel: string;
  cloud: string;
}

export interface Device {
  id: string;
  transport: "adb" | "lan";
  address: string;
  serial: string;
  forwardPort: number;
  state: "connecting" | "online" | "unpaired" | "offline";
  error: string;
  /** Machine-readable twin of `error` (an RPC error code such as device.unreachable); absent on older backends. */
  errorCode?: string;
  warning: string;
  lastSeen: number;
  info: Partial<DeviceInfo>;
  status: Record<string, unknown>;
  /** User-facing label from the saved-device row (design §14.5). Empty until the user sets one. */
  name?: string;
  group?: string;
  note?: string;
  autoConnect?: boolean;
  sortOrder?: number;
  saved?: boolean;
}

export interface SecretSlot {
  kind: "env" | "backend" | "device";
  name: string;
}

export interface UiTreeResult {
  mode?: number;
  width?: number;
  height?: number;
  roots?: Array<Record<string, unknown>>;
}

export interface Hello {
  version: string;
  platform: string;
  adbPath: string | null;
  methods: string[];
}

export interface ScanHit {
  address: string;
  host: string;
  port: number;
  info: Partial<DeviceInfo>;
}

export interface ScanResult {
  found: ScanHit[];
  cancelled?: boolean;
  total?: number;
}

/** device.scan.progress / device.scan.found event payloads */
export interface ScanProgress {
  scanId: string;
  done: number;
  total: number;
}
export interface ScanFound {
  scanId: string;
  device: ScanHit;
}

export interface AppSettings {
  adbPath: string | null;
  autoReconnect: boolean;
}

export interface ProjectSummary {
  name: string;
  [k: string]: unknown;
}

export interface ProjectFiles {
  project: string;
  files: Array<{ path: string; size: number }>;
  dirs: string[];
}

export interface FileContent {
  path: string;
  encoding: "utf-8" | "base64";
  content: string;
}

export interface LogEntry {
  seq: number;
  ts: number;
  stream: string;
  line: string;
}

export interface RunResult {
  ok?: boolean;
  running?: boolean;
  project?: string;
  error?: string;
}

export interface SyncPlan {
  upload: string[];
  skipped: string[];
  bytes: number;
  uploaded?: number;
}

export interface PullResult {
  added: string[];
  changed: string[];
  unchanged: string[];
  written: number;
}

export type DebugStateName = "idle" | "starting" | "running" | "stopped" | "ended";
export interface DebugFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  /** project-relative path, or null for frames outside the project (stdlib, runtime) */
  path: string | null;
  file: string;
}
export interface DebugState {
  id: string;
  project?: string;
  state: DebugStateName;
  frames: DebugFrame[];
  path?: string | null;
  line?: number | null;
  reason?: string;
  error?: string;
}
export interface DebugScope { name: string; ref: number; expensive: boolean }
export interface DebugVar { name: string; value: string; type: string; ref: number }
export interface MirrorStatus {
  id: string;
  state: string;
  reason: string;
  seq: number;
  w: number;
  h: number;
  viewers: number;
  fps: number;
  scale: number;
  quality: number;
}

export type DebugStep = "continue" | "next" | "stepIn" | "stepOut" | "pause";
export type Breakpoints = Record<string, number[]>;
/** DAP SourceBreakpoint options: pause only when `condition` is true / on the `hitCondition`-th hit; `logMessage` makes a logpoint. */
export interface BpOptions {
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}
/** Options per breakpoint, keyed by bpKey(path, line). Plain breakpoints have no entry. */
export type BreakpointOptions = Record<string, BpOptions>;
export type BpSpec = number | ({ line: number } & BpOptions);
export const bpKey = (path: string, line: number) => `${path}:${line}`;
export function hasBpOptions(o: BpOptions | undefined): o is BpOptions {
  return !!o && !!(o.condition?.trim() || o.hitCondition?.trim() || o.logMessage?.trim());
}
/** One file's breakpoints for the RPC: plain line numbers, or {line, ...options} where options are set. */
export function wireBreakpoints(path: string, lines: number[], opts: BreakpointOptions): BpSpec[] {
  return lines.map((line) => {
    const o = opts[bpKey(path, line)];
    if (!hasBpOptions(o)) return line;
    const spec: { line: number } & BpOptions = { line };
    for (const k of ["condition", "hitCondition", "logMessage"] as const) if (o[k]?.trim()) spec[k] = o[k]!.trim();
    return spec;
  });
}

/** Typed wrappers over the JSON-RPC methods (names match xscript_desktop/context.py). */
export function createApi(rpc: RpcClient) {
  return {
    ping: (echo: string) => rpc.call<{ pong: string; version: string; python: string; platform: string }>("app.ping", { echo }),
    hello: (pingOk: boolean) => rpc.call<Hello>("app.hello", { pingOk }),
    /** Whether the page holds unsaved edits; the shell asks before closing the window when it does. */
    setUnsaved: (unsaved: boolean, lang: "zh" | "en") => rpc.call<{ unsaved: boolean }>("app.setUnsaved", { unsaved, lang }),
    setAdbPath: (adbPath: string) => rpc.call<{ adbPath: string | null }>("app.settings.set", { adbPath }),
    getSettings: () => rpc.call<AppSettings>("app.settings.get"),
    /** Global switch: reconnect devices that were online last time (at startup and when re-plugged). */
    setAutoReconnect: (autoReconnect: boolean) => rpc.call<AppSettings>("app.settings.set", { autoReconnect }),
    /** Also the hotplug tick: saved auto-reconnect devices that just appeared start connecting (`autoConnecting`). */
    adbList: () => rpc.call<{ adbPath: string | null; devices: AdbDevice[]; autoConnecting?: string[] }>("device.adb.list", {}, { timeoutMs: 20_000 }),
    connectAdb: (serial: string) => rpc.call<Device>("device.connect", { transport: "adb", serial }, { timeoutMs: 30_000 }),
    connectLan: (address: string) => rpc.call<Device>("device.connect", { transport: "lan", address }, { timeoutMs: 30_000 }),
    listDevices: () => rpc.call<{ devices: Device[]; notice?: string; noticeDetail?: string }>("device.list"),
    refresh: (id: string) => rpc.call<Device>("device.refresh", { id }),
    pairDevice: (id: string, code: string) => rpc.call<Device>("device.pair", { id, code }),
    disconnect: (id: string) => rpc.call<{ removed: boolean; device?: Device }>("device.disconnect", { id }),
    updateDevice: (id: string, patch: { name?: string; group?: string; note?: string; autoConnect?: boolean }) =>
      rpc.call<Device>("device.update", { id, ...patch }),
    forgetDevice: (id: string) => rpc.call<{ forgotten: boolean }>("device.forget", { id }),
    projects: (id: string) => rpc.call<{ projects: ProjectSummary[] }>("project.list", { id }),
    createProject: (id: string, project: string) => rpc.call<{ ok: boolean }>("project.create", { id, project }),
    files: (id: string, project: string) => rpc.call<ProjectFiles>("project.files", { id, project }),
    readFile: (id: string, project: string, path: string) => rpc.call<FileContent>("project.read", { id, project, path }),
    writeFile: (id: string, project: string, path: string, content: string, create = false) =>
      rpc.call<{ ok: boolean }>("project.write", { id, project, path, content, create }, { timeoutMs: 60_000 }),
    deleteFile: (id: string, project: string, path: string) => rpc.call<{ ok: boolean }>("project.deleteFile", { id, project, path }),
    moveFile: (id: string, project: string, from: string, to: string) => rpc.call<{ ok: boolean }>("project.move", { id, project, from, to }),
    run: (id: string, project: string) => rpc.call<RunResult>("project.run", { id, project }),
    stop: (id: string, project: string) => rpc.call<RunResult>("project.stop", { id, project }),
    logs: (id: string, since: number) => rpc.call<{ entries: LogEntry[]; next: number }>("device.logs", { id, since }),
    recordRun: (body: { flow: string; startedAt: number; endedAt: number; status: string; errorNode?: string; errorLine?: number | null; nodes: Array<{ seq: number; node: string; enter_ms: number | null; exit_ms: number | null; summary: string }> }) =>
      rpc.call<{ id: number }>("flow.recordRun", body),
    listRuns: () => rpc.call<{ runs: Array<{ id: number; flow: string; started_at: number; ended_at: number; status: string; error_node: string; error_line: number | null; nodes: Array<{ seq: number; node: string; enter_ms: number | null; exit_ms: number | null; summary: string }> }> }>("flow.listRuns"),
    action: (id: string, payload: Record<string, unknown>) => rpc.call<{ ok: boolean }>("device.action", { id, ...payload }),
    evalCode: (id: string, code: string, timeoutMs: number) =>
      rpc.call<{ ok: boolean; result: string; error: string }>("device.eval", { id, code, timeoutMs }, { timeoutMs: timeoutMs + 5_000 }),
    key: (id: string, name: string) => rpc.call<{ ok: boolean }>("device.action", { id, type: "key", name }),
    pickDirectory: (title: string) => rpc.call<{ path: string | null }>("app.pickDirectory", { title }, { timeoutMs: 600_000 }),
    syncPreview: (id: string, project: string, dir: string, full = false) =>
      rpc.call<SyncPlan>("sync.preview", { id, project, dir, full }, { timeoutMs: 120_000 }),
    syncUpload: (id: string, project: string, dir: string, full = false) =>
      rpc.call<SyncPlan>("sync.upload", { id, project, dir, full }, { timeoutMs: 600_000 }),
    syncPull: (id: string, project: string, dir: string, dryRun = false) =>
      rpc.call<PullResult>("sync.pull", { id, project, dir, dryRun }, { timeoutMs: 600_000 }),
    debugStart: (id: string, project: string, breakpoints: Record<string, BpSpec[]>) =>
      rpc.call<DebugState>("debug.start", { id, project, breakpoints }, { timeoutMs: 90_000 }),
    debugStatus: (id: string) => rpc.call<DebugState>("debug.status", { id }),
    debugSetBreakpoints: (id: string, path: string, lines: BpSpec[]) =>
      rpc.call<{ breakpoints: Array<{ line: number; verified: boolean; message?: string }> }>("debug.setBreakpoints", { id, path, lines }),
    debugStep: (id: string, command: DebugStep) => rpc.call<{ ok: boolean }>("debug.step", { id, command }, { timeoutMs: 40_000 }),
    debugScopes: (id: string, frameId: number) => rpc.call<{ scopes: DebugScope[] }>("debug.scopes", { id, frameId }, { timeoutMs: 40_000 }),
    debugVariables: (id: string, ref: number) => rpc.call<{ variables: DebugVar[] }>("debug.variables", { id, ref }, { timeoutMs: 40_000 }),
    debugEvaluate: (id: string, expression: string, frameId?: number, context: "repl" | "watch" = "repl") =>
      rpc.call<{ result: string; type: string; ref: number }>(
        "debug.evaluate",
        { id, expression, ...(frameId === undefined ? {} : { frameId }), ...(context === "repl" ? {} : { context }) },
        { timeoutMs: 40_000 },
      ),
    debugStop: (id: string, terminate = true) => rpc.call<{ stopped: boolean }>("debug.stop", { id, terminate }, { timeoutMs: 20_000 }),
    mirrorSubscribe: (id: string, opts: { fps?: number; scale?: number; quality?: number } = {}) =>
      rpc.call<MirrorStatus>("mirror.subscribe", { id, viewer: "mirror", ...opts }),
    mirrorUnsubscribe: (id: string) => rpc.call<{ ok: boolean; viewers: number }>("mirror.unsubscribe", { id, viewer: "mirror" }),
    mirrorRetry: (id: string) => rpc.call<MirrorStatus>("mirror.retry", { id }),
    /** With a scanId Python pushes device.scan.found / device.scan.progress for it, and scanCancel can stop it. */
    scan: (opts: { cidr?: string; scanId?: string } = {}) =>
      rpc.call<ScanResult>("device.scan", { ...(opts.cidr ? { cidr: opts.cidr } : {}), ...(opts.scanId ? { scanId: opts.scanId } : {}) }, { timeoutMs: 180_000 }),
    scanCancel: (scanId: string) => rpc.call<{ cancelled: boolean }>("device.scan.cancel", { scanId }),
    secretList: () => rpc.call<{ slots: SecretSlot[] }>("secret.list"),
    secretSet: (kind: string, name: string, value: string) => rpc.call<{ ok: boolean; kind: string; name: string }>("secret.set", { kind, name, value }),
    secretDelete: (kind: string, name: string) => rpc.call<{ deleted: boolean }>("secret.delete", { kind, name }),
    secretHas: (kind: string, name: string) => rpc.call<{ present: boolean }>("secret.has", { kind, name }),
    cloudStatus: () => rpc.call<CloudStatus>("cloud.status", {}, { timeoutMs: 20_000 }),
    /** The token goes to the OS keyring; it is never sent back. */
    cloudConnect: (origin: string, token: string) => rpc.call<CloudStatus>("cloud.connect", { origin, token }, { timeoutMs: 20_000 }),
    cloudDisconnect: () => rpc.call<CloudStatus>("cloud.disconnect"),
    copyText: (text: string) => rpc.call<{ ok: boolean }>("app.copyText", { text }),
    toolsOpen: (id: string, page: string) => rpc.call<{ url: string; page: string; warning: string }>("tools.open", { id, page }),
    uiTree: (id: string, mode = 0) => rpc.call<UiTreeResult>("device.uiTree", { id, mode }),
    pixel: (id: string, x: number, y: number) => rpc.call<{ color: string | null; x: number; y: number }>("device.pixel", { id, x, y }),
    saveScreenshot: (id: string) => rpc.call<{ saved: boolean; path?: string; bytes?: number }>("device.saveScreenshot", { id }, { timeoutMs: 600_000 }),
  };
}

export type Api = ReturnType<typeof createApi>;

// ---- cloud control (admin backend, P4) ----
export type CloudRole = "viewer" | "operator" | "admin";
export interface CloudAccount { username: string; role: CloudRole; canOperate: boolean; isAdmin: boolean }
export interface CloudStatus {
  state: "not_configured" | "connected" | "expired" | "unreachable" | "error";
  origin: string;
  account?: CloudAccount;
  code?: string;
  message?: string;
}
