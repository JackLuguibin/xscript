// Device HTTP client (protocol/openapi.yaml). Kept free of `vscode` so it runs under node --test.

export const DEFAULT_PORT = 9860; // XScript's port; AScript uses 9096
const CLIENT_HEADER = { "X-XScript-Client": "vscode" };

export interface DeviceTarget {
  host: string;
  port: number;
}

export interface UploadFile {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
}

export interface LogEntry {
  seq: number;
  ts: number;
  stream: string;
  line: string;
}

export interface Logs {
  entries: LogEntry[];
  next: number;
}

export interface DebugStartResult {
  ok?: boolean;
  error?: string;
  project?: string;
  debug?: { port: number; remote_root: string };
}

export interface DebugMessages {
  messages?: { id: number; message: Record<string, any> }[];
  next: number;
  connected?: boolean;
  error?: string;
  dropped_before?: number;
}

export interface RemoteFile {
  path: string;
  size: number;
}

export interface EvalResult {
  ok: boolean;
  result?: string;
  error?: string;
}

/** Accepts "host", "host:port", "http://host:port/path", "[ipv6]:port" or a bare IPv6 address. */
export function parseTarget(value: string): DeviceTarget {
  let text = (value || "").trim();
  if (!text) return { host: "127.0.0.1", port: DEFAULT_PORT };
  if (text.includes("://")) text = text.split("://", 2)[1];
  text = text.split("/", 1)[0]; // drop any path, e.g. http://ip:9860/tools/
  const port = (s: string): number => {
    if (s === "") return DEFAULT_PORT;
    const n = Number(s);
    if (!/^\d+$/.test(s) || n <= 0 || n > 65535) throw new Error("invalid port in device address: " + value);
    return n;
  };
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) throw new Error("invalid device address: " + value);
    const rest = text.slice(end + 1);
    return { host: text.slice(1, end) || "::1", port: port(rest.startsWith(":") ? rest.slice(1) : "") };
  }
  if ((text.match(/:/g) || []).length > 1) return { host: text, port: DEFAULT_PORT }; // bare IPv6
  const i = text.lastIndexOf(":");
  if (i < 0) return { host: text, port: DEFAULT_PORT };
  return { host: text.slice(0, i) || "127.0.0.1", port: port(text.slice(i + 1)) };
}

export function baseUrl(t: DeviceTarget): string {
  return "http://" + (t.host.includes(":") ? "[" + t.host + "]" : t.host) + ":" + t.port;
}

export class HttpError extends Error {
  /** The device's own `error` text when the body is JSON (e.g. "工程已存在: demo"), else the raw body. */
  public detail: string;
  constructor(public status: number, public body: string) {
    const detail = HttpError.detailOf(body);
    super("HTTP " + status + (detail ? ": " + detail : ""));
    this.detail = detail;
  }
  private static detailOf(body: string): string {
    try {
      const data = JSON.parse(body);
      if (data && typeof data === "object" && (data.error || data.msg)) return String(data.error || data.msg);
    } catch {
      /* not JSON */
    }
    return (body || "").slice(0, 200);
  }
}

/** Short reason for a failed device call, for messages and the output channel. */
export function describeError(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError") return "timed out";
  if (e?.cause?.code) return e.cause.code; // ECONNREFUSED etc.
  return e?.message ?? String(err);
}

/** Latest log seq, so following shows only lines from the next run. */
export async function currentSeq(client: Pick<DeviceClient, "logs">, maxPages = 100): Promise<number> {
  let since = 0;
  for (let i = 0; i < maxPages; i++) {
    const r = await client.logs(since);
    if (!r.entries.length || r.next === since) break;
    since = r.next;
  }
  return since;
}

export interface FollowState {
  since: number;
  idle: number;
}

/**
 * One log-follow poll: appends new lines, advances `since`, and every third quiet poll asks the
 * device whether the script is still running. Returns "done" once it has finished.
 */
export async function followTick(
  client: Pick<DeviceClient, "logs" | "status">,
  state: FollowState,
  write: (text: string) => void,
): Promise<"more" | "done"> {
  const r = await client.logs(state.since);
  for (const e of r.entries) write(e.line.endsWith("\n") ? e.line : e.line + "\n");
  // The device log may have been cleared (next < since): restart from its cursor.
  state.since = typeof r.next === "number" ? r.next : state.since;
  state.idle = r.entries.length ? 0 : state.idle + 1;
  if (state.idle > 0 && state.idle % 3 === 0) {
    const s = await client.status(3000);
    if (!s.running) return "done";
  }
  return "more";
}

