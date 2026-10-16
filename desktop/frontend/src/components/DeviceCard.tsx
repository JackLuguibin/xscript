import { useState } from "react";
import type { Device } from "../api";
import { t } from "../strings";

function Row({ k, v }: { k: string; v: string | number | null | undefined }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v === null || v === undefined || v === "" ? "—" : String(v)}</dd>
    </>
  );
}

const yn = (b: boolean | undefined) => (b ? t.info.yes : t.info.no);

export function DeviceCard({ device, onDisconnect, busy }: { device: Device; onDisconnect: () => void; busy: boolean }) {
  const i = device.info;
  // A per-click nonce, not a counter: a counter restarts at 1 for every new card and Chromium would serve the cached image of the previous session.
  const [shotTick, setShotTick] = useState(0);
  const [shotFailed, setShotFailed] = useState(false);
  // Screenshots come over the custom scheme (xsapp://app/_shot/...), not through the JSON bridge (design §3.1).
  const shotUrl = shotTick ? `/_shot/${encodeURIComponent(device.id)}.jpg?max=360&t=${shotTick}` : "";
  return (
    <article className="card" aria-label={`device ${device.id}`}>
      <header className="row">
        <h3 className="grow">
          {i.name || i.model || device.id} <span className={"pill " + (device.state === "online" ? "ok" : "bad")}>{t.state[device.state] ?? device.state}</span>
        </h3>
        <button onClick={onDisconnect} disabled={busy}>
          {t.disconnect}
        </button>
      </header>
      <p className="muted mono">
        {device.transport === "adb" ? `adb ${device.serial} → ${device.address}` : device.address}
        {device.transport === "adb" && device.forwardPort ? ` (${t.forward} ${device.forwardPort})` : ""}
      </p>
      {device.warning && <div className="banner warn">{device.warning}</div>}
      {device.error && <div className="banner error">{device.error}</div>}
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
        <div className="shot">
          <button onClick={() => { setShotFailed(false); setShotTick((n) => Math.max(Date.now(), n + 1)); }}>{t.takeShot}</button>
          {shotUrl && !shotFailed && <img alt={t.screenshot} src={shotUrl} onError={() => setShotFailed(true)} />}
          {!i.capture && <p className="muted">{t.captureHint}</p>}
          {shotFailed && <p className="muted">{t.shotFailed}</p>}
        </div>
      </div>
    </article>
  );
}
