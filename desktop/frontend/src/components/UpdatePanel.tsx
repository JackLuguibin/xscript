import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateInfo, UpdateStatus } from "../api";
import { useServices } from "../app-context";
import { RpcError } from "../bridge/types";
import { errorLine } from "../errors";
import { getLanguage, t } from "../strings";
import { useConfirm } from "./ConfirmDialog";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

export const AUTO_KEY = "xs.update.auto";
export const LAST_KEY = "xs.update.lastCheck";
const DAY = 24 * 3600 * 1000;

export function autoCheckEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}

export function formatSize(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function kindLine(kind: string, message: string): string {
  const k = t.update.kinds[kind];
  return k ? `${k}${t.errors.sep}${message}` : message;
}

function rpcLine(e: unknown): string {
  if (e instanceof RpcError && e.code.startsWith("update.")) return kindLine(e.code.slice(7), e.message);
  return errorLine(e);
}

/**
 * Desktop auto-update (P5.4), in the settings dialog: check → (user) download → verified → (user confirms) install and
 * restart. The shell checks the Ed25519-signed manifest and the file's sha256; the page only shows the state.
 */
export function UpdatePanel() {
  const { api } = useServices();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [err, setErr] = useState("");
  const [auto, setAuto] = useState(autoCheckEnabled);
  const { confirm, dialog } = useConfirm();
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
  };
  useEffect(() => {
    let dead = false;
    api.updateInfo().then(
      (i) => {
        if (dead) return;
        setInfo(i);
        setSt(i);
      },
      (e) => !dead && setErr(rpcLine(e)),
    );
    return () => {
      dead = true;
      stopPoll();
    };
  }, [api]);

  const run = useCallback(async (f: () => Promise<UpdateStatus>) => {
    setErr("");
    try {
      setSt(await f());
    } catch (e) {
      setErr(rpcLine(e));
    }
  }, []);

  const check = () =>
    run(async () => {
      setSt((s) => (s ? { ...s, state: "checking", error: null } : s));
      const r = await api.updateCheck();
      try {
        localStorage.setItem(LAST_KEY, String(Date.now()));
      } catch {
        /* private mode */
      }
      return r;
    });

  const download = () =>
    run(async () => {
      setSt((s) => (s ? { ...s, state: "downloading", error: null } : s));
      stopPoll();
      poll.current = setInterval(() => {
        api.updateStatus().then((s) => s.state === "downloading" && setSt(s), () => undefined);
      }, 500);
      try {
        return await api.updateDownload();
      } finally {
        stopPoll();
      }
    });

  const install = async () => {
    const v = st?.update?.version ?? "";
    const ok = await confirm({ title: t.update.confirmTitle, message: t.update.confirm(v), confirmLabel: t.update.install });
    if (ok) await run(() => api.updateInstall());
  };

  const toggleAuto = (on: boolean) => {
    setAuto(on);
    try {
      localStorage.setItem(AUTO_KEY, on ? "1" : "0");
    } catch {
      /* private mode */
    }
  };

  const u = st?.update;
  const busy = st?.state === "checking" || st?.state === "downloading" || st?.state === "installing";
  const pct = st && st.progress.total ? Math.floor((100 * st.progress.done) / st.progress.total) : 0;
  const notes = u ? (u.notes[getLanguage()] ?? u.notes.zh ?? u.notes.en ?? "") : "";
  return (
    <section className="update-panel" aria-labelledby="update-title">
      <h3 id="update-title">{t.update.section}</h3>
      {info && (
        <p>
          <strong>{t.update.version(info.version)}</strong>
          {info.platform && <span className="muted mono"> · {info.platform}</span>}
        </p>
      )}
      {info && !info.configured && <p className="muted">{info.platform ? t.update.notConfigured : t.update.noPlatform}</p>}
      {info && info.configured && !info.platform && <p className="muted">{t.update.noPlatform}</p>}
      {info?.configured && (
        <>
          <div className="update-actions">
            <Button onClick={() => void check()} disabled={busy}>
              {st?.state === "checking" ? t.update.checking : t.update.check}
            </Button>
            <label className="update-auto">
              <input type="checkbox" checked={auto} onChange={(e) => toggleAuto(e.target.checked)} />
              {t.update.auto}
            </label>
          </div>
          <p className="muted mono update-feed" title={t.update.feed}>
            {info.feed}
          </p>
        </>
      )}
      {st?.state === "none" && <p role="status">{t.update.none}</p>}
      {u && u.newer && st && ["available", "downloading", "ready", "installing", "error"].includes(st.state) && (
        <div className="update-offer">
          <p role="status">
            <strong>{t.update.available(u.version)}</strong>
            {u.published && <span className="muted"> · {t.update.published(u.published.slice(0, 10))}</span>}
          </p>
          {notes && <p className="update-notes">{notes}</p>}
          {(st.state === "available" || (st.state === "error" && st.error?.kind !== "install")) && (
            <Button onClick={() => void download()}>{t.update.download(formatSize(u.asset.size))}</Button>
          )}
          {st.state === "downloading" && (
            <div className="update-progress">
              <progress max={100} value={pct} aria-label={t.update.downloading(pct)} />
              <span>{t.update.downloading(pct)}</span>
            </div>
          )}
          {st.state === "ready" && (
            <>
              <p className="muted">{t.update.ready}</p>
              {info?.canInstall ? (
                <Button variant="primary" onClick={() => void install()}>
                  {t.update.install}
                </Button>
              ) : (
                <p className="muted">
                  {t.update.manual} <span className="mono">{u.asset.name}</span>
                </p>
              )}
            </>
          )}
          {st.state === "installing" && <p role="status">{t.update.installing}</p>}
        </div>
      )}
      {st?.state === "error" && st.error && <Alert tone="error" role="alert">{kindLine(st.error.kind, st.error.message)}</Alert>}
      {err && <Alert tone="error" role="alert">{err}</Alert>}
      {dialog}
    </section>
  );
}

