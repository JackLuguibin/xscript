import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tooltip,
} from "antd";
import { CloudDownloadOutlined, DeleteOutlined, PlusOutlined, SendOutlined } from "@ant-design/icons";
import { api, download, type MaintenanceInfo, type Settings, type Webhook } from "./api";
import { fmtAgo, fmtSize, fmtTime } from "./format";

const KINDS = [
  { value: "wecom", label: "企业微信机器人" },
  { value: "dingtalk", label: "钉钉机器人" },
  { value: "feishu", label: "飞书机器人" },
  { value: "generic", label: "通用 Webhook（JSON）" },
];

/** 告警通知: robot webhooks and which events each one receives. */
export function AlertSettings({ settings, editable }: { settings?: Settings; editable: boolean }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ hooks: Webhook[]; offline: number }>();
  useEffect(() => {
    if (settings) form.setFieldsValue({ hooks: settings.alert_webhooks, offline: settings.alert_offline_minutes });
  }, [settings, form]);
  const save = useMutation({
    mutationFn: (v: { hooks: Webhook[]; offline: number }) =>
      api.put<Settings>("/api/settings", {
        alert_webhooks: (v.hooks ?? []).map(({ has_secret: _h, ...w }) => ({ ...w, secret: w.secret ?? "" })),
        alert_offline_minutes: v.offline,
      }),
    onSuccess: (s) => {
      message.success("已保存");
      qc.setQueryData(["settings"], s);
    },
    onError: (e) => message.error((e as Error).message),
  });
  const test = useMutation({
    mutationFn: (w: Webhook) => api.post("/api/alerts/test", { ...w, events: [], secret: w.secret ?? "" }),
    onSuccess: () => message.success("测试消息已发送，去群里看看"),
    onError: (e) => message.error((e as Error).message),
  });
  const recent = useQuery({
    queryKey: ["alerts-recent"],
    queryFn: () => api.get<{ items: { time: number; event: string; subject: string; text: string; sent: number; errors: string[] }[] }>(
      "/api/alerts/recent",
    ),
    refetchInterval: 15000,
  });
  const events = Object.entries(settings?.alert_events ?? {}).map(([value, label]) => ({ value, label }));

  return (
    <Card title="告警通知" extra={<span className="muted">设备离线、脚本崩溃、打包结果等推送到群</span>}>
      <Form form={form} layout="vertical" onFinish={save.mutate} disabled={!editable}>
        <Form.List name="hooks">
          {(fields, { add, remove }) => (
            <Space orientation="vertical" style={{ width: "100%" }} size="middle">
              {fields.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有配置通知渠道" />}
              {fields.map((f) => (
                <div key={f.key} className="hook-row">
                  <Row gutter={12}>
                    <Col xs={24} md={6}>
                      <Form.Item name={[f.name, "name"]} label="名称">
                        <Input placeholder="运维群" maxLength={64} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={6}>
                      <Form.Item name={[f.name, "kind"]} label="类型" initialValue="wecom">
                        <Select options={KINDS} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        name={[f.name, "url"]}
                        label="Webhook 地址"
                        rules={[{ required: true, message: "填写机器人 Webhook 地址" }, { pattern: /^https?:\/\/\S+$/, message: "以 http(s):// 开头" }]}
                      >
                        <Input className="mono" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Row gutter={12}>
                    <Col xs={24} md={14}>
                      <Form.Item name={[f.name, "events"]} label="推送哪些事件" initialValue={["device_offline", "script_crash", "pack_failed"]}>
                        <Select mode="multiple" options={events} placeholder="选择事件" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={10}>
                      <Form.Item noStyle shouldUpdate>
                        {() => {
                          const w = form.getFieldValue(["hooks", f.name]) as Webhook | undefined;
                          return w?.kind === "dingtalk" || w?.kind === "feishu" ? (
                            <Form.Item
                              name={[f.name, "secret"]}
                              label="加签密钥（可选）"
                              extra={w.has_secret ? "已设置，留空保持不变" : "机器人安全设置里的「加签」密钥"}
                            >
                              <Input.Password placeholder={w.has_secret ? "••••••" : "SEC…"} autoComplete="off" />
                            </Form.Item>
                          ) : null;
                        }}
                      </Form.Item>
                    </Col>
                  </Row>
                  {editable && (
                    <Space>
                      <Button
                        size="small"
                        icon={<SendOutlined />}
                        loading={test.isPending}
                        onClick={() =>
                          form
                            .validateFields([["hooks", f.name, "url"]])
                            .then(() => test.mutate(form.getFieldValue(["hooks", f.name])))
                        }
                      >
                        发送测试
                      </Button>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => remove(f.name)}>
                        删除
                      </Button>
                    </Space>
                  )}
                </div>
              ))}
              {editable && (
                <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ kind: "wecom", events: ["device_offline", "script_crash", "pack_failed"] })} block>
                  添加通知渠道
                </Button>
              )}
            </Space>
          )}
        </Form.List>
        <Form.Item
          name="offline"
          label="设备离线多久后告警（分钟）"
          extra="短暂断线重连不会告警。0 表示不告警"
          style={{ marginTop: 16, maxWidth: 320 }}
        >
          <InputNumber min={0} max={1440} style={{ width: "100%" }} />
        </Form.Item>
        {editable && (
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            保存
          </Button>
        )}
      </Form>
      {(recent.data?.items.length ?? 0) > 0 && (
        <Table
          style={{ marginTop: 20 }}
          size="small"
          rowKey={(r) => r.time + r.subject + r.event}
          dataSource={recent.data?.items.slice(0, 10)}
          pagination={false}
          title={() => <b>最近告警</b>}
          columns={[
            { title: "时间", dataIndex: "time", width: 110, render: (t: number) => <Tooltip title={fmtTime(t)}>{fmtAgo(t)}</Tooltip> },
            { title: "事件", dataIndex: "event", width: 120, render: (e: string) => settings?.alert_events[e] ?? e },
            { title: "内容", dataIndex: "text", ellipsis: true },
            {
              title: "推送",
              key: "sent",
              width: 90,
              render: (_, r) =>
                r.errors.length ? (
                  <Tooltip title={r.errors.join("\n")}>
                    <span style={{ color: "var(--xs-red)" }}>失败 {r.errors.length}</span>
                  </Tooltip>
                ) : (
                  <span className="muted">{r.sent} 个渠道</span>
                ),
            },
          ]}
        />
      )}
    </Card>
  );
}

