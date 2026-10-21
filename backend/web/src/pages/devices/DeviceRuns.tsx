import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import { Alert, Empty, Select, Space, Switch, Table, Tooltip, Typography } from "antd";
import { ApiError, request } from "../../api";
import { Pill } from "../../components";

/** One entry of the phone's GET /projects/{name}/runs (XScript App v0.5.0+). */
export interface RunRecord {
  project: string;
  start: number;
  duration_ms: number;
  exit?: string | null;
  user_stop?: boolean;
  log_from: number;
  log_to: number;
  outcome: string;
  failed: boolean;
  stats?: { captures: number; capture_avg_ms: number; peak_mb: number } | null;
}

function relay<T>(id: string, path: string, query?: Record<string, string>) {
  return request<T>("POST", `/api/devices/${encodeURIComponent(id)}/http`, { method: "GET", path, query, timeout: 15 });
}

/** One run's own lines (log_from < seq <= log_to) from the phone's log buffer, read through the relay. */
function RunLog({ id, run }: { id: string; run: RunRecord }) {
  const q = useQuery({
    queryKey: ["device-run-log", id, run.log_from, run.log_to],
    queryFn: () => relay<{ entries: { seq: number; stream: string; line: string }[] }>(id, "/logs", { since: String(run.log_from) }),
    retry: false,
  });
  if (q.isLoading) return <Typography.Text type="secondary">读取中…</Typography.Text>;
  if (q.error) return <Alert type="error" showIcon message={(q.error as Error).message} />;
  const lines = (q.data?.entries ?? []).filter((e) => e.seq > run.log_from && e.seq <= run.log_to);
  if (!lines.length) return <Typography.Text type="secondary">这段日志已不在手机的日志缓冲区里（被新日志挤掉或已清空）</Typography.Text>;
  return (
    <pre className="mono code-block" aria-label="这次运行的日志" style={{ maxHeight: 260, overflow: "auto", margin: 0 }}>
      {lines.map((l) => (
        <div key={l.seq} style={l.stream === "stderr" ? { color: "var(--ant-color-error, #d4380d)" } : undefined}>
          {l.line.replace(/\n$/, "")}
        </div>
      ))}
    </pre>
  );
}

export function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

export function fmtStats(s: RunRecord["stats"]): string {
  if (!s) return "-";
  return s.captures > 0 ? `截图 ${s.captures} 次 · 均 ${s.capture_avg_ms}ms · ${s.peak_mb}MB` : `未截图 · ${s.peak_mb}MB`;
}

/** 最近运行 of one project, read live from the phone through the 云控 relay (the server keeps no copy). */
export function DeviceRuns({ id, online, defaultProject }: { id: string; online: boolean; defaultProject?: string | null }) {
  const projects = useQuery({
    queryKey: ["device-projects", id],
    queryFn: () => relay<{ projects: { name: string }[] }>(id, "/projects"),
    enabled: online,
  });
  const names = (projects.data?.projects ?? []).map((p) => p.name);
  const [project, setProject] = useState<string>(defaultProject ?? "");
  const [failedOnly, setFailedOnly] = useState(false);
  useEffect(() => {
    if (!project && names.length) setProject(defaultProject && names.includes(defaultProject) ? defaultProject : names[0]);
  }, [names, project, defaultProject]);
  const runs = useQuery({
    queryKey: ["device-runs", id, project],
    queryFn: () => relay<{ runs: RunRecord[] }>(id, `/projects/${encodeURIComponent(project)}/runs`),
    enabled: online && !!project,
    retry: false,
  });
  if (!online) return <Empty description="设备离线：运行记录保存在手机上，上线后才能查看" />;
  const missing = runs.error instanceof ApiError && runs.error.status === 404;
  const rows = (runs.data?.runs ?? []).filter((r) => !failedOnly || r.failed);
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Select
          aria-label="工程"
          style={{ minWidth: 200 }}
          value={project || undefined}
          placeholder="选择工程"
          loading={projects.isLoading}
          options={names.map((n) => ({ value: n, label: n }))}
          onChange={setProject}
        />
        <Space size={6}>
          <Switch size="small" checked={failedOnly} onChange={setFailedOnly} aria-label="只看出错" />
          <span>只看出错</span>
        </Space>
      </Space>
      {missing ? (
        <Alert type="info" showIcon message="手机上没有这个工程的运行记录接口：工程已删除，或手机端 XScript 早于 v0.5.0。" />
      ) : runs.error ? (
        <Alert type="error" showIcon message={(runs.error as Error).message} />
      ) : (
        <Table<RunRecord>
          size="small"
          rowKey="start"
          loading={runs.isLoading && !!project}
          pagination={false}
          expandable={{ expandedRowRender: (r) => <RunLog id={id} run={r} />, expandRowByClick: true }}
          dataSource={rows}
          locale={{ emptyText: failedOnly ? "最近没有出错的运行" : "还没有运行记录" }}
          columns={[
            {
              title: "开始",
              dataIndex: "start",
              render: (v: number) => <span style={{ whiteSpace: "nowrap" }}>{dayjs(v).format("MM-DD HH:mm")}</span>,
            },
            { title: "耗时", dataIndex: "duration_ms", render: (v: number) => <span style={{ whiteSpace: "nowrap" }}>{fmtDuration(v)}</span> },
            {
              title: "结束方式",
              dataIndex: "outcome",
              render: (v: string, r) => <Pill tone={r.failed ? "red" : r.user_stop ? "gray" : "green"}>{v}</Pill>,
            },
            {
              title: "统计",
              dataIndex: "stats",
              render: (s: RunRecord["stats"]) => (
                <Tooltip title="来自运行结束时日志里的「运行统计」行；点停止的运行没有">
                  <Typography.Text type="secondary">{fmtStats(s)}</Typography.Text>
                </Tooltip>
              ),
            },
          ]}
        />
      )}
    </Space>
  );
}
