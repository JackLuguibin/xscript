import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Segmented, Space, Switch, Tooltip } from "antd";
import {
  AppstoreOutlined,
  BellOutlined,
  HomeOutlined,
  PauseCircleOutlined,
  ReloadOutlined,
  RollbackOutlined,
} from "@ant-design/icons";
import { request } from "./api";

/** One relayed device HTTP call (POST /api/devices/<id>/http). */
async function relay<T>(id: string, method: string, path: string, opts: { query?: Record<string, string>; body?: unknown } = {}) {
  return request<T>("POST", `/api/devices/${encodeURIComponent(id)}/http`, {
    method,
    path,
    query: opts.query,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    timeout: 20,
  });
}

const QUALITY: Record<string, { max: number; quality: number }> = {
  流畅: { max: 480, quality: 40 },
  清晰: { max: 800, quality: 60 },
};

/**
 * 远程操控 over the 云控 relay: polls small JPEG frames and maps clicks / drags on the image
 * to device coordinates (POST /action click or swipe). Works through NAT like the rest of 云控.
 */
export function RemoteControl({
  id,
  width,
  height,
  running,
  onStop,
  autoStart = false,
}: {
  id: string;
  width?: number;
  height?: number;
  running: boolean;
  onStop: () => void;
  autoStart?: boolean;
}) {
  const { message } = App.useApp();
  const [live, setLive] = useState(autoStart);
  const [mode, setMode] = useState("流畅");
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ripple, setRipple] = useState<{ x: number; y: number; k: number } | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; t: number } | null>(null);
  const inflight = useRef(false);
  const urlRef = useRef<string | null>(null);

  const frame = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    try {
      const q = QUALITY[mode];
      const blob = await relay<Blob>(id, "GET", "/screen", {
        query: { format: "jpg", max: String(q.max), quality: String(q.quality) },
      });
      if (!(blob instanceof Blob) || !blob.type.startsWith("image/")) throw new Error("截图不可用");
      const url = URL.createObjectURL(blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setSrc(url);
      setError("");
    } catch (e) {
      setError((e as Error).message || "截图失败");
      setLive(false);
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }, [id, mode]);

  useEffect(() => {
    if (!live) return;
    let stop = false;
    const loop = async () => {
      while (!stop) {
        await frame();
        await new Promise((r) => setTimeout(r, 700));
      }
    };
    loop();
    return () => {
      stop = true;
    };
  }, [live, frame]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const toDevice = (clientX: number, clientY: number) => {
    const el = img.current;
    if (!el || !width || !height) return null;
    const r = el.getBoundingClientRect();
    const fx = (clientX - r.left) / r.width;
    const fy = (clientY - r.top) / r.height;
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
    return { x: Math.round(fx * width), y: Math.round(fy * height), px: clientX - r.left, py: clientY - r.top };
  };

  const act = async (body: Record<string, unknown>) => {
    try {
      const r = await relay<{ ok?: boolean; error?: string }>(id, "POST", "/action", { body });
      if (r && r.ok === false) message.warning("设备没有执行（检查无障碍或 Root）");
      setTimeout(frame, 350);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onUp = (e: React.PointerEvent) => {
    const start = drag.current;
    drag.current = null;
    if (!start) return;
    const a = toDevice(start.x, start.y);
    const b = toDevice(e.clientX, e.clientY);
    if (!a || !b) {
      if (!width) message.info("设备没有上报屏幕尺寸，无法换算坐标");
      return;
    }
    setRipple({ x: a.px, y: a.py, k: Date.now() });
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (moved < 8) {
      const held = Date.now() - start.t;
      act({ type: "click", x: a.x, y: a.y, dur: held > 450 ? 800 : 30 });
    } else {
      act({ type: "swipe", x1: a.x, y1: a.y, x2: b.x, y2: b.y, dur: Math.min(1500, Math.max(150, Date.now() - start.t)) });
    }
  };

  const key = (name: string) => act({ type: "key", name });

  return (
    <div className="remote">
      <div className="remote-bar">
        <Space size={10} wrap>
          <Space size={6}>
            <Switch size="small" checked={live} onChange={setLive} aria-label="实时刷新" />
            <span className="muted">实时</span>
          </Space>
          <Segmented size="small" value={mode} onChange={(v) => setMode(String(v))} options={Object.keys(QUALITY)} />
          <Tooltip title="刷新一帧">
            <Button size="small" icon={<ReloadOutlined />} loading={busy && !live} onClick={frame} aria-label="刷新" />
          </Tooltip>
        </Space>
      </div>
      <div className="remote-screen">
        {src ? (
          <img
            ref={img}
            src={src}
            alt="设备画面，点击或拖动来操作"
            draggable={false}
            onPointerDown={onDown}
            onPointerUp={onUp}
            onPointerLeave={() => (drag.current = null)}
          />
        ) : (
          <div className="placeholder">{error || "打开「实时」或点刷新，获取设备画面。在画面上点击、长按、拖动即可操作设备。"}</div>
        )}
        {ripple && <span key={ripple.k} className="remote-ripple" style={{ left: ripple.x + 8, top: ripple.y + 8 }} />}
      </div>
      <div className="remote-bar">
        <Button size="small" icon={<RollbackOutlined />} onClick={() => key("back")}>
          返回
        </Button>
        <Button size="small" icon={<HomeOutlined />} onClick={() => key("home")}>
          主页
        </Button>
        <Button size="small" icon={<AppstoreOutlined />} onClick={() => key("recents")}>
          多任务
        </Button>
        <Button size="small" icon={<BellOutlined />} onClick={() => key("notifications")}>
          通知栏
        </Button>
        {running && (
          <Button size="small" danger icon={<PauseCircleOutlined />} onClick={onStop}>
            停止脚本
          </Button>
        )}
      </div>
      {error && src && <span className="muted" style={{ fontSize: 12.5 }}>{error}</span>}
    </div>
  );
}
