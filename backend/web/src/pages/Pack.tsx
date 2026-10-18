import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Drawer,
  Dropdown,
  Modal,
  Pagination,
  Popconfirm,
  QRCode,
  Row,
  Select,
  Skeleton,
  Space,
  Table,
  Tooltip,
  Typography,
} from "antd";
import {
  AndroidOutlined,
  DeleteOutlined,
  DownloadOutlined,
  MoreOutlined,
  PlusOutlined,
  ShareAltOutlined,
} from "@ant-design/icons";
import { api, download, type Page, type PackJob, type ShareLink } from "../api";
import { useAuth } from "../auth";
import { CopyText, JobStatusTag, PageHeader } from "../components";
import { fmtAgo, fmtDuration, fmtSize, fmtTime } from "../format";
import { PackForm, type PackInfo } from "./pack/PackForm";

export default function PackPage() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const preset = useMemo(() => {
    const sid = Number(params.get("script")) || undefined;
    const vid = Number(params.get("version")) || undefined;
    return sid ? { script_id: sid, version_id: vid } : undefined;
  }, [params]);
  const [page, setPage] = useState(1);
  const [logJob, setLogJob] = useState<PackJob | null>(null);
  const [shareJob, setShareJob] = useState<PackJob | null>(null);
  const info = useQuery({ queryKey: ["pack-info"], queryFn: () => api.get<PackInfo>("/api/pack/info") });
  const jobs = useQuery({
    queryKey: ["pack-jobs", page],
    queryFn: () => api.get<Page<PackJob>>("/api/pack/jobs", { page, page_size: 10 }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((j) => j.status === "queued" || j.status === "running") ? 2000 : 15000),
  });
  const items = jobs.data?.items ?? [];
  const running = items.filter((j) => j.status === "running").length;
  const queued = items.filter((j) => j.status === "queued").length;

  return (
    <>
      <PageHeader
        title="APK 打包"
        desc="把工程构建成独立 App，可内嵌卡密授权、云控连接、热更新和代码保护。构建在服务器上进行，一次一个。"
        extra={
          <span className="queue-chip">
            <span className={"dot" + (running ? " on" : "")} />
            {running ? `构建中 ${running}` : "空闲"}
            {queued > 0 && ` · 排队 ${queued}`}
          </span>
        }
      />
      {info.data && !info.data.available && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} title={"打包不可用：" + info.data.reason} />
      )}
      <Row gutter={[20, 20]}>
        {can("operator") && (
          <Col xs={24} xl={11} xxl={10}>
            <PackForm info={info.data} onCreated={() => setPage(1)} preset={preset} />
          </Col>
        )}
        <Col xs={24} xl={can("operator") ? 13 : 24} xxl={can("operator") ? 14 : 24}>
          <JobList
            data={jobs.data}
            loading={jobs.isLoading}
            page={page}
            setPage={setPage}
            onLog={setLogJob}
            onShare={setShareJob}
          />
        </Col>
      </Row>
      <LogDrawer job={logJob} onClose={() => setLogJob(null)} />
      <ShareModal job={shareJob} publicUrl={info.data?.public_url} onClose={() => setShareJob(null)} />
    </>
  );
}

