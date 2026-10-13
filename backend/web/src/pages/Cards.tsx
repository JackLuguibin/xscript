import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tooltip,
  Typography,
} from "antd";
import { DownloadOutlined, DownOutlined, KeyOutlined, PlusOutlined } from "@ant-design/icons";
import { api, download, type Batch, type Card as CardT, type CardStats, type Page } from "../api";
import { useAuth } from "../auth";
import {
  CARD_STATUS_OPTIONS,
  CardStatusTag,
  CopyText,
  PageHeader,
  SearchInput,
  toneColor,
  useSecretModal,
} from "../components";
import { copy, fmtDays, fmtTime } from "../format";

const APP_RULE = { pattern: /^(\*|[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+)$/, message: "填 * 或包名，例如 com.me.game" };

interface Filters {
  q: string;
  status: string;
  app: string;
  batch: string;
  page: number;
  page_size: number;
}

export default function CardsPage() {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [tab, setTab] = useState("cards");
  const [f, setF] = useState<Filters>({ q: "", status: "", app: "", batch: "", page: 1, page_size: 20 });
  const [selected, setSelected] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [created, setCreated] = useState<{ batch: string; cards: string[] } | null>(null);

  const stats = useQuery({ queryKey: ["card-stats"], queryFn: () => api.get<CardStats>("/api/cards/stats") });
  const list = useQuery({
    queryKey: ["cards", f],
    queryFn: () => api.get<Page<CardT>>("/api/cards", { ...f }),
    placeholderData: keepPreviousData,
  });
  const batches = useQuery({
    queryKey: ["batches"],
    queryFn: () => api.get<{ items: Batch[] }>("/api/cards/batches"),
    enabled: tab === "batches",
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["cards"] });
    qc.invalidateQueries({ queryKey: ["card-stats"] });
    qc.invalidateQueries({ queryKey: ["batches"] });
  };

  const action = useMutation({
    mutationFn: (v: { cards: string[]; action: string }) => api.post<{ updated: number }>("/api/cards/actions", v),
    onSuccess: (r) => {
      message.success(`已处理 ${r.updated} 张`);
      setSelected([]);
      refresh();
    },
    onError: (e) => message.error((e as Error).message),
  });

  const confirmAction = (cards: string[], act: string) => {
    const text: Record<string, string> = {
      revoke: "停用后，已激活的 App 最多 6 小时内联网复核时失效。",
      restore: "恢复后卡密可以继续使用。",
      unbind: "解绑后可以在另一台设备上激活，到期时间不变。",
      delete: "删除后无法恢复，已激活的 App 复核时会失效。",
    };
    const label: Record<string, string> = { revoke: "停用", restore: "恢复", unbind: "解绑", delete: "删除" };
    modal.confirm({
      title: `${label[act]} ${cards.length} 张卡密？`,
      content: text[act],
      okType: act === "restore" ? "primary" : "danger",
      onOk: () => action.mutateAsync({ cards, action: act }),
    });
  };

  const exportCsv = (query: Partial<Filters>) =>
    download("/api/cards/export", { q: query.q, status: query.status, app: query.app, batch: query.batch }, "cards.csv").catch(
      (e) => message.error((e as Error).message),
    );

  const s = stats.data;
  return (
    <>
      <PageHeader
        title="卡密管理"
        desc="生成、发放和管理打包 App 的授权卡密。点击上方统计可按状态筛选。"
        extra={
          can("operator") && (
            <>
              {can("admin") && (
                <Button icon={<KeyOutlined />} onClick={() => setOfflineOpen(true)}>
                  离线授权码
                </Button>
              )}
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                生成卡密
              </Button>
            </>
          )
        }
      />
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {(
          [
            ["total", "全部", "", "var(--xs-primary)"],
            ["unused", "未使用", "unused", toneColor("gray")],
            ["active", "已激活", "active", toneColor("green")],
            ["expired", "已过期", "expired", toneColor("amber")],
            ["unbound", "已解绑", "unbound", toneColor("blue")],
            ["revoked", "已停用", "revoked", toneColor("red")],
          ] as const
        ).map(([k, label, status, color]) => (
          <Col key={k} xs={12} sm={8} xl={4}>
            <Card
              className={"mini-stat" + (tab === "cards" && f.status === status ? " active" : "")}
              role="button"
              tabIndex={0}
              aria-pressed={tab === "cards" && f.status === status}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setTab("cards");
                  setF({ ...f, status, page: 1 });
                }
              }}
              onClick={() => {
                setTab("cards");
                setF({ ...f, status, page: 1 });
              }}
            >
              <div className="label">
                <i style={{ background: color }} />
                {label}
              </div>
              <div className="value">{(s?.[k] ?? 0).toLocaleString()}</div>
            </Card>
          </Col>
        ))}
      </Row>
      <Card className="table-card">
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: "cards",
              label: "卡密",
              children: (
                <>
                  <div className="toolbar">
                    <SearchInput placeholder="搜索卡密 / 设备 ID / 备注" onSearch={(q) => setF((f) => ({ ...f, q, page: 1 }))} />
                    <Select
                      style={{ width: 120 }}
                      value={f.status}
                      onChange={(status) => setF({ ...f, status, page: 1 })}
                      options={[{ value: "", label: "全部状态" }, ...CARD_STATUS_OPTIONS]}
                    />
                    <Input
                      placeholder="应用包名"
                      allowClear
                      style={{ width: 180 }}
                      onChange={(e) => !e.target.value && setF({ ...f, app: "", page: 1 })}
                      onPressEnter={(e) => setF({ ...f, app: e.currentTarget.value.trim(), page: 1 })}
                    />
                    {f.batch && <Button onClick={() => setF({ ...f, batch: "", page: 1 })}>批次 {f.batch} ✕</Button>}
                    <Button icon={<DownloadOutlined />} onClick={() => exportCsv(f)} disabled={!can("operator")}>
                      导出 CSV
                    </Button>
                    <span className="spacer" />
                    {selected.length > 0 && can("operator") && (
                      <div className="selection-bar">
                        已选 {selected.length} 张
                        <Button size="small" onClick={() => copy(selected.join("\n")).then(() => message.success("已复制"))}>
                          复制
                        </Button>
                        <Dropdown
                          menu={{
                            items: [
                              { key: "extend", label: "延期…" },
                              { key: "unbind", label: "解绑设备" },
                              { key: "revoke", label: "停用", danger: true },
                              { key: "restore", label: "恢复" },
                              ...(can("admin")
                                ? [{ type: "divider" as const }, { key: "delete", label: "删除", danger: true }]
                                : []),
                            ],
                            onClick: ({ key }) => (key === "extend" ? setExtendOpen(true) : confirmAction(selected, key)),
                          }}
                        >
                          <Button size="small">
                            批量操作 <DownOutlined />
                          </Button>
                        </Dropdown>
                        <Button size="small" type="text" onClick={() => setSelected([])}>
                          清除
                        </Button>
                      </div>
                    )}
                  </div>
                  <Table<CardT>
                    rowKey="card"
                    size="middle"
                    loading={list.isLoading}
                    dataSource={list.data?.items}
                    scroll={{ x: 1300 }}
                    rowSelection={
                      can("operator")
                        ? {
                            selectedRowKeys: selected,
                            onChange: (k) => setSelected(k as string[]),
                            preserveSelectedRowKeys: true,
                          }
                        : undefined
                    }
                    pagination={{
                      current: f.page,
                      pageSize: f.page_size,
                      total: list.data?.total,
                      showSizeChanger: true,
                      pageSizeOptions: [20, 50, 100, 200],
                      showTotal: (t) => `共 ${t} 张`,
                      onChange: (page, page_size) => setF({ ...f, page, page_size }),
                    }}
                    columns={[
                      {
                        title: "卡密",
                        dataIndex: "card",
                        width: 250,
                        fixed: "left",
                        render: (c: string) => <CopyText text={c} />,
                      },
                      { title: "状态", dataIndex: "status", width: 90, render: (st) => <CardStatusTag status={st} /> },
                      { title: "有效期", dataIndex: "days", width: 90, render: fmtDays },
                      {
                        title: "应用",
                        dataIndex: "app",
                        width: 160,
                        ellipsis: true,
                        render: (a: string) => (a === "*" ? "全部应用" : a),
                      },
                      {
                        title: "绑定设备",
                        dataIndex: "device",
                        ellipsis: true,
                        render: (d: string | null, c) =>
                          d ? (
                            <Tooltip title={c.model}>
                              <span className="mono">{d}</span>
                            </Tooltip>
                          ) : (
                            "-"
                          ),
                      },
                      { title: "激活时间", dataIndex: "activated_at", width: 150, render: fmtTime },
                      {
                        title: "到期",
                        dataIndex: "expires_at",
                        width: 150,
                        render: (e: number | null, c) => (c.activated_at && !e ? "永久" : fmtTime(e)),
                      },
                      { title: "备注", dataIndex: "note", ellipsis: true },
                      {
                        title: "批次",
                        dataIndex: "batch",
                        width: 150,
                        render: (b: string) => <a onClick={() => setF({ ...f, batch: b, page: 1 })}>{b}</a>,
                      },
                      {
                        title: "操作",
                        key: "ops",
                        width: 120,
                        fixed: "right",
                        render: (_, c) =>
                          can("operator") && (
                            <Space size={0}>
                              {c.revoked ? (
                                <Button type="link" size="small" onClick={() => confirmAction([c.card], "restore")}>
                                  恢复
                                </Button>
                              ) : (
                                <Button type="link" size="small" danger onClick={() => confirmAction([c.card], "revoke")}>
                                  停用
                                </Button>
                              )}
                              {c.device && (
                                <Button type="link" size="small" onClick={() => confirmAction([c.card], "unbind")}>
                                  解绑
                                </Button>
                              )}
                            </Space>
                          ),
                      },
                    ]}
                  />
                </>
              ),
            },
            {
              key: "batches",
              label: "批次",
              children: (
                <Table<Batch>
                  rowKey="batch"
                  loading={batches.isLoading}
                  dataSource={batches.data?.items}
                  columns={[
                    { title: "批次", dataIndex: "batch", render: (b: string) => <span className="mono">{b}</span> },
                    { title: "数量", dataIndex: "count" },
                    { title: "已绑定", dataIndex: "bound" },
                    { title: "有效期", dataIndex: "days", render: fmtDays },
                    { title: "应用", dataIndex: "app", render: (a: string) => (a === "*" ? "全部应用" : a) },
                    { title: "备注", dataIndex: "note" },
                    { title: "生成时间", dataIndex: "created_at", render: fmtTime },
                    {
                      title: "操作",
                      key: "ops",
                      render: (_, b) => (
                        <Space size={0}>
                          <Button
                            type="link"
                            size="small"
                            onClick={() => {
                              setTab("cards");
                              setF({ ...f, batch: b.batch, status: "", page: 1 });
                            }}
                          >
                            查看
                          </Button>
                          {can("operator") && (
                            <Button
                              type="link"
                              size="small"
                              icon={<DownloadOutlined />}
                              onClick={() => exportCsv({ batch: b.batch })}
                            >
                              导出
                            </Button>
                          )}
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(r) => {
          setCreateOpen(false);
          setCreated(r);
          refresh();
        }}
      />
      <CreatedModal value={created} onClose={() => setCreated(null)} onExport={(batch) => exportCsv({ batch })} />
      <ExtendModal
        open={extendOpen}
        cards={selected}
        onClose={() => setExtendOpen(false)}
        onDone={() => {
          setSelected([]);
          refresh();
        }}
      />
      <OfflineModal open={offlineOpen} onClose={() => setOfflineOpen(false)} onDone={refresh} />
    </>
  );
}

function CreateModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (r: { batch: string; cards: string[] }) => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post<{ batch: string; cards: string[] }>("/api/cards/batches", v),
    onSuccess: onCreated,
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={open}
      title="生成卡密"
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        onFinish={save.mutate}
        initialValues={{ count: 50, days: 30, app: "*", prefix: "XS" }}
      >
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="count" label="数量" rules={[{ required: true }]}>
              <InputNumber min={1} max={10000} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="days" label="有效天数" extra="从激活开始算，0 = 永久" rules={[{ required: true }]}>
              <InputNumber min={0} max={36500} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="app" label="限定应用" extra="打包时的包名；* 表示所有应用都能用" rules={[{ required: true }, APP_RULE]}>
          <Input className="mono" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={16}>
            <Form.Item name="note" label="备注">
              <Input maxLength={255} placeholder="例如 代理商 A 月卡" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="prefix" label="前缀" rules={[{ pattern: /^[A-Z0-9]{1,8}$/, message: "大写字母或数字" }]}>
              <Input maxLength={8} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

function CreatedModal({
  value,
  onClose,
  onExport,
}: {
  value: { batch: string; cards: string[] } | null;
  onClose: () => void;
  onExport: (b: string) => void;
}) {
  const { message } = App.useApp();
  const text = value?.cards.join("\n") ?? "";
  return (
    <Modal
      open={!!value}
      title={`已生成 ${value?.cards.length ?? 0} 张卡密`}
      onCancel={onClose}
      width={560}
      footer={[
        <Button key="csv" icon={<DownloadOutlined />} onClick={() => value && onExport(value.batch)}>
          导出 CSV
        </Button>,
        <Button key="copy" type="primary" onClick={() => copy(text).then(() => message.success("已复制"))}>
          全部复制
        </Button>,
      ]}
    >
      <Typography.Paragraph type="secondary">
        批次 <span className="mono">{value?.batch}</span>。之后也可以在列表里按批次筛选和导出。
      </Typography.Paragraph>
      <Input.TextArea value={text} readOnly rows={12} className="mono" />
    </Modal>
  );
}

function ExtendModal({
  open,
  cards,
  onClose,
  onDone,
}: {
  open: boolean;
  cards: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [days, setDays] = useState<number | null>(30);
  const save = useMutation({
    mutationFn: () => api.post<{ updated: number }>("/api/cards/extend", { cards, days }),
    onSuccess: (r) => {
      message.success(`已延期 ${r.updated} 张`);
      onDone();
      onClose();
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={open}
      title={`延期 ${cards.length} 张卡密`}
      onCancel={onClose}
      onOk={() => save.mutate()}
      confirmLoading={save.isPending}
      okButtonProps={{ disabled: !days }}
    >
      <Typography.Paragraph type="secondary">
        未激活的卡增加有效天数；已激活的卡推迟到期时间（已过期的从现在算起）；永久卡不变。
      </Typography.Paragraph>
      <InputNumber min={1} max={36500} value={days} onChange={setDays} addonAfter="天" />
    </Modal>
  );
}

function OfflineModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { message } = App.useApp();
  const showSecret = useSecretModal();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post<{ token: string }>("/api/cards/offline", v),
    onSuccess: (r) => {
      onClose();
      onDone();
      showSecret(
        "离线授权码",
        r.token,
        <Typography.Text type="secondary">发给用户，在 App 的「卡密授权」里粘贴整段授权码。</Typography.Text>,
      );
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={open}
      title="签发离线授权码"
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="不需要 App 联网激活。授权码会记录在卡密列表里（批次 offline），停用后 App 联网复核时失效。"
      />
      <Form form={form} layout="vertical" preserve={false} onFinish={save.mutate} initialValues={{ days: 30, app: "*" }}>
        <Form.Item
          name="device"
          label="设备 ID"
          extra="用户在 App 卡密对话框里看到的设备 ID；填 * 表示任意设备（例如试用）"
          rules={[{ required: true }]}
        >
          <Input className="mono" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={10}>
            <Form.Item name="days" label="有效天数" extra="0 = 永久">
              <InputNumber min={0} max={36500} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={14}>
            <Form.Item name="app" label="限定应用" rules={[APP_RULE]}>
              <Input className="mono" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="note" label="备注">
          <Input maxLength={255} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
