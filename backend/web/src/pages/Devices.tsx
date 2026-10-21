import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CameraOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  HomeOutlined,
  MessageOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  MobileOutlined,
  ReloadOutlined,
  RollbackOutlined,
  TagsOutlined,
} from "@ant-design/icons";
import { api, type CommandReply, type CommandResult, type Device, type Group, type Page } from "../api";
import { useAuth } from "../auth";
import { PageHeader, Pill, SearchInput, TargetSelect } from "../components";
import { COMMAND_LABELS, crashSummary, crashedRun, describeTarget, fmtAgo } from "../format";
import { DeviceDrawer } from "./devices/DeviceDrawer";

interface Filters {
  q: string;
  group: string;
  online: string;
  page: number;
  page_size: number;
}

export default function DevicesPage() {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [f, setF] = useState<Filters>({
    q: params.get("q") ?? "",
    group: "",
    online: params.get("online") === "1" ? "true" : "",
    page: 1,
    page_size: 20,
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [edit, setEdit] = useState<Device | null>(null);
  const [runOpen, setRunOpen] = useState<string | null>(null);
  const [msgOpen, setMsgOpen] = useState<string | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [results, setResults] = useState<{ title: string; data: CommandResult } | null>(null);

  const list = useQuery({
    queryKey: ["devices", f],
    queryFn: () => api.get<Page<Device>>("/api/devices", { ...f, online: f.online || undefined }),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => api.get<{ items: Group[] }>("/api/groups") });

  const command = useMutation({
    mutationFn: (v: { target: string; command: Record<string, unknown>; label: string }) =>
      api.post<CommandResult>("/api/command", { target: v.target, command: v.command }),
    onSuccess: (data, v) => {
      if (!data.devices) message.warning("目标里没有在线设备");
      else if (v.command.path === "screen_shot" || data.ok < data.devices) setResults({ title: v.label, data });
      else message.success(`${v.label}：${data.ok}/${data.devices} 台成功`);
      qc.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (e) => message.error((e as Error).message),
  });

  const send = (target: string, cmd: Record<string, unknown>) =>
    command.mutate({
      target,
      command: cmd,
      label: (COMMAND_LABELS[String(cmd.path)] ?? String(cmd.path)) + " · " + describeTarget(target),
    });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/devices/${encodeURIComponent(id)}`),
    onSuccess: () => {
      message.success("已删除");
      qc.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (e) => message.error((e as Error).message),
  });

  const actionsMenu = (target: string) => ({
    items: [
      { key: "run", icon: <PlayCircleOutlined />, label: "启动小程序…" },
      { key: "stop", icon: <PauseCircleOutlined />, label: "停止" },
      { key: "shot", icon: <CameraOutlined />, label: "截图" },
      { type: "divider" as const },
      { key: "home", icon: <HomeOutlined />, label: "主页键" },
      { key: "back", icon: <RollbackOutlined />, label: "返回键" },
      { key: "msg", icon: <MessageOutlined />, label: "发消息给脚本…" },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === "run") setRunOpen(target);
      else if (key === "msg") setMsgOpen(target);
      else if (key === "stop") send(target, { path: "app_stop" });
      else if (key === "shot") send(target, { path: "screen_shot", max: 480, quality: 40 });
      else send(target, { path: "device_action", action: "key", ori: key });
    },
  });

  const columns: ColumnsType<Device> = [
    {
      title: "设备",
      key: "device",
      render: (_, d) => (
        <div className="device-cell">
          <span className={"device-avatar" + (d.online ? " on" : "")} aria-label={d.online ? "在线" : "离线"}>
            <MobileOutlined />
          </span>
          <div style={{ minWidth: 0 }}>
            <div>
              <a className="name" onClick={() => setDetail(d.id)}>
                {[d.brand, d.model].filter(Boolean).join(" ") || "未知设备"}
              </a>
              {d.note && <span className="muted"> · {d.note}</span>}
            </div>
            <span className="mono muted">{d.id}</span>
          </div>
        </div>
      ),
    },
    {
      title: "分组",
      dataIndex: "group",
      width: 130,
      render: (g: string, d) =>
        g ? (
          <Tooltip title={d.group_override ? `后台设置（设备上报：${d.reported_group || "无"}）` : "设备上报"}>
            <Tag color={d.group_override ? "purple" : "default"}>{g}</Tag>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: "状态",
      key: "state",
      width: 180,
      render: (_, d) => (
        <>
          {!d.online ? (
            <Pill>离线 · {fmtAgo(d.last_seen)}</Pill>
          ) : d.running ? (
            <Pill tone="green" pulse>
              运行 {d.project}
            </Pill>
          ) : (
            <Pill tone="blue">在线 · 空闲</Pill>
          )}
          {crashedRun(d) ? (
            <Tooltip title={<CrashTip run={d.last_run!} />}>
              <span style={{ marginLeft: 4 }}>
                <Pill tone="red">异常退出</Pill>
              </span>
            </Tooltip>
          ) : null}
        </>
      ),
    },
    {
      title: "脚本数据",
      dataIndex: "data",
      ellipsis: true,
      render: (v: Record<string, unknown>) =>
        Object.keys(v ?? {}).length ? (
          <Space size={[4, 4]} wrap>
            {Object.entries(v)
              .slice(0, 6)
              .map(([k, x]) => (
                <Tag key={k} className="mono">
                  {k}: {typeof x === "object" ? JSON.stringify(x) : String(x)}
                </Tag>
              ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: "版本 / 通道",
      key: "ver",
      width: 190,
      responsive: ["xl"],
      render: (_, d) => (
        <Typography.Text type="secondary">
          {d.version ? "v" + d.version : "-"} · {d.channel ?? "-"}
        </Typography.Text>
      ),
    },
    {
      title: "操作",
      key: "ops",
      width: 170,
      fixed: "right",
      render: (_, d) =>
        can("operator") ? (
          <Space size={0}>
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEdit(d)}>
              编辑
            </Button>
            {d.online ? (
              <Dropdown menu={actionsMenu(d.id)}>
                <Button type="link" size="small">
                  控制 <DownOutlined />
                </Button>
              </Dropdown>
            ) : (
              <Button
                type="link"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() =>
                  modal.confirm({
                    title: "删除设备记录？",
                    content: "只删除后台里的记录和分组设置；设备下次连上会重新出现。",
                    okType: "danger",
                    onOk: () => del.mutateAsync(d.id),
                  })
                }
              >
                删除
              </Button>
            )}
          </Space>
        ) : null,
    },
  ];

  const onlineSelected = selected.filter((id) => list.data?.items.find((d) => d.id === id)?.online);
  const bulkTarget = onlineSelected.join(",");

  return (
    <>
      <PageHeader
        title="设备管理"
        desc="查看连接到云控的设备，远程启动脚本、截图或发送按键。列表每 5 秒自动刷新。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => list.refetch()}>
              刷新
            </Button>
            {can("operator") && (
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => setRunOpen("")}>
                批量下发
              </Button>
            )}
          </>
        }
      />
      <Card className="table-card">
        <div className="toolbar">
          <SearchInput
            placeholder="搜索设备 ID / 型号 / 备注"
            initial={f.q}
            onSearch={(q) => setF((f) => ({ ...f, q, page: 1 }))}
          />
          <Select
            placeholder="全部分组"
            allowClear
            style={{ width: 160 }}
            value={f.group || undefined}
            onChange={(g) => setF({ ...f, group: g ?? "", page: 1 })}
            options={(groups.data?.items ?? []).map((g) => ({ value: g.name, label: `${g.name}（${g.online}/${g.total}）` }))}
          />
          <Select
            style={{ width: 120 }}
            value={f.online}
            onChange={(online) => setF({ ...f, online, page: 1 })}
            options={[
              { value: "", label: "全部状态" },
              { value: "true", label: "在线" },
              { value: "false", label: "离线" },
            ]}
          />
          <span className="spacer" />
          {selected.length > 0 && can("operator") && (
            <div className="selection-bar">
              已选 {selected.length} 台（在线 {onlineSelected.length}）
              <Dropdown menu={actionsMenu(bulkTarget)} disabled={!onlineSelected.length}>
                <Button size="small">
                  批量控制 <DownOutlined />
                </Button>
              </Dropdown>
              <Button size="small" icon={<TagsOutlined />} onClick={() => setGroupOpen(true)}>
                设置分组
              </Button>
              <Button size="small" type="text" onClick={() => setSelected([])}>
                清除
              </Button>
            </div>
          )}
        </div>
        <Table<Device>
          rowKey="id"
          size="middle"
          loading={list.isLoading || command.isPending}
          columns={columns}
          dataSource={list.data?.items}
          scroll={{ x: 960 }}
          rowSelection={
            can("operator")
              ? { selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]), preserveSelectedRowKeys: true }
              : undefined
          }
          pagination={{
            current: f.page,
            pageSize: f.page_size,
            total: list.data?.total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 台`,
            onChange: (page, page_size) => setF({ ...f, page, page_size }),
          }}
          locale={{
            emptyText: <Empty description="还没有设备连接。到「设备密钥」生成连接地址，填到手机 XScript → 云端控制。" />,
          }}
        />
      </Card>

      <RunModal
        open={runOpen !== null}
        target={runOpen || "all"}
        selectedIds={onlineSelected}
        loading={command.isPending}
        onCancel={() => setRunOpen(null)}
        onOk={(target, cmd) => {
          send(target, cmd);
          setRunOpen(null);
        }}
      />
      <MessageModal
        open={msgOpen !== null}
        onCancel={() => setMsgOpen(null)}
        onOk={(data) => {
          send(msgOpen || "all", { path: "message", data });
          setMsgOpen(null);
        }}
      />
      <EditModal device={edit} onClose={() => setEdit(null)} />
      <BatchGroupModal
        open={groupOpen}
        ids={selected}
        onClose={() => {
          setGroupOpen(false);
          setSelected([]);
        }}
      />
      <ResultsModal value={results} onClose={() => setResults(null)} />
      <DeviceDrawer id={detail} onClose={() => setDetail(null)} onCommand={send} />
    </>
  );
}

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function RunModal({
  open,
  target,
  selectedIds,
  loading,
  onCancel,
  onOk,
}: {
  open: boolean;
  target: string;
  selectedIds: string[];
  loading: boolean;
  onCancel: () => void;
  onOk: (target: string, cmd: Record<string, unknown>) => void;
}) {
  const [form] = Form.useForm();
  return (
    <Modal
      open={open}
      title="启动小程序"
      okText="下发"
      confirmLoading={loading}
      onCancel={onCancel}
      destroyOnHidden
      onOk={() =>
        form.validateFields().then((v) => {
          const cmd: Record<string, unknown> = { path: "app_run", id: v.id.trim(), param: parseJson(v.param ?? "") };
          if (v.card?.trim()) cmd.card = v.card.trim();
          onOk(v.target, cmd);
        })
      }
    >
      <Form form={form} layout="vertical" initialValues={{ target, param: "" }} preserve={false}>
        <Form.Item name="target" label="目标" rules={[{ required: true }]}>
          <TargetSelect selectedIds={selectedIds} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="id" label="小程序（工程名）" rules={[{ required: true, message: "填写设备上的工程名" }]}>
          <Input placeholder="例如 demo" />
        </Form.Item>
        <Form.Item
          name="param"
          label="启动参数（JSON，可选）"
          extra="脚本里用 system.params() 读取"
          rules={[
            {
              validator: (_, v) => {
                try {
                  const x = parseJson(v ?? "");
                  return typeof x === "object" && x !== null && !Array.isArray(x)
                    ? Promise.resolve()
                    : Promise.reject(new Error("需要 JSON 对象"));
                } catch {
                  return Promise.reject(new Error("不是合法的 JSON"));
                }
              },
            },
          ]}
        >
          <Input.TextArea rows={3} className="mono" placeholder='{"level": 3}' />
        </Form.Item>
        <Form.Item name="card" label="卡密（可选）" extra="打包 App 未激活时顺便激活">
          <Input className="mono" placeholder="XS-XXXX-XXXX-XXXX-XXXX" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function MessageModal({ open, onCancel, onOk }: { open: boolean; onCancel: () => void; onOk: (data: unknown) => void }) {
  const [text, setText] = useState("");
  return (
    <Modal
      open={open}
      title="发消息给正在运行的脚本"
      okText="发送"
      onCancel={onCancel}
      onOk={() => {
        let data: unknown = text;
        try {
          data = JSON.parse(text);
        } catch {
          /* plain text */
        }
        onOk(data);
        setText("");
      }}
      okButtonProps={{ disabled: !text.trim() }}
    >
      <Typography.Paragraph type="secondary">脚本用 cloud.on_message 接收。可以是文本，也可以是 JSON。</Typography.Paragraph>
      <Input.TextArea rows={4} value={text} onChange={(e) => setText(e.target.value)} className="mono" />
    </Modal>
  );
}

function EditModal({ device, onClose }: { device: Device | null; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: { group_override: string; note: string }) => api.patch(`/api/devices/${encodeURIComponent(device!.id)}`, v),
    onSuccess: () => {
      message.success("已保存");
      qc.invalidateQueries({ queryKey: ["devices"] });
      qc.invalidateQueries({ queryKey: ["groups"] });
      onClose();
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={!!device}
      title="编辑设备"
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      {device && (
        <Form
          form={form}
          layout="vertical"
          initialValues={{ group_override: device.group_override, note: device.note }}
          onFinish={save.mutate}
          preserve={false}
        >
          <Form.Item label="设备">
            <span className="mono">{device.id}</span>
          </Form.Item>
          <Form.Item name="group_override" label="分组" extra={`留空则使用设备上报的分组（${device.reported_group || "无"}）`}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input maxLength={255} placeholder="例如 机房 A-12" />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}

function BatchGroupModal({ open, ids, onClose }: { open: boolean; ids: string[]; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [group, setGroup] = useState("");
  const save = useMutation({
    mutationFn: () => api.post<{ updated: number }>("/api/devices/batch-group", { ids, group_override: group }),
    onSuccess: (r) => {
      message.success(`已更新 ${r.updated} 台`);
      qc.invalidateQueries({ queryKey: ["devices"] });
      qc.invalidateQueries({ queryKey: ["groups"] });
      onClose();
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={open}
      title={`设置 ${ids.length} 台设备的分组`}
      onCancel={onClose}
      onOk={() => save.mutate()}
      confirmLoading={save.isPending}
    >
      <Input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="留空表示恢复为设备上报的分组" maxLength={64} />
    </Modal>
  );
}

function CrashTip({ run }: { run: NonNullable<Device["last_run"]> }) {
  const { head, error } = crashSummary(run);
  return (
    <div>
      <div>{head}</div>
      {error ? <div className="mono">{error}</div> : null}
      <div>详见设备详情 → 运行日志</div>
    </div>
  );
}

function ResultsModal({ value, onClose }: { value: { title: string; data: CommandResult } | null; onClose: () => void }) {
  const entries = Object.entries(value?.data.results ?? {});
  const shots = entries.filter(([, r]) => r.result?.image);
  return (
    <Modal open={!!value} title={value?.title} onCancel={onClose} footer={null} width={shots.length ? 900 : 640}>
      {shots.length > 0 && (
        <div className="shots" style={{ marginBottom: 16 }}>
          {shots.map(([id, r]) => (
            <figure key={id}>
              <img src={"data:image/jpeg;base64," + r.result!.image} alt={"截图 " + id} />
              <figcaption>{id}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <Table<[string, CommandReply]>
        size="small"
        rowKey={(r) => r[0]}
        pagination={entries.length > 10 ? { pageSize: 10 } : false}
        dataSource={entries}
        columns={[
          { title: "设备", render: (_, r) => <span className="mono">{r[0]}</span> },
          {
            title: "结果",
            width: 90,
            render: (_, r) => (r[1].code === 1 ? <Pill tone="green">成功</Pill> : <Pill tone="red">失败</Pill>),
          },
          { title: "信息", render: (_, r) => r[1].msg ?? "" },
        ]}
      />
    </Modal>
  );
}