/** 备份与存储: disk usage, automatic backups and retention. */
export function MaintenanceSettings({ settings }: { settings?: Settings }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  useEffect(() => {
    if (settings) form.setFieldsValue(settings);
  }, [settings, form]);
  const info = useQuery({ queryKey: ["maintenance"], queryFn: () => api.get<MaintenanceInfo>("/api/maintenance") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["maintenance"] });
  const save = useMutation({
    mutationFn: (v: Partial<Settings>) =>
      api.put<Settings>("/api/settings", {
        backup_daily: v.backup_daily,
        backup_hour: v.backup_hour,
        keep_backups: v.keep_backups,
        keep_pack_jobs: v.keep_pack_jobs,
        audit_days: v.audit_days,
        device_log_days: v.device_log_days,
      }),
    onSuccess: (s) => {
      message.success("已保存");
      qc.setQueryData(["settings"], s);
    },
    onError: (e) => message.error((e as Error).message),
  });
  const backup = useMutation({
    mutationFn: () => api.post<{ name: string; size: number }>("/api/maintenance/backup"),
    onSuccess: (r) => {
      message.success(`已备份 ${r.name}`);
      refresh();
    },
    onError: (e) => message.error((e as Error).message),
  });
  const cleanup = useMutation({
    mutationFn: () => api.post<{ apks: number; audit: number; shares: number; backups: number }>("/api/maintenance/cleanup"),
    onSuccess: (r) => {
      message.success(`清理了 ${r.apks} 个旧 APK、${r.audit} 条日志、${r.backups} 个旧备份`);
      refresh();
    },
    onError: (e) => message.error((e as Error).message),
  });
  const u = info.data?.usage;
  const last = info.data?.last_backup;

  return (
    <Card
      title="备份与存储"
      extra={
        <Space>
          <Popconfirm title="按下面的保留策略立即清理？" onConfirm={() => cleanup.mutate()}>
            <Button loading={cleanup.isPending}>立即清理</Button>
          </Popconfirm>
          <Button type="primary" icon={<CloudDownloadOutlined />} loading={backup.isPending} onClick={() => backup.mutate()}>
            立即备份
          </Button>
        </Space>
      }
    >
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        {(
          [
            ["数据库", u?.database],
            ["打包产物", u?.pack],
            ["小程序", u?.scripts],
            ["备份", u?.backups],
          ] as const
        ).map(([label, v]) => (
          <Col key={label} xs={12} md={6}>
            <Statistic title={label} value={v ? fmtSize(v) : "0 B"} loading={info.isLoading} />
          </Col>
        ))}
      </Row>
      {last && !last.ok && <Alert type="error" showIcon style={{ marginBottom: 16 }} title={`自动备份失败：${last.error}`} />}
      <Form form={form} layout="vertical" onFinish={save.mutate}>
        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Form.Item name="backup_daily" label="每天自动备份" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="backup_hour" label="备份时间（点）">
              <InputNumber min={0} max={23} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="keep_backups" label="保留备份份数" extra="0 = 不自动删除">
              <InputNumber min={0} max={365} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="keep_pack_jobs" label="保留 APK 的打包记录数" extra="更早的只删文件，记录保留">
              <InputNumber min={0} max={10000} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="audit_days" label="操作日志保留天数" extra="0 = 永久">
              <InputNumber min={0} max={36500} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="device_log_days" label="设备运行日志保留天数" extra="0 = 不在服务器保存">
              <InputNumber min={0} max={365} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Button htmlType="submit" loading={save.isPending}>
          保存策略
        </Button>
      </Form>
      <Alert
        type="info"
        showIcon
        style={{ margin: "20px 0 12px" }}
        title="备份包含数据库、卡密签名私钥和所有小程序源码，不含 APK。下载后请放到安全的地方；恢复时先停止服务，再运行 python -m xscript_server restore 备份文件。"
      />
      <Table
        size="small"
        rowKey="name"
        loading={info.isLoading}
        dataSource={info.data?.backups}
        pagination={{ pageSize: 5, hideOnSinglePage: true }}
        locale={{ emptyText: "还没有备份" }}
        columns={[
          { title: "文件", dataIndex: "name", render: (n: string) => <span className="mono">{n}</span> },
          { title: "大小", dataIndex: "size", width: 100, render: fmtSize },
          { title: "时间", dataIndex: "created_at", width: 160, render: fmtTime },
          {
            title: "",
            key: "dl",
            width: 80,
            render: (_, b) => (
              <Button
                type="link"
                size="small"
                onClick={() => download(`/api/maintenance/backups/${encodeURIComponent(b.name)}`).catch((e) => message.error(e.message))}
              >
                下载
              </Button>
            ),
          },
        ]}
      />
      {info.data?.last_retention && (
        <Descriptions
          size="small"
          style={{ marginTop: 12 }}
          items={[
            {
              label: "上次自动清理",
              children: `${fmtTime(info.data.last_retention.time)}：APK ${info.data.last_retention.apks} 个，操作日志 ${info.data.last_retention.audit} 条，设备日志 ${info.data.last_retention.device_logs ?? 0} 条，备份 ${info.data.last_retention.backups} 个`,
            },
          ]}
        />
      )}
    </Card>
  );
}
