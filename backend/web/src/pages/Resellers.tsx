import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Avatar,
  Button,
  Card,
  Col,
  Drawer,
  Dropdown,
  Empty,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  DownOutlined,
  LineChartOutlined,
  PlusOutlined,
  AccountBookOutlined,
  SafetyCertificateOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import { api, type ResellerBalance, type ResellerRow } from "../api";
import { PageHeader } from "../components";
import { fmtAgo, fmtDays, fmtYuan } from "../format";
import TrendCard, { CARD_TREND_SERIES } from "./overview/TrendCard";
import { KIND_LABELS, LimitsModal, NewResellerModal, QuotaModal, QuotaBar } from "./resellers/ResellerModals";
import { SettlementDrawer } from "./resellers/Settlement";

/** 代理管理 (admin): quota, limits and sales of every reseller account. */
export default function ResellersPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [quotaOf, setQuotaOf] = useState<ResellerRow | null>(null);
  const [limitsOf, setLimitsOf] = useState<ResellerRow | null>(null);
  const [trendOf, setTrendOf] = useState<ResellerRow | null>(null);
  const [settleOf, setSettleOf] = useState<ResellerRow | null>(null);
  const balances = useQuery({
    queryKey: ["reseller-balances"],
    queryFn: () => api.get<{ items: (ResellerBalance & { id: number })[] }>("/api/resellers/balances"),
  });
  const balanceOf = new Map((balances.data?.items ?? []).map((b) => [b.id, b]));
  const list = useQuery({
    queryKey: ["resellers"],
    queryFn: () => api.get<{ items: ResellerRow[] }>("/api/resellers"),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["resellers"] });
  const toggle = useMutation({
    mutationFn: (r: ResellerRow) => api.patch(`/api/users/${r.id}`, { disabled: !r.disabled }),
    onSuccess: refresh,
    onError: (e) => message.error((e as Error).message),
  });

  const rows = list.data?.items ?? [];
  const sum = (f: (r: ResellerRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const summary = [
    {
      label: "代理",
      value: rows.length,
      unit: "个",
      hint: `启用 ${rows.filter((r) => !r.disabled).length} 个`,
    },
    {
      label: "已发放额度",
      value: sum((r) => r.quota),
      unit: "张",
      hint: `剩余 ${sum((r) => r.left).toLocaleString()} 张`,
    },
    {
      label: "已生成",
      value: sum((r) => r.used),
      unit: "张",
      hint: `已激活 ${sum((r) => r.cards.active).toLocaleString()} 张`,
    },
    {
      label: "待结算",
      value: (balances.data?.items ?? []).reduce((n, b) => n + b.balance, 0),
      unit: "",
      hint: `近 30 天激活 ${sum((r) => r.activations_30d).toLocaleString()} 张`,
      money: true,
    },
  ];

  return (
    <>
      <PageHeader
        title="代理"
        desc="给代理分配可生成的卡密额度、发卡限制和批发价，登记收款并导出对账单；代理登录后只能看到自己的卡和账单。所有调整都记入操作日志。"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            新建代理
          </Button>
        }
      />
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {summary.map((s) => (
          <Col key={s.label} xs={12} xl={6}>
            <Card className="mini-stat static">
              <div className="label">{s.label}</div>
              <div className="value">
                {"money" in s ? fmtYuan(s.value) : s.value.toLocaleString()} <small>{s.unit}</small>
              </div>
              <div className="hint">{s.hint}</div>
            </Card>
          </Col>
        ))}
      </Row>
      <Card className="table-card">
        <Table<ResellerRow>
          rowKey="id"
          size="middle"
          loading={list.isLoading}
          dataSource={rows}
          scroll={{ x: 1560 }}
          pagination={false}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有代理">
                <Button type="primary" onClick={() => setCreating(true)}>
                  新建代理
                </Button>
              </Empty>
            ),
          }}
          columns={[
            {
              title: "代理",
              dataIndex: "username",
              fixed: "left",
              width: 190,
              render: (u: string, r) => (
                <Space>
                  <Avatar size={28} style={{ background: "var(--xs-violet)" }}>
                    {u.slice(0, 1).toUpperCase()}
                  </Avatar>
                  <span>
                    <b style={{ fontWeight: 500 }}>{u}</b>
                    {r.note && (
                      <Typography.Text type="secondary" className="cell-sub">
                        {r.note}
                      </Typography.Text>
                    )}
                  </span>
                  {r.disabled && <Tag>已停用</Tag>}
                </Space>
              ),
            },
            {
              title: "额度",
              key: "quota",
              width: 220,
              render: (_, r) => <QuotaBar used={r.used} quota={r.quota} />,
            },
            {
              title: "卡密",
              key: "cards",
              width: 150,
              render: (_, r) => (
                <Tooltip
                  title={`未使用 ${r.cards.unused}，已激活 ${r.cards.active}，已过期 ${r.cards.expired}，已停用 ${r.cards.revoked}`}
                >
                  <span>
                    <b>{r.cards.active.toLocaleString()}</b>
                    <span className="muted"> 激活 / {r.cards.total.toLocaleString()} 张</span>
                  </span>
                </Tooltip>
              ),
            },
            {
              title: "近 30 天激活",
              dataIndex: "activations_30d",
              width: 110,
              align: "right",
              render: (n: number) => n.toLocaleString(),
            },
            {
              title: "待结算",
              key: "balance",
              width: 120,
              align: "right",
              render: (_, r) => {
                const b = balanceOf.get(r.id);
                if (!b) return <span className="muted">—</span>;
                return (
                  <Tooltip title={`应付 ${fmtYuan(b.charged)}，已收 ${fmtYuan(b.paid)}，调整 ${fmtYuan(b.adjusted)}`}>
                    <b className={b.balance > 0 ? "money-owed" : undefined}>{fmtYuan(b.balance)}</b>
                  </Tooltip>
                );
              },
            },
            {
              title: "发卡限制",
              key: "limits",
              width: 300,
              render: (_, r) => (
                <Space size={[4, 4]} wrap>
                  {r.kinds.map((k) => (
                    <Tag key={k}>{KIND_LABELS[k]}</Tag>
                  ))}
                  <Tag color="blue">{r.max_days ? "≤ " + fmtDays(r.max_days) : "可发永久卡"}</Tag>
                  {r.max_devices > 1 && <Tag color="blue">每卡 ≤ {r.max_devices} 台</Tag>}
                  <Tooltip title={r.apps.join("、")}>
                    <Tag color={r.apps.includes("*") ? "default" : "geekblue"}>
                      {r.apps.includes("*") ? "全部应用" : r.apps.length === 1 ? r.apps[0] : `${r.apps.length} 个应用`}
                    </Tag>
                  </Tooltip>
                </Space>
              ),
            },
            {
              title: "最近登录",
              dataIndex: "last_login_at",
              width: 110,
              render: fmtAgo,
            },
            {
              title: "操作",
              key: "ops",
              fixed: "right",
              width: 290,
              render: (_, r) => (
                <Space size={0}>
                  <Button type="link" size="small" icon={<WalletOutlined />} onClick={() => setQuotaOf(r)}>
                    额度
                  </Button>
                  <Button type="link" size="small" icon={<AccountBookOutlined />} onClick={() => setSettleOf(r)}>
                    结算
                  </Button>
                  <Button type="link" size="small" icon={<LineChartOutlined />} onClick={() => setTrendOf(r)}>
                    销量
                  </Button>
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: "limits",
                          icon: <SafetyCertificateOutlined />,
                          label: "发卡限制…",
                        },
                        { key: "cards", label: "查看卡密" },
                        { type: "divider" },
                        {
                          key: "toggle",
                          label: r.disabled ? "启用账号" : "停用账号",
                          danger: !r.disabled,
                        },
                      ],
                      onClick: ({ key }) =>
                        key === "limits"
                          ? setLimitsOf(r)
                          : key === "cards"
                            ? navigate(`/cards?owner=${r.id}`)
                            : toggle.mutate(r),
                    }}
                  >
                    <Button type="link" size="small">
                      更多 <DownOutlined />
                    </Button>
                  </Dropdown>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <NewResellerModal
        open={creating}
        onClose={() => setCreating(false)}
        onDone={() => {
          setCreating(false);
          refresh();
        }}
      />
      <QuotaModal row={quotaOf} onClose={() => setQuotaOf(null)} onDone={refresh} />
      <LimitsModal row={limitsOf} onClose={() => setLimitsOf(null)} onDone={refresh} />
      <SettlementDrawer row={settleOf} onClose={() => setSettleOf(null)} />
      <Drawer
        open={!!trendOf}
        onClose={() => setTrendOf(null)}
        size={760}
        title={trendOf ? `代理 ${trendOf.username} 的销量` : ""}
        destroyOnHidden
      >
        {trendOf && (
          <TrendCard
            title="每日生成 / 激活 / 到期"
            url={(days) => `/api/resellers/${trendOf.id}/stats/daily?days=${days}`}
            cacheKey={`reseller-trend-${trendOf.id}`}
            defs={CARD_TREND_SERIES}
            defaultHidden={[]}
            emptyText="所选时间段内这个代理没有生成或激活卡密"
          />
        )}
      </Drawer>
    </>
  );
}
