import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Col,
  Collapse,
  Form,
  Input,
  InputNumber,
  Radio,
  Row,
  Segmented,
  Select,
  Switch,
  Tooltip,
  Upload,
} from "antd";
import type { UploadFile } from "antd";
import {
  ArrowRightOutlined,
  BuildOutlined,
  CloudServerOutlined,
  InboxOutlined,
  LockOutlined,
  PictureOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { api, type PackJob, type Script, type ScriptVersion } from "../../api";

export interface PackInfo {
  available: boolean;
  reason: string;
  release_signing: boolean;
  public_url: string;
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

export function PackForm({
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
