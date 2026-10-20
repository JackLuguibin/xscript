import { useCallback, useEffect, useMemo, useState } from "react";
import { useServices } from "../app-context";
import type { CloudAccount, CloudDeployResult, CloudGroup, CloudVersion } from "../api";
import { errorLine } from "../errors";
import { deployPlan } from "../flow/deploy";
import { readDraft } from "../flow/draft";
import { parse } from "../flow/dsl";
import { SAMPLE_FLOW } from "../flow/sample";
import { builtinSpecs } from "../flow/specs";
import { t } from "../strings";
import { seenText } from "./CloudDevices";
import { useConfirm } from "./ConfirmDialog";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

/** The flow the editor has open (same choice as the flow page's boot), compiled into the files of its device project. */
export function currentFlowPlan() {
  const kept = readDraft();
  for (const source of kept ? [kept.text, kept.valid] : []) {
    try {
      return deployPlan(parse(source), builtinSpecs(), kept?.layout ?? null);
    } catch {
      // fall through to the last valid text, then the sample
    }
  }
  return deployPlan(parse(SAMPLE_FLOW), builtinSpecs(), null);
}

function Results({ result }: { result: CloudDeployResult }) {
  return (
    <>
      <p role="status">{t.cloud.deploy.done(result.version, result.ok, result.total)}</p>
      {result.rows.length > 0 && (
        <div className="cloud-table-wrap cloud-results">
          <table className="cloud-table">
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td>
                    <Badge tone={r.ok ? "ok" : "bad"}>{r.ok ? t.cloud.batch.done : t.cloud.batch.failed}</Badge>
                  </td>
                  <td className="muted">{r.msg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Deploy the open flow to a device group as a new backend version, and roll back to an earlier one (P4.5). Admin only. */
export function CloudDeploy({ account }: { account: CloudAccount }) {
  const { api } = useServices();
  const { confirm, dialog } = useConfirm();
  const plan = useMemo(currentFlowPlan, []);
  const [groups, setGroups] = useState<CloudGroup[]>([]);
  const [group, setGroup] = useState("");
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [run, setRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<CloudDeployResult | null>(null);
  const [history, setHistory] = useState<{ scriptId: number | null; versions: CloudVersion[] } | null>(null);
  const admin = account.isAdmin;
  const project = plan.ok ? plan.project : "";

  const loadHistory = useCallback(() => {
    if (!project) return;
    api.cloudFlowVersions(project).then(setHistory, (e) => setErr(errorLine(e)));
  }, [api, project]);
  useEffect(() => {
    api.cloudGroups().then((r) => setGroups(r.groups), () => undefined);
    loadHistory();
  }, [api, loadHistory]);

  const go = async (work: () => Promise<CloudDeployResult>, question: string) => {
    if (!(await confirm({ message: question, confirmLabel: t.cloud.deploy.deploy }))) return;
    setBusy(true);
    setErr("");
    setResult(null);
    try {
      setResult(await work());
      setVersion("");
      loadHistory();
    } catch (e) {
      setErr(errorLine(e));
    } finally {
      setBusy(false);
    }
  };

  if (!plan.ok) return <Alert tone="error">{t.cloud.deploy.badFlow(plan.detail)}</Alert>;
  return (
    <>
      {!admin && <p className="muted">{t.cloud.deploy.adminOnly}</p>}
      <section className="panel cloud-batch" aria-label={t.cloud.deploy.deploy}>
        <div className="row">
          <strong>
            {t.cloud.deploy.flow}: <span className="mono">{plan.project}</span>
          </strong>
          <span className="muted">{t.cloud.deploy.fromEditor}</span>
        </div>
        <div className="cloud-form">
          <label className="stack">
            {t.cloud.deploy.group}
            <Select aria-label={t.cloud.deploy.group} value={group} disabled={!admin} onChange={(e) => setGroup(e.target.value)}>
              <option value="">{t.cloud.deploy.pickGroup}</option>
              {groups.map((g) => (
                <option key={g.name} value={g.name}>
                  {g.name} ({g.online}/{g.total})
                </option>
              ))}
            </Select>
          </label>
          <label className="stack">
            {t.cloud.deploy.version}
            <Input aria-label={t.cloud.deploy.version} placeholder={t.cloud.deploy.versionPlaceholder} value={version} disabled={!admin} onChange={(e) => setVersion(e.target.value)} />
          </label>
          <label className="stack">
            {t.cloud.deploy.notes}
            <Input aria-label={t.cloud.deploy.notes} value={notes} disabled={!admin} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <label className="row">
            <input type="checkbox" checked={run} disabled={!admin} onChange={(e) => setRun(e.target.checked)} />
            {t.cloud.deploy.run}
          </label>
        </div>
        <div className="row">
          <Button
            size="sm"
            type="button"
            variant="primary"
            disabled={!admin || busy || !group}
            title={admin ? undefined : t.cloud.deploy.adminOnly}
            onClick={() =>
              void go(() => api.cloudFlowDeploy({ project: plan.project, files: plan.files, group, version: version.trim(), notes, run }), t.cloud.deploy.confirm(plan.project, group))
            }
          >
            {busy ? t.cloud.deploy.deploying : t.cloud.deploy.deploy}
          </Button>
        </div>
        {err && <Alert tone="error">{err}</Alert>}
        {result && <Results result={result} />}
      </section>
      <section className="panel cloud-batch" aria-label={t.cloud.deploy.versions}>
        <strong>{t.cloud.deploy.versions}</strong>
        {history && !history.versions.length && <p className="muted">{t.cloud.deploy.noVersions}</p>}
        {history && history.versions.length > 0 && (
          <div className="cloud-table-wrap">
            <table className="cloud-table">
              <tbody>
                {history.versions.map((v, i) => (
                  <tr key={v.id}>
                    <td className="mono">{v.version}</td>
                    <td className="muted">{v.notes || "—"}</td>
                    <td className="muted">
                      {t.cloud.deploy.by(v.createdBy)} · {seenText(v.createdAt)}
                    </td>
                    <td>
                      {i > 0 && (
                        <Button
                          size="sm"
                          type="button"
                          disabled={!admin || busy || !group || history.scriptId === null}
                          title={admin ? undefined : t.cloud.deploy.adminOnly}
                          onClick={() => void go(() => api.cloudFlowRollback(history.scriptId as number, v.id, group, run), t.cloud.deploy.rollbackConfirm(v.version, group))}
                        >
                          {t.cloud.deploy.rollback}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {dialog}
    </>
  );
}
