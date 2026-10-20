// Typed fetch wrapper for the FastAPI backend. Cookie session + CSRF header on writes.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(query?: Query): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? "?" + s : "";
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function errorFrom(r: Response): Promise<ApiError> {
  let msg = r.statusText || "HTTP " + r.status;
  try {
    const j = await r.json();
    msg = typeof j.error === "string" ? j.error : JSON.stringify(j.error ?? j);
  } catch {
    /* not JSON */
  }
  return new ApiError(r.status, msg);
}

export async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const headers: Record<string, string> = { "X-XScript-Csrf": "1" };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await fetch(path + qs(query), { method, headers, body: payload, credentials: "same-origin" });
  if (r.status === 401 && !path.startsWith("/api/auth/login")) onUnauthorized();
  if (!r.ok) throw await errorFrom(r);
  const type = r.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? r.json() : r.blob()) as Promise<T>;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>("GET", path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
};

/** Triggers a browser download of an authenticated GET (CSV, APK). */
export async function download(path: string, query?: Query, fallbackName = "download") {
  const r = await fetch(path + qs(query), { credentials: "same-origin" });
  if (r.status === 401) onUnauthorized();
  if (!r.ok) throw await errorFrom(r);
  const cd = r.headers.get("content-disposition") ?? "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  let name = fallbackName;
  if (m) {
    try {
      name = decodeURIComponent(m[1]);
    } catch {
      name = m[1]; // a plain filename that merely contains "%"
    }
  }
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------------------- types

/** reseller = 代理: no staff rank; only the 代理 console (/api/reseller/*). */
export type Role = "viewer" | "operator" | "admin" | "reseller";

export interface User {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  created_at: number;
  last_login_at: number | null;
  totp_enabled: boolean;
  /** Admin must enable 两步验证 before the console unlocks (setting require_totp_admin). */
  needs_totp_setup: boolean;
}

/** Login answer when the password is right but a 两步验证 code is still needed. */
export interface TotpRequired {
  totp_required: true;
}

export interface TotpSetup {
  secret: string;
  uri: string;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface Device {
  id: string;
  device_id: string;
  app: string;
  model: string;
  brand: string;
  group: string;
  reported_group: string;
  group_override: string;
  note: string;
  online: boolean;
  running: boolean;
  project: string | null;
  channel?: string;
  version?: string;
  sdk?: number;
  release?: string;
  width?: number | null;
  height?: number | null;
  data: Record<string, unknown>;
  remote: string;
  first_seen: number;
  last_seen: number;
  connected_at: number | null;
  status?: Record<string, unknown>;
  last_run?: {
    project: string;
    exit: string;
    crashed: boolean;
    time: number;
    tail: { stream: string; line: string }[];
  } | null;
}

export interface CommandReply {
  code?: number;
  msg?: string;
  path?: string;
  result?: Record<string, unknown> & { image?: string };
  [k: string]: unknown;
}

export interface CommandResult {
  results: Record<string, CommandReply>;
  devices: number;
  ok: number;
}

export interface Group {
  name: string;
  total: number;
  online: number;
}

export interface DeviceKey {
  id: number;
  name: string;
  hint: string;
  created_at: number;
  created_by: string;
  revoked: boolean;
  last_used_at: number | null;
  online: number;
  token?: string;
}

export interface Task {
  id: number;
  name: string;
  target: string;
  command: Record<string, unknown> & { path: string };
  daily: string | null;
  every: number | null;
  enabled: boolean;
  last_run: number | null;
  next_run: number | null;
  last_result: { time: number; devices?: number; ok?: number; error?: string; results?: Record<string, CommandReply> } | null;
  created_by: string;
  created_at: number;
}

export type CardStatus = "unused" | "active" | "expired" | "exhausted" | "unbound" | "revoked";

export interface Card {
  card: string;
  batch: string;
  days: number;
  app: string;
  note: string;
  created_at: number;
  device: string | null;
  model: string | null;
  activated_at: number | null;
  expires_at: number | null;
  revoked: boolean;
  last_verified_at: number | null;
  status: CardStatus;
  kind: "normal" | "trial" | "count";
  max_devices: number;
  stack: boolean;
  uses_total: number;
  uses_left: number;
  /** 代理 that generated the card; null = staff. */
  owner_id: number | null;
  devices: { device: string; model: string }[];
}

export type CardKind = "normal" | "trial" | "count";

/** 代理 limits and quota (quota = cards the reseller may ever generate; used never goes down). */
export interface ResellerLimits {
  quota: number;
  used: number;
  left: number;
  apps: string[];
  kinds: CardKind[];
  max_days: number;
  max_devices: number;
  max_uses: number;
}

export interface ResellerMe extends ResellerLimits {
  username: string;
  cards: CardStats;
}

export interface ResellerRow extends ResellerLimits {
  id: number;
  username: string;
  disabled: boolean;
  last_login_at: number | null;
  /** Admin-only note about the 代理. */
  note: string;
  cards: CardStats;
  activations_30d: number;
}

export interface AbuseItem {
  time: number;
  subject: string;
  ip: string;
  signal: string;
  label: string;
  count: number;
  threshold: number;
}

export interface DeviceBanItem {
  device: string;
  reason: string;
  created_by: string;
  created_at: number;
}

export interface CardStats extends Record<CardStatus, number> {
  total: number;
}

export interface Batch {
  batch: string;
  app: string;
  days: number;
  note: string;
  count: number;
  bound: number;
  created_at: number;
  kind: "normal" | "trial" | "count";
  max_devices: number;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface PackJob {
  id: number;
  status: JobStatus;
  app_id: string;
  app_name: string;
  version: string;
  version_code: number;
  project_name: string;
  options: Record<string, unknown>;
  created_by: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  apk_size: number | null;
  error: string | null;
  has_apk: boolean;
  queue_position: number | null;
}

export interface AuditEntry {
  id: number;
  time: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  ip: string;
}

export type WebhookKind = "wecom" | "dingtalk" | "feishu" | "generic";

export interface Webhook {
  name: string;
  kind: WebhookKind;
  url: string;
  events: string[];
  secret?: string;
  has_secret?: boolean;
}

export interface Settings {
  site_name: string;
  public_url: string;
  version: string;
  license_public_key: string;
  release_signing: boolean;
  keep_pack_jobs: number;
  audit_days: number;
  backup_daily: boolean;
  backup_hour: number;
  keep_backups: number;
  alert_webhooks: Webhook[];
  alert_offline_minutes: number;
  alert_events: Record<string, string>;
  require_totp_admin: boolean;
  device_log_days: number;
  abuse_card_devices: number;
  abuse_device_cards: number;
  abuse_ip_devices: number;
  abuse_ip_failures: number;
  login_ip_allowlist: string[];
  login_ip_allowlist_on: boolean;
  your_ip: string;
  /** 后台 AI 写脚本: overrides XSCRIPT_AI_BASE_URL / XSCRIPT_AI_MODEL ("" = environment). The key is env-only. */
  ai_base_url: string;
  ai_model: string;
}

export interface MaintenanceInfo {
  usage: { database: number; pack: number; scripts: number; backups: number };
  backups: { name: string; size: number; created_at: number }[];
  last_backup: { time: number; name?: string; ok: boolean; error?: string } | null;
  last_retention: {
    time: number;
    apks: number;
    audit: number;
    shares: number;
    backups: number;
    device_logs?: number;
  } | null;
}

export interface Overview {
  devices: { online: number; running: number; total: number; active_24h: number };
  cards: CardStats;
  tasks: { total: number; enabled: number };
  pack: { queued: number; running: number };
  events: { time: number; text: string }[];
  crashes: { device: string; model: string; project: string; exit: string; time: number; error: string }[];
  scripts: { total: number; published: number };
  alerts_24h: number;
  last_backup: { time: number; name?: string; ok: boolean; error?: string } | null;
}

export type TrendKey = "activations" | "expirations" | "new_devices" | "online_devices";

/** Any trend payload: the 概览 one (DailyStats) or a 代理's card-only one (created / activations / expirations). */
export interface TrendData {
  days: string[];
  series: Record<string, number[]>;
  totals: Record<string, number>;
  expiring_7d: number;
  by_app: { name: string; count: number }[];
  by_batch: { name: string; count: number }[];
  timezone: string;
}

/** GET /api/stats/daily: per server-local day, oldest first. */
export interface DailyStats {
  days: string[];
  series: Record<TrendKey, number[]>;
  totals: { activations: number; expirations: number; new_devices: number; online_peak: number };
  expiring_7d: number;
  by_app: { name: string; count: number }[];
  by_batch: { name: string; count: number }[];
  timezone: string;
}

export interface ScriptVersion {
  id: number;
  version: string;
  version_code: number;
  notes: string;
  sha256: string;
  size: number;
  files: number;
  downloads: number;
  created_by: string;
  created_at: number;
  current: boolean;
}

export interface Script {
  id: number;
  name: string;
  project_name: string;
  description: string;
  protect: boolean;
  channel: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  versions: number;
  current: ScriptVersion | null;
  latest: ScriptVersion | null;
}

export interface ShareLink {
  id: number;
  job_id: number;
  token: string;
  path: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  downloads: number;
  disabled: boolean;
}

export interface PublicShare {
  app_name: string;
  app_id: string;
  version: string;
  version_code: number;
  size: number | null;
  built_at: number | null;
  expires_at: number | null;
  site_name: string;
  apk: string;
}

export interface ApiToken {
  id: number;
  name: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  token?: string;
}

/** 后台 AI 写脚本: model config without the key (XSCRIPT_AI_KEY stays on the server). */
export interface AiStatus {
  configured: boolean;
  base_url: string;
  model: string;
  key_set: boolean;
  source: "settings" | "env";
}

export interface AiResult {
  code: string;
  notes: string;
  /** "" when the code parses; otherwise "第 N 行: …". Nothing is executed on the server. */
  syntax_error: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  ms: number;
}
