import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import { DownloadOutlined, DownOutlined, KeyOutlined, PlusOutlined } from "@ant-design/icons";
import {
  api,
  download,
  type AbuseItem,
  type Batch,
  type Card as CardT,
  type CardStats,
  type DeviceBanItem,
  type Page,
  type ResellerMe,
  type ResellerRow,
} from "../api";
import { useAuth } from "../auth";
import { CARD_STATUS_OPTIONS, CardStatusTag, CopyText, PageHeader, SearchInput, toneColor } from "../components";
import { copy, fmtDays, fmtTime } from "../format";
import { CreateModal, CreatedModal } from "./cards/CreateModal";
import { DevicesModal, ExtendModal, OfflineModal } from "./cards/CardModals";

interface Filters {
  q: string;
  status: string;
  app: string;
  batch: string;
  /** Staff only: one 代理's cards (user id), -1 = staff-created only, 0 = all. */
  owner: number;
  page: number;
  page_size: number;
}

/**
 * 卡密管理. Staff see every card; a 代理 sees the same page scoped to /api/reseller/cards (own cards, quota-limited
 * creation, no delete / extend / offline codes / abuse / bans).
 */
export default function CardsPage() {
  const { can, user } = useAuth();
  const reseller = user?.role === "reseller";
  const base = reseller ? "/api/reseller/cards" : "/api/cards";
  const edit = reseller || can("operator");
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [tab, setTab] = useState("cards");
  const [f, setF] = useState<Filters>(() => ({
    q: "",
    status: "",
    app: "",
    batch: "",
    owner: reseller ? 0 : Number(params.get("owner")) || 0,
    page: 1,
    page_size: 20,
  }));
  const [selected, setSelected] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [created, setCreated] = useState<{ batch: string; cards: string[] } | null>(null);
  const [devicesOf, setDevicesOf] = useState<string | null>(null);

  // A 代理 never sends owner: the server scopes /api/reseller/* to the signed-in account.
  const filterParams = (q: Partial<Filters>) => ({
    q: q.q,
    status: q.status,
    app: q.app,
    batch: q.batch,
    owner: reseller ? undefined : q.owner || undefined,
  });
  const stats = useQuery({ queryKey: ["card-stats", base], queryFn: () => api.get<CardStats>(base + "/stats") });
  const list = useQuery({
    queryKey: ["cards", base, f],
    queryFn: () => api.get<Page<CardT>>(base, { ...filterParams(f), page: f.page, page_size: f.page_size }),
    placeholderData: keepPreviousData,
  });
  const batches = useQuery({
    queryKey: ["batches", base],
    queryFn: () => api.get<{ items: Batch[] }>(base + "/batches"),
    enabled: tab === "batches",
  });
  const me = useQuery({
    queryKey: ["reseller-me"],
    queryFn: () => api.get<ResellerMe>("/api/reseller/me"),
    enabled: reseller,
  });
  // Names for the 来源 column and filter; only admins can list 代理.
  const resellers = useQuery({
    queryKey: ["resellers"],
    queryFn: () => api.get<{ items: ResellerRow[] }>("/api/resellers"),
    enabled: !reseller && can("admin"),
    staleTime: 60_000,
  });
  const ownerName = useMemo(
    () => new Map((resellers.data?.items ?? []).map((r) => [r.id, r.username])),
    [resellers.data],
  );
  const abuse = useQuery({
    queryKey: ["card-abuse"],
    queryFn: () => api.get<{ items: AbuseItem[] }>("/api/cards/abuse"),
    enabled: !reseller && tab === "abuse",
  });
  const bans = useQuery({
    queryKey: ["card-bans"],
    queryFn: () => api.get<{ items: DeviceBanItem[] }>("/api/cards/bans"),
    enabled: !reseller && (tab === "bans" || tab === "abuse"),
  });
  const ban = useMutation({
    mutationFn: (v: { device: string; reason: string }) => api.post("/api/cards/bans", v),
    onSuccess: () => {
      message.success("已加入黑名单");
      qc.invalidateQueries({ queryKey: ["card-bans"] });
    },
    onError: (e) => message.error((e as Error).message),
  });
  const unban = useMutation({
    mutationFn: (device: string) => api.del(`/api/cards/bans/${encodeURIComponent(device)}`),
    onSuccess: () => {
      message.success("已移出黑名单");
      qc.invalidateQueries({ queryKey: ["card-bans"] });
    },
    onError: (e) => message.error((e as Error).message),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["cards"] });
    qc.invalidateQueries({ queryKey: ["card-stats"] });
    qc.invalidateQueries({ queryKey: ["batches"] });
    qc.invalidateQueries({ queryKey: ["reseller-me"] });
  };

  const action = useMutation({
    mutationFn: (v: { cards: string[]; action: string; device?: string }) => api.post<{ updated: number }>(base + "/actions", v),
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
      unbind: "解绑后可以在另一台设备上激活，到期时间不变；多设备卡会释放全部设备。",
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
    download(base + "/export", filterParams(query), "cards.csv").catch((e) => message.error((e as Error).message));

  const quota = me.data;
  const s = stats.data;
  return (
    <>
      <PageHeader
        title={reseller ? "我的卡密" : "卡密管理"}
        desc={
          reseller
            ? "在额度内生成卡密，管理和导出你自己发出的卡。点击上方统计可按状态筛选。"
            : "生成、发放和管理打包 App 的授权卡密。点击上方统计可按状态筛选。"
        }
        extra={
          reseller ? (
            <>
              {quota && (
                <span className={"quota-chip" + (quota.left === 0 ? " empty" : "")} aria-label="剩余额度">
                  剩余额度 <b>{quota.left.toLocaleString()}</b>
                  <small>/ {quota.quota.toLocaleString()} 张</small>
                </span>
              )}
              <Tooltip title={quota?.left === 0 ? "额度已用完，请联系管理员充值" : undefined}>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  disabled={!quota || quota.left === 0}
                  onClick={() => setCreateOpen(true)}
                >
                  生成卡密
                </Button>
              </Tooltip>
            </>
          ) : (
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
            ["exhausted", "次数用完", "exhausted", toneColor("amber")],
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
                    {!reseller && can("admin") && (
                      <Select
                        style={{ width: 150 }}
                        value={f.owner}
                        aria-label="卡密来源"
                        onChange={(owner) => setF({ ...f, owner, page: 1 })}
                        options={[
                          { value: 0, label: "全部来源" },
                          { value: -1, label: "员工生成" },
                          ...(resellers.data?.items ?? []).map((r) => ({ value: r.id, label: "代理 " + r.username })),
                        ]}
                      />
                    )}
                    {f.batch && <Button onClick={() => setF({ ...f, batch: "", page: 1 })}>批次 {f.batch} ✕</Button>}
                    <Button icon={<DownloadOutlined />} onClick={() => exportCsv(f)} disabled={!edit}>
                      导出 CSV
                    </Button>
                    <span className="spacer" />
                    {selected.length > 0 && edit && (
                      <div className="selection-bar">
                        已选 {selected.length} 张
                        <Button size="small" onClick={() => copy(selected.join("\n")).then(() => message.success("已复制"))}>
                          复制
                        </Button>
                        <Dropdown
                          menu={{
                            items: [
                              ...(reseller ? [] : [{ key: "extend", label: "延期…" }]),
                              { key: "unbind", label: "解绑设备" },
                              { key: "revoke", label: "停用", danger: true },
                              { key: "restore", label: "恢复" },
                              ...(!reseller && can("admin")
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
                      edit
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
                        title: "类型",
                        dataIndex: "kind",
                        width: 110,
                        render: (k: string, c) => (
                          <Space size={4}>
                            {k === "trial" && <Tag color="gold">体验卡</Tag>}
                            {k === "count" && (
                              <Tag color="purple">
                                按次 {c.uses_left}/{c.uses_total}
                              </Tag>
                            )}
                            {c.max_devices > 1 && <Tag color="blue">{c.max_devices} 台</Tag>}
                            {k === "normal" && c.max_devices <= 1 && "-"}
                          </Space>
                        ),
                      },
                      {
                        title: "应用",
                        dataIndex: "app",
                        width: 160,
                        ellipsis: true,
                        render: (a: string) => (a === "*" ? "全部应用" : a),
                      },
                      ...(reseller
                        ? []
                        : [
                            {
                              title: "来源",
                              dataIndex: "owner_id",
                              width: 120,
                              ellipsis: true,
                              render: (o: number | null) =>
                                o == null ? (
                                  <span className="muted">员工</span>
                                ) : (
                                  <Tag color="geekblue">{ownerName.get(o) ?? "代理 #" + o}</Tag>
                                ),
                            },
                          ]),
                      {
                        title: "绑定设备",
                        dataIndex: "device",
                        ellipsis: true,
                        render: (d: string | null, c) =>
                          d ? (
                            <Tooltip title={c.devices.map((x) => x.device + (x.model ? "（" + x.model + "）" : "")).join("\n")}>
                              <span className="mono">{d}</span>
                              {c.devices.length > 1 && <Tag style={{ marginLeft: 6 }}>+{c.devices.length - 1}</Tag>}
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
                          edit && (
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
                              {c.device && c.max_devices > 1 && (
                                <Button type="link" size="small" onClick={() => setDevicesOf(c.card)}>
                                  设备
                                </Button>
                              )}
                              {c.device && c.max_devices <= 1 && (
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
                    {
                      title: "类型",
                      dataIndex: "kind",
                      render: (k: string, b) => (
                        <Space size={4}>
                          {k === "trial" ? <Tag color="gold">体验卡</Tag> : k === "count" ? <Tag color="purple">按次卡</Tag> : "正式卡"}
                          {b.max_devices > 1 && <Tag color="blue">{b.max_devices} 台</Tag>}
                        </Space>
                      ),
                    },
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
                          {edit && (
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
            // 代理 only manage their own cards: abuse findings and the device blacklist are staff tools.
            ...(reseller
              ? []
              : [
                {
                  key: "abuse",
                  label: "滥用告警",
                  children: (
                    <>
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginBottom: 12 }}
                        title="最近 24 小时内的异常激活：卡密被多台设备尝试、单设备激活大量卡密、单 IP 激活大量设备、暴力猜卡密。阈值和通知渠道在「系统设置」里配置（事件：卡密滥用告警）。"
                      />
                      <Table<AbuseItem>
                        rowKey={(r) => r.time + r.subject + r.signal}
                        loading={abuse.isLoading}
                        dataSource={abuse.data?.items}
                        columns={[
                          { title: "时间", dataIndex: "time", width: 160, render: fmtTime },
                          { title: "类型", dataIndex: "label" },
                          { title: "对象", dataIndex: "subject", render: (x: string) => <span className="mono">{x}</span> },
                          { title: "次数 / 阈值", key: "n", render: (_, r) => `${r.count} / ${r.threshold}` },
                          { title: "来源 IP", dataIndex: "ip", render: (x: string) => <span className="mono">{x}</span> },
                          {
                            title: "操作",
                            key: "ops",
                            render: (_, r) =>
                              r.signal === "card_shared" ? (
                                <Button
                                  type="link"
                                  size="small"
                                  onClick={() => {
                                    setTab("cards");
                                    setF({ ...f, q: r.subject, status: "", batch: "", page: 1 });
                                  }}
                                >
                                  查看卡密
                                </Button>
                              ) : r.signal === "device_many_cards" && can("operator") ? (
                                bans.data?.items.some((b) => b.device === r.subject) ? (
                                  <Tag>已在黑名单</Tag>
                                ) : (
                                  <Button
                                    type="link"
                                    size="small"
                                    danger
                                    onClick={() =>
                                      modal.confirm({
                                        title: "把这台设备加入黑名单？",
                                        content: `${r.subject}：它将不能再激活卡密，已激活的授权在下次联网复核时失效。`,
                                        okType: "danger",
                                        onOk: () => ban.mutateAsync({ device: r.subject, reason: r.label }),
                                      })
                                    }
                                  >
                                    加入黑名单
                                  </Button>
                                )
                              ) : null,
                          },
                        ]}
                      />
                    </>
                  ),
                },
                {
                  key: "bans",
                  label: "设备黑名单",
                  children: (
                    <BansPanel
                      items={bans.data?.items}
                      loading={bans.isLoading}
                      canEdit={can("operator")}
                      onAdd={(device, reason) => ban.mutateAsync({ device, reason })}
                      onRemove={(device) => unban.mutateAsync(device)}
                    />
                  ),
                },
              ]),
          ]}
        />
      </Card>

      <DevicesModal
        card={list.data?.items.find((c) => c.card === devicesOf) ?? null}
        onClose={() => setDevicesOf(null)}
        onUnbind={(card, device) => action.mutateAsync({ cards: [card], action: "unbind", device })}
      />
      <CreateModal
        open={createOpen}
        endpoint={base + "/batches"}
        limits={reseller ? quota : undefined}
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
      {!reseller && <OfflineModal open={offlineOpen} onClose={() => setOfflineOpen(false)} onDone={refresh} />}
    </>
  );
}

function BansPanel({
  items,
  loading,
  canEdit,
  onAdd,
  onRemove,
}: {
  items?: DeviceBanItem[];
  loading: boolean;
  canEdit: boolean;
  onAdd: (device: string, reason: string) => Promise<unknown>;
  onRemove: (device: string) => Promise<unknown>;
}) {
  const [form] = Form.useForm<{ device: string; reason: string }>();
  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="黑名单里的设备不能再激活卡密，已激活的授权在 App 下次联网复核（最多 6 小时）时失效；离线授权码不受影响。设备 ID 在 App 首页底部、卡密详情里能看到。"
      />
      {canEdit && (
        <Form
          form={form}
          layout="inline"
          style={{ marginBottom: 12 }}
          onFinish={async (v) => {
            await onAdd(v.device.trim(), (v.reason ?? "").trim());
            form.resetFields();
          }}
        >
          <Form.Item name="device" rules={[{ required: true, message: "填设备 ID" }, { pattern: /^[^\s*]\S*$/, message: "设备 ID 不能含空格或为 *" }]}>
            <Input placeholder="设备 ID" style={{ width: 240 }} />
          </Form.Item>
          <Form.Item name="reason">
            <Input placeholder="原因（可选）" style={{ width: 240 }} maxLength={200} />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            加入黑名单
          </Button>
        </Form>
      )}
      <Table<DeviceBanItem>
        rowKey="device"
        loading={loading}
        dataSource={items}
        pagination={false}
        locale={{ emptyText: "黑名单是空的" }}
        columns={[
          { title: "设备 ID", dataIndex: "device", render: (x: string) => <span className="mono">{x}</span> },
          { title: "原因", dataIndex: "reason" },
          { title: "操作人", dataIndex: "created_by", width: 120 },
          { title: "时间", dataIndex: "created_at", width: 160, render: fmtTime },
          {
            title: "操作",
            key: "ops",
            width: 100,
            render: (_, r) =>
              canEdit ? (
                <Button type="link" size="small" onClick={() => onRemove(r.device)}>
                  移除
                </Button>
              ) : null,
          },
        ]}
      />
    </>
  );
}
