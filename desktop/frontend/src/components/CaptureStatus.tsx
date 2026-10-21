import type { DeviceInfo } from "../api";
import { t } from "../strings";
import { IconAlert, IconPhone, IconRefresh } from "./icons";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

export type CaptureState =
  | { kind: "ok"; via: string; lost: boolean }
  | { kind: "lost" }
  | { kind: "none" }
  | null;

/** What the screen page says about capture. null: nothing to say (older app that does not report capture_via). */
export function captureState(info: Partial<DeviceInfo> | undefined): CaptureState {
  if (!info) return null;
  const via = info.captureVia;
  if (via === undefined || via === null) return info.capture === false ? { kind: "none" } : null;
  if (via) return { kind: "ok", via, lost: Boolean(info.captureLost) };
  return info.captureLost ? { kind: "lost" } : { kind: "none" };
}

export function captureSourceLabel(via: string): string {
  return (t.capture.sources as Record<string, string>)[via] ?? via;
}

/** Small "截图：系统录屏" note for the toolbar while capture works. */
export function CaptureChip({ state }: { state: CaptureState }) {
  if (!state || state.kind !== "ok") return null;
  return (
    <span className="capture-chip" title={state.lost ? t.capture.fallbackHint : t.capture.okHint}>
      {t.capture.via(captureSourceLabel(state.via))}
    </span>
  );
}

/** The 截图状态 card: shown when the device cannot capture, with what happened and how to restore it. */
export function CaptureCard({
  state,
  onRecheck,
  busy,
  onRequest,
  requested,
}: {
  state: CaptureState;
  onRecheck: () => void;
  busy: boolean;
  /** 在手机上授权: bring up the grant dialog on the phone. */
  onRequest?: () => void;
  /** After asking: "sent" (what to do on the phone) or "old" (the app cannot be asked). */
  requested?: "sent" | "old" | null;
}) {
  if (!state || state.kind === "ok") return null;
  const lost = state.kind === "lost";
  return (
    <Alert tone="warn" role="region" aria-label={t.capture.title} className="capture-card">
      <IconAlert size={16} />
      <div className="grow">
        <strong>{lost ? t.capture.lostTitle : t.capture.noneTitle}</strong>
        <p>{lost ? t.capture.lostBody : t.capture.noneBody}</p>
        <ol>
          {(lost ? t.capture.lostSteps : t.capture.noneSteps).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {requested && (
          <p role="status" className="capture-requested">
            {requested === "sent" ? t.capture.requested : t.capture.requestOld}
          </p>
        )}
      </div>
      <div className="capture-actions">
        {onRequest && (
          <Button size="sm" variant="primary" onClick={onRequest} disabled={busy}>
            <IconPhone size={14} />
            {t.capture.request}
          </Button>
        )}
        <Button size="sm" onClick={onRecheck} disabled={busy}>
          <IconRefresh size={14} />
          {t.capture.recheck}
        </Button>
      </div>
    </Alert>
  );
}
