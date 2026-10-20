import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useServices } from "../app-context";
import type { CloudAccount, CloudTask } from "../api";
import { errorLine } from "../errors";
import { t } from "../strings";
import { seenText } from "./CloudDevices";
import { useConfirm } from "./ConfirmDialog";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

function schedule(task: CloudTask): string {
  return task.daily ? t.cloud.tasks.daily(task.daily) : task.every ? t.cloud.tasks.every(task.every) : "—";
}

function NewTask({ selected, onCreated }: { selected: string[]; onCreated: () => void }) {
  const { api } = useServices();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("all");
  const [path, setPath] = useState<"app_run" | "app_stop">("app_run");
  const [project, setProject] = useState("");
  const [mode, setMode] = useState<"daily" | "every">("daily");
  const [time, setTime] = useState("08:30");
  const [every, setEvery] = useState("60");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    api
      .cloudTaskCreate({ name, target, path, project, ...(mode === "daily" ? { daily: time } : { every: Number(every) }) })
      .then(() => {
        setName("");
        onCreated();
      })
      .catch((e2) => setErr(errorLine(e2)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="panel cloud-batch" aria-label={t.cloud.tasks.newTitle} onSubmit={submit}>
      <strong>{t.cloud.tasks.newTitle}</strong>
      <div className="cloud-form">
        <label className="stack">
          {t.cloud.tasks.name}
          <Input aria-label={t.cloud.tasks.name} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="stack">
          {t.cloud.tasks.target}
          <Input aria-label={t.cloud.tasks.target} title={t.cloud.tasks.targetHint} value={target} spellCheck={false} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <label className="stack">
          {t.cloud.tasks.action}
          <Select aria-label={t.cloud.tasks.action} value={path} onChange={(e) => setPath(e.target.value as typeof path)}>
            <option value="app_run">{t.cloud.tasks.actions.app_run}</option>
            <option value="app_stop">{t.cloud.tasks.actions.app_stop}</option>
          </Select>
        </label>
        {path === "app_run" && (
          <label className="stack">
            {t.cloud.tasks.project}
            <Input aria-label={t.cloud.tasks.project} value={project} onChange={(e) => setProject(e.target.value)} />
          </label>
        )}
        <label className="stack">
          {t.cloud.tasks.mode}
          <Select aria-label={t.cloud.tasks.mode} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="daily">{t.cloud.tasks.modes.daily}</option>
            <option value="every">{t.cloud.tasks.modes.every}</option>
          </Select>
        </label>
        {mode === "daily" ? (
          <label className="stack">
            {t.cloud.tasks.time}
            <Input aria-label={t.cloud.tasks.time} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        ) : (
          <label className="stack">
            {t.cloud.tasks.minutes}
            <Input aria-label={t.cloud.tasks.minutes} type="number" min={1} value={every} onChange={(e) => setEvery(e.target.value)} />
          </label>
        )}
      </div>
      <p className="muted">{t.cloud.tasks.targetHint} · {t.cloud.tasks.deployNote}</p>
      {err && <Alert tone="error">{err}</Alert>}
      <div className="row">
        <Button size="sm" type="submit" variant="primary" disabled={busy || !target.trim() || (path === "app_run" && !project.trim())}>
          {t.cloud.tasks.create}
        </Button>
        {selected.length > 0 && (
          <Button size="sm" type="button" onClick={() => setTarget(selected.join(","))}>
            {t.cloud.tasks.useSelection(selected.length)}
          </Button>
        )}
      </div>
    </form>
  );
}

/** Server-side scheduled tasks (P4.4): list for everyone; enable / run / delete / create for operators and admins. */
export function CloudTasks({ account, selected, reloadKey = 0 }: { account: CloudAccount; selected: string[]; reloadKey?: number }) {
  const { api } = useServices();
  const { confirm, dialog } = useConfirm();
  const [tasks, setTasks] = useState<CloudTask[] | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const load = useCallback(() => {
    api.cloudTasks().then(
      (r) => setTasks(r.tasks),
      (e) => setErr(errorLine(e)),
    );
  }, [api]);
  useEffect(load, [load, reloadKey]);
  const can = account.canOperate;
  const act = (p: Promise<unknown>) => {
    setErr("");
    p.then(load, (e) => setErr(errorLine(e)));
  };

  return (
    <>
      {!can && <p className="muted">{t.cloud.tasks.viewerOnly}</p>}
      {err && <Alert tone="error">{err}</Alert>}
      {note && <p role="status">{note}</p>}
      <div className="cloud-table-wrap">
        <table className="cloud-table">
          <thead>
            <tr>
              <th>{t.cloud.tasks.cols.enabled}</th>
              <th>{t.cloud.tasks.cols.name}</th>
              <th>{t.cloud.tasks.cols.target}</th>
              <th>{t.cloud.tasks.cols.command}</th>
              <th>{t.cloud.tasks.cols.schedule}</th>
              <th>{t.cloud.tasks.cols.next}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(tasks ?? []).map((task) => (
              <tr key={task.id}>
                <td className="check">
                  <input
                    type="checkbox"
                    aria-label={t.cloud.tasks.enable(task.name || `#${task.id}`)}
                    checked={task.enabled}
                    disabled={!can}
                    onChange={() => act(api.cloudTaskUpdate(task.id, { enabled: !task.enabled }))}
                  />
                </td>
                <td>{task.name || `#${task.id}`}</td>
                <td className="mono">{task.target}</td>
                <td>{task.path === "app_run" ? `${t.cloud.tasks.actions.app_run} ${task.project}` : (t.cloud.tasks.actions as Record<string, string>)[task.path] ?? task.path}</td>
                <td>{schedule(task)}</td>
                <td>{task.nextRun ? seenText(task.nextRun) : "—"}</td>
                <td>
                  <div className="row">
                    <Button
                      size="sm"
                      type="button"
                      disabled={!can}
                      onClick={() => {
                        setNote("");
                        api.cloudTaskRun(task.id).then(
                          (r) => (setNote(t.cloud.tasks.ran(r.ok, r.devices)), load()),
                          (e) => setErr(errorLine(e)),
                        );
                      }}
                    >
                      {t.cloud.tasks.run}
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="danger"
                      disabled={!can}
                      onClick={async () => {
                        if (await confirm({ message: t.cloud.tasks.delConfirm(task.name || `#${task.id}`), confirmLabel: t.cloud.tasks.del, danger: true }))
                          act(api.cloudTaskDelete(task.id));
                      }}
                    >
                      {t.cloud.tasks.del}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {tasks && !tasks.length && (
              <tr>
                <td colSpan={7} className="muted">
                  {t.cloud.tasks.empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {can && <NewTask selected={selected} onCreated={load} />}
      {dialog}
    </>
  );
}
