import type { DeviceInfo } from "../api";
import { t } from "../strings";
import { IconAlert, IconRefresh } from "./icons";
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
export function CaptureCard({ state, onRecheck, busy }: { state: CaptureState; onRecheck: () => void; busy: boolean }) {
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
      </div>
      <Button size="sm" onClick={onRecheck} disabled={busy}>
        <IconRefresh size={14} />
        {t.capture.recheck}
      </Button>
    </Alert>
  );
}
