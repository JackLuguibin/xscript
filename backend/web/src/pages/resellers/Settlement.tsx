import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Typography,
} from "antd";
import { DeleteOutlined, DownloadOutlined, PlusOutlined } from "@ant-design/icons";
import type { Dayjs } from "dayjs";
import {
  api,
  download,
  type CardKind,
  type LedgerKind,
  type LedgerPage,
  type LedgerRow,
  type ResellerBalance,
  type ResellerPrice,
  type ResellerPrices,
  type ResellerRow,
} from "../../api";
import { Pill, type Tone } from "../../components";
import { fmtDays, fmtTime, fmtYuan } from "../../format";
import { KIND_LABELS } from "./ResellerModals";

export const LEDGER_KINDS: Record<LedgerKind, [Tone, string]> = {
  charge: ["blue", "生成卡密"],
  payment: ["green", "收款"],
  adjust: ["amber", "调整"],
};

/** 应付 / 已付 / 调整 / 余额 as four mini stats; the balance turns red while money is owed. */
export function BalanceStats({ b }: { b?: ResellerBalance }) {
  const items: [string, number | undefined, string][] = [
    ["累计应付", b?.charged, "生成卡密按批发价计"],
    ["已收款", b?.paid, "管理员登记的收款"],
    ["调整", b?.adjusted, "优惠、补差等"],
    ["待结算", b?.balance, "应付 + 调整 − 已收款"],
  ];
  return (
    <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
      {items.map(([label, v, hint]) => (
        <Col key={label} xs={12} xl={6}>
          <Card className="mini-stat static">
            <div className="label">{label}</div>
            <div
              className="value"
              style={label === "待结算" && (v ?? 0) > 0 ? { color: "var(--xs-red)" } : undefined}
            >
              {fmtYuan(v ?? 0)}
            </div>
            <div className="hint">{hint}</div>
          </Card>
        </Col>
      ))}
    </Row>
  );
}

