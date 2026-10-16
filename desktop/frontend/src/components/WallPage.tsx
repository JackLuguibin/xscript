import { useEffect, useState, type PointerEvent as RPointerEvent } from "react";
import { useServices } from "../app-context";
import type { Device } from "../api";
import { RpcError } from "../bridge/types";
import { t } from "../strings";
import { useDevices } from "../useDevices";
import { onlineSelected, pointOnDevice, relativePoint, thumbUrl } from "../wall";
import { EmptyState } from "./EmptyState";
import { IconPhone } from "./icons";

const KEYS = ["back", "home", "recents"] as const;

function errText(e: unknown): string {
  if (e instanceof RpcError) return `${e.message} [${e.code}]`;
  return e instanceof Error ? e.message : String(e);
}

/** Thumbnail wall. Pictures are `/_shot/` polls, never a `/screen/stream` (the device allows two viewers). */
export function WallPage() {
  const { api } = useServices();
  const devices = useDevices();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(1);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, []);

  const targets = () => onlineSelected(devices, selected);

  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const broadcast = async (list: Device[], payload: Record<string, unknown> | ((d: Device) => Record<string, unknown> | null)) => {
    setError("");
    setNotice("");
    if (!list.length) return;
    const results = await Promise.all(
      list.map(async (d) => {
        const body = typeof payload === "function" ? payload(d) : payload;
        if (!body) return false;
        try {
          await api.action(d.id, body);
          return true;
        } catch (e) {
          setError(errText(e));
          return false;
        }
      }),
    );
    const n = results.filter(Boolean).length;
    if (n) setNotice(t.wall.sent(n));
  };

  if (!devices.length) {
    return (
      <div className="page">
        <EmptyState icon={<IconPhone size={26} />} title={t.wall.empty} role="status">
          {t.wall.emptyDesc}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      <div className="row toolbar">
        <button type="button" className="small" onClick={() => setSelected(new Set(devices.filter((d) => d.state === "online").map((d) => d.id)))}>
          {t.wall.selectAll}
        </button>
        <button type="button" className="small" onClick={() => setSelected(new Set())}>
          {t.wall.clear}
        </button>
        <span className="hint">{t.wall.selected(targets().length)}</span>
        <span className="grow" />
        {KEYS.map((k) => (
          <button key={k} type="button" className="small" disabled={!targets().length} onClick={() => void broadcast(targets(), { type: "key", name: k })}>
            {t.projects[k]}
          </button>
        ))}
      </div>
      <p className="hint">{t.wall.hint}</p>
      {notice && (
        <p className="hint" role="status">
          {notice}
        </p>
      )}
      <div className="wall-grid">
        {devices.map((d) => {
          const online = d.state === "online";
          const label = d.name || d.info.name || d.info.model || d.id;
          return (
            <article key={d.id} className="wall-card">
              <label className="row">
                <input type="checkbox" checked={selected.has(d.id)} disabled={!online} onChange={() => toggle(d.id)} aria-label={label} />
                <span className="grow">{label}</span>
                <span className="muted">{t.state[d.state] || d.state}</span>
              </label>
              {online ? (
                <img
                  alt={`${t.wall.shot} ${label}`}
                  src={thumbUrl(d.id, tick)}
                  onPointerUp={(e: RPointerEvent<HTMLImageElement>) => {
                    const el = e.currentTarget;
                    const r = el.getBoundingClientRect();
                    const rel = relativePoint(e.clientX - r.left, e.clientY - r.top, { w: r.width, h: r.height });
                    const ids = new Set(selected);
                    ids.add(d.id);
                    const list = devices.filter((dev) => dev.state === "online" && ids.has(dev.id));
                    void broadcast(list, (dev) => {
                      const p = pointOnDevice(rel.fx, rel.fy, { w: dev.info.width || 0, h: dev.info.height || 0 });
                      return p ? { type: "click", x: p.x, y: p.y, dur: 20 } : null;
                    });
                  }}
                />
              ) : (
                <p className="muted wall-off">{t.state.offline}</p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
