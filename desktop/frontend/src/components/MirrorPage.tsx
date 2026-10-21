import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as RClipboardEvent, type CSSProperties, type KeyboardEvent as RKeyboardEvent } from "react";
import { useServices } from "../app-context";
import type { MirrorStatus } from "../api";
import {
  MIRROR_FPS, classify, fitWidth, frameUrl, isLandscape, loadMirrorPrefs, saveMirrorPrefs, streamScale, toDevice, wheelPixels, wheelSwipe,
  type FitMode, type Size,
} from "../mirror";
import { t } from "../strings";
import { useCurrentDevice } from "../device-context";
import { CaptureCard, CaptureChip, captureState } from "./CaptureStatus";
import { EmptyState } from "./EmptyState";
import { ErrorBanner } from "./ErrorBanner";
import { IconAlert, IconMonitor, IconPhone } from "./icons";
import { ScreenTools, rectPercent, type PointerMode } from "./ScreenTools";
import { useToast } from "./Toast";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

const WHEEL_IDLE_MS = 120; // one wheel "flick" = events closer together than this
const MAX_COMPOSE = 2000;


/**
 * Screen mirror. One MJPEG upstream per device lives in Python (design §14.4); the page only hears `mirror.frame` and reads
 * `xsapp://app/_frame/<id>?seq=N`. A frame that arrives while the previous image is still loading is skipped.
 */
