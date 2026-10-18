/**
 * One place that turns an error (RpcError code + message + details) into what the user should read:
 * a short title, an actionable hint, and the raw detail kept for the collapsible 「详情 / 复制」 section.
 */
import { RpcError } from "./bridge/types";
import { t } from "./strings";

export interface ErrorInfo {
  title: string;
  /** What to do next; "" when the title says it all. */
  hint: string;
  code: string;
  /** Raw `message [code]` (+ details JSON) for the details / copy section. */
  detail: string;
}

function httpStatus(details: unknown): number | undefined {
  if (details && typeof details === "object" && "status" in details) {
    const s = (details as { status: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

function rawDetail(code: string, message: string, details: unknown): string {
  let out = code ? `${message} [${code}]` : message;
  if (details !== undefined && details !== null) {
    try {
      const json = JSON.stringify(details);
      if (json && json !== "{}") out += `\n${json}`;
    } catch {
      /* unserializable details stay out of the copy text */
    }
  }
  return out;
}

export function describeCode(code: string, message: string, details?: unknown): ErrorInfo {
  const e = t.errors;
  let key = code;
  // adb.not_ready covers several adb states; "unauthorized" is the common one and has its own fix
  if (code === "adb.not_ready" && /unauthori[sz]ed/i.test(message)) key = "adb.unauthorized";
  // the backend reports an unparsable address as device.protocol; it is a typo, not a foreign device
  else if (code === "device.protocol" && /^invalid (port in )?device address/.test(message)) key = "device.bad_address";
  let entry = e.codes[key];
  if (code === "device.http") {
    const status = httpStatus(details) ?? Number(/->\s*(\d{3})/.exec(message)?.[1] ?? NaN);
    const byStatus = Number.isFinite(status) ? e.http[status >= 500 ? "5xx" : String(status)] : undefined;
    if (byStatus) entry = byStatus;
  }
  const detail = rawDetail(code, message, details);
  if (!entry) return { title: message || e.unknown, hint: "", code, detail };
  // entries without a hint of their own: the backend message is already the specific, user-facing part
  const hint = entry.hint ?? (message && message !== entry.title ? message : "");
  return { title: entry.title, hint, code, detail };
}

export function describeError(err: unknown): ErrorInfo {
  if (err instanceof RpcError) return describeCode(err.code, err.message, err.details);
  if (err instanceof Error) return describeCode("", err.message);
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const o = err as { code: unknown; message: unknown; details?: unknown };
    return describeCode(String(o.code ?? ""), String(o.message ?? ""), o.details);
  }
  return describeCode("", err === undefined || err === null ? "" : String(err));
}

/** One-line form for inline (non-banner) spots such as form fields. */
export function errorLine(err: unknown): string {
  const i = describeError(err);
  return i.hint ? `${i.title}${t.errors.sep}${i.hint}` : i.title;
}
