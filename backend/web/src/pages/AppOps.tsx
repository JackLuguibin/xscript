import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api, type Page, type PackJob } from "../api";
import { useAuth } from "../auth";
import { PageHeader } from "../components";
import { fmtSize, fmtTime } from "../format";

const APP_RULE = { pattern: /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/, message: "填包名，例如 com.me.game" };
const NOTICE_APP_RULE = { pattern: /^(\*|[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+)$/, message: "填 * 或包名" };

interface Notice {
  id: number;
  app: string;
  title: string;
  body: string;
  level: "info" | "warning" | "urgent";
  enabled: boolean;
  starts_at: number | null;
  ends_at: number | null;
  created_by: string;
  created_at: number;
  active: boolean;
}

interface Policy {
  app: string;
  latest_code: number;
  latest_name: string;
  min_code: number;
  job_id: number | null;
  url: string;
  sha256: string;
  size: number;
  notes: string;
  updated_by: string;
  updated_at: number;
  apk_available: boolean;
}

const LEVEL: Record<string, [string, string]> = { info: ["blue", "通知"], warning: ["gold", "提醒"], urgent: ["red", "紧急"] };

function Notices() {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Partial<Notice> | null>(null);
  const [form] = Form.useForm();
  const list = useQuery({ queryKey: ["notices"], queryFn: () => api.get<{ items: Notice[] }>("/api/app-notices") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["notices"] });
  const fail = (e: unknown) => message.error((e as Error).message);
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) =>
      edit?.id ? api.patch("/api/app-notices/" + edit.id, v) : api.post("/api/app-notices", v),
    onSuccess: () => {
      setEdit(null);
      refresh();
    },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (n: Notice) => api.patch("/api/app-notices/" + n.id, { enabled: !n.enabled }),
    onSuccess: refresh,
    onError: fail,
  });
  const del = useMutation({ mutationFn: (id: number) => api.del("/api/app-notices/" + id), onSuccess: refresh, onError: fail });
  const open = (n: Partial<Notice>) => {
    setEdit(n);
    form.setFieldsValue({
      app: "*",
      level: "info",
      enabled: true,
      ...n,
      starts_at: n.starts_at ? dayjs.unix(n.starts_at) : null,
      ends_at: n.ends_at ? dayjs.unix(n.ends_at) : null,
    });
  };
  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="打包的 App 启动时向服务器取公告（纯文本，最多 5 条，最新的在前）。App 包名填 * 表示所有应用都显示。"
      />
      <div className="toolbar">
        <span className="spacer" />
        {can("operator") && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => open({})}>
            新建公告
          </Button>
        )}
      </div>
      <Table<Notice>
        rowKey="id"
        loading={list.isLoading}
        dataSource={list.data?.items}
        columns={[
          { title: "级别", dataIndex: "level", width: 80, render: (l: string) => <Tag color={LEVEL[l][0]}>{LEVEL[l][1]}</Tag> },
          { title: "标题", dataIndex: "title", ellipsis: true },
          { title: "应用", dataIndex: "app", render: (a: string) => (a === "*" ? "全部应用" : <span className="mono">{a}</span>) },
          {
            title: "状态",
            dataIndex: "active",
            width: 90,
            render: (a: boolean, n) => (a ? <Tag color="green">显示中</Tag> : <Tag>{n.enabled ? "不在时间段内" : "已停用"}</Tag>),
          },
          { title: "开始", dataIndex: "starts_at", width: 150, render: (t: number | null) => (t ? fmtTime(t) : "立即") },
          { title: "结束", dataIndex: "ends_at", width: 150, render: (t: number | null) => (t ? fmtTime(t) : "不结束") },
          { title: "创建", dataIndex: "created_by", width: 100 },
          {
            title: "操作",
            key: "ops",
            width: 190,
            render: (_, n) =>
              can("operator") && (
                <Space size={0}>
                  <Button type="link" size="small" onClick={() => open(n)}>
                    编辑
                  </Button>
                  <Button type="link" size="small" onClick={() => toggle.mutate(n)}>
                    {n.enabled ? "停用" : "启用"}
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    danger
                    onClick={() =>
                      modal.confirm({
                        title: "删除这条公告？",
                        okType: "danger",
                        onOk: () => del.mutateAsync(n.id),
                      })
                    }
                  >
                    删除
                  </Button>
                </Space>
              ),
          },
        ]}
      />
      <Modal
        open={!!edit}
        title={edit?.id ? "编辑公告" : "新建公告"}
        onCancel={() => setEdit(null)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        destroyOnHidden
        forceRender
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          onFinish={(v) =>
            save.mutate({
              app: v.app,
              title: v.title,
              body: v.body ?? "",
              level: v.level,
              enabled: v.enabled,
              starts_at: v.starts_at ? v.starts_at.unix() : null,
              ends_at: v.ends_at ? v.ends_at.unix() : null,
            })
          }
        >
          <Form.Item name="app" label="应用" rules={[{ required: true }, NOTICE_APP_RULE]}>
            <Input className="mono" />
          </Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item name="body" label="内容（纯文本）">
            <Input.TextArea rows={4} maxLength={2000} showCount />
          </Form.Item>
          <Form.Item name="level" label="级别">
            <Radio.Group
              optionType="button"
              options={[
                { value: "info", label: "通知" },
                { value: "warning", label: "提醒" },
                { value: "urgent", label: "紧急" },
              ]}
            />
          </Form.Item>
          <Space size={12} wrap>
            <Form.Item name="starts_at" label="开始时间（空 = 立即）">
              <DatePicker showTime />
            </Form.Item>
            <Form.Item name="ends_at" label="结束时间（空 = 不结束）">
              <DatePicker showTime />
            </Form.Item>
          </Space>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function Updates() {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Partial<Policy> | null>(null);
  const [mode, setMode] = useState<"job" | "url">("job");
  const [form] = Form.useForm();
  const appId = Form.useWatch("app", form);
  const list = useQuery({ queryKey: ["app-updates"], queryFn: () => api.get<{ items: Policy[] }>("/api/app-updates") });
  const jobs = useQuery({
    queryKey: ["pack-jobs-all"],
    queryFn: () => api.get<Page<PackJob>>("/api/pack/jobs", { page: 1, page_size: 100 }),
    enabled: !!open,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["app-updates"] });
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.put("/api/app-updates/" + v.app, { ...v, app: undefined }),
    onSuccess: () => {
      setOpen(null);
      refresh();
      message.success("已保存");
    },
    onError: (e) => message.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (app: string) => api.del("/api/app-updates/" + app),
    onSuccess: refresh,
    onError: (e) => message.error((e as Error).message),
  });
  const choices = (jobs.data?.items ?? []).filter((j) => j.status === "succeeded" && j.has_apk && (!appId || j.app_id === appId));
  const edit = (p: Partial<Policy>) => {
    setMode(p.url ? "url" : "job");
    setOpen(p);
    form.setFieldsValue({ min_code: 0, notes: "", ...p, job_id: p.job_id ?? undefined });
  };
  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="热更新只能换脚本代码；改了包名、图标、权限或原生代码时要让用户装新的 APK。这里给每个打包 App 设置最新版本，以及「最低版本」：App 启动时询问服务器，版本低于最低版本的只能更新后继续用。"
      />
      <div className="toolbar">
        <span className="spacer" />
        {can("admin") && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => edit({})}>
            设置更新
          </Button>
        )}
      </div>
      <Table<Policy>
        rowKey="app"
        loading={list.isLoading}
        dataSource={list.data?.items}
        columns={[
          { title: "应用", dataIndex: "app", render: (a: string) => <span className="mono">{a}</span> },
          { title: "最新版本", key: "latest", render: (_, p) => `${p.latest_name || "-"}（${p.latest_code}）` },
          {
            title: "强制更新",
            dataIndex: "min_code",
            render: (m: number) => (m ? <Tag color="red">版本号低于 {m} 必须更新</Tag> : <Tag>不强制</Tag>),
          },
          {
            title: "来源",
            key: "src",
            render: (_, p) =>
              p.job_id ? (
                <span>
                  打包任务 #{p.job_id} · {fmtSize(p.size)}
                  {!p.apk_available && <Tag color="red">APK 已被清理</Tag>}
                </span>
              ) : (
                <Typography.Text ellipsis style={{ maxWidth: 260 }}>
                  {p.url}
                </Typography.Text>
              ),
          },
          { title: "说明", dataIndex: "notes", ellipsis: true },
          { title: "更新", key: "at", width: 150, render: (_, p) => `${p.updated_by} ${fmtTime(p.updated_at)}` },
          {
            title: "操作",
            key: "ops",
            width: 120,
            render: (_, p) =>
              can("admin") && (
                <Space size={0}>
                  <Button type="link" size="small" onClick={() => edit(p)}>
                    修改
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    danger
                    onClick={() => modal.confirm({ title: `清除 ${p.app} 的更新策略？`, content: "清除后不再提示更新，也不再强制。", okType: "danger", onOk: () => del.mutateAsync(p.app) })}
                  >
                    清除
                  </Button>
                </Space>
              ),
          },
        ]}
      />
      <Modal
        open={!!open}
        title="设置应用更新"
        onCancel={() => setOpen(null)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        destroyOnHidden
        forceRender
        width={600}
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          onFinish={(v) =>
            save.mutate(
              mode === "job"
                ? { app: v.app, job_id: v.job_id, min_code: v.min_code ?? 0, notes: v.notes ?? "" }
                : { app: v.app, url: v.url, latest_code: v.latest_code, latest_name: v.latest_name ?? "", sha256: v.sha256 ?? "", min_code: v.min_code ?? 0, notes: v.notes ?? "" },
            )
          }
        >
          <Form.Item name="app" label="应用包名" rules={[{ required: true }, APP_RULE]}>
            <Input className="mono" disabled={!!open?.app} />
          </Form.Item>
          <Radio.Group
            style={{ marginBottom: 16 }}
            optionType="button"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            options={[
              { value: "job", label: "用本站打包的 APK" },
              { value: "url", label: "外部下载链接" },
            ]}
          />
          {mode === "job" ? (
            <Form.Item name="job_id" label="打包任务" extra="版本号、版本名、大小和 SHA-256 取自任务；该任务的 APK 会被保留，不会被存储清理删除" rules={[{ required: true, message: "选择一个打包任务" }]}>
              <Select
                showSearch
                optionFilterProp="label"
                loading={jobs.isLoading}
                options={choices.map((j) => ({
                  value: j.id,
                  label: `#${j.id} ${j.app_id} ${j.version}（${j.version_code}） ${fmtTime(j.finished_at)}`,
                }))}
              />
            </Form.Item>
          ) : (
            <>
              <Form.Item name="url" label="下载链接" rules={[{ required: true }, { pattern: /^https?:\/\/\S+$/, message: "以 http:// 或 https:// 开头" }]}>
                <Input placeholder="https://example.com/app.apk" />
              </Form.Item>
              <Space size={12} align="start">
                <Form.Item name="latest_code" label="最新版本号" rules={[{ required: true }]}>
                  <InputNumber min={1} />
                </Form.Item>
                <Form.Item name="latest_name" label="版本名">
                  <Input maxLength={32} />
                </Form.Item>
              </Space>
              <Form.Item name="sha256" label="SHA-256（可选）" extra="填了的话 App 下载后会校验">
                <Input className="mono" maxLength={64} />
              </Form.Item>
            </>
          )}
          <Form.Item name="min_code" label="最低版本号" extra="版本号低于它的 App 必须更新；0 = 不强制。不能高于最新版本号。">
            <InputNumber min={0} />
          </Form.Item>
          <Form.Item name="notes" label="更新说明">
            <Input.TextArea rows={3} maxLength={1000} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export default function AppOpsPage() {
  return (
    <>
      <PageHeader title="应用运营" desc="给打包的 App 发公告，设置新版本和强制更新。" />
      <Card className="table-card">
        <Tabs
          items={[
            { key: "notices", label: "公告", children: <Notices /> },
            { key: "updates", label: "版本更新", children: <Updates /> },
          ]}
        />
      </Card>
    </>
  );
}