export function MirrorPage() {
  const { api, rpc } = useServices();
  const { devId, device } = useCurrentDevice(); // picked in the top bar
  // frame rate, fit and pause are remembered across page visits (fps/fit also across restarts)
  const [prefs] = useState(loadMirrorPrefs);
  const [playing, setPlaying] = useState(prefs.playing);
  const [fps, setFps] = useState(prefs.fps);
  const [fit, setFit] = useState<FitMode>(prefs.fit);
  const [shape, setShape] = useState<Size | null>(null); // frame orientation/size from the stream (follows rotation)
  const [avail, setAvail] = useState(600); // px from the frame's top to the window bottom
  const [, setWinTick] = useState(0);
  const [compose, setComposeState] = useState(""); // typed on the focused frame, sent with Enter
  // the ref is the source of truth: several keydowns can arrive before React re-renders (fast typing, key repeat)
  const composeRef = useRef("");
  const setCompose = (next: string | ((cur: string) => string)) => {
    composeRef.current = typeof next === "function" ? next(composeRef.current) : next;
    setComposeState(composeRef.current);
  };
  const [scale, setScale] = useState(0.5);
  const [src, setSrc] = useState("");
  const [phase, setPhase] = useState<"waiting" | "ok" | "failed">("waiting");
  const [mirrorState, setMirrorState] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [rechecking, setRechecking] = useState(false);
  const { toast, toasts } = useToast();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<PointerMode>("control");
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [picked, setPicked] = useState<{ x: number; y: number; n: number } | null>(null);
  const [hitBox, setHitBox] = useState<CSSProperties | null>(null);
  const [trackDev, setTrackDev] = useState(devId);
  const img = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const down = useRef<{ ex: number; ey: number; t: number; x: number; y: number } | null>(null);
  const screenSize = useRef<{ w: number; h: number } | null>(null);
  const want = useRef(0);
  const shown = useRef(0);
  const inflight = useRef(false);
  const nonce = useRef(0);
  const pickN = useRef(0);
  const ticket = useRef(0);
  const currentDev = useRef(devId);
  const shotWRef = useRef<number | null>(null);
  const fitRef = useRef<FitMode>("fit");

  if (devId !== trackDev) {
    setTrackDev(devId);
    setSrc("");
    setPhase("waiting");
    setMirrorState("");
    setReason("");
    setError(null);
    setHover(null);
    setPicked(null);
    setHitBox(null);
    setShape(null);
    setCompose("");
    screenSize.current = null;
    want.current = 0;
    shown.current = 0;
    inflight.current = false;
  }

  const noteFrame = (seq: number, w: number, h: number) => {
    if (!(seq > 0) || !devId) return;
    if (w > 0 && h > 0) {
      screenSize.current = { w, h };
      setShape((cur) => (cur && cur.w === w && cur.h === h ? cur : { w, h }));
    }
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

  useEffect(() => saveMirrorPrefs({ fps, fit, playing }), [fps, fit, playing]);

  useEffect(() => {
    const on = () => setWinTick((n) => n + 1);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  // H3: the frame gets the height left below the toolbar (banners included), so a tall phone never needs page scrolling
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const next = Math.max(200, Math.floor(window.innerHeight - top - 24));
    setAvail((cur) => (Math.abs(cur - next) > 2 ? next : cur));
  });

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
        if (!dead && mine === ticket.current) setError(e);
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
        const shownPx = Math.max(el.getBoundingClientRect().width, shotWRef.current || 0) * (fitRef.current === "actual" ? window.devicePixelRatio || 1 : 1);
        const next = streamScale(shownPx, sw);
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

  const deviceSized = (): Size | null =>
    screenSize.current && screenSize.current.w ? screenSize.current : device?.info.width && device.info.height ? { w: device.info.width, h: device.info.height } : null;

  const pointAt = (el: HTMLImageElement, clientX: number, clientY: number, t: number) => {
    const r = el.getBoundingClientRect();
    const ex = clientX - r.left;
    const ey = clientY - r.top;
    const p = toDevice(ex, ey, { w: r.width, h: r.height }, { w: el.naturalWidth || r.width, h: el.naturalHeight || r.height }, deviceSized());
    return { ex, ey, t, x: p.x, y: p.y };
  };
  const point = (e: { currentTarget: HTMLImageElement; clientX: number; clientY: number; timeStamp: number }) =>
    pointAt(e.currentTarget, e.clientX, e.clientY, e.timeStamp || Date.now());

  /** Device-pixel extent of the frame in its current orientation (the space toDevice maps into). */
  const deviceSpace = (el: HTMLImageElement): Size => {
    const r = el.getBoundingClientRect();
    const fw = el.naturalWidth || r.width || 1;
    const fh = el.naturalHeight || r.height || 1;
    const sized = deviceSized();
    const k = sized ? Math.max(sized.w, sized.h) / Math.max(fw, fh) : 1;
    return { w: Math.round(fw * k), h: Math.round(fh * k) };
  };

  const send = async (payload: Record<string, unknown>): Promise<boolean> => {
    setError(null);
    try {
      await api.action(devId, payload);
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  };

  // ---- M9: wheel → swipe (one swipe per flick, starting where the wheel started) -----------------------------------------------
  const wheel = useRef<{ dx: number; dy: number; x: number; y: number; k: number; screen: Size | null; timer?: ReturnType<typeof setTimeout> }>({ dx: 0, dy: 0, x: 0, y: 0, k: 1, screen: null });
  const onWheelRef = useRef<(e: WheelEvent) => void>(() => undefined);
  onWheelRef.current = (e: WheelEvent) => {
    const el = img.current;
    if (!el || e.target !== el || mode !== "control") return;
    e.preventDefault(); // the page must not scroll under the cursor
    const r = el.getBoundingClientRect();
    let dx = wheelPixels(e.deltaX, e.deltaMode, r.width || 1);
    let dy = wheelPixels(e.deltaY, e.deltaMode, r.height || 1);
    if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
    const acc = wheel.current;
    if (acc.timer === undefined) {
      const p = pointAt(el, e.clientX, e.clientY, 0);
      acc.x = p.x;
      acc.y = p.y;
    }
    acc.dx += dx;
    acc.dy += dy;
    acc.screen = deviceSpace(el);
    acc.k = acc.screen.h / Math.max(1, r.height);
    clearTimeout(acc.timer);
    acc.timer = setTimeout(() => {
      const g = acc.screen ? wheelSwipe({ x: acc.x, y: acc.y }, { dx: acc.dx, dy: acc.dy }, acc.k, acc.screen) : null;
      acc.dx = acc.dy = 0;
      acc.timer = undefined;
      if (g) void send(g);
    }, WHEEL_IDLE_MS);
  };
  const hasFrame = !!device;
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => onWheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    const acc = wheel.current;
    return () => {
      el.removeEventListener("wheel", h);
      clearTimeout(acc.timer);
      acc.timer = undefined;
      acc.dx = acc.dy = 0;
    };
  }, [hasFrame, devId]);

  // ---- M9: keyboard on the focused frame. The device has no Enter/Backspace key action and `input` replaces the focused
  // field's text (accessibility SET_TEXT), so keys build a line here and Enter sends it in one `input` action.
  const sendCompose = () => {
    const v = composeRef.current;
    if (!v) return;
    void send({ type: "input", text: v }).then((ok) => {
      if (!ok) return;
      setCompose((cur) => (cur === v ? "" : cur));
      toast(t.mirror.sent(v));
    });
  };
  const onFrameKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // a retry button inside the frame keeps its own Enter/Space
    if (mode !== "control" || e.nativeEvent.isComposing || e.key === "Process") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      sendCompose();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      setCompose((c) => Array.from(c).slice(0, -1).join(""));
    } else if (e.key === "Escape") {
      if (composeRef.current) {
        e.preventDefault();
        setCompose("");
      }
    } else if (Array.from(e.key).length === 1) {
      e.preventDefault();
      setCompose((c) => (c + e.key).slice(0, MAX_COMPOSE));
    }
  };
  const onFramePaste = (e: RClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (e.target !== e.currentTarget || mode !== "control" || !text) return;
    e.preventDefault();
    setCompose((c) => (c + text).slice(0, MAX_COMPOSE));
  };

  const retryFrame = () => {
    setPhase("waiting");
    inflight.current = false;
    if (want.current > 0 && devId) {
      inflight.current = true;
      shown.current = want.current;
      nonce.current += 1;
      setSrc(frameUrl(devId, want.current, nonce.current));
    }
    if (playing && devId) void api.mirrorRetry(devId).then(applySnap).catch((e) => setError(e));
  };

  // ---- H3 layout ------------------------------------------------------------------------------------------------------------------
  const screen: Size | null = shape ?? (device?.info.width && device.info.height ? { w: device.info.width, h: device.info.height } : null);
  const landscape = isLandscape(screen);
  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  const shotW = fitWidth({ w: Infinity, h: avail }, screen, fit, dpr);
  shotWRef.current = shotW;
  fitRef.current = fit;

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
  const capture = captureState(device.info);
  return (
    <div className="page">
      {error !== null && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
      <CaptureCard
        state={capture}
        busy={rechecking}
        onRecheck={() => {
          setRechecking(true);
          void api
            .refresh(devId)
            .then(() => (playing ? api.mirrorRetry(devId).then(applySnap) : undefined))
            .catch((e) => setError(e))
            .finally(() => setRechecking(false));
        }}
      />
      {reason === "viewers_full" && (
        <Alert tone="warn" role="status">
          <IconAlert size={16} />
          <span className="grow">{t.mirror.viewersFull}</span>
        </Alert>
      )}
      <div className="row toolbar">
        <Button variant="bare" className={playing ? "" : "primary"} onClick={() => setPlaying((p) => !p)}>
          {playing ? t.mirror.pause : t.mirror.start}
        </Button>
        <label className="row">
          {t.mirror.fps}
          <Select aria-label={t.mirror.fps} value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            {MIRROR_FPS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </label>
        <div className="seg" role="group" aria-label={t.mirror.view} title={t.mirror.viewHint}>
          {(["fit", "actual"] as const).map((m) => (
            <Button key={m} size="sm" aria-pressed={fit === m} onClick={() => setFit(m)}>
              {m === "fit" ? t.mirror.fit : t.mirror.actual}
            </Button>
          ))}
        </div>
        <CaptureChip state={capture} />
        <span className="grow" />
        {(["back", "home", "recents"] as const).map((k) => (
          <Button size="sm" key={k} onClick={() => void send({ type: "key", name: k })}>
            {t.projects[k]}
          </Button>
        ))}
      </div>
      <div className={"mirror-grid" + (landscape ? " stacked" : "")}>
        <div
          className={"mirror-frame" + (fit === "actual" ? " actual" : "")}
          ref={frameRef}
          tabIndex={0}
          aria-label={t.mirror.keyboard}
          data-text-entry="true"
          style={fit === "actual" ? { maxHeight: avail } : shotW ? { width: shotW } : undefined}
          onKeyDown={onFrameKey}
          onPaste={onFramePaste}
        >
          {src && (
            <div className="mirror-shot" style={shotW ? { width: shotW } : undefined}>
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
                if (e.button !== 0) return; // right button = back (contextmenu), middle does nothing
                frameRef.current?.focus({ preventScroll: true });
                e.currentTarget.setPointerCapture?.(e.pointerId);
                down.current = point(e);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (mode === "control") void send({ type: "key", name: "back" });
              }}
              onPointerMove={(e) => {
                const p = point(e);
                setHover({ x: p.x, y: p.y });
              }}
              onPointerUp={(e) => {
                const d = down.current;
                down.current = null;
                if (!d) return;
                const up = point(e);
                if (mode !== "control") {
                  setPicked({ x: up.x, y: up.y, n: ++pickN.current });
                  return;
                }
                void send(classify(d, up));
              }}
              onPointerCancel={() => (down.current = null)}
            />
            {hitBox && <div className="hitbox" style={hitBox} />}
            </div>
          )}
          {blocked && (
            <div className="overlay fail" role="status">
              <IconAlert size={28} />
              <span>{t.mirror.noCapture}</span>
              <Button onClick={() => void api.mirrorRetry(devId).catch((e) => setError(e))}>
                {t.mirror.retry}
              </Button>
            </div>
          )}
          {stalled && !blocked && (
            <div className="overlay fail" role="status">
              <IconAlert size={28} />
              <span>{t.mirror.stalled}</span>
              <Button onClick={() => void api.mirrorRetry(devId).catch((e) => setError(e))}>
                {t.mirror.retry}
              </Button>
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
              <Button onClick={retryFrame}>
                {t.mirror.retry}
              </Button>
            </div>
          )}
          {compose && (
            <div className="mirror-compose" role="status">
              <span className="muted">{t.mirror.composing}</span>
              <span className="mono grow compose-text">
                {compose}
                <span className="caret" aria-hidden="true">▌</span>
              </span>
              <span className="muted">{t.mirror.composeKeys}</span>
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
              void send({ type: "input", text: v }).then((ok) => {
                if (!ok) return; // the error banner says why; keep the text so it can be resent
                setText("");
                toast(t.mirror.sent(v));
              });
            }}
          >
            <Input aria-label={t.mirror.text} className="grow w-auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={t.mirror.textPlaceholder} />
            <Button type="submit" disabled={!text}>
              {t.mirror.send}
            </Button>
          </form>
          <p className="hint">{t.mirror.hint}</p>
          <ScreenTools
            device={device}
            mode={mode}
            onMode={setMode}
            hover={hover}
            picked={picked}
            onHit={(rect, screen) => setHitBox(rect && screen ? rectPercent(rect, screen) : null)}
            toast={toast}
          />
        </div>
      </div>
      {toasts}
    </div>
  );
}
