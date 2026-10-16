import { useEffect, useState } from "react";
import { useServices } from "../app-context";
import { t } from "../strings";
import { Spinner } from "./icons";

const KEY = "xscript.syncdir.";

function stored(key: string): string {
  try {
    return window.localStorage.getItem(KEY + key) ?? "";
  } catch {
    return "";
  }
}

/** Local folder ⇄ device project (the VS Code extension's upload/pull, done by Python: the page never touches the disk). */
export function SyncPanel({ devId, project, onSynced, onError }: { devId: string; project: string; onSynced: () => void; onError: (e: unknown) => void }) {
  const { api, rpc } = useServices();
  const key = `${devId}/${project}`;
  const [dir, setDir] = useState(() => stored(key));
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setDir(stored(key));
    setMsg("");
  }, [key]);

  useEffect(
    () =>
      rpc.on("sync.progress", (d) => {
        const p = d as { id: string; project: string; sent: number; total: number };
        if (p.id === devId && p.project === project) setMsg(t.sync.progress(p.sent, p.total));
      }),
    [rpc, devId, project],
  );

  const remember = (v: string) => {
    setDir(v);
    try {
      window.localStorage.setItem(KEY + key, v);
    } catch {
      /* not persisted */
    }
  };

  const go = async (what: string, fn: () => Promise<string>) => {
    setBusy(what);
    setMsg("");
    try {
      setMsg(await fn());
    } catch (e) {
      onError(e);
    } finally {
      setBusy("");
    }
  };

  const pick = () =>
    go("pick", async () => {
      const r = await api.pickDirectory(t.sync.dir);
      if (r.path) remember(r.path);
      return "";
    });
  const preview = () =>
    go("preview", async () => {
      const p = await api.syncPreview(devId, project, dir);
      return p.upload.length ? `${t.sync.plan(p.upload.length, p.skipped.length)}：${p.upload.slice(0, 8).join("、")}${p.upload.length > 8 ? "…" : ""}` : t.sync.planNone;
    });
  const upload = (full: boolean) =>
    go(full ? "full" : "upload", async () => {
      const p = await api.syncUpload(devId, project, dir, full);
      onSynced();
      return t.sync.uploaded(p.uploaded ?? p.upload.length, p.skipped.length);
    });
  const pull = () =>
    go("pull", async () => {
      const r = await api.syncPull(devId, project, dir);
      return t.sync.pulled(r.written, r.added.length, r.changed.length);
    });

  const off = busy !== "" || !dir.trim();
  return (
    <section aria-labelledby="h-sync" className="sync">
      <h3 id="h-sync" className="sub-head">
        {t.sync.title}
      </h3>
      <div className="row">
        <input aria-label={t.sync.dir} className="grow mono" value={dir} onChange={(e) => remember(e.target.value)} placeholder={t.sync.dirPlaceholder} spellCheck={false} />
        <button className="small" onClick={() => void pick()} disabled={busy !== ""}>
          {busy === "pick" ? <Spinner /> : t.sync.pick}
        </button>
      </div>
      <div className="row wrap" style={{ marginTop: "var(--sp-2)" }}>
        <button className="small" onClick={() => void preview()} disabled={off}>
          {busy === "preview" ? <Spinner /> : t.sync.preview}
        </button>
        <button className="small primary" onClick={() => void upload(false)} disabled={off}>
          {busy === "upload" ? <Spinner /> : t.sync.upload}
        </button>
        <button className="small" onClick={() => void upload(true)} disabled={off}>
          {busy === "full" ? <Spinner /> : t.sync.full}
        </button>
        <button className="small" onClick={() => void pull()} disabled={off}>
          {busy === "pull" ? <Spinner /> : t.sync.pull}
        </button>
      </div>
      {msg && (
        <p className="hint" role="status">
          {msg}
        </p>
      )}
      <p className="hint">{t.sync.hint}</p>
    </section>
  );
}
