// Step-by-step connection check for "XScript: Connect to Device" (same steps and texts as the desktop app and PyCharm;
// the texts come from protocol/connect-check.json through src/generated/connectCheck.ts).
import * as net from "node:net";
import { DeviceTarget, HttpError, parseTarget } from "./client";
import { CONNECT_CHECK_STEPS } from "./generated/connectCheck";

export const TROUBLESHOOTING_URL = "https://github.com/JackLuguibin/xscript/blob/main/docs/TROUBLESHOOTING.md";
export const STEP_IDS = ["address", "reach", "app", "xscript", "pairing"] as const;
export type StepId = (typeof STEP_IDS)[number];

/** ok === null: not checked because an earlier step failed. */
export interface CheckStep {
  id: StepId;
  ok: boolean | null;
  detail: string;
}

export interface CheckDeps {
  connect: (t: DeviceTarget) => Promise<void>;
  status: (t: DeviceTarget) => Promise<Record<string, unknown>>;
}

/** Plain TCP connect: "refused" when nothing listens, "timeout" when nothing answers. */
export function tcpConnect(t: DeviceTarget, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: t.host, port: t.port });
    const done = (err?: Error) => {
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    sock.setTimeout(timeoutMs, () => done(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    sock.once("connect", () => done());
    sock.once("error", (e) => done(e));
  });
}

function reachDetail(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "unknown host";
  return code || (e as Error)?.message || String(e);
}

/** Same rule as the desktop app and PyCharm: any JSON object is not enough, a random local web server answers too. */
export function isXscriptStatus(s: unknown): s is Record<string, unknown> {
  return !!s && typeof s === "object" && !Array.isArray(s) && ["device_id", "app_id", "model"].some((k) => k in (s as object));
}

/** address → reach → app → xscript → pairing; stops at the first failure. Never throws. */
export async function runConnectCheck(value: string, deps: CheckDeps): Promise<CheckStep[]> {
  const steps: CheckStep[] = [];
  const finish = () => [...steps, ...STEP_IDS.slice(steps.length).map((id) => ({ id, ok: null, detail: "" }))];
  let target: DeviceTarget;
  try {
    target = parseTarget(value);
  } catch {
    steps.push({ id: "address", ok: false, detail: value.trim() });
    return finish();
  }
  steps.push({ id: "address", ok: true, detail: (target.host.includes(":") ? `[${target.host}]` : target.host) + ":" + target.port });
  try {
    await deps.connect(target);
  } catch (e) {
    steps.push({ id: "reach", ok: false, detail: reachDetail(e) });
    return finish();
  }
  steps.push({ id: "reach", ok: true, detail: "" });
  let s: Record<string, unknown>;
  try {
    s = await deps.status(target);
  } catch (e) {
    if (e instanceof HttpError) {
      steps.push({ id: "app", ok: true, detail: "" });
      if (e.status === 401) {
        steps.push({ id: "xscript", ok: true, detail: "" }, { id: "pairing", ok: false, detail: "" });
      } else {
        steps.push({ id: "xscript", ok: false, detail: e.message });
      }
    } else if (e instanceof SyntaxError) {
      steps.push({ id: "app", ok: true, detail: "" }, { id: "xscript", ok: false, detail: "not JSON" });
    } else {
      const err = e as { name?: string; message?: string; cause?: { code?: string } };
      const code = err?.cause?.code;
      // an adb forward with nothing behind it accepts the TCP connection, then closes it without an answer
      const closed = code === "UND_ERR_SOCKET" || code === "ECONNRESET";
      steps.push({ id: "app", ok: false, detail: err?.name === "TimeoutError" ? "timeout" : closed ? "closed without an answer" : code || err?.message || String(e) });
    }
    return finish();
  }
  steps.push({ id: "app", ok: true, detail: "" });
  if (!isXscriptStatus(s)) {
    steps.push({ id: "xscript", ok: false, detail: "not XScript" });
    return finish();
  }
  steps.push({ id: "xscript", ok: true, detail: [s.model, s.version].filter((v) => typeof v === "string" && v).join(" ") });
  if (s.pairing === true && s.paired === false) steps.push({ id: "pairing", ok: false, detail: "" });
  else steps.push({ id: "pairing", ok: true, detail: s.pairing === true ? "paired" : "off" });
  return finish();
}

/** All passed, or only the pairing code is missing (connecting asks for it next). */
export function canConnect(steps: CheckStep[]): boolean {
  return steps.every((s) => s.ok === true || s.id === "pairing");
}

export type Lang = "zh" | "en";
export function langOf(vscodeLanguage: string): Lang {
  return vscodeLanguage.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function text(id: StepId) {
  const t = CONNECT_CHECK_STEPS.find((s) => s.id === id);
  if (!t) throw new Error("no text for connection-check step " + id);
  return t;
}

export function stepTitle(id: StepId, lang: Lang): string {
  return text(id).title[lang];
}

export function stepFix(id: StepId, lang: Lang): string {
  return text(id).fix[lang];
}

/** The result as lines for the output channel: ✓ / ✗ / · per step, the fix under the failing one. */
export function formatCheck(address: string, steps: CheckStep[], lang: Lang): string[] {
  const skipped = lang === "zh" ? "未检查" : "not checked";
  const lines = [(lang === "zh" ? "逐项检查连接 " : "Connection check ") + address];
  for (const s of steps) {
    const mark = s.ok === true ? "✓" : s.ok === false ? "✗" : "·";
    const detail = s.ok === null ? " · " + skipped : s.detail ? " · " + s.detail : "";
    lines.push(`  ${mark} ${stepTitle(s.id, lang)}${detail}`);
    if (s.ok === false) lines.push("      " + (lang === "zh" ? "怎么修：" : "How to fix: ") + stepFix(s.id, lang));
  }
  if (steps.every((s) => s.ok === true)) lines.push(lang === "zh" ? "  全部通过，可以连接。" : "  All checks passed.");
  else lines.push("  " + (lang === "zh" ? "更多排查步骤：" : "More troubleshooting: ") + TROUBLESHOOTING_URL);
  return lines;
}

/** One-line summary for the notification: where it stopped and the fix. */
export function failureSummary(steps: CheckStep[], lang: Lang): string {
  const bad = steps.find((s) => s.ok === false);
  if (!bad) return "";
  const title = stepTitle(bad.id, lang) + (bad.detail ? ` (${bad.detail})` : "");
  return (lang === "zh" ? "停在「" + title + "」：" : "Stopped at “" + title + "”: ") + stepFix(bad.id, lang);
}
