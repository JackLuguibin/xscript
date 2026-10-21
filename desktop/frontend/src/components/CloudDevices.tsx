import { useEffect, useMemo, useState } from "react";
import { useServices } from "../app-context";
import type { CloudDevice, CloudDevicePage, CloudGroup } from "../api";
import { errorLine } from "../errors";
import { t } from "../strings";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

const PAGE_SIZE = 50;

export function seenText(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Read-only fleet table (P4.2). Selection lives in the parent so the batch bar (P4.3) can act on it; ids stay
 * selected across pages and filters until cleared.
 */
export function CloudDevices({ selected, onSelected, reloadKey = 0 }: { selected: Set<string>; onSelected: (s: Set<string>) => void; reloadKey?: number }) {
  const { api } = useServices();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [app, setApp] = useState("");
  const [state, setState] = useState<"" | "online" | "offline">("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CloudDevicePage | null>(null);
  const [meta, setMeta] = useState<{ groups: CloudGroup[]; apps: string[] }>({ groups: [], apps: [] });
  const [err, setErr] = useState("");

  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(q.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => {
    void api.cloudGroups().then(setMeta, () => undefined);
  }, [api, reloadKey]);
  useEffect(() => {
    let live = true;
    setErr("");
    api
      .cloudDevices({ q: query, group, app, online: state === "" ? undefined : state === "online", page, pageSize: PAGE_SIZE })
      .then(
        (r) => live && setData(r),
        (e) => live && setErr(errorLine(e)),
      );
    return () => {
      live = false;
    };
  }, [api, query, group, app, state, page, reloadKey]);

  const items: CloudDevice[] = useMemo(() => data?.items ?? [], [data]);
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const allOnPage = items.length > 0 && items.every((d) => selected.has(d.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelected(next);
  };
  const toggleAll = () => {
    const next = new Set(selected);
    for (const d of items) {
      if (allOnPage) next.delete(d.id);
      else next.add(d.id);
    }
    onSelected(next);
  };

  return (
    <>
      <div className="row cloud-filters">
        <Input aria-label={t.cloud.dev.search} placeholder={t.cloud.dev.search} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label={t.cloud.dev.allGroups} value={group} onChange={(e) => (setGroup(e.target.value), setPage(1))}>
          <option value="">{t.cloud.dev.allGroups}</option>
          {meta.groups.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name} ({g.online}/{g.total})
            </option>
          ))}
        </Select>
        <Select aria-label={t.cloud.dev.allApps} value={app} onChange={(e) => (setApp(e.target.value), setPage(1))}>
          <option value="">{t.cloud.dev.allApps}</option>
          {meta.apps.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select aria-label={t.cloud.dev.anyState} value={state} onChange={(e) => (setState(e.target.value as typeof state), setPage(1))}>
          <option value="">{t.cloud.dev.anyState}</option>
          <option value="online">{t.cloud.dev.online}</option>
          <option value="offline">{t.cloud.dev.offline}</option>
        </Select>
        <span className="grow" />
        {data && <span className="muted">{t.cloud.dev.total(data.total)}</span>}
        {selected.size > 0 && (
          <>
            <span role="status">{t.cloud.dev.selected(selected.size)}</span>
            <Button size="sm" type="button" variant="ghost" onClick={() => onSelected(new Set())}>
              {t.cloud.dev.clear}
            </Button>
          </>
        )}
      </div>
      {err && <Alert tone="error">{err}</Alert>}
      <div className="cloud-table-wrap">
        <table className="cloud-table">
          <thead>
            <tr>
              <th className="check">
                <input type="checkbox" aria-label={t.cloud.dev.selectAll} checked={allOnPage} disabled={!items.length} onChange={toggleAll} />
              </th>
              <th>{t.cloud.dev.cols.id}</th>
              <th>{t.cloud.dev.cols.model}</th>
              <th>{t.cloud.dev.cols.group}</th>
              <th>{t.cloud.dev.cols.note}</th>
              <th>{t.cloud.dev.cols.version}</th>
              <th>{t.cloud.dev.cols.state}</th>
              <th>{t.cloud.dev.cols.seen}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id} aria-selected={selected.has(d.id)}>
                <td className="check">
                  <input type="checkbox" aria-label={t.cloud.dev.selectRow(d.id)} checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                </td>
                <td className="mono">{d.id}</td>
                <td>{[d.brand, d.model].filter(Boolean).join(" ") || "—"}</td>
                <td>{d.group || "—"}</td>
                <td>{d.note || "—"}</td>
                <td>{d.version || "—"}</td>
                <td>
                  <Badge tone={d.online ? "ok" : "neutral"}>{d.online ? t.cloud.dev.online : t.cloud.dev.offline}</Badge>{" "}
                  {d.online && <span className="muted">{d.running ? `${t.cloud.dev.running}${d.project ? " · " + d.project : ""}` : t.cloud.dev.idle}</span>}
                  {d.crash && (
                    <>
                      {" "}
                      <Badge tone="bad" title={t.cloud.dev.crashTip(d.crash.project, d.crash.exit, d.crash.error)}>
                        {t.cloud.dev.crashed}
                      </Badge>
                    </>
                  )}
                </td>
                <td>{d.online ? "—" : seenText(d.last_seen)}</td>
              </tr>
            ))}
            {data && !items.length && (
              <tr>
                <td colSpan={8} className="muted">
                  {t.cloud.dev.empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="row cloud-pager">
          <Button size="sm" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {t.cloud.dev.prev}
          </Button>
          <span className="muted">{t.cloud.dev.page(page, pages)}</span>
          <Button size="sm" type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            {t.cloud.dev.next}
          </Button>
        </div>
      )}
    </>
  );
}
