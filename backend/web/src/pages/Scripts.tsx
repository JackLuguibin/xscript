import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Skeleton,
  Space,
  Table,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import type { UploadFile } from "antd";
import {
  BuildOutlined,
  CloudUploadOutlined,
  CodeOutlined,
  DownloadOutlined,
  InboxOutlined,
  LockOutlined,
  PlusOutlined,
  RocketOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { api, download, type CommandReply, type Script, type ScriptVersion } from "../api";
import { useAuth } from "../auth";
import { CopyText, PageHeader, Pill, TargetSelect } from "../components";
import { fmtAgo, fmtSize, fmtTime } from "../format";

export default function ScriptsPage() {
  const { can } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const list = useQuery({ queryKey: ["scripts"], queryFn: () => api.get<{ items: Script[] }>("/api/scripts") });
  const items = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="小程序"
        desc="上传工程并管理版本。发布后，开启热更新的 App 会自动更新到发布版本；也可以一键下发到云控设备，或从某个版本打包 APK。"
        extra={
          can("operator") && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建小程序
            </Button>
          )
        }
      />
      {list.isLoading ? (
        <Card>
          <Skeleton active />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <Empty description="还没有小程序。新建一个，然后上传工程 zip 作为第一个版本。" />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {items.map((s) => (
            <Col key={s.id} xs={24} md={12} xxl={8}>
              <ScriptCard script={s} onOpen={() => setDetail(s.id)} />
            </Col>
          ))}
        </Row>
      )}
      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => setDetail(id)} />
      <ScriptDrawer id={detail} onClose={() => setDetail(null)} />
    </>
  );
}

function ScriptCard({ script: s, onOpen }: { script: Script; onOpen: () => void }) {
  return (
    <Card hoverable className="script-card" onClick={onOpen}>
      <div className="script-card-head">
        <span className="icon-badge violet">
          <CodeOutlined />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="script-name">{s.name}</div>
          <div className="mono muted">{s.project_name}</div>
        </div>
        {s.protect && (
          <Tooltip title="代码保护：只下发字节码">
            <LockOutlined className="muted" />
          </Tooltip>
        )}
      </div>
      {s.description && <p className="script-desc">{s.description}</p>}
      <div className="script-meta">
        {s.current ? <Pill tone="green">已发布 v{s.current.version}</Pill> : <Pill>未发布</Pill>}
        {s.latest && s.latest.id !== s.current?.id && <Pill tone="blue">最新 v{s.latest.version}</Pill>}
        <span className="muted">
          {s.versions} 个版本 · {fmtAgo(s.updated_at)}更新
        </span>
      </div>
    </Card>
  );
}

function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post<Script>("/api/scripts", v),
    onSuccess: (s) => {
      message.success("已创建，上传第一个版本吧");
      qc.invalidateQueries({ queryKey: ["scripts"] });
      onClose();
      onCreated(s.id);
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal open={open} title="新建小程序" onCancel={onClose} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={save.mutate} preserve={false} initialValues={{ protect: false }}>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: "填写名称" }]}>
          <Input maxLength={64} placeholder="例如 自动签到" />
        </Form.Item>
        <Form.Item
          name="project_name"
          label="工程名"
          extra="设备上的工程目录名，也是 Python 包名；创建后不能修改"
          rules={[
            { required: true, message: "填写工程名" },
            { pattern: /^[\p{L}_][\p{L}\p{N}_]*$/u, message: "只能用字母、数字、下划线，且不能以数字开头" },
          ]}
        >
          <Input className="mono" maxLength={64} placeholder="auto_sign" />
        </Form.Item>
        <Form.Item name="description" label="简介">
          <Input.TextArea rows={2} maxLength={2000} />
        </Form.Item>
        <Form.Item name="protect" valuePropName="checked" extra="下发和热更新只发送编译后的字节码，不含 .py 源码">
          <Checkbox>代码保护</Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}

function ScriptDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deployVersion, setDeployVersion] = useState<ScriptVersion | null>(null);
  const script = useQuery({
    queryKey: ["script", id],
    queryFn: () => api.get<Script>(`/api/scripts/${id}`),
    enabled: id !== null,
  });
  const versions = useQuery({
    queryKey: ["script-versions", id],
    queryFn: () => api.get<{ items: ScriptVersion[] }>(`/api/scripts/${id}/versions`),
    enabled: id !== null,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["scripts"] });
    qc.invalidateQueries({ queryKey: ["script", id] });
    qc.invalidateQueries({ queryKey: ["script-versions", id] });
  };
  const publish = useMutation({
    mutationFn: (vid: number) => api.post(`/api/scripts/${id}/publish`, { version_id: vid }),
    onSuccess: () => {
      message.success("已发布");
      refresh();
    },
    onError: (e) => message.error((e as Error).message),
  });
  const removeVersion = useMutation({
    mutationFn: (vid: number) => api.del(`/api/scripts/${id}/versions/${vid}`),
    onSuccess: refresh,
    onError: (e) => message.error((e as Error).message),
  });
  const removeScript = useMutation({
    mutationFn: () => api.del(`/api/scripts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scripts"] });
      onClose();
    },
    onError: (e) => message.error((e as Error).message),
  });
  const toggleProtect = useMutation({
    mutationFn: (protect: boolean) => api.patch(`/api/scripts/${id}`, { protect }),
    onSuccess: refresh,
    onError: (e) => message.error((e as Error).message),
  });
  const s = script.data;
  const current = s?.current;

  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      size={820}
      destroyOnHidden
      title={s ? s.name : "小程序"}
      extra={
        s &&
        can("operator") && (
          <Space>
            <Button icon={<CloudUploadOutlined />} type="primary" onClick={() => setUploadOpen(true)}>
              上传新版本
            </Button>
          </Space>
        )
      }
    >
      {s && (
        <Space orientation="vertical" size="large" style={{ width: "100%" }}>
          <Descriptions
            size="small"
            column={2}
            bordered
            items={[
              { label: "工程名", children: <span className="mono">{s.project_name}</span> },
              {
                label: "当前发布",
                children: current ? <Pill tone="green">v{current.version}</Pill> : <Pill>未发布</Pill>,
              },
              {
                label: "热更新频道",
                span: 2,
                children: <CopyText text={s.channel} />,
              },
              {
                label: "代码保护",
                children: can("admin") ? (
                  <Checkbox
                    checked={s.protect}
                    disabled={toggleProtect.isPending}
                    onChange={(e) => toggleProtect.mutate(e.target.checked)}
                  >
                    只下发字节码
                  </Checkbox>
                ) : s.protect ? (
                  "开启"
                ) : (
                  "关闭"
                ),
              },
              { label: "创建", children: `${fmtTime(s.created_at)} · ${s.created_by}` },
              ...(s.description ? [{ label: "简介", span: 2, children: s.description }] : []),
            ]}
          />
          {!current && s.versions > 0 && (
            <Alert type="info" showIcon title="还没有发布版本。发布后，开启了热更新的 App 才会收到这个版本。" />
          )}
          <Card title="版本" size="small" className="table-card">
            <Table<ScriptVersion>
              rowKey="id"
              size="middle"
              loading={versions.isLoading}
              dataSource={versions.data?.items}
              pagination={false}
              locale={{ emptyText: "还没有版本，点右上角「上传新版本」" }}
              columns={[
                {
                  title: "版本",
                  key: "v",
                  render: (_, v) => (
                    <Space size={6}>
                      <b>v{v.version}</b>
                      <span className="muted">#{v.version_code}</span>
                      {v.current && <Pill tone="green">当前</Pill>}
                    </Space>
                  ),
                },
                {
                  title: "说明",
                  dataIndex: "notes",
                  ellipsis: true,
                  render: (n: string) => n || <span className="muted">-</span>,
                },
                {
                  title: "大小",
                  key: "size",
                  width: 90,
                  render: (_, v) => (
                    <Tooltip title={`${v.files} 个文件`}>
                      <span>{fmtSize(v.size)}</span>
                    </Tooltip>
                  ),
                },
                {
                  title: "上传",
                  key: "by",
                  width: 140,
                  responsive: ["xl"],
                  render: (_, v) => (
                    <Tooltip title={fmtTime(v.created_at)}>
                      <span>
                        {v.created_by} · {fmtAgo(v.created_at)}
                      </span>
                    </Tooltip>
                  ),
                },
                {
                  title: "操作",
                  key: "ops",
                  width: 290,
                  render: (_, v) => (
                    <Space size={0}>
                      {can("admin") && !v.current && (
                        <Popconfirm
                          title={`发布 v${v.version}？`}
                          description="开启热更新的 App 会在下次检查时切换到这个版本"
                          onConfirm={() => publish.mutate(v.id)}
                        >
                          <Button type="link" size="small" icon={<RocketOutlined />}>
                            发布
                          </Button>
                        </Popconfirm>
                      )}
                      {can("admin") && (
                        <Button type="link" size="small" icon={<SendOutlined />} onClick={() => setDeployVersion(v)}>
                          下发
                        </Button>
                      )}
                      {can("operator") && (
                        <Button
                          type="link"
                          size="small"
                          icon={<BuildOutlined />}
                          onClick={() => navigate(`/pack?script=${s.id}&version=${v.id}`)}
                        >
                          打包
                        </Button>
                      )}
                      {can("admin") && !v.current && (
                        <Popconfirm title="删除这个版本？" onConfirm={() => removeVersion.mutate(v.id)}>
                          <Button type="link" size="small" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      )}
                      {can("operator") && (
                        <Tooltip title="下载源码 zip">
                          <Button
                            type="text"
                            size="small"
                            aria-label="下载源码"
                            icon={<DownloadOutlined />}
                            onClick={() =>
                              download(`/api/scripts/${s.id}/versions/${v.id}/source`).catch((e) => message.error(e.message))
                            }
                          />
                        </Tooltip>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
          {can("admin") && (
            <Button
              danger
              type="text"
              onClick={() =>
                modal.confirm({
                  title: `删除小程序「${s.name}」？`,
                  content: "所有版本一起删除。已打包的 App 不受影响，但不会再收到热更新。",
                  okType: "danger",
                  onOk: () => removeScript.mutateAsync(),
                })
              }
            >
              删除小程序
            </Button>
          )}
        </Space>
      )}
      {s && (
        <UploadModal
          open={uploadOpen}
          script={s}
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setUploadOpen(false);
            refresh();
          }}
        />
      )}
      {s && <DeployModal script={s} version={deployVersion} onClose={() => setDeployVersion(null)} />}
    </Drawer>
  );
}

function UploadModal({
  open,
  script,
  onClose,
  onDone,
}: {
  open: boolean;
  script: Script;
  onClose: () => void;
  onDone: () => void;
}) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [file, setFile] = useState<UploadFile[]>([]);
  const save = useMutation({
    mutationFn: (v: { version?: string; notes?: string; publish?: boolean }) => {
      const fd = new FormData();
      fd.append("file", file[0].originFileObj as File);
      if (v.version) fd.append("version", v.version.trim());
      fd.append("notes", v.notes ?? "");
      fd.append("publish", String(!!v.publish));
      return api.post<ScriptVersion>(`/api/scripts/${script.id}/versions`, fd);
    },
    onSuccess: (v) => {
      message.success(`已上传 v${v.version}${v.current ? " 并发布" : ""}`);
      setFile([]);
      onDone();
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={open}
      title={`上传 ${script.name} 新版本`}
      onCancel={onClose}
      okText="上传"
      confirmLoading={save.isPending}
      okButtonProps={{ disabled: !file.length }}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={save.mutate} preserve={false}>
        <Form.Item extra="工程目录（含 __init__.py）的 zip，AScript 导出的工程也可以；顶层文件夹名不影响">
          <Upload.Dragger
            accept=".zip"
            maxCount={1}
            fileList={file}
            beforeUpload={() => false}
            onChange={({ fileList }) => setFile(fileList.slice(-1))}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">点击或拖入工程 zip</p>
          </Upload.Dragger>
        </Form.Item>
        <Form.Item
          name="version"
          label="版本号"
          extra={`留空自动递增${script.latest ? `（上一个是 ${script.latest.version}）` : "，从 1.0.0 开始"}`}
          rules={[{ pattern: /^[0-9A-Za-z.\-_+]{1,32}$/, message: "只能包含字母、数字和 . - _ +" }]}
        >
          <Input placeholder="1.0.0" />
        </Form.Item>
        <Form.Item name="notes" label="更新说明">
          <Input.TextArea rows={3} maxLength={4000} />
        </Form.Item>
        {can("admin") && (
          <Form.Item name="publish" valuePropName="checked">
            <Checkbox>上传后立即发布</Checkbox>
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

function DeployModal({ script, version, onClose }: { script: Script; version: ScriptVersion | null; onClose: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [result, setResult] = useState<{ results: Record<string, CommandReply>; devices: number; ok: number } | null>(null);
  const deploy = useMutation({
    mutationFn: (v: { target: string; run: boolean; params?: string }) =>
      api.post<{ results: Record<string, CommandReply>; devices: number; ok: number }>(`/api/scripts/${script.id}/deploy`, {
        target: v.target,
        version_id: version!.id,
        run: v.run,
        params: v.params?.trim() ? JSON.parse(v.params) : {},
      }),
    onSuccess: (r) => {
      if (!r.devices) message.warning("目标里没有在线设备");
      setResult(r);
    },
    onError: (e) => message.error((e as Error).message),
  });
  const close = () => {
    setResult(null);
    onClose();
  };
  return (
    <Modal
      open={!!version}
      title={version && `下发 ${script.name} v${version.version} 到设备`}
      onCancel={close}
      okText={result ? "完成" : "下发"}
      confirmLoading={deploy.isPending}
      onOk={() => (result ? close() : form.submit())}
      width={620}
      destroyOnHidden
    >
      {!result ? (
        <Form form={form} layout="vertical" initialValues={{ target: "all", run: true, params: "" }} onFinish={deploy.mutate} preserve={false}>
          <Typography.Paragraph type="secondary">
            通过云控连接把工程安装到设备的 <span className="mono">{script.project_name}</span>
            ，会覆盖设备上的同名工程。{script.protect && "已开启代码保护，只发送字节码。"}
          </Typography.Paragraph>
          <Form.Item name="target" label="目标设备" rules={[{ required: true }]}>
            <TargetSelect style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="run" valuePropName="checked">
            <Checkbox>安装后立即启动</Checkbox>
          </Form.Item>
          <Form.Item
            name="params"
            label="启动参数（JSON，可选）"
            rules={[
              {
                validator: (_, v) => {
                  if (!v?.trim()) return Promise.resolve();
                  try {
                    const x = JSON.parse(v);
                    return typeof x === "object" && x && !Array.isArray(x)
                      ? Promise.resolve()
                      : Promise.reject(new Error("需要 JSON 对象"));
                  } catch {
                    return Promise.reject(new Error("不是合法的 JSON"));
                  }
                },
              },
            ]}
          >
            <Input.TextArea rows={2} className="mono" placeholder='{"level": 3}' />
          </Form.Item>
        </Form>
      ) : (
        <>
          <Alert
            type={result.ok === result.devices ? "success" : "warning"}
            showIcon
            style={{ marginBottom: 12 }}
            title={`${result.ok}/${result.devices} 台设备成功`}
          />
          <Table<[string, CommandReply]>
            size="small"
            rowKey={(r) => r[0]}
            dataSource={Object.entries(result.results)}
            pagination={Object.keys(result.results).length > 10 ? { pageSize: 10 } : false}
            columns={[
              { title: "设备", render: (_, r) => <span className="mono">{r[0]}</span> },
              {
                title: "结果",
                width: 80,
                render: (_, r) => (r[1].code === 1 ? <Pill tone="green">成功</Pill> : <Pill tone="red">失败</Pill>),
              },
              { title: "信息", render: (_, r) => r[1].msg ?? "" },
            ]}
          />
        </>
      )}
    </Modal>
  );
}
