import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Drawer, Empty, Segmented, Select, Space, Switch, Tooltip } from "antd";
import { ExpandOutlined, ReloadOutlined } from "@ant-design/icons";
import { api, request, type Device, type Group, type Page } from "../api";
import { PageHeader, Pill, usePageVisible } from "../components";
import { RemoteControl } from "../remote";

const SIZES: Record<string, number> = { 小: 150, 中: 200, 大: 260 };
// Frames are fetched a few at a time so a wall of 50 phones does not flood the relay.
const PARALLEL = 4;
// Devices per wall (the API's page size); more are reported instead of silently left out.
const WALL_MAX = 200;

/** 屏幕墙: thumbnails of every online device, refreshed in rotation; click to take control. */
export default function WallPage() {
  const [group, setGroup] = useState<string>("");
  const [size, setSize] = useState("中");
  const [live, setLive] = useState(true);
  const [frames, setFrames] = useState<Record<string, { url: string; at: number; error?: string }>>({});
  const [open, setOpen] = useState<Device | null>(null);
  const urls = useRef<Record<string, string>>({});

  const groups = useQuery({ queryKey: ["groups"], queryFn: () => api.get<{ items: Group[] }>("/api/groups") });
  const list = useQuery({
    queryKey: ["wall-devices", group],
    queryFn: () => api.get<Page<Device>>("/api/devices", { online: true, group: group || undefined, page_size: WALL_MAX }),
    refetchInterval: 10000,
    placeholderData: keepPreviousData,
  });
  const devices = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const ids = devices.map((d) => d.id).join(",");
  const visible = usePageVisible();

  // Release the last frame of devices that left the wall (went offline, other group); the map only grew before.
  useEffect(() => {
    const keep = new Set(ids ? ids.split(",") : []);
    const gone = Object.keys(urls.current).filter((id) => !keep.has(id));
    if (!gone.length) return;
    for (const id of gone) {
      URL.revokeObjectURL(urls.current[id]);
      delete urls.current[id];
    }
    setFrames((f) => {
      const next = { ...f };
      for (const id of gone) delete next[id];
      return next;
    });
  }, [ids]);

  useEffect(() => {
    // A hidden tab stops taking screenshots; every device is asked again once it is visible.
    if (!live || !ids || !visible) return;
    let stop = false;
    const queue = ids.split(",");
    const one = async (id: string) => {
      try {
        const blob = await request<Blob>("POST", `/api/devices/${encodeURIComponent(id)}/http`, {
          method: "GET",
          path: "/screen",
          query: { format: "jpg", max: "320", quality: "35" },
          timeout: 15,
        });
        if (stop || !(blob instanceof Blob) || !blob.type.startsWith("image/")) throw new Error("截图不可用");
        const url = URL.createObjectURL(blob);
        if (urls.current[id]) URL.revokeObjectURL(urls.current[id]);
        urls.current[id] = url;
        setFrames((f) => ({ ...f, [id]: { url, at: Date.now() } }));
      } catch (e) {
        if (!stop) setFrames((f) => ({ ...f, [id]: { ...(f[id] ?? { url: "", at: 0 }), error: (e as Error).message } }));
      }
    };
    const loop = async () => {
      while (!stop) {
        for (let i = 0; i < queue.length && !stop; i += PARALLEL) {
          await Promise.all(queue.slice(i, i + PARALLEL).map(one));
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    loop();
    return () => {
      stop = true;
    };
  }, [ids, live, visible]);

  useEffect(
    () => () => {
      Object.values(urls.current).forEach((u) => URL.revokeObjectURL(u));
    },
    [],
  );

  const w = SIZES[size];
  return (
    <>
      <PageHeader
        title="屏幕墙"
        desc="同时查看所有在线设备的画面，轮流刷新。点击某台设备进入远程操控。"
        extra={
          <Space wrap>
            <Select
              style={{ width: 180 }}
              value={group}
              onChange={setGroup}
              options={[
                { value: "", label: "全部在线设备" },
                ...(groups.data?.items ?? []).map((g) => ({ value: g.name, label: `${g.name}（${g.online}）` })),
              ]}
            />
            <Segmented value={size} onChange={(v) => setSize(String(v))} options={Object.keys(SIZES)} />
            <Space size={6}>
              <Switch checked={live} onChange={setLive} aria-label="自动刷新" />
              <span className="muted">自动刷新</span>
            </Space>
            <Tooltip title="刷新设备列表">
              <Button icon={<ReloadOutlined />} onClick={() => list.refetch()} aria-label="刷新设备列表" />
            </Tooltip>
          </Space>
        }
      />
      {total > devices.length && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title={`显示 ${devices.length} / ${total} 台在线设备`}
          description={`屏幕墙最多显示 ${WALL_MAX} 台。按分组筛选可以查看其余设备。`}
        />
      )}
      {devices.length === 0 ? (
        <Card>
          <Empty description={list.isLoading ? "加载中…" : "没有在线设备"} />
        </Card>
      ) : (
        <div className="wall" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${w}px, 1fr))` }}>
          {devices.map((d) => {
            const f = frames[d.id];
            return (
              <button type="button" key={d.id} className="wall-tile" onClick={() => setOpen(d)} aria-label={`操控 ${d.model || d.id}`}>
                <div className="wall-screen" style={{ aspectRatio: aspect(d) }}>
                  {f?.url ? <img src={f.url} alt="" /> : <span className="muted">{f?.error || "加载中…"}</span>}
                  <span className="wall-expand">
                    <ExpandOutlined />
                  </span>
                </div>
                <div className="wall-meta">
                  <b>{[d.brand, d.model].filter(Boolean).join(" ") || d.id}</b>
                  {d.running ? (
                    <Pill tone="green" pulse>
                      {d.project}
                    </Pill>
                  ) : (
                    <Pill tone="blue">空闲</Pill>
                  )}
                </div>
                <div className="wall-sub mono muted">
                  {d.group ? d.group + " · " : ""}
                  {d.id}
                </div>
              </button>
            );
          })}
        </div>
      )}
      <Drawer open={!!open} onClose={() => setOpen(null)} size={480} title={open && ([open.brand, open.model].filter(Boolean).join(" ") || open.id)} destroyOnHidden>
        {open && (
          <RemoteControl
            id={open.id}
            width={open.width || undefined}
            height={open.height || undefined}
            running={open.running}
            onStop={() => api.post("/api/command", { target: open.id, command: { path: "app_stop" } })}
            autoStart
          />
        )}
      </Drawer>
    </>
  );
}

function aspect(d: Device): string {
  const w = d.width || 9;
  const h = d.height || 19.5;
  return `${w} / ${h}`;
}
