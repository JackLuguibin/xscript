import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  Drawer,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popconfirm,
  QRCode,
  Radio,
  Row,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import type { UploadFile } from "antd";
import {
  AndroidOutlined,
  ArrowRightOutlined,
  BuildOutlined,
  CloudServerOutlined,
  DeleteOutlined,
  DownloadOutlined,
  InboxOutlined,
  LockOutlined,
  MoreOutlined,
  PictureOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  ShareAltOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { api, download, type Page, type PackJob, type Script, type ScriptVersion, type ShareLink } from "../api";
import { useAuth } from "../auth";
import { CopyText, JobStatusTag, PageHeader, usePageVisible } from "../components";
import { fmtAgo, fmtDuration, fmtSize, fmtTime } from "../format";

interface PackInfo {
  available: boolean;
  reason: string;
  release_signing: boolean;
  public_url: string;
}

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

/** Selectable tile for an on/off build feature (used as a Form.Item child with valuePropName="checked"). */
function FeatureToggle({
  checked,
  onChange,
  icon,
  tone,
  title,
  desc,
  disabled,
  reason,
}: {
  checked?: boolean;
  onChange?: (v: boolean) => void;
  icon: React.ReactNode;
  tone: "violet" | "green" | "blue" | "amber";
  title: string;
  desc: string;
  disabled?: boolean;
  reason?: string;
}) {
  const on = !!checked && !disabled;
  return (
    <div
      role="switch"
      aria-checked={on}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      className={"feature-tile" + (on ? " on" : "") + (disabled ? " disabled" : "")}
      onClick={() => !disabled && onChange?.(!checked)}
      onKeyDown={(e) => {
        if (!disabled && (e.key === " " || e.key === "Enter")) {
          e.preventDefault();
          onChange?.(!checked);
        }
      }}
    >
      <div className="feature-top">
        <span className={"icon-badge " + tone}>{icon}</span>
        <Switch size="small" checked={on} disabled={disabled} tabIndex={-1} />
      </div>
      <b>{title}</b>
      <span className="feature-desc">{disabled && reason ? reason : desc}</span>
    </div>
  );
}

function Section({ step, title, extra, children }: { step: number; title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="form-section">
      <header>
        <span className="step">{step}</span>
        <h3>{title}</h3>
        {extra && <span className="extra">{extra}</span>}
      </header>
      {children}
    </section>
  );
}

function PackForm({
  info,
  onCreated,
  preset,
}: {
  info?: PackInfo;
  onCreated: () => void;
  preset?: { script_id?: number; version_id?: number };
}) {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [project, setProject] = useState<UploadFile[]>([]);
  const [icon, setIcon] = useState<File | null>(null);
  const iconUrl = useMemo(() => (icon ? URL.createObjectURL(icon) : null), [icon]);
  useEffect(() => () => void (iconUrl && URL.revokeObjectURL(iconUrl)), [iconUrl]);
  const source = (Form.useWatch("source", form) as string | undefined) ?? (preset?.script_id ? "script" : "upload");
  const scriptId = Form.useWatch("script_id", form) as number | undefined;
  const w = Form.useWatch([], form) as Record<string, unknown> | undefined;
  const scripts = useQuery({
    queryKey: ["scripts"],
    queryFn: () => api.get<{ items: Script[] }>("/api/scripts"),
    enabled: source === "script",
  });
  const versions = useQuery({
    queryKey: ["script-versions", scriptId],
    queryFn: () => api.get<{ items: ScriptVersion[] }>(`/api/scripts/${scriptId}/versions`),
    enabled: source === "script" && !!scriptId,
  });
  useEffect(() => {
    if (preset?.script_id) form.setFieldsValue({ source: "script", script_id: preset.script_id, script_version_id: preset.version_id });
  }, [preset, form]);
  const needsUrl = !info?.public_url;
  const off = !info?.available;
  // 卡密, 云控 and 热更新 need a public URL the app can reach; keep them off until one is set.
  useEffect(() => {
    if (info) form.setFieldsValue(needsUrl ? { license: false, cloud: false, hot_update: false } : { license: true });
  }, [info, needsUrl, form]);
  useEffect(() => {
    if (source !== "script") form.setFieldValue("hot_update", false);
  }, [source, form]);

  const submit = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const fd = new FormData();
      const { source: _source, ...opts } = v;
      fd.append("options", JSON.stringify(opts));
      if (source === "upload") fd.append("project", project[0].originFileObj as File);
      if (icon) fd.append("icon", icon);
      return api.post<PackJob>("/api/pack/jobs", fd);
    },
    onSuccess: (j) => {
      message.success(`已提交打包任务 #${j.id}`);
      qc.invalidateQueries({ queryKey: ["pack-jobs"] });
      // Bump versionCode so the next build installs as an update.
      form.setFieldValue("version_code", (form.getFieldValue("version_code") ?? 1) + 1);
      onCreated();
    },
    onError: (e) => message.error((e as Error).message),
  });

  const summary = [
    w?.app_id ? String(w.app_id) : "未填包名",
    "v" + String(w?.version ?? "1.0.0"),
    String(w?.abis ?? "arm64-v8a") === "arm64-v8a" ? "arm64" : "arm64 + x86_64",
    w?.license && "卡密",
    w?.cloud && "云控",
    w?.hot_update && "热更新",
    w?.protect && "代码保护",
    w?.release && "正式签名",
  ].filter(Boolean) as string[];
  const urlReason = "先在系统设置填写服务器公网地址";

  return (
    <Card className="pack-form">
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={(v) => {
          if (source === "upload" && !project.length) {
            message.error("先选择工程 zip");
            return;
          }
          submit.mutate(v);
        }}
        initialValues={{
          source: preset?.script_id ? "script" : "upload",
          script_id: preset?.script_id,
          script_version_id: preset?.version_id,
          version: "1.0.0",
          version_code: 1,
          abis: "arm64-v8a",
          license: false,
          cloud: false,
          protect: false,
          hot_update: false,
        }}
        disabled={off}
      >
        <Section step={1} title="选择工程">
          <Form.Item name="source" style={{ marginBottom: 12 }}>
            <Segmented
              block
              options={[
                { value: "upload", label: "上传 zip" },
                { value: "script", label: "小程序版本" },
              ]}
            />
          </Form.Item>
          {source === "upload" ? (
            <Form.Item style={{ marginBottom: 0 }}>
              <Upload.Dragger
                className="dropzone"
                accept=".zip"
                maxCount={1}
                fileList={project}
                beforeUpload={() => false}
                onChange={({ fileList }) => setProject(fileList.slice(-1))}
              >
                <div className="dropzone-body">
                  <span className="icon-badge blue">
                    <InboxOutlined />
                  </span>
                  <div>
                    <b>点击或拖入工程 zip</b>
                    <span>工程目录（含 __init__.py）的压缩包，AScript 导出的也可以</span>
                  </div>
                </div>
              </Upload.Dragger>
            </Form.Item>
          ) : (
            <Row gutter={12}>
              <Col span={14}>
                <Form.Item name="script_id" label="小程序" rules={[{ required: true, message: "选择小程序" }]} style={{ marginBottom: 0 }}>
                  <Select
                    placeholder="选择小程序"
                    showSearch
                    optionFilterProp="label"
                    options={(scripts.data?.items ?? []).map((s) => ({ value: s.id, label: `${s.name}（${s.project_name}）` }))}
                    onChange={() => form.setFieldValue("script_version_id", undefined)}
                    notFoundContent="还没有小程序，先到「小程序」页上传"
                  />
                </Form.Item>
              </Col>
              <Col span={10}>
                <Form.Item name="script_version_id" label="版本" style={{ marginBottom: 0 }}>
                  <Select
                    allowClear
                    placeholder="当前发布版本"
                    options={(versions.data?.items ?? []).map((v) => ({
                      value: v.id,
                      label: `${v.version}${v.current ? "（当前）" : ""}`,
                    }))}
                  />
                </Form.Item>
              </Col>
            </Row>
          )}
        </Section>

        <Section step={2} title="应用信息">
          <div className="app-info">
            <Upload
              accept=".png"
              showUploadList={false}
              beforeUpload={(f) => {
                setIcon(f);
                return false;
              }}
            >
              <Tooltip title={icon ? "更换图标" : "上传图标（PNG，建议 512×512）"}>
                <button type="button" className="icon-picker" aria-label="上传图标" disabled={off}>
                  {iconUrl ? <img src={iconUrl} alt="图标预览" /> : <PictureOutlined />}
                  <span>{icon ? "更换" : "图标"}</span>
                </button>
              </Tooltip>
            </Upload>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="app_name" label="App 名称">
                    <Input maxLength={64} placeholder="默认用工程名" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="app_id"
                    label="包名"
                    rules={[
                      { required: true, message: "填写包名" },
                      { pattern: /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/, message: "格式如 com.me.game" },
                    ]}
                  >
                    <Input className="mono" placeholder="com.me.game" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="version" label="版本号" rules={[{ required: true, message: "填写版本号" }]} style={{ marginBottom: 0 }}>
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="version_code"
                    label={
                      <Tooltip title="每次发布更新都要增大，提交后会自动 +1">
                        <span>versionCode</span>
                      </Tooltip>
                    }
                    rules={[{ required: true }]}
                    style={{ marginBottom: 0 }}
                  >
                    <InputNumber min={1} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
            </div>
          </div>
          {icon && (
            <Button type="link" size="small" style={{ padding: 0, marginTop: 6 }} onClick={() => setIcon(null)}>
              移除图标
            </Button>
          )}
        </Section>

        <Section
          step={3}
          title="功能"
          extra={
            needsUrl && (
              <a onClick={() => navigate("/settings")}>
                填写公网地址 <ArrowRightOutlined />
              </a>
            )
          }
        >
          {needsUrl && (
            <div className="inline-note">卡密、云控和热更新需要 App 能连回这台服务器，先在系统设置里填写服务器公网地址。</div>
          )}
          <div className="feature-grid">
            <Form.Item name="license" valuePropName="checked" noStyle>
              <FeatureToggle
                icon={<SafetyCertificateOutlined />}
                tone="violet"
                title="卡密授权"
                desc="输入卡密才能运行，在本后台激活和复核"
                disabled={off || needsUrl}
                reason={urlReason}
              />
            </Form.Item>
            <Form.Item name="cloud" valuePropName="checked" noStyle>
              <FeatureToggle
                icon={<CloudServerOutlined />}
                tone="green"
                title="连接云控"
                desc="首次启动自动接入，单独生成设备密钥"
                disabled={off || needsUrl}
                reason={urlReason}
              />
            </Form.Item>
            <Form.Item name="hot_update" valuePropName="checked" noStyle>
              <FeatureToggle
                icon={<SyncOutlined />}
                tone="blue"
                title="热更新"
                desc="发布新版本后自动更新代码，不用重装"
                disabled={off || needsUrl || source !== "script"}
                reason={needsUrl ? urlReason : "从「小程序版本」打包时可用"}
              />
            </Form.Item>
            <Form.Item name="protect" valuePropName="checked" noStyle>
              <FeatureToggle
                icon={<LockOutlined />}
                tone="amber"
                title="代码保护"
                desc="只打包字节码，不含 .py 源码"
                disabled={off}
              />
            </Form.Item>
          </div>
          <Form.Item noStyle shouldUpdate={(a, b) => a.cloud !== b.cloud}>
            {({ getFieldValue }) =>
              getFieldValue("cloud") && (
                <Form.Item name="cloud_group" label="云控分组" style={{ marginTop: 14, marginBottom: 0 }}>
                  <Input maxLength={64} placeholder="设备连上后归入这个分组（可选）" />
                </Form.Item>
              )
            }
          </Form.Item>
        </Section>

        <Collapse
          ghost
          size="small"
          className="adv-collapse"
          items={[
            {
              key: "adv",
              label: "高级选项",
              children: (
                <>
                  <Form.Item name="abis" label="CPU 架构">
                    <Radio.Group
                      optionType="button"
                      options={[
                        { value: "arm64-v8a", label: "仅 arm64（真机，约小 40%）" },
                        { value: "arm64-v8a,x86_64", label: "arm64 + x86_64（含模拟器）" },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="project_name" label="工程名" extra="App 内的 Python 包名，默认用 zip 里的目录名">
                    <Input className="mono" />
                  </Form.Item>
                  <div className="switch-grid">
                    <Form.Item name="autostart" valuePropName="checked" label="开机自启">
                      <Switch />
                    </Form.Item>
                    <Form.Item name="bundle_requirements" valuePropName="checked" label="构建时装依赖">
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      name="dev_server"
                      valuePropName="checked"
                      label={
                        <Tooltip title="保留局域网调试接口，仅调试用，没有鉴权">
                          <span>调试接口</span>
                        </Tooltip>
                      }
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      name="release"
                      valuePropName="checked"
                      label={
                        <Tooltip title={info?.release_signing ? "使用服务器配置的签名证书" : "服务器未配置 XSCRIPT_KEYSTORE"}>
                          <span>正式签名</span>
                        </Tooltip>
                      }
                    >
                      <Switch disabled={!info?.release_signing} />
                    </Form.Item>
                  </div>
                </>
              ),
            },
          ]}
        />

        <div className="pack-submit">
          <div className="pack-summary">
            {summary.map((s, i) => (
              <span key={i}>{s}</span>
            ))}
          </div>
          <Button type="primary" htmlType="submit" icon={<BuildOutlined />} loading={submit.isPending} block size="large">
            开始打包
          </Button>
          <span className="muted" style={{ fontSize: 12 }}>
            构建约需 5–10 分钟，可以离开页面，完成后在右侧下载或分发
          </span>
        </div>
      </Form>
    </Card>
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

  const visible = usePageVisible();

  useEffect(() => {
    setText("");
    offset.current = 0;
  }, [job]);

  useEffect(() => {
    // Paused while the tab is hidden; `offset` keeps the position, so polling resumes where it left off.
    if (!job || !visible) return;
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
  }, [job, visible]);

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
