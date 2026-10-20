import { useState } from "react";
import { useServices } from "../app-context";
import type { CloudAccount, CloudBatchResult } from "../api";
import { errorLine } from "../errors";
import { t } from "../strings";
import { useConfirm } from "./ConfirmDialog";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** Run / stop on the selected cloud devices (P4.3). Greyed out for viewers; the backend refuses them anyway. */
export function CloudBatch({ account, selected, onDone }: { account: CloudAccount; selected: string[]; onDone?: () => void }) {
  const { api } = useServices();
  const { confirm, dialog } = useConfirm();
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<CloudBatchResult | null>(null);
  const blocked = !account.canOperate ? t.cloud.batch.viewerOnly : !selected.length ? t.cloud.batch.noSelection : "";

  const send = async (action: "run" | "stop") => {
    if (action === "stop" && !(await confirm({ message: t.cloud.batch.stopConfirm(selected.length), confirmLabel: t.cloud.batch.stop, danger: true }))) return;
    setBusy(true);
    setErr("");
    try {
      setResult(await api.cloudCommand(selected, action, action === "run" ? project.trim() : ""));
      onDone?.();
    } catch (e) {
      setErr(errorLine(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel cloud-batch" aria-label={t.cloud.batch.title}>
      <div className="row">
        <strong>{t.cloud.batch.title}</strong>
        <Input aria-label={t.cloud.batch.project} placeholder={t.cloud.batch.projectPlaceholder} value={project} disabled={!account.canOperate} onChange={(e) => setProject(e.target.value)} />
        <Button size="sm" type="button" variant="primary" disabled={!!blocked || busy || !project.trim()} title={blocked || undefined} onClick={() => void send("run")}>
          {busy ? t.cloud.batch.sending : t.cloud.batch.run}
        </Button>
        <Button size="sm" type="button" variant="danger" disabled={!!blocked || busy} title={blocked || undefined} onClick={() => void send("stop")}>
          {t.cloud.batch.stop}
        </Button>
        {blocked && <span className="muted">{blocked}</span>}
      </div>
      {err && <Alert tone="error">{err}</Alert>}
      {result && (
        <>
          <div className="row">
            <span role="status">{t.cloud.batch.summary(result.ok, result.total)}</span>
            <Button size="sm" type="button" variant="ghost" onClick={() => setResult(null)}>
              {t.cloud.batch.dismiss}
            </Button>
          </div>
          <div className="cloud-table-wrap cloud-results">
            <table className="cloud-table">
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>
                      <Badge tone={r.ok ? "ok" : r.offline ? "neutral" : "bad"}>{r.ok ? t.cloud.batch.done : r.offline ? t.cloud.batch.offline : t.cloud.batch.failed}</Badge>
                    </td>
                    <td className="muted">{r.msg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {dialog}
    </section>
  );
}