interface RequestOptions {
  query?: Record<string, string | number>;
  json?: unknown;
  timeoutMs?: number;
  /** Non-2xx statuses whose JSON body is returned instead of thrown. */
  passStatuses?: number[];
}

export class DeviceClient {
  constructor(public target: DeviceTarget, private timeoutMs = 15000) {}

  get baseUrl(): string {
    return baseUrl(this.target);
  }

  private async request(method: string, route: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.baseUrl + route);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { ...CLIENT_HEADER };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const r = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
    });
    if (!r.ok && !(opts.passStatuses ?? []).includes(r.status)) {
      throw new HttpError(r.status, await r.text().catch(() => ""));
    }
    return r;
  }

  private async json<T>(method: string, route: string, opts?: RequestOptions): Promise<T> {
    return (await (await this.request(method, route, opts)).json()) as T;
  }

  private static p(project: string): string {
    return encodeURIComponent(project);
  }

  status(timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.json("GET", "/status", { timeoutMs });
  }

  async listProjects(): Promise<string[]> {
    const r = await this.json<{ projects?: string[] }>("GET", "/projects");
    return r.projects ?? [];
  }

  /** Batch upload (PUT /projects/{name}/files); creates the project if needed. */
  uploadFiles(project: string, files: UploadFile[]): Promise<{ ok: boolean; count?: number }> {
    return this.json("PUT", "/projects/" + DeviceClient.p(project) + "/files", {
      json: { files },
      timeoutMs: Math.max(this.timeoutMs, 120000),
    });
  }

  /** 409 (already running) is returned as data. */
  run(project: string): Promise<Record<string, unknown>> {
    return this.json("POST", "/projects/" + DeviceClient.p(project) + "/run", { passStatuses: [404, 409] });
  }

  stop(project: string): Promise<Record<string, unknown>> {
    return this.json("POST", "/projects/" + DeviceClient.p(project) + "/stop");
  }

  logs(since = 0): Promise<Logs> {
    return this.json("GET", "/logs", { query: { since } });
  }

  async eval(code: string, timeoutMs = 8000): Promise<EvalResult> {
    const r = await this.request("POST", "/eval", {
      json: { code, timeout_ms: timeoutMs },
      timeoutMs: Math.max(this.timeoutMs, timeoutMs + 2000),
      passStatuses: [408],
    });
    if (r.status === 408) return { ok: false, error: "timeout" };
    return (await r.json()) as EvalResult;
  }

  // ---- debugging: DAP over the device HTTP bridge (docs/DEBUGGING.md) ----
  /** Starts the saved project with debugpy waiting for a client. 403/404/409 come back as data ({error}). */
  debugStart(project: string): Promise<DebugStartResult> {
    return this.json("POST", "/projects/" + DeviceClient.p(project) + "/debug", {
      passStatuses: [403, 404, 409],
      timeoutMs: Math.max(this.timeoutMs, 30000),
    });
  }

  debugConnect(): Promise<Record<string, unknown>> {
    return this.json("POST", "/debug/connect", { json: {}, passStatuses: [409] });
  }

  debugRequest(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json("POST", "/debug/request", { json: message });
  }

  debugMessages(since: number): Promise<DebugMessages> {
    return this.json("GET", "/debug/messages", { query: { since } });
  }

  debugClose(): Promise<Record<string, unknown>> {
    return this.json("DELETE", "/debug");
  }

  /** Files of a project on the device (path + size); undefined when the project does not exist (404). */
  async projectFiles(project: string): Promise<RemoteFile[] | undefined> {
    const r = await this.request("GET", "/projects/" + DeviceClient.p(project) + "/files", { passStatuses: [404] });
    if (r.status === 404) return undefined;
    return ((await r.json()) as { files?: RemoteFile[] }).files ?? [];
  }

  /** Exact bytes of one project file (GET /projects/{name}/file?raw=1). */
  async readFileRaw(project: string, filePath: string): Promise<Buffer> {
    const r = await this.request("GET", "/projects/" + DeviceClient.p(project) + "/file", { query: { path: filePath, raw: "1" } });
    return Buffer.from(await r.arrayBuffer());
  }

  async screenPng(): Promise<Buffer> {
    const r = await this.request("GET", "/screen");
    return Buffer.from(await r.arrayBuffer());
  }
}
