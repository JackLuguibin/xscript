import { useEffect, useState } from "react";
import type { LogEntry, RunRecord } from "../api";
import { useServices } from "../app-context";
import { t } from "../strings";
import { Badge } from "./Badge";
import { Button } from "./ui/button";

function when(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The phone's run history for one project (GET /projects/{name}/runs); each run can show its own slice of the log. */
export function RecentRuns({ devId, project, refresh, onError }: { devId: string; project: string; refresh: unknown; onError: (e: unknown) => void }) {
  const { api } = useServices();
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [slice, setSlice] = useState<LogEntry[] | null>(null);

  useEffect(() => {
    let live = true;
    setOpen(null);
    api
      .runs(devId, project)
      .then((r) => {
        if (!live) return;
        setRuns(r.runs);
        setUnsupported(!!r.unsupported);
      })
      .catch((e) => live && onError(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, devId, project, refresh]);

  const toggle = async (r: RunRecord) => {
    if (open === r.start) return setOpen(null);
    setOpen(r.start);
    setSlice(null);
    try {
      const got = await api.logs(devId, r.log_from);
      setSlice(got.entries.filter((e) => e.seq > r.log_from && e.seq <= r.log_to));
    } catch (e) {
      onError(e);
    }
  };

  if (runs === null) return null;
  return (
    <div className="recent-runs">
      <h3 className="sub-head">{t.projects.recentRuns}</h3>
      {runs.length === 0 ? (
        <p className="muted">{unsupported ? t.projects.runsUnsupported : t.projects.noRuns}</p>
      ) : (
        <ul aria-label={t.projects.recentRuns} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--sp-2)" }}>
          {runs.map((r) => (
            <li key={r.start} style={{ display: "grid", gap: 4 }}>
              <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center" }}>
                <span className="mono" style={{ whiteSpace: "nowrap" }}>{when(r.start)}</span>
                <span className="muted" style={{ whiteSpace: "nowrap" }}>{t.projects.runDuration(r.duration_ms)}</span>
                <span className="grow" />
                <Button size="sm" aria-expanded={open === r.start} onClick={() => void toggle(r)}>
                  {t.projects.runLog}
                </Button>
              </div>
              <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }}>
                <Badge tone={r.failed ? "bad" : "ok"}>{r.outcome}</Badge>
                {r.stats && <span className="muted">{t.projects.runStats(r.stats.captures, r.stats.capture_avg_ms, r.stats.peak_mb)}</span>}
              </div>
              {open === r.start && slice && (
                <pre className="logs" style={{ maxHeight: 200, minHeight: 0 }}>
                  {slice.length === 0 ? <span className="muted">{t.projects.runLogGone}</span> : slice.map((l) => <span key={l.seq} className={l.stream === "stderr" ? "err" : ""}>{l.line.endsWith("\n") ? l.line : l.line + "\n"}</span>)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
