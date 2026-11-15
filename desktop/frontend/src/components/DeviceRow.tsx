import { mediaUrl } from "../bridge/electron";
import { useEffect, useId, useRef, useState } from "react";
import type { Device } from "../api";
import { describeCode, errorLine } from "../errors";
import { t } from "../strings";
import { Badge } from "./Badge";
import { ErrorBanner } from "./ErrorBanner";
import { IconAlert, IconCamera, IconRefresh, Spinner } from "./icons";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog } from "./ui/dialog";
import { TableCell } from "./ui/table";
import { ActionGroup } from "./ui/action-group";
import { PreviewLayout } from "./ui/preview-layout";
import { Toolbar } from "./ui/toolbar";
import { Field, FormActions } from "./ui/field";
import { ImagePreview } from "./ui/image-preview";

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

export type DevicePageTarget = "mirror" | "projects";

/** "abcd efgh" → "ABCD-EFGH" while typing; the backend normalizes again. */
export function formatPairCode(raw: string): string {
  const v = raw.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
  return v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
}

/** Inline pairing form for a device whose API wants the phone's pairing code. */
function PairForm({ title, onPair }: { title: string; onPair: (code: string) => Promise<unknown> }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const ready = code.replace(/-/g, "").length === 8;
  return (
    <Alert tone="warn" className="pair-box">
      <IconAlert size={16} />
      <div className="grow">
        <strong>{t.pair.title}</strong>
        <p className="muted">{t.pair.hint}</p>
        <form
          className="row pair-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) {
              setErr(t.pair.invalid);
              return;
            }
            setBusy(true);
            setErr("");
            onPair(code)
              .catch((x: unknown) => {
                // a refused code: the backend's own sentence ("配对码不正确…") says more than the generic title
                const o = x as { code?: unknown; message?: unknown };
                setErr(o && o.code === "device.unpaired" && o.message ? String(o.message) : errorLine(x));
              })
              .finally(() => setBusy(false));
          }}
        >
          <Input
            id={inputId}
            aria-label={t.pair.label(title)}
            className="mono pair-code"
            value={code}
            maxLength={9}
            onChange={(e) => {
              setCode(formatPairCode(e.target.value));
              setErr("");
            }}
            placeholder={t.pair.placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={err ? true : undefined}
          />
          <Button type="submit" variant="primary" disabled={busy || !ready}>
            {busy ? <Spinner /> : null}
            {t.pair.submit}
          </Button>
        </form>
        {err && (
          <p className="pair-error" role="alert">
            {err}
          </p>
        )}
      </div>
    </Alert>
  );
}

