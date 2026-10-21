import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useServices } from "../app-context";
import type { CloudOverview as Overview } from "../api";
import { errorLine } from "../errors";
import { t } from "../strings";
import { seenText } from "./CloudDevices";
import type { CloudTab } from "./CloudPage";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

function Tile({ title, value, lines, open, onOpen }: { title: string; value: ReactNode; lines: ReactNode[]; open?: CloudTab; onOpen: (tab: CloudTab) => void }) {
  return (
    <section className="panel tight cloud-stat" aria-label={title}>
      <h2>{title}</h2>
      <p className="cloud-stat-value">{value}</p>
      {lines.map((l, i) => (
        <p key={i} className="muted">
          {l}
        </p>
      ))}
      {open && (
        <Button size="sm" type="button" onClick={() => onOpen(open)}>
          {t.cloud.overview.open}
        </Button>
      )}
    </section>
  );
}

/** 概览 (#219 M.1): the backend's GET /api/overview counts, read-only, for every role. Reloads with the page's 刷新. */
export function CloudOverview({ onOpen, reloadKey = 0 }: { onOpen: (tab: CloudTab) => void; reloadKey?: number }) {
  const { api } = useServices();
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    api.cloudOverview().then(setData, (e) => setErr(errorLine(e)));
  }, [api]);
  useEffect(load, [load, reloadKey]);
  const o = t.cloud.overview;

  return (
    <>
      <p className="muted">{o.hint}</p>
      {err && <Alert tone="error">{err}</Alert>}
      {!data && !err && (
        <p className="muted" role="status">
          {o.loading}
        </p>
      )}
      {data && (
        <div className="cloud-stats">
          <Tile title={o.devices} value={data.devices.online} lines={[o.online(data.devices.online, data.devices.total), o.running(data.devices.running), o.active24h(data.devices.active24h)]} open="devices" onOpen={onOpen} />
          <Tile title={o.tasks} value={data.tasks.enabled} lines={[o.tasksLine(data.tasks.enabled, data.tasks.total)]} open="tasks" onOpen={onOpen} />
          <Tile title={o.pack} value={data.pack.running + data.pack.queued} lines={[o.packLine(data.pack.running, data.pack.queued)]} open="pack" onOpen={onOpen} />
          <Tile title={o.scripts} value={data.scripts.published} lines={[o.scriptsLine(data.scripts.published, data.scripts.total)]} onOpen={onOpen} />
          <Tile
            title={o.health}
            value={
              <>
                <Badge tone={data.alerts24h ? "warn" : "ok"}>{o.alerts(data.alerts24h)}</Badge> <Badge tone={data.crashes24h ? "bad" : "ok"}>{o.crashes(data.crashes24h)}</Badge>
              </>
            }
            lines={[]}
            open={data.crashes24h ? "devices" : undefined}
            onOpen={onOpen}
          />
          <Tile
            title={o.backup}
            value={data.lastBackup ? seenText(data.lastBackup.time) : "—"}
            lines={[data.lastBackup ? (data.lastBackup.ok ? "" : o.backupFailed) : o.backupNone].filter(Boolean)}
            onOpen={onOpen}
          />
        </div>
      )}
    </>
  );
}
