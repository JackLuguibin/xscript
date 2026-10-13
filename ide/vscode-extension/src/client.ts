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

export interface EvalResult {
  ok: boolean;
  result?: string;
  error?: string;
}

/** Accepts "host", "host:port" or "http://host:port/". */
export function parseTarget(value: string): DeviceTarget {
  let text = (value || "").trim();
  if (!text) return { host: "127.0.0.1", port: DEFAULT_PORT };
  if (text.includes("://")) text = text.split("://", 2)[1];
  text = text.replace(/\/+$/, "");
  const i = text.lastIndexOf(":");
  if (i < 0) return { host: text, port: DEFAULT_PORT };
  const port = Number(text.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("invalid port in device address: " + value);
  }
  return { host: text.slice(0, i) || "127.0.0.1", port };
}

export function baseUrl(t: DeviceTarget): string {
  return "http://" + t.host + ":" + t.port;
}

export class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super("HTTP " + status + (body ? ": " + body.slice(0, 200) : ""));
  }
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

  async screenPng(): Promise<Buffer> {
    const r = await this.request("GET", "/screen");
    return Buffer.from(await r.arrayBuffer());
  }
}