/** Compact table row; pairing, diagnostics, properties and editing live in the shared details dialog. */
export function DeviceRow({
  device,
  onDisconnect,
  onForget,
  onRetry,
  onSave,
  onOpen,
  onPair,
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
  /** the device is "unpaired": send the code the user typed (rejects with the RPC error when it is wrong) */
  onPair?: (code: string) => Promise<unknown>;
  /** this is the app-wide current device */
  current?: boolean;
  busy: boolean;
}) {
  const i = device.info;
  const detailsId = useId();
  const restoreFocus = useRef(true);
  const [open, setOpen] = useState(false);
  // A per-click nonce, not a counter: a counter restarts at 1 for every new card and Chromium would serve the cached image of the previous session.
  const [shotTick, setShotTick] = useState(0);
  const [shot, setShot] = useState<ShotState>("idle");
  // Screenshots come over the custom scheme (xsapp://app/_shot/...), not through the JSON bridge (design §3.1).
  const shotUrl = shotTick ? mediaUrl(`/_shot/${encodeURIComponent(device.id)}.jpg?max=native&format=png&t=${shotTick}`) : "";
  const ratio = i.width && i.height ? `${i.width} / ${i.height}` : "9 / 19.5";
  const tone = device.state === "online" ? "ok" : device.state === "connecting" || device.state === "unpaired" ? "warn" : "bad";
  const title = device.name || i.name || i.model || device.id;
  const defaultName = device.name || i.name || i.model || device.id;
  const defaultGroup = device.group || t.saved.defaultGroup;
  const defaultNote = device.note || `${device.transport === "adb" ? "USB / ADB" : "LAN"} · ${device.serial || device.address || device.id}`;
  const [name, setName] = useState(defaultName);
  const [group, setGroup] = useState(defaultGroup);
  const [note, setNote] = useState(defaultNote);
  const [autoConnect, setAutoConnect] = useState(Boolean(device.autoConnect));
  useEffect(() => {
    setName(defaultName);
    setGroup(defaultGroup);
    setNote(defaultNote);
    setAutoConnect(Boolean(device.autoConnect));
  }, [defaultName, defaultGroup, defaultNote, device.autoConnect]);
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
    <tr className={`device-row${current ? " current" : ""}`} aria-label={`device ${device.id}`} aria-current={current ? "true" : undefined}>
      <TableCell>
        <div className="device-table-name"><strong title={title}>{title}</strong>{current && <span className="tag">{t.deviceFlow.current}</span>}</div>
        <span className="muted device-table-text" title={device.group || ""}>{device.group || "—"}</span>
      </TableCell>
      <TableCell>
        <Badge tone={tone} busy={device.state === "connecting"}>{t.state[device.state] ?? device.state}</Badge>
        {i.running && <span className="device-table-text muted" title={i.project}>{t.info.running}</span>}
        {(device.error || device.warning) && <span className="device-table-notice device-table-text" title={device.error || device.warning}>{device.error ? describeCode(device.errorCode ?? "", device.error).title : device.warning}</span>}
      </TableCell>
      <TableCell className="device-model-cell"><span className="device-table-text" title={summary}>{summary || "—"}</span></TableCell>
      <TableCell><span className="device-table-text mono" title={address}>{address}</span></TableCell>
      <TableCell className="device-actions-cell">
        <ActionGroup label={t.deviceFlow.actions}>
          {online && onOpen && (
            <>
              <Button variant="action" onClick={() => onOpen("mirror")} aria-label={t.deviceFlow.openMirrorOf(title)}>
                {t.deviceFlow.openMirror}
              </Button>
              <Button variant="action" onClick={() => onOpen("projects")} aria-label={t.deviceFlow.openProjectsOf(title)}>
                {t.deviceFlow.openProjects}
              </Button>
            </>
          )}
          {device.state === "offline" && onRetry && (
            <Button variant="action" onClick={onRetry} disabled={busy} aria-label={`${t.saved.retry} ${device.serial || device.address}`}>
              {t.saved.retry}
            </Button>
          )}
          {showDisconnect && (
            <Button variant="actionDanger" onClick={onDisconnect} disabled={busy}>
              {busy && <Spinner />}
              {t.disconnect}
            </Button>
          )}
          <Button
            variant="action"
            className="details-toggle"
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-controls={open ? detailsId : undefined}
            aria-label={t.deviceFlow.detailsOf(device.id)}
            onClick={() => setOpen((o) => !o)}
          >
            {t.deviceFlow.details}
          </Button>
        </ActionGroup>
      {open && <Dialog title={t.deviceFlow.detailsOf(title)} titleId={detailsId} closeLabel={t.shortcuts.close}
        onClose={() => setOpen(false)} restoreFocus={restoreFocus} ownsKeys size="wide" className="device-details-dialog max-w-[62rem]">
      {device.warning && (
        <Alert tone="warn">
          <IconAlert size={16} />
          <span className="grow">{device.warning}</span>
        </Alert>
      )}
      {device.state === "unpaired" && onPair && <PairForm title={title} onPair={onPair} />}
      {device.error && device.error !== hiddenError && !(device.state === "unpaired" && onPair) && (
        <ErrorBanner
          info={describeCode(device.errorCode ?? "", device.error)}
          onDismiss={() => setHiddenError(device.error)}
          label={`${t.errorPrefix} ${device.id}`}
          role="status"
        />
      )}
      <PreviewLayout preview={hasStatus ? (
            <div className="shot" aria-busy={shot === "loading"}>
              <Toolbar label={t.screenshot} className="screenshot-toolbar" actions={
                <Button variant="ghost" size="sm" onClick={requestShot} disabled={shot === "loading"}>
                  {shot === "loading" ? <Spinner /> : <IconRefresh size={14} />}
                  {t.takeShot}
                </Button>
              }><span className="muted">{t.screenshot}</span></Toolbar>
              <div className="shot-frame" style={{ aspectRatio: ratio }}>
                {shotUrl && shot !== "failed" && (
                  <ImagePreview
                    viewLabel={t.deviceFlow.viewOriginal} fitLabel={t.deviceFlow.fitImage} closeLabel={t.shortcuts.close}
                    ready={shot === "loaded"}
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
      ) : undefined}>
          <form
            className="saved-meta"
            onSubmit={(e) => {
              e.preventDefault();
              onSave?.({ name, group, note, autoConnect });
            }}
          >
            {device.saved && (onSave || onForget) && <>
            <Field label={t.saved.name}>
              <Input aria-label={`${t.saved.name} ${device.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </Field>
            <Field label={t.saved.group}>
              <Input aria-label={`${t.saved.group} ${device.id}`} value={group} onChange={(e) => setGroup(e.target.value)} maxLength={80} />
            </Field>
            <Field label={t.saved.note}>
              <Input aria-label={`${t.saved.note} ${device.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </Field>
            </>}
        {hasStatus && (
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
        )}
            {device.saved && (onSave || onForget) && <FormActions className="device-meta-actions">
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
            </FormActions>}
          </form>
      </PreviewLayout>
      </Dialog>}
      </TableCell>
    </tr>
  );
}
