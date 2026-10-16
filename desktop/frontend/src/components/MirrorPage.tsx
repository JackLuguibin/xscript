import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useServices } from "../app-context";
import type { MirrorStatus } from "../api";
import { RpcError } from "../bridge/types";
import { classify, frameUrl, streamScale, toDevice } from "../mirror";
import { t } from "../strings";
import { useDevices, useSelectedDevice } from "../useDevices";
import { EmptyState } from "./EmptyState";
import { IconAlert, IconMonitor, IconPhone } from "./icons";

const FPS = [5, 8, 12, 15];

function errText(e: unknown): string {
  if (e instanceof RpcError) return `${e.message} [${e.code}]`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Screen mirror. One MJPEG upstream per device lives in Python (design §14.4); the page only hears `mirror.frame` and reads
 * `xsapp://app/_frame/<id>?seq=N`. A frame that arrives while the previous image is still loading is skipped.
 */
export function MirrorPage() {
  const { api, rpc } = useServices();
  const devices = useDevices();
  const [devId, setDevId] = useSelectedDevice(devices);
  const device = devices.find((d) => d.id === devId);
  const [playing, setPlaying] = useState(true);
  const [fps, setFps] = useState(12);
  const [scale, setScale] = useState(0.5);
  const [src, setSrc] = useState("");
  const [phase, setPhase] = useState<"waiting" | "ok" | "failed">("waiting");
  const [mirrorState, setMirrorState] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [trackDev, setTrackDev] = useState(devId);
  const img = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const down = useRef<{ ex: number; ey: number; t: number; x: number; y: number } | null>(null);
  const screenSize = useRef<{ w: number; h: number } | null>(null);
  const want = useRef(0);
  const shown = useRef(0);
  const inflight = useRef(false);
  const nonce = useRef(0);
  const ticket = useRef(0);
  const currentDev = useRef(devId);

  if (devId !== trackDev) {
    setTrackDev(devId);
    setSrc("");
    setPhase("waiting");
    setMirrorState("");
    setReason("");
    setError("");
    screenSize.current = null;
    want.current = 0;
    shown.current = 0;
    inflight.current = false;
  }

  const noteFrame = (seq: number, w: number, h: number) => {
    if (!(seq > 0) || !devId) return;
    if (w > 0 && h > 0) screenSize.current = { w, h };
    want.current = seq;
    if (!inflight.current) {
      inflight.current = true;
      shown.current = seq;
      nonce.current += 1;
      setSrc(frameUrl(devId, seq, nonce.current));
    }
  };
  const noteRef = useRef(noteFrame);
  noteRef.current = noteFrame;

  const applySnap = (s: MirrorStatus) => {
    setMirrorState(s.state || "");
    setReason(s.reason || "");
    if (s.seq > 0) noteFrame(s.seq, s.w, s.h);
  };

  useEffect(() => {
    currentDev.current = devId;
    if (!playing || !devId) return;
    const mine = ++ticket.current;
    let dead = false;
    void api
      .mirrorSubscribe(devId, { fps, scale })
      .then((s) => {
        if (dead) {
          // a newer subscribe owns this device; leaving the device (or pausing) must still drop the viewer
          if (mine === ticket.current || devId !== currentDev.current) void api.mirrorUnsubscribe(devId).catch(() => undefined);
          return;
        }
        if (mine !== ticket.current) return;
        applySnap(s);
      })
      .catch((e) => {
        if (!dead && mine === ticket.current) setError(errText(e));
      });
    return () => {
      dead = true;
    };
    // applySnap/noteFrame close over the latest setters; ticket ignores stale replies
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, playing, devId, fps, scale]);

  useEffect(() => {
    if (!playing || !devId) return;
    const offFrame = rpc.on("mirror.frame", (d) => {
      const ev = d as { id?: string; seq?: number; w?: number; h?: number };
      if (ev.id !== devId || typeof ev.seq !== "number") return;
      noteRef.current(ev.seq, ev.w || 0, ev.h || 0);
    });
    const offState = rpc.on("mirror.state", (d) => {
      const ev = d as { id?: string; state?: string; reason?: string };
      if (ev.id !== devId) return;
      setMirrorState(ev.state || "");
      setReason(ev.reason || "");
    });
    return () => {
      inflight.current = false;
      offFrame();
      offState();
      void api.mirrorUnsubscribe(devId).catch(() => undefined);
    };
  }, [api, rpc, playing, devId]);

  useEffect(() => {
    const el = frameRef.current;
    if (!playing || !el || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const sw = screenSize.current?.w || device?.info.width || 0;
        const next = streamScale(el.getBoundingClientRect().width, sw);
        setScale((cur) => (Math.abs(cur - next) < 0.049 ? cur : next));
      }, 400);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [playing, devId, device?.info.width]);

  const advance = () => {
    inflight.current = false;
    if (want.current !== shown.current && devId) {
      inflight.current = true;
      shown.current = want.current;
      nonce.current += 1;
      setSrc(frameUrl(devId, want.current, nonce.current));
    }
  };

  const point = (e: RPointerEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const ex = e.clientX - r.left;
    const ey = e.clientY - r.top;
    const sized = screenSize.current && screenSize.current.w ? screenSize.current : device?.info.width && device.info.height ? { w: device.info.width, h: device.info.height } : null;
    const p = toDevice(ex, ey, { w: r.width, h: r.height }, { w: el.naturalWidth || r.width, h: el.naturalHeight || r.height }, sized);
    return { ex, ey, t: e.timeStamp || Date.now(), x: p.x, y: p.y };
  };

  const send = async (payload: Record<string, unknown>) => {
    setError("");
    try {
      await api.action(devId, payload);
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

  const blocked = mirrorState === "blocked";
  const stalled = mirrorState === "stalled";
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
      {reason === "viewers_full" && (
        <div className="banner warn" role="status">
          <IconAlert size={16} />
          <span className="grow">{t.mirror.viewersFull}</span>
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
        <div className="mirror-frame" ref={frameRef}>
          {src && (
            <img
              ref={img}
              src={src}
              alt={t.mirror.frame}
              draggable={false}
              className={phase === "ok" ? "" : "loading"}
              onLoad={() => {
                setPhase("ok");
                advance();
              }}
              onError={() => {
                setPhase("failed");
                advance();
              }}
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
          {blocked && (
            <div className="overlay fail" role="status">
              <IconAlert size={28} />
              <span>{t.mirror.noCapture}</span>
              <button type="button" onClick={() => void api.mirrorRetry(devId).catch((e) => setError(errText(e)))}>
                {t.mirror.retry}
              </button>
            </div>
          )}
          {stalled && !blocked && (
            <div className="overlay fail" role="status">
              <IconAlert size={28} />
              <span>{t.mirror.stalled}</span>
              <button type="button" onClick={() => void api.mirrorRetry(devId).catch((e) => setError(errText(e)))}>
                {t.mirror.retry}
              </button>
            </div>
          )}
          {phase === "waiting" && !blocked && !stalled && (
            <div className="overlay" role="status">
              <IconMonitor size={28} />
              <span>{t.mirror.waiting}</span>
            </div>
          )}
          {phase === "failed" && !blocked && !stalled && (
            <div className="overlay fail" role="status">
              <IconAlert size={28} />
              <span>{t.mirror.failed}</span>
            </div>
          )}
          {!playing && <span className="mirror-badge">{t.mirror.paused}</span>}
          {playing && mirrorState === "streaming" && <span className="mirror-badge">{t.mirror.live}</span>}
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
