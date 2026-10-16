import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useServices } from "../app-context";
import { RpcError } from "../bridge/types";
import { classify, toDevice } from "../mirror";
import { t } from "../strings";
import { useDevices, useSelectedDevice } from "../useDevices";
import { EmptyState } from "./EmptyState";
import { IconAlert, IconMonitor, IconPhone } from "./icons";

const FPS = [1, 2, 5, 10];

function errText(e: unknown): string {
  if (e instanceof RpcError) return `${e.message} [${e.code}]`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Screen mirror. Frames are successive screenshots over xsapp://app/_shot/ (the next one is requested when the previous one
 * has loaded, so a slow device lowers the rate instead of queueing): it never takes one of the device's two
 * /screen/stream viewer slots (design §14). Pointer gestures become /action click/swipe through the bridge.
 */
export function MirrorPage() {
  const { api } = useServices();
  const devices = useDevices();
  const [devId, setDevId] = useSelectedDevice(devices);
  const device = devices.find((d) => d.id === devId);
  const [playing, setPlaying] = useState(true);
  const [fps, setFps] = useState(2);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<"waiting" | "ok" | "failed">("waiting");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const img = useRef<HTMLImageElement>(null);
  const down = useRef<{ ex: number; ey: number; t: number; x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setState("waiting");
    setTick(Date.now());
  }, [devId]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const next = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setTick((n) => Math.max(Date.now(), n + 1)), delay);
  };

  useEffect(() => {
    if (playing && state !== "waiting") next(1000 / fps);
    else clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, fps]);

  const onLoad = () => {
    setState("ok");
    if (playing) next(1000 / fps);
  };
  const onError = () => {
    setState("failed");
    if (playing) next(3000); // keep trying slowly: permission may be granted meanwhile
  };

  const point = (e: RPointerEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const ex = e.clientX - r.left;
    const ey = e.clientY - r.top;
    const dev = device?.info.width && device.info.height ? { w: device.info.width, h: device.info.height } : null;
    const p = toDevice(ex, ey, { w: r.width, h: r.height }, { w: el.naturalWidth || r.width, h: el.naturalHeight || r.height }, dev);
    return { ex, ey, t: e.timeStamp || Date.now(), x: p.x, y: p.y };
  };

  const send = async (payload: Record<string, unknown>) => {
    setError("");
    try {
      await api.action(devId, payload);
      if (playing) next(150); // show the result soon
    } catch (e) {
      setError(errText(e));
    }
  };

  if (!device) {
    return (
      <div className="page">
        <EmptyState icon={<IconPhone size={26} />} title={t.projects.noDevice} role="status">
          {t.projects.noDeviceDesc}
        </EmptyState>
      </div>
    );
  }

  const src = devId && tick ? `/_shot/${encodeURIComponent(devId)}.jpg?max=1080&t=${tick}` : "";
  return (
    <div className="page">
      {error && (
        <div className="banner error" role="alert">
          <IconAlert size={16} />
          <span className="grow">
            {t.errorPrefix}：{error}
          </span>
        </div>
      )}
      <div className="row toolbar">
        <label className="row">
          {t.projects.device}
          <select aria-label={t.projects.device} value={devId} onChange={(e) => setDevId(e.target.value)}>
            {devices.map((d) => (
              <option key={d.id} value={d.id} disabled={d.state !== "online"}>
                {d.info.name || d.info.model || d.id}
              </option>
            ))}
          </select>
        </label>
        <button className={playing ? "" : "primary"} onClick={() => setPlaying((p) => !p)}>
          {playing ? t.mirror.pause : t.mirror.start}
        </button>
        <label className="row">
          {t.mirror.fps}
          <select aria-label={t.mirror.fps} value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            {FPS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <span className="grow" />
        {(["back", "home", "recents"] as const).map((k) => (
          <button key={k} className="small" onClick={() => void send({ type: "key", name: k })}>
            {t.projects[k]}
          </button>
        ))}
      </div>
      <div className="mirror-grid">
        <div className="mirror-frame">
          {src && (
            <img
              ref={img}
              src={src}
              alt={t.mirror.frame}
              draggable={false}
              className={state === "ok" ? "" : "loading"}
              onLoad={onLoad}
              onError={onError}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture?.(e.pointerId);
                down.current = point(e);
              }}
              onPointerUp={(e) => {
                const d = down.current;
                down.current = null;
                if (!d) return;
                void send(classify(d, point(e)));
              }}
              onPointerCancel={() => (down.current = null)}
            />
          )}
          {state === "waiting" && (
            <div className="overlay" role="status">
              <IconMonitor size={28} />
              <span>{t.mirror.waiting}</span>
            </div>
          )}
          {state === "failed" && (
            <div className="overlay fail" role="status">
              <IconAlert size={28} />
              <span>{t.mirror.failed}</span>
            </div>
          )}
          {!playing && <span className="mirror-badge">{t.mirror.paused}</span>}
        </div>
        <div className="panel">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const v = text;
              if (!v) return;
              void send({ type: "input", text: v }).then(() => {
                setText("");
                setNotice(t.mirror.sent(v));
              });
            }}
          >
            <input aria-label={t.mirror.text} className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={t.mirror.textPlaceholder} />
            <button type="submit" disabled={!text}>
              {t.mirror.send}
            </button>
          </form>
          {notice && (
            <p className="hint" role="status">
              {notice}
            </p>
          )}
          <p className="hint">{t.mirror.hint}</p>
        </div>
      </div>
    </div>
  );
}
