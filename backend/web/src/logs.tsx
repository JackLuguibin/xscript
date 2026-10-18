import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, DatePicker, Segmented, Select, Space, Switch, Tooltip } from "antd";
import { ClearOutlined, DownloadOutlined, HistoryOutlined, ThunderboltOutlined, VerticalAlignBottomOutlined } from "@ant-design/icons";
import type { Dayjs } from "dayjs";
import { api, download, request } from "./api";
import { SearchInput } from "./components";
import { fmtAgo, fmtTime } from "./format";

interface LogEntry {
  seq: number;
  ts: number;
  stream: string;
  line: string;
  /** Server row id (history mode only). */
  id?: number;
}

export interface LastRun {
  project: string;
  exit: string;
  crashed: boolean;
  time: number;
  tail: { stream: string; line: string }[];
}

const MAX_LINES = 3000;

function LogLines({ lines, boxRef, empty, showDate }: { lines: LogEntry[]; boxRef: React.RefObject<HTMLPreElement | null>; empty: string; showDate?: boolean }) {
  return (
    <pre ref={boxRef} className="log-view" style={{ height: 460 }} aria-live="polite">
      {lines.length === 0 ? (
        <span style={{ color: "#6b7383" }}>{empty}</span>
      ) : (
        lines.map((e) => {
          const d = new Date(e.ts);
          const time = d.toLocaleTimeString("zh-CN", { hour12: false });
          return (
            <div key={e.id ?? e.seq} className={e.stream === "stderr" ? "log-err" : undefined}>
              <span className="log-ts" title={fmtTime(Math.floor(e.ts / 1000))}>
                {showDate ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${time}` : time}
              </span>
              {e.line.replace(/\n$/, "")}
            </div>
          );
        })
      )}
    </pre>
  );
}

function useFollow(lines: LogEntry[], follow: boolean) {
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);
  return box;
}

/** 实时: device GET /logs?since=… over the 云控 relay, polled every 2 s. */
function LiveLogs({ id }: { id: string }) {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [live, setLive] = useState(true);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState("");
  const since = useRef(0);
  const box = useFollow(lines, follow);

  useEffect(() => {
    if (!live) return;
    let stop = false;
    // A slow device can take longer than the poll interval; overlapping polls would read the same
    // `since` and append the same lines twice.
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await request<{ entries: LogEntry[]; next: number }>(
          "POST",
          `/api/devices/${encodeURIComponent(id)}/http`,
          { method: "GET", path: "/logs", query: { since: String(since.current) }, timeout: 15 },
        );
        if (stop) return;
        setError("");
        if (r.entries?.length) {
          since.current = r.next;
          setLines((old) => [...old, ...r.entries].slice(-MAX_LINES));
        }
      } catch (e) {
        if (!stop) setError((e as Error).message);
      } finally {
        busy = false;
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [id, live]);

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <Space size={6}>
          <Switch size="small" checked={live} onChange={setLive} aria-label="实时刷新" />
          <span className="muted">实时刷新</span>
        </Space>
        <Space size={6}>
          <Switch size="small" checked={follow} onChange={setFollow} aria-label="自动滚动" />
          <span className="muted">自动滚动</span>
        </Space>
        <span className="spacer" />
        <Tooltip title="只清空这里显示的内容">
          <Button size="small" icon={<ClearOutlined />} onClick={() => setLines([])}>
            清屏
          </Button>
        </Tooltip>
        <Button
          size="small"
          icon={<VerticalAlignBottomOutlined />}
          aria-label="滚到底部"
          onClick={() => box.current && (box.current.scrollTop = box.current.scrollHeight)}
        />
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      <LogLines lines={lines} boxRef={box} empty="等待日志输出…" />
    </>
  );
}

interface HistFilter {
  q: string;
  stream: string;
  since_ts: number;
  until_ts: number;
}

/** 历史: lines the device uploaded to the server; readable while the device is offline. */
function HistoryLogs({ id, online }: { id: string; online: boolean }) {
  const { message } = App.useApp();
  const [f, setF] = useState<HistFilter>({ q: "", stream: "", since_ts: 0, until_ts: 0 });
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [follow, setFollow] = useState(true);
  const box = useFollow(lines, follow);
  const path = `/api/devices/${encodeURIComponent(id)}/logs`;
  const lastId = useRef(0);

  // Newest page whenever the filter changes.
  useEffect(() => {
    let stop = false;
    setLoading(true);
    api
      .get<{ items: LogEntry[]; more: boolean }>(path, { ...f, limit: 500 })
      .then((r) => {
        if (stop) return;
        setError("");
        setLines(r.items);
        setMore(r.more);
        lastId.current = r.items.at(-1)?.id ?? 0;
        setFollow(true);
      })
      .catch((e) => !stop && setError((e as Error).message))
      .finally(() => !stop && setLoading(false));
    return () => {
      stop = true;
    };
  }, [path, f]);

  // New lines arrive every few seconds while the device is online (unless looking at a closed range).
  useEffect(() => {
    if (!online || f.until_ts) return;
    let stop = false;
    let busy = false; // see LiveLogs: never poll the same cursor twice
    const t = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await api.get<{ items: LogEntry[] }>(path, { ...f, after: lastId.current, limit: 2000 });
        if (!stop && r.items.length) {
          lastId.current = r.items.at(-1)!.id!;
          setLines((old) => [...old, ...r.items].slice(-MAX_LINES * 2));
        }
      } catch {
        /* next tick */
      } finally {
        busy = false;
      }
    }, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [path, f, online]);

  const loadOlder = useCallback(async () => {
    const first = lines[0]?.id;
    if (!first) return;
    setLoading(true);
    setFollow(false);
    try {
      const el = box.current;
      const oldHeight = el?.scrollHeight ?? 0;
      const r = await api.get<{ items: LogEntry[]; more: boolean }>(path, { ...f, before: first, limit: 500 });
      setLines((old) => [...r.items, ...old]);
      setMore(r.more);
      // Keep the line the user was looking at in place.
      requestAnimationFrame(() => el && (el.scrollTop += el.scrollHeight - oldHeight));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [lines, path, f, box, message]);

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <SearchInput placeholder="搜索日志内容" width={200} onSearch={(q) => setF((x) => ({ ...x, q }))} />
        <Select
          value={f.stream}
          style={{ width: 110 }}
          aria-label="输出类型"
          onChange={(stream) => setF((x) => ({ ...x, stream }))}
          options={[
            { value: "", label: "全部输出" },
            { value: "stdout", label: "标准输出" },
            { value: "stderr", label: "错误输出" },
          ]}
        />
        <DatePicker.RangePicker
          showTime={{ format: "HH:mm" }}
          format="MM-DD HH:mm"
          style={{ width: 260 }}
          onChange={(r) => {
            const [a, b] = (r ?? [null, null]) as [Dayjs | null, Dayjs | null];
            setF((x) => ({ ...x, since_ts: a ? a.unix() : 0, until_ts: b ? b.unix() : 0 }));
          }}
        />
        <Space size={6}>
          <Switch size="small" checked={follow} onChange={setFollow} aria-label="自动滚动" />
          <span className="muted">自动滚动</span>
        </Space>
        <span className="spacer" />
        <Button
          size="small"
          icon={<DownloadOutlined />}
          onClick={() =>
            download(`${path}/export`, { ...f }, "logs.txt").catch((e) => message.error((e as Error).message))
          }
        >
          导出
        </Button>
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      {more && (
        <Button size="small" block loading={loading} onClick={loadOlder}>
          加载更早的日志
        </Button>
      )}
      <LogLines
        lines={lines}
        boxRef={box}
        showDate
        empty={loading ? "加载中…" : f.q || f.stream || f.since_ts ? "没有符合条件的日志" : "服务器上还没有这台设备的日志"}
      />
    </>
  );
}

/**
 * 运行日志 tab. 实时 reads the phone directly (online only); 历史 reads what the phone
 * uploaded to the server, so it also works after the device went offline.
 */
export function DeviceLogs({
  id,
  online,
  lastRun,
  historyDays,
}: {
  id: string;
  online: boolean;
  lastRun?: LastRun | null;
  /** Settings device_log_days; 0 = the server keeps no history. */
  historyDays?: number;
}) {
  const [mode, setMode] = useState<"live" | "history">(online ? "live" : "history");
  const history = historyDays !== 0;
  const showing = !history ? "live" : mode;

  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      {lastRun && (
        <Alert
          type={lastRun.crashed ? "error" : "info"}
          showIcon
          title={
            lastRun.crashed
              ? `${lastRun.project} 异常退出（退出码 ${lastRun.exit}）· ${fmtAgo(lastRun.time)}`
              : `上次运行 ${lastRun.project} 已结束（${lastRun.exit}）· ${fmtAgo(lastRun.time)}`
          }
          description={
            lastRun.crashed &&
            lastRun.tail.length > 0 && (
              <pre className="log-view" style={{ height: "auto", maxHeight: 200, marginTop: 8 }}>
                {lastRun.tail.map((t) => t.line).join("\n")}
              </pre>
            )
          }
        />
      )}
      {history && (
        <Space wrap>
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as "live" | "history")}
            options={[
              { value: "live", label: "实时", icon: <ThunderboltOutlined /> },
              { value: "history", label: "历史", icon: <HistoryOutlined /> },
            ]}
          />
          <span className="muted" style={{ fontSize: 12.5 }}>
            {showing === "live"
              ? "直接读取手机上的日志"
              : `服务器保存最近 ${historyDays ?? 7} 天，设备离线也能查看`}
          </span>
        </Space>
      )}
      {showing === "history" ? (
        <HistoryLogs id={id} online={online} />
      ) : !online ? (
        <Alert
          type="warning"
          showIcon
          title="设备离线，无法读取实时日志"
          description={!history && "管理员可在「系统设置 → 备份与存储」开启设备日志保存，离线后也能查看历史日志。"}
        />
      ) : (
        <LiveLogs id={id} />
      )}
    </Space>
  );
}