/** 账单: paged ledger with a type filter, a time range and the CSV statement for that range. */
export function LedgerTable({
  base,
  cacheKey,
  onBalance,
  extra,
}: {
  /** /api/reseller (own) or /api/resellers/{id} (admin) */
  base: string;
  cacheKey: string;
  onBalance?: (b: ResellerBalance) => void;
  extra?: React.ReactNode;
}) {
  const { message } = App.useApp();
  const [f, setF] = useState({ kind: "", since: 0, until: 0, page: 1, page_size: 20 });
  const list = useQuery({
    queryKey: [cacheKey, f],
    queryFn: () => api.get<LedgerPage>(`${base}/ledger`, f),
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (list.data && onBalance) onBalance(list.data);
  }, [list.data, onBalance]);
  const range = { since: f.since, until: f.until };
  return (
    <>
      <div className="toolbar">
        <Select
          value={f.kind}
          style={{ width: 130 }}
          aria-label="账单类型"
          onChange={(kind) => setF({ ...f, kind, page: 1 })}
          options={[
            { value: "", label: "全部类型" },
            ...Object.entries(LEDGER_KINDS).map(([value, [, label]]) => ({ value, label })),
          ]}
        />
        <DatePicker.RangePicker
          showTime={{ format: "HH:mm" }}
          format="YYYY-MM-DD HH:mm"
          onChange={(r) => {
            const [a, b] = (r ?? [null, null]) as [Dayjs | null, Dayjs | null];
            setF({ ...f, since: a ? a.unix() : 0, until: b ? b.unix() : 0, page: 1 });
          }}
        />
        <Button
          icon={<DownloadOutlined />}
          onClick={() =>
            download(`${base}/statement`, range, "statement.csv").catch((e) => message.error((e as Error).message))
          }
        >
          导出对账单
        </Button>
        {extra}
      </div>
      <Table<LedgerRow>
        rowKey="id"
        size="middle"
        loading={list.isLoading}
        dataSource={list.data?.items}
        scroll={{ x: 820 }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个时间段没有账单" /> }}
        pagination={{
          current: f.page,
          pageSize: f.page_size,
          total: list.data?.total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (page, page_size) => setF({ ...f, page, page_size }),
        }}
        columns={[
          { title: "时间", dataIndex: "time", width: 150, render: fmtTime },
          {
            title: "类型",
            dataIndex: "kind",
            width: 100,
            render: (k: LedgerKind) => <Pill tone={LEDGER_KINDS[k]?.[0]}>{LEDGER_KINDS[k]?.[1] ?? k}</Pill>,
          },
          {
            title: "金额",
            key: "amount",
            width: 120,
            align: "right",
            render: (_, r) => (
              <b className={r.kind === "payment" ? "money-in" : undefined}>
                {fmtYuan(r.kind === "payment" ? -r.amount_cents : r.amount_cents)}
              </b>
            ),
          },
          {
            title: "明细",
            key: "detail",
            render: (_, r) =>
              r.kind === "charge" ? (
                <span>
                  {r.count} 张 × {fmtYuan(r.unit_cents)}
                  <Typography.Text type="secondary" className="cell-sub">
                    {KIND_LABELS[r.card_kind as CardKind] ?? r.card_kind} · {r.days ? fmtDays(r.days) : "永久"} ·{" "}
                    <span className="mono">{r.app || "全部应用"}</span> · 批次 <span className="mono">{r.batch}</span>
                  </Typography.Text>
                </span>
              ) : (
                r.note || <span className="muted">—</span>
              ),
          },
          { title: "操作人", dataIndex: "actor", width: 110 },
        ]}
      />
    </>
  );
}

const ANY = "any";

/** 批发价 editor: one list per reseller, saved as a whole (past charges are never repriced). */
export function PriceEditor({ id }: { id: number }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const prices = useQuery({
    queryKey: ["reseller-prices", id],
    queryFn: () => api.get<ResellerPrices>(`/api/resellers/${id}/prices`),
  });
  useEffect(() => {
    if (prices.data)
      form.setFieldsValue({
        unpriced: prices.data.unpriced,
        items: prices.data.items.map((p) => ({ ...p, days: p.days ?? ANY, price: p.price_cents / 100 })),
      });
  }, [prices.data, form]);
  const save = useMutation({
    mutationFn: (v: { unpriced: string; items: (Omit<ResellerPrice, "days"> & { price: number; days: number | string })[] }) =>
      api.put<ResellerPrices>(`/api/resellers/${id}/prices`, {
        unpriced: v.unpriced,
        items: (v.items ?? []).map((p) => ({
          app: (p.app || "*").trim(),
          kind: p.kind,
          days: p.days === ANY ? null : Number(p.days),
          price_cents: Math.round(Number(p.price) * 100),
        })),
      }),
    onSuccess: () => {
      message.success("已保存批发价");
      qc.invalidateQueries({ queryKey: ["reseller-prices", id] });
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Form form={form} layout="vertical" onFinish={save.mutate} initialValues={{ unpriced: "free", items: [] }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="代理生成卡密时按这里的单价记应付。匹配顺序：指定应用优先于全部应用，指定天数优先于任意天数。改价只影响之后生成的卡。"
      />
      <Form.List name="items">
        {(fields, { add, remove }) => (
          <>
            {fields.map((f) => (
              <Space key={f.key} align="baseline" wrap style={{ display: "flex", marginBottom: 4 }}>
                <Form.Item name={[f.name, "app"]} style={{ width: 200 }}>
                  <Input placeholder="* 全部应用" aria-label="应用" />
                </Form.Item>
                <Form.Item name={[f.name, "kind"]} style={{ width: 100 }}>
                  <Select
                    aria-label="卡类型"
                    options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
                  />
                </Form.Item>
                <Form.Item name={[f.name, "days"]} style={{ width: 120 }}>
                  <Select
                    aria-label="天数"
                    options={[
                      { value: ANY, label: "任意天数" },
                      ...[1, 7, 30, 90, 180, 365].map((d) => ({ value: d, label: `${d} 天` })),
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  name={[f.name, "price"]}
                  rules={[{ required: true, message: "填写单价" }]}
                  style={{ width: 140 }}
                >
                  <InputNumber min={0} precision={2} prefix="¥" placeholder="单价" style={{ width: "100%" }} />
                </Form.Item>
                <Button type="text" icon={<DeleteOutlined />} aria-label="删除" onClick={() => remove(f.name)} />
              </Space>
            ))}
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={() => add({ app: "*", kind: "normal", days: ANY, price: undefined })}
              style={{ marginBottom: 16 }}
            >
              添加价格
            </Button>
          </>
        )}
      </Form.List>
      <Form.Item name="unpriced" label="没有匹配价格时">
        <Radio.Group
          options={[
            { value: "free", label: "允许，记 0 元" },
            { value: "deny", label: "禁止生成" },
          ]}
        />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={save.isPending} disabled={prices.isLoading}>
        保存批发价
      </Button>
    </Form>
  );
}

/** 登记收款 / 调整 for one reseller. */
export function LedgerModal({
  id,
  kind,
  onClose,
  onDone,
}: {
  id: number;
  kind: "payment" | "adjust" | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: { amount: number; note: string }) =>
      api.post(`/api/resellers/${id}/ledger`, {
        kind,
        amount_cents: Math.round(v.amount * 100),
        note: v.note ?? "",
      }),
    onSuccess: () => {
      message.success(kind === "payment" ? "已登记收款" : "已调整应付");
      onDone();
      onClose();
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={!!kind}
      title={kind === "payment" ? "登记收款" : "调整应付"}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={save.mutate} preserve={false}>
        <Form.Item
          name="amount"
          label={kind === "payment" ? "收款金额" : "调整金额（正数增加应付，负数减少）"}
          rules={[
            { required: true, message: "填写金额" },
            {
              validator: (_, v) =>
                v === 0 || (kind === "payment" && v < 0) ? Promise.reject(new Error("金额不正确")) : Promise.resolve(),
            },
          ]}
        >
          <InputNumber
            prefix="¥"
            precision={2}
            min={kind === "payment" ? 0.01 : undefined}
            style={{ width: "100%" }}
            aria-label="金额"
          />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input maxLength={200} placeholder={kind === "payment" ? "如：微信转账 10/20" : "如：活动优惠"} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Admin drawer: balance, ledger with payments/adjustments, and the price table. */
export function SettlementDrawer({ row, onClose }: { row: ResellerRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [bal, setBal] = useState<ResellerBalance>();
  const [entry, setEntry] = useState<"payment" | "adjust" | null>(null);
  const key = `reseller-ledger-${row?.id}`;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: [key] });
    qc.invalidateQueries({ queryKey: ["reseller-balances"] });
  };
  return (
    <Drawer
      open={!!row}
      onClose={onClose}
      size={900}
      title={row ? `代理 ${row.username} 的结算` : ""}
      destroyOnHidden
    >
      {row && (
        <>
          <BalanceStats b={bal} />
          <Tabs
            items={[
              {
                key: "ledger",
                label: "账单",
                children: (
                  <LedgerTable
                    base={`/api/resellers/${row.id}`}
                    cacheKey={key}
                    onBalance={setBal}
                    extra={
                      <Space style={{ marginLeft: "auto" }}>
                        <Button onClick={() => setEntry("adjust")}>调整</Button>
                        <Button type="primary" onClick={() => setEntry("payment")}>
                          登记收款
                        </Button>
                      </Space>
                    }
                  />
                ),
              },
              { key: "prices", label: "批发价", children: <PriceEditor id={row.id} /> },
            ]}
          />
          <LedgerModal id={row.id} kind={entry} onClose={() => setEntry(null)} onDone={refresh} />
        </>
      )}
    </Drawer>
  );
}