function JobList({
  data,
  loading,
  page,
  setPage,
  onLog,
  onShare,
}: {
  data?: Page<PackJob>;
  loading: boolean;
  page: number;
  setPage: (p: number) => void;
  onLog: (j: PackJob) => void;
  onShare: (j: PackJob) => void;
}) {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["pack-jobs"] });
  const cancel = useMutation({ mutationFn: (id: number) => api.post(`/api/pack/jobs/${id}/cancel`), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/api/pack/jobs/${id}`), onSuccess: refresh });
  const items = data?.items ?? [];

  return (
    <Card title="打包记录" className="table-card" extra={data && data.total > 0 && <span className="muted">共 {data.total} 个</span>}>
      {loading ? (
        <div style={{ padding: 20 }}>
          <Skeleton active avatar paragraph={{ rows: 2 }} />
        </div>
      ) : items.length === 0 ? (
        <div className="job-empty">
          <span className="icon-badge gray">
            <AndroidOutlined />
          </span>
          <b>还没有打包记录</b>
          <span className="muted">在左侧选择工程、填写包名后点「开始打包」。构建完成后可以在这里下载 APK，或生成下载链接分发给用户。</span>
        </div>
      ) : (
        <ul className="job-list">
          {items.map((j) => {
            const active = j.status === "queued" || j.status === "running";
            const tags = [
              j.options.script_name ? `${String(j.options.script_name)} ${String(j.options.script_version ?? "")}` : "",
              j.options.license && "卡密",
              j.options.cloud && "云控",
              j.options.hot_update && "热更新",
              j.options.protect && "代码保护",
              j.options.release && "正式签名",
              String(j.options.abis ?? "") === "arm64-v8a" ? "arm64" : j.options.abis ? "arm64 + x86_64" : "",
            ].filter(Boolean) as string[];
            return (
              <li key={j.id} className={"job-item" + (j.status === "running" ? " running" : "")}>
                <span className="job-icon" aria-hidden>
                  {(j.app_name || j.app_id).slice(0, 1).toUpperCase()}
                </span>
                <div className="job-main">
                  <div className="job-title">
                    <b>{j.app_name || j.app_id}</b>
                    <span className="muted">
                      v{j.version}（{j.version_code}）
                    </span>
                    <JobStatusTag status={j.status} />
                    {j.queue_position ? <span className="muted">第 {j.queue_position} 位</span> : null}
                  </div>
                  <div className="mono muted job-sub">
                    #{j.id} · {j.app_id}
                  </div>
                  {tags.length > 0 && (
                    <div className="job-tags">
                      {tags.map((t) => (
                        <span key={t}>{t}</span>
                      ))}
                    </div>
                  )}
                  {j.error && (
                    <Tooltip title={j.error}>
                      <div className="job-error">{j.error}</div>
                    </Tooltip>
                  )}
                </div>
                <div className="job-side">
                  <span className="muted">
                    {j.created_by} · {fmtAgo(j.created_at)}
                  </span>
                  <span className="muted">
                    {j.started_at ? fmtDuration(j.started_at, j.finished_at) : "未开始"}
                    {j.apk_size ? " · " + fmtSize(j.apk_size) : ""}
                  </span>
                  <Space size={4} wrap style={{ justifyContent: "flex-end" }}>
                    {j.has_apk && (
                      <Button
                        type="primary"
                        size="small"
                        icon={<DownloadOutlined />}
                        onClick={() =>
                          download(`/api/pack/jobs/${j.id}/apk`, undefined, j.app_id + ".apk").catch((e) => message.error(e.message))
                        }
                      >
                        下载
                      </Button>
                    )}
                    {j.has_apk && can("operator") && (
                      <Button size="small" icon={<ShareAltOutlined />} onClick={() => onShare(j)}>
                        分发
                      </Button>
                    )}
                    <Button size="small" onClick={() => onLog(j)}>
                      日志
                    </Button>
                    {can("operator") && (
                      <Dropdown
                        trigger={["click"]}
                        menu={{
                          items: active
                            ? [{ key: "cancel", label: "取消任务", danger: true }]
                            : [{ key: "delete", label: "删除记录和 APK", danger: true }],
                          onClick: ({ key }) =>
                            modal.confirm({
                              title: key === "cancel" ? "取消这个打包任务？" : "删除记录和 APK？",
                              okType: "danger",
                              onOk: () => (key === "cancel" ? cancel.mutateAsync(j.id) : remove.mutateAsync(j.id)),
                            }),
                        }}
                      >
                        <Button size="small" type="text" icon={<MoreOutlined />} aria-label="更多操作" />
                      </Dropdown>
                    )}
                  </Space>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {data && data.total > 10 && (
        <div style={{ padding: "12px 16px", display: "flex", justifyContent: "flex-end" }}>
          <Pagination current={page} pageSize={10} total={data.total} onChange={setPage} size="small" showSizeChanger={false} />
        </div>
      )}
    </Card>
  );
}

/** 分发: public download links with a QR code for phones. */
function ShareModal({ job, publicUrl, onClose }: { job: PackJob | null; publicUrl?: string; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [days, setDays] = useState(0);
  const base = (publicUrl || window.location.origin).replace(/\/$/, "");
  const links = useQuery({
    queryKey: ["shares", job?.id],
    queryFn: () => api.get<{ items: ShareLink[] }>(`/api/pack/jobs/${job!.id}/shares`),
    enabled: !!job,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["shares", job?.id] });
  const create = useMutation({
    mutationFn: () => api.post<ShareLink>(`/api/pack/jobs/${job!.id}/shares`, { days }),
    onSuccess: refresh,
    onError: (e) => message.error((e as Error).message),
  });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/api/pack/shares/${id}`), onSuccess: refresh });
  const items = links.data?.items ?? [];
  const first = items[0];
  return (
    <Modal
      open={!!job}
      onCancel={onClose}
      footer={null}
      width={640}
      title={job && `分发 ${job.app_name || job.app_id} v${job.version}`}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        生成公开下载页，用户用手机扫码或打开链接即可下载安装。任何拿到链接的人都能下载，不需要登录；不用时可以删除链接。
      </Typography.Paragraph>
      {first && (
        <div className="share-hero">
          <QRCode value={base + first.path} size={148} bordered={false} />
          <div style={{ minWidth: 0 }}>
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
              最新链接
            </div>
            <CopyText text={base + first.path} />
            <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
              {first.expires_at ? `${fmtTime(first.expires_at)} 失效` : "长期有效"} · 已下载 {first.downloads} 次
            </div>
            {!publicUrl && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 10 }}
                title="系统设置里还没填公网地址，链接按当前浏览器地址生成"
              />
            )}
          </div>
        </div>
      )}
      <Space style={{ margin: "16px 0" }} wrap>
        <Select
          value={days}
          onChange={setDays}
          style={{ width: 140 }}
          options={[
            { value: 0, label: "长期有效" },
            { value: 1, label: "1 天" },
            { value: 7, label: "7 天" },
            { value: 30, label: "30 天" },
          ]}
        />
        <Button type="primary" icon={<PlusOutlined />} loading={create.isPending} onClick={() => create.mutate()}>
          生成下载链接
        </Button>
      </Space>
      <Table<ShareLink>
        size="small"
        rowKey="id"
        loading={links.isLoading}
        dataSource={items}
        pagination={false}
        locale={{ emptyText: "还没有下载链接" }}
        columns={[
          { title: "链接", render: (_, l) => <CopyText text={base + l.path}>{l.path}</CopyText> },
          { title: "下载", dataIndex: "downloads", width: 70 },
          { title: "失效", dataIndex: "expires_at", width: 140, render: (t: number | null) => (t ? fmtTime(t) : "长期") },
          {
            title: "",
            key: "ops",
            width: 50,
            render: (_, l) => (
              <Popconfirm title="删除后链接立即失效" onConfirm={() => remove.mutate(l.id)}>
                <Button type="text" size="small" danger aria-label="删除链接" icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />
    </Modal>
  );
}

function LogDrawer({ job, onClose }: { job: PackJob | null; onClose: () => void }) {
  const [text, setText] = useState("");
  const offset = useRef(0);
  const box = useRef<HTMLPreElement>(null);
  const live = useQuery({
    queryKey: ["pack-job", job?.id],
    queryFn: () => api.get<PackJob>(`/api/pack/jobs/${job!.id}`),
    enabled: !!job,
    refetchInterval: (q) => (q.state.data && !["queued", "running"].includes(q.state.data.status) ? false : 2000),
  });
  const status = live.data?.status ?? job?.status;

  useEffect(() => {
    setText("");
    offset.current = 0;
    if (!job) return;
    let stop = false;
    let busy = false; // an overlapping poll would fetch the same offset and duplicate the text
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await api.get<{ text: string; next: number }>(`/api/pack/jobs/${job.id}/log`, { offset: offset.current });
        if (stop) return;
        if (r.text) {
          offset.current = r.next;
          setText((t) => (t + r.text).slice(-400_000));
          requestAnimationFrame(() => box.current && (box.current.scrollTop = box.current.scrollHeight));
        }
      } catch {
        /* retry next tick */
      } finally {
        busy = false;
      }
    };
    tick();
    const timer = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [job]);

  return (
    <Drawer
      open={!!job}
      onClose={onClose}
      size={760}
      title={job && `构建日志 #${job.id} · ${job.app_id}`}
      extra={status && <JobStatusTag status={status} />}
    >
      <pre ref={box} className="log-view" style={{ height: "calc(100vh - 140px)" }}>
        {text || "等待输出…"}
      </pre>
    </Drawer>
  );
}
