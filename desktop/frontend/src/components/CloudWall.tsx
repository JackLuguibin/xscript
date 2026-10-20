import { useEffect, useState } from "react";
import { useServices } from "../app-context";
import { cloudThumbUrl, type CloudAccount, type CloudDevice, type CloudGroup } from "../api";
import { errorLine } from "../errors";
import { t } from "../strings";
import { REFRESH_MS } from "./WallPage";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Select } from "./ui/select";

export const CLOUD_WALL_MAX = 48;

/** Demo mode has no xsapp:// handler: draw a labelled phone outline instead of a screenshot. */
export function demoThumb(label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="390" viewBox="0 0 180 390"><rect x="2" y="2" width="176" height="386" rx="18" fill="#1f2937" stroke="#64748b" stroke-width="3"/><rect x="12" y="40" width="156" height="300" rx="6" fill="#0f766e"/><text x="90" y="190" font-family="sans-serif" font-size="16" fill="#ecfeff" text-anchor="middle">${label}</text><text x="90" y="214" font-family="sans-serif" font-size="12" fill="#a5f3fc" text-anchor="middle">${t.cloud.wall.demo}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function Thumb({ device, tick }: { device: CloudDevice; tick: number }) {
  const { inShell } = useServices();
  const [broken, setBroken] = useState(false);
  const label = [device.brand, device.model].filter(Boolean).join(" ") || device.id;
  const src = inShell ? cloudThumbUrl(device.id, tick) : demoThumb(device.id);
  useEffect(() => setBroken(false), [src]);
  return broken ? (
    <p className="muted wall-off">{t.cloud.wall.noImage}</p>
  ) : (
    <img src={src} alt={`${t.wall.shot} ${label}`} loading="lazy" onError={() => setBroken(true)} />
  );
}

/** Live thumbnails of online cloud devices (P4.6), same cards as the local device wall. Operator+ (backend relay). */
export function CloudWall({ account }: { account: CloudAccount }) {
  const { api } = useServices();
  const [groups, setGroups] = useState<CloudGroup[]>([]);
  const [group, setGroup] = useState("");
  const [devices, setDevices] = useState<CloudDevice[] | null>(null);
  const [tick, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.cloudGroups().then((r) => setGroups(r.groups), () => undefined);
  }, [api]);
  useEffect(() => {
    let live = true;
    api.cloudDevices({ group, online: true, pageSize: 50 }).then(
      (r) => live && setDevices(r.items.slice(0, CLOUD_WALL_MAX)),
      (e) => live && setErr(errorLine(e)),
    );
    return () => {
      live = false;
    };
  }, [api, group]);
  useEffect(() => {
    if (paused || !account.canOperate) return;
    const id = setInterval(() => setTick((n) => n + 1), REFRESH_MS * 2);
    return () => clearInterval(id);
  }, [paused, account.canOperate]);

  if (!account.canOperate) return <p className="muted">{t.cloud.wall.viewerOnly}</p>;
  return (
    <div className="cloud-wall">
      <div className="row cloud-filters">
        <Select aria-label={t.cloud.dev.allGroups} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">{t.cloud.dev.allGroups}</option>
          {groups.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name} ({g.online}/{g.total})
            </option>
          ))}
        </Select>
        <span className="grow" />
        {paused && <span className="muted">{t.cloud.wall.paused}</span>}
        <Button size="sm" type="button" onClick={() => setPaused(!paused)}>
          {paused ? t.cloud.wall.resume : t.cloud.wall.pause}
        </Button>
      </div>
      <p className="hint">{t.cloud.wall.hint}</p>
      {err && <Alert tone="error">{err}</Alert>}
      {devices && !devices.length && <p className="muted">{t.cloud.wall.none}</p>}
      <div className="wall-grid">
        {(devices ?? []).map((d) => (
          <article key={d.id} className="wall-card">
            <div className="row">
              <span className="grow mono">{d.id}</span>
              <span className="muted">{d.running ? `${t.cloud.dev.running}${d.project ? " · " + d.project : ""}` : t.cloud.dev.idle}</span>
            </div>
            <Thumb device={d} tick={tick} />
          </article>
        ))}
      </div>
    </div>
  );
}
