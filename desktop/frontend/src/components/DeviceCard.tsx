import { useEffect, useState } from "react";
import type { Device } from "../api";
import { t } from "../strings";
import { Badge } from "./Badge";
import { IconAlert, IconCamera, IconPhone, IconUnlink, Spinner } from "./icons";

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

export function DeviceCard({ device, onDisconnect, onForget, onRetry, onSave, busy }: {
  device: Device;
  onDisconnect: () => void;
  onForget?: () => void;
  onRetry?: () => void;
  onSave?: (patch: { name: string; group: string; note: string; autoConnect: boolean }) => void;
  busy: boolean;
}) {
  const i = device.info;
  // A per-click nonce, not a counter: a counter restarts at 1 for every new card and Chromium would serve the cached image of the previous session.
  const [shotTick, setShotTick] = useState(0);
  const [shot, setShot] = useState<ShotState>("idle");
  // Screenshots come over the custom scheme (xsapp://app/_shot/...), not through the JSON bridge (design §3.1).
  const shotUrl = shotTick ? `/_shot/${encodeURIComponent(device.id)}.jpg?max=${shotMax()}&t=${shotTick}` : "";
  const ratio = i.width && i.height ? `${i.width} / ${i.height}` : "9 / 19.5";
  const tone = device.state === "online" ? "ok" : device.state === "connecting" ? "warn" : "bad";
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
  const requestShot = () => {
    setShot("loading");
    setShotTick((n) => Math.max(Date.now(), n + 1));
  };
  return (
    <article className="card" aria-label={`device ${device.id}`}>
      <header className="card-head">
        <span className="avatar" aria-hidden="true">
          <IconPhone size={22} />
        </span>
        <div className="titles">
          <div className="name">
            <h3>{device.name || i.name || i.model || device.id}</h3>
            {device.group ? <span className="muted">{device.group}</span> : null}
            <Badge tone={tone} busy={device.state === "connecting"}>
              {t.state[device.state] ?? device.state}
            </Badge>
          </div>
          <p className="muted mono addr">
            {device.transport === "adb"
              ? device.forwardPort
                ? `adb ${device.serial} → ${device.address}`
                : `adb ${device.serial || device.address}`
              : device.address}
            {device.transport === "adb" && device.forwardPort ? ` (${t.forward} ${device.forwardPort})` : ""}
          </p>
        </div>
        {device.state === "offline" && onRetry ? (
          <div className="card-actions">
            <button type="button" onClick={onRetry} disabled={busy} aria-label={`${t.saved.retry} ${device.serial || device.address}`}>
              {t.saved.retry}
            </button>
            {(device.forwardPort > 0 || Boolean(device.error) || !device.saved) && (
              <button type="button" className="danger" onClick={onDisconnect} disabled={busy}>
                {busy ? <Spinner /> : <IconUnlink size={16} />}
                {t.disconnect}
              </button>
            )}
            {device.saved && onForget && (
              <button type="button" className="small" onClick={onForget} disabled={busy} aria-label={`${t.saved.forget} ${device.id}`}>
                {t.saved.forget}
              </button>
            )}
          </div>
        ) : (
          <>
            <button className="danger" onClick={onDisconnect} disabled={busy}>
              {busy ? <Spinner /> : <IconUnlink size={16} />}
              {t.disconnect}
            </button>
            {device.saved && onForget && (
              <button type="button" className="small" onClick={onForget} disabled={busy} aria-label={`${t.saved.forget} ${device.id}`}>
                {t.saved.forget}
              </button>
            )}
          </>
        )}
      </header>
      {device.saved && onSave && (
        <form
          className="saved-meta"
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ name, group, note, autoConnect });
          }}
        >
          <label>
            {t.saved.name}
            <input aria-label={`${t.saved.name} ${device.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
          <label>
            {t.saved.group}
            <input aria-label={`${t.saved.group} ${device.id}`} value={group} onChange={(e) => setGroup(e.target.value)} maxLength={80} />
          </label>
          <label>
            {t.saved.note}
            <input aria-label={`${t.saved.note} ${device.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
          <label className="check">
            <input type="checkbox" aria-label={`${t.saved.auto} ${device.id}`} checked={autoConnect} onChange={(e) => setAutoConnect(e.target.checked)} />
            {t.saved.auto}
          </label>
          <button type="submit" className="small" disabled={busy} aria-label={`${t.saved.save} ${device.id}`}>
            {t.saved.save}
          </button>
        </form>
      )}
      {device.warning && (
        <div className="banner warn">
          <IconAlert size={16} />
          <span className="grow">{device.warning}</span>
        </div>
      )}
      {device.error && (
        <div className="banner error">
          <IconAlert size={16} />
          <span className="grow">{device.error}</span>
        </div>
      )}
      {!(device.saved && device.state === "offline" && Object.keys(device.status).length === 0) && <div className="card-body">
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
          <button className={shot === "idle" ? "primary" : ""} onClick={requestShot} disabled={shot === "loading"}>
            {shot === "loading" ? <Spinner /> : <IconCamera size={16} />}
            {t.takeShot}
          </button>
          <div className="shot-frame" style={{ aspectRatio: ratio }}>
            {shotUrl && shot !== "failed" && (
              <img className={shot === "loaded" ? "" : "loading"} alt={t.screenshot} src={shotUrl} onLoad={() => setShot("loaded")} onError={() => setShot("failed")} />
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
      </div>}
    </article>
  );
}