/** Startup check (at most once a day, when enabled and configured): the version to badge, or null. */
export function useUpdateBadge(enabled: boolean): string | null {
  const { api } = useServices();
  const [ver, setVer] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !autoCheckEnabled()) return;
    let dead = false;
    void (async () => {
      try {
        const info = await api.updateInfo();
        if (!info.configured || !info.platform) return;
        if (info.update?.newer) {
          if (!dead) setVer(info.update.version);
          return;
        }
        const last = Number(localStorage.getItem(LAST_KEY) || 0);
        if (Date.now() - last < DAY) return;
        localStorage.setItem(LAST_KEY, String(Date.now()));
        const s = await api.updateCheck();
        if (!dead && s.state === "available" && s.update) setVer(s.update.version);
      } catch {
        /* the badge is best effort; the settings dialog shows errors */
      }
    })();
    return () => {
      dead = true;
    };
  }, [api, enabled]);
  return ver;
}

/** Diagnostics bundle (P5.5): the shell asks where to save and writes a redacted zip. */
export function DiagnosticsPanel() {
  const { api } = useServices();
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const r = await api.diagnostics();
      if (r.saved && r.path) setMsg(t.update.diagSaved(r.path, r.files?.length ?? 0));
    } catch (e) {
      setErr(errorLine(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="update-panel" aria-labelledby="diag-title">
      <h3 id="diag-title">{t.update.diagTitle}</h3>
      <p className="muted">{t.update.diagHint}</p>
      <div className="update-actions">
        <Button onClick={() => void save()} disabled={busy}>
          {t.update.diagExport}
        </Button>
      </div>
      {msg && <p role="status" className="mono update-feed">{msg}</p>}
      {err && (
        <Alert tone="error" role="alert">
          {err}
        </Alert>
      )}
    </section>
  );
}
