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
/** Gap between a thumbnail arriving and the next request; longer after a failed one. */
export const REFRESH_MS = 2000;
export const RETRY_MS = 5000;

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/**
 * One device's picture. The next `/_shot/` is requested only after the previous one has loaded or
 * failed (a slow device never has requests piling up), and not at all while the window is hidden.
 */
function WallThumb({ id, alt, onPointerUp }: { id: string; alt: string; onPointerUp: (e: RPointerEvent<HTMLImageElement>) => void }) {
  const visible = usePageVisible();
  const [tick, setTick] = useState(1);
  const [wait, setWait] = useState<number | null>(null); // null: a request is in flight

  useEffect(() => {
    if (wait === null || !visible) return;
    const timer = setTimeout(() => {
      setWait(null);
      setTick((n) => n + 1);
    }, wait);
    return () => clearTimeout(timer);
  }, [wait, visible]);

  return (
    <img alt={alt} src={thumbUrl(id, tick)} onLoad={() => setWait(REFRESH_MS)} onError={() => setWait(RETRY_MS)} onPointerUp={onPointerUp} />
  );
}

function errText(e: unknown): string {
  if (e instanceof RpcError) return `${e.message} [${e.code}]`;
  return e instanceof Error ? e.message : String(e);
}

/** Thumbnail wall. Pictures are `/_shot/` polls, never a `/screen/stream` (the device allows two viewers). */
export function WallPage() {
  const { api } = useServices();
  const devices = useDevices();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

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
                <WallThumb
                  id={d.id}
                  alt={`${t.wall.shot} ${label}`}
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
