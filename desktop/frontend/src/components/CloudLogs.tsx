import { useState, type FormEvent } from "react";
import { useServices } from "../app-context";
import type { CloudLogLine, CloudLogStream } from "../api";
import { errorLine } from "../errors";
import { t } from "../strings";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

const STREAMS: CloudLogStream[] = ["", "stdout", "stderr", "system"];

function hms(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Stored run-log search for one device (P4.4). Read-only, so viewers get it too. */
export function CloudLogs({ initialDevice = "" }: { initialDevice?: string }) {
  const { api } = useServices();
  const [device, setDevice] = useState(initialDevice);
  const [q, setQ] = useState("");
  const [stream, setStream] = useState<CloudLogStream>("");
  const [lines, setLines] = useState<CloudLogLine[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = async (before = 0) => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.cloudLogs(device.trim(), { q: q.trim(), stream, before, limit: 300 });
      setLines((old) => (before && old ? [...r.items, ...old] : r.items));
      setMore(r.more);
    } catch (e) {
      setErr(errorLine(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="muted">{t.cloud.logs.hint}</p>
      <form
        className="row cloud-filters"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void load();
        }}
      >
        <Input aria-label={t.cloud.logs.device} placeholder={t.cloud.logs.device} value={device} spellCheck={false} onChange={(e) => setDevice(e.target.value)} />
        <Input aria-label={t.cloud.logs.search} placeholder={t.cloud.logs.search} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label={t.cloud.logs.stream} value={stream} onChange={(e) => setStream(e.target.value as CloudLogStream)}>
          {STREAMS.map((s) => (
            <option key={s} value={s}>
              {t.cloud.logs.streams[s]}
            </option>
          ))}
        </Select>
        <Button size="sm" type="submit" variant="primary" disabled={busy || !device.trim()}>
          {t.cloud.logs.find}
        </Button>
      </form>
      {err && <Alert tone="error">{err}</Alert>}
      {lines && (
        <>
          {more && (
            <div className="row">
              <Button size="sm" type="button" disabled={busy} onClick={() => void load(lines[0]?.id ?? 0)}>
                {t.cloud.logs.older}
              </Button>
            </div>
          )}
          {lines.length ? (
            <pre className="cloud-log" aria-label={t.cloud.tabs.logs}>
              {lines.map((l) => (
                <div key={l.id} className={l.stream}>
                  <time>{hms(l.ts)}</time>
                  {l.line}
                </div>
              ))}
            </pre>
          ) : (
            <p className="muted">{t.cloud.logs.empty}</p>
          )}
        </>
      )}
    </>
  );
}
