import { useEffect, useId, useState } from "react";
import type { Device } from "../api";
import { describeCode } from "../errors";
import { t } from "../strings";
import { Badge } from "./Badge";
import { ErrorBanner } from "./ErrorBanner";
import { IconAlert, IconCamera, IconChevron, IconFolder, IconMonitor, IconPhone, IconUnlink, Spinner } from "./icons";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function Row({ k, v }: { k: string; v: string | number | null | undefined }) {
  return (
    <div className="kv-row">
      <dt>{k}</dt>
      <dd>{v === null || v === undefined || v === "" ? "—" : String(v)}</dd>
    </div>
  );
}

const yn = (b: boolean | undefined) => (b ? t.info.yes : t.info.no);

type ShotState = "idle" | "loading" | "loaded" | "failed";

/** Screenshot pixels to request: the card is ~13 rem wide, so ask for 360 css px × devicePixelRatio (crisp on HiDPI), capped. */
function shotMax(): number {
  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  return Math.min(1080, Math.round(360 * Math.max(1, dpr)));
}

export type DevicePageTarget = "mirror" | "projects";

/**
 * Compact device card: name, state, model and the primary buttons. Properties, the screenshot, the editable
 * name / group / note / auto-reconnect and 「忘记」 live under 「详情」 (collapsed by default) so a list of devices fits on screen.
 */
