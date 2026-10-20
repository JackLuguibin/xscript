import { useCallback, useEffect, useState } from "react";
import { useServices } from "../app-context";
import type { CloudAccount, CloudPackJob } from "../api";
import { errorLine } from "../errors";
import { t } from "../strings";
import { useConfirm } from "./ConfirmDialog";
import { Alert } from "./ui/alert";
import { Badge, type BadgeTone } from "./ui/badge";
import { Button } from "./ui/button";

const TONE: Record<string, BadgeTone> = { done: "ok", failed: "bad", cancelled: "neutral", running: "warn", queued: "neutral" };

function size(bytes: number | null): string {
  return bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "—";
}

/** The backend's APK pack jobs (P4.6): status, log, cancel (operator+), save the APK through the shell's save dialog. */
export function CloudPack({ account }: { account: CloudAccount }) {
  const { api } = useServices();
  const { confirm, dialog } = useConfirm();
  const [data, setData] = useState<{ available: boolean; reason: string; items: CloudPackJob[] } | null>(null);
  const [log, setLog] = useState<{ id: number; text: string } | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const load = useCallback(() => {
    api.cloudPackJobs().then(setData, (e) => setErr(errorLine(e)));
  }, [api]);
  useEffect(load, [load]);
  const fail = (e: unknown) => setErr(errorLine(e));

  return (
    <>
      <p className="muted">{t.cloud.pack.hint}</p>
      {data && !data.available && <Alert tone="warn">{t.cloud.pack.unavailable(data.reason)}</Alert>}
      {err && <Alert tone="error">{err}</Alert>}
      {note && <p role="status">{note}</p>}
      <div className="cloud-table-wrap">
        <table className="cloud-table">
          <thead>
            <tr>
              <th>{t.cloud.pack.cols.id}</th>
              <th>{t.cloud.pack.cols.app}</th>
              <th>{t.cloud.pack.cols.version}</th>
              <th>{t.cloud.pack.cols.status}</th>
              <th>{t.cloud.pack.cols.by}</th>
              <th>{t.cloud.pack.cols.size}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((j) => (
              <tr key={j.id}>
                <td className="mono">{j.id}</td>
                <td>
                  {j.app_name} <span className="muted mono">{j.app_id}</span>
                </td>
                <td>{j.version}</td>
                <td>
                  <Badge tone={TONE[j.status] ?? "neutral"}>{t.cloud.pack.status[j.status] ?? j.status}</Badge>
                  {j.error && <span className="muted"> {j.error}</span>}
                </td>
                <td>{j.created_by}</td>
                <td>{size(j.apk_size)}</td>
                <td>
                  <div className="row">
                    <Button
                      size="sm"
                      type="button"
                      onClick={() => (log?.id === j.id ? setLog(null) : api.cloudPackLog(j.id).then((r) => setLog({ id: j.id, text: r.text }), fail))}
                    >
                      {log?.id === j.id ? t.cloud.pack.hideLog : t.cloud.pack.log}
                    </Button>
                    {j.has_apk && (
                      <Button
                        size="sm"
                        type="button"
                        variant="primary"
                        onClick={() => {
                          setNote("");
                          api.cloudPackSave(j.id, `${j.app_name}-${j.version}.apk`).then((r) => r.saved && r.path && setNote(t.cloud.pack.saved(r.path)), fail);
                        }}
                      >
                        {t.cloud.pack.save}
                      </Button>
                    )}
                    {(j.status === "queued" || j.status === "running") && (
                      <Button
                        size="sm"
                        type="button"
                        variant="danger"
                        disabled={!account.canOperate}
                        onClick={async () => {
                          if (await confirm({ message: t.cloud.pack.cancelConfirm(j.id), confirmLabel: t.cloud.pack.cancel, danger: true }))
                            api.cloudPackCancel(j.id).then(load, fail);
                        }}
                      >
                        {t.cloud.pack.cancel}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {data && !data.items.length && (
              <tr>
                <td colSpan={7} className="muted">
                  {t.cloud.pack.empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {log && (
        <pre className="cloud-log" aria-label={t.cloud.pack.log}>
          {log.text}
        </pre>
      )}
      {dialog}
    </>
  );
}