export function DeviceCard({
  device,
  onDisconnect,
  onForget,
  onRetry,
  onSave,
  onOpen,
  current = false,
  busy,
}: {
  device: Device;
  onDisconnect: () => void;
  onForget?: () => void;
  onRetry?: () => void;
  onSave?: (patch: { name: string; group: string; note: string; autoConnect: boolean }) => void;
  /** 「屏幕」/「工程」: make this the current device and go to that page */
  onOpen?: (page: DevicePageTarget) => void;
  /** this is the app-wide current device */
  current?: boolean;
  busy: boolean;
}) {
  const i = device.info;
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  // A per-click nonce, not a counter: a counter restarts at 1 for every new card and Chromium would serve the cached image of the previous session.
  const [shotTick, setShotTick] = useState(0);
  const [shot, setShot] = useState<ShotState>("idle");
  // Screenshots come over the custom scheme (xsapp://app/_shot/...), not through the JSON bridge (design §3.1).
  const shotUrl = shotTick ? `/_shot/${encodeURIComponent(device.id)}.jpg?max=${shotMax()}&t=${shotTick}` : "";
  const ratio = i.width && i.height ? `${i.width} / ${i.height}` : "9 / 19.5";
  const tone = device.state === "online" ? "ok" : device.state === "connecting" ? "warn" : "bad";
  const title = device.name || i.name || i.model || device.id;
  const [name, setName] = useState(device.name ?? "");
  const [group, setGroup] = useState(device.group ?? "");
  const [note, setNote] = useState(device.note ?? "");
  const [autoConnect, setAutoConnect] = useState(Boolean(device.autoConnect));
  useEffect(() => {
    setName(device.name ?? "");
    setGroup(device.group ?? "");
    setNote(device.note ?? "");
    setAutoConnect(Boolean(device.autoConnect));
  }, [device.name, device.group, device.note, device.autoConnect]);
  // the raw error comes from health polling; hiding it lasts until the error text changes
  const [hiddenError, setHiddenError] = useState("");
  const requestShot = () => {
    setShot("loading");
    setShotTick((n) => Math.max(Date.now(), n + 1));
  };
  const online = device.state === "online";
  const summary = [[i.brand, i.model].filter(Boolean).join(" "), i.android ? `Android ${i.android}` : "", i.width && i.height ? `${i.width}×${i.height}` : ""]
    .filter(Boolean)
    .join(" · ");
  const address =
    (device.transport === "adb"
      ? device.forwardPort
        ? `adb ${device.serial} → ${device.address}`
        : `adb ${device.serial || device.address}`
      : device.address) + (device.transport === "adb" && device.forwardPort ? ` (${t.forward} ${device.forwardPort})` : "");
  const hasStatus = !(device.saved && device.state === "offline" && Object.keys(device.status).length === 0);
  const showDisconnect = device.state !== "offline" || device.forwardPort > 0 || Boolean(device.error) || !device.saved;

  return (
    <article className={`card device-card${current ? " current" : ""}`} aria-label={`device ${device.id}`} aria-current={current ? "true" : undefined}>
      <header className="card-head">
        <span className="avatar" aria-hidden="true">
          <IconPhone size={22} />
        </span>
        <div className="titles">
          <div className="name">
            <h3>{title}</h3>
            {device.group ? <span className="muted">{device.group}</span> : null}
            <Badge tone={tone} busy={device.state === "connecting"}>
              {t.state[device.state] ?? device.state}
            </Badge>
            {i.running && <Badge tone="ok">{`${t.info.running}${i.project ? `：${i.project}` : ""}`}</Badge>}
            {current && <span className="tag">{t.flow.current}</span>}
          </div>
          <p className="muted summary">{summary || "—"}</p>
          <p className="muted mono addr">{address}</p>
        </div>
        <div className="card-actions">
          {online && onOpen && (
            <>
              <Button variant="primary" onClick={() => onOpen("mirror")} aria-label={t.flow.openMirrorOf(title)}>
                <IconMonitor size={16} />
                {t.flow.openMirror}
              </Button>
              <Button onClick={() => onOpen("projects")} aria-label={t.flow.openProjectsOf(title)}>
                <IconFolder size={16} />
                {t.flow.openProjects}
              </Button>
            </>
          )}
          {device.state === "offline" && onRetry && (
            <Button variant="primary" onClick={onRetry} disabled={busy} aria-label={`${t.saved.retry} ${device.serial || device.address}`}>
              {t.saved.retry}
            </Button>
          )}
          {showDisconnect && (
            <Button variant="danger" onClick={onDisconnect} disabled={busy}>
              {busy ? <Spinner /> : <IconUnlink size={16} />}
              {t.disconnect}
            </Button>
          )}
          <Button
            variant="ghost"
            className="details-toggle"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={t.flow.detailsOf(device.id)}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t.flow.hideDetails : t.flow.details}
            <IconChevron size={14} />
          </Button>
        </div>
      </header>
      {device.warning && (
        <Alert tone="warn">
          <IconAlert size={16} />
          <span className="grow">{device.warning}</span>
        </Alert>
      )}
      {device.error && device.error !== hiddenError && (
        <ErrorBanner
          info={describeCode(device.errorCode ?? "", device.error)}
          onDismiss={() => setHiddenError(device.error)}
          label={`${t.errorPrefix} ${device.id}`}
          role="status"
        />
      )}
      <div className="card-details" id={detailsId} hidden={!open}>
        {open && hasStatus && (
          <div className="card-body">
            <dl className="kv">
              <Row k={t.info.model} v={[i.brand, i.model].filter(Boolean).join(" ")} />
              <Row k={t.info.android} v={i.android} />
              <Row k={t.info.sdk} v={i.sdk} />
              <Row k={t.info.screen} v={i.width && i.height ? `${i.width}×${i.height}` : ""} />
              <Row k={t.info.density} v={i.density} />
              <Row k={t.info.version} v={i.version} />
              <Row k={t.info.ip} v={i.ip} />
              <Row k={t.info.deviceId} v={i.deviceId} />
              <Row k={t.info.running} v={i.running ? `${t.info.yes}${i.project ? ` (${i.project})` : ""}` : t.info.no} />
              <Row k={t.info.accessibility} v={yn(i.accessibility)} />
              <Row k={t.info.root} v={yn(i.root)} />
              <Row k={t.info.capture} v={yn(i.capture)} />
              <Row k={t.info.channel} v={i.channel} />
              <Row k={t.info.cloud} v={i.cloud} />
            </dl>
            <div className="shot" aria-busy={shot === "loading"}>
              <Button variant="bare" className={shot === "idle" ? "primary" : ""} onClick={requestShot} disabled={shot === "loading"}>
                {shot === "loading" ? <Spinner /> : <IconCamera size={16} />}
                {t.takeShot}
              </Button>
              <div className="shot-frame" style={{ aspectRatio: ratio }}>
                {shotUrl && shot !== "failed" && (
                  <img
                    className={shot === "loaded" ? "" : "loading"}
                    alt={t.screenshot}
                    src={shotUrl}
                    onLoad={() => setShot("loaded")}
                    onError={() => setShot("failed")}
                  />
                )}
                {shot === "idle" && (
                  <div className="overlay">
                    <IconCamera size={28} />
                    <span>{t.shotIdle}</span>
                  </div>
                )}
                {shot === "loading" && <div className="skeleton overlay" role="status" aria-label={t.shotLoading} />}
                {shot === "failed" && (
                  <div className="overlay fail" role="status">
                    <IconAlert size={28} />
                    <span>{t.shotFailed}</span>
                  </div>
                )}
              </div>
              {i.capture === false && (device.state !== "offline" || Boolean(device.error)) && <p className="hint">{t.captureHint}</p>}
            </div>
          </div>
        )}
        {open && device.saved && (onSave || onForget) && (
          <form
            className="saved-meta"
            onSubmit={(e) => {
              e.preventDefault();
              onSave?.({ name, group, note, autoConnect });
            }}
          >
            <label>
              {t.saved.name}
              <Input aria-label={`${t.saved.name} ${device.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </label>
            <label>
              {t.saved.group}
              <Input aria-label={`${t.saved.group} ${device.id}`} value={group} onChange={(e) => setGroup(e.target.value)} maxLength={80} />
            </label>
            <label>
              {t.saved.note}
              <Input aria-label={`${t.saved.note} ${device.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </label>
            <label className="check">
              <input type="checkbox" aria-label={`${t.saved.auto} ${device.id}`} checked={autoConnect} onChange={(e) => setAutoConnect(e.target.checked)} />
              {t.saved.auto}
            </label>
            {onSave && (
              <Button type="submit" size="sm" disabled={busy} aria-label={`${t.saved.save} ${device.id}`}>
                {t.saved.save}
              </Button>
            )}
            {onForget && (
              <Button variant="danger" size="sm" onClick={onForget} disabled={busy} aria-label={`${t.saved.forget} ${device.id}`}>
                {t.saved.forget}
              </Button>
            )}
          </form>
        )}
      </div>
    </article>
  );
}
