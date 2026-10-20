import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Alert, App, Checkbox, Col, Form, Input, InputNumber, Modal, Progress, Radio, Row, Select } from "antd";
import { api, type CardKind, type ResellerRow } from "../../api";
import { APP_RULE } from "../cards/CreateModal";

export const KIND_LABELS: Record<CardKind, string> = {
  normal: "正式卡",
  trial: "体验卡",
  count: "按次卡",
};

/** used / quota with the remaining count; red when nothing is left. */
export function QuotaBar({ used, quota }: { used: number; quota: number }) {
  const left = Math.max(0, quota - used);
  const pct = quota ? Math.round((100 * used) / quota) : 0;
  return (
    <div className="quota-bar">
      <Progress
        percent={quota ? pct : 0}
        size="small"
        showInfo={false}
        status={quota && left === 0 ? "exception" : "normal"}
        aria-label={`已用 ${used} / ${quota}`}
      />
      <span>
        剩 <b>{left.toLocaleString()}</b>
        <span className="muted">
          {" "}
          · 已用 {used.toLocaleString()} / {quota.toLocaleString()}
        </span>
      </span>
    </div>
  );
}

export function NewResellerModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: async (v: { username: string; password: string; quota: number }) => {
      const u = await api.post<{ id: number }>("/api/users", {
        username: v.username,
        password: v.password,
        role: "reseller",
      });
      if (v.quota > 0)
        await api.post(`/api/resellers/${u.id}/quota`, {
          delta: v.quota,
          note: "开户",
        });
      return u;
    },
    onSuccess: () => {
      message.success("已创建代理账号");
      onDone();
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={open}
      title="新建代理"
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="默认只能发正式卡、最长 365 天、每卡 1 台设备、全部应用；创建后可在「发卡限制」里调整。"
      />
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ quota: 100 }}
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item
          name="username"
          label="登录名"
          rules={[{ required: true }, { pattern: /^[\w.@-]{2,64}$/, message: "2–64 位字母、数字或 _.@-" }]}
        >
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item name="password" label="初始密码" rules={[{ required: true }, { min: 8, message: "至少 8 位" }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="quota" label="初始额度" extra="可生成的卡密张数，之后可随时充值">
          <InputNumber min={0} max={10_000_000} style={{ width: "100%" }} addonAfter="张" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function QuotaModal({
  row,
  onClose,
  onDone,
}: {
  row: ResellerRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{
    mode: "add" | "sub";
    amount: number;
    note: string;
  }>();
  const mode = Form.useWatch("mode", form);
  const amount = Form.useWatch("amount", form) ?? 0;
  const save = useMutation({
    mutationFn: (v: { mode: "add" | "sub"; amount: number; note: string }) =>
      api.post(`/api/resellers/${row!.id}/quota`, {
        delta: v.mode === "sub" ? -v.amount : v.amount,
        note: v.note ?? "",
      }),
    onSuccess: () => {
      message.success("额度已调整");
      onDone();
      onClose();
    },
    onError: (e) => message.error((e as Error).message),
  });
  const after = row ? row.quota + (mode === "sub" ? -amount : amount) : 0;
  const maxSub = row ? row.quota - row.used : 0;
  return (
    <Modal
      open={!!row}
      title={row ? `调整额度：${row.username}` : ""}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      {row && <QuotaBar used={row.used} quota={row.quota} />}
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        style={{ marginTop: 16 }}
        initialValues={{ mode: "add", amount: 100 }}
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item name="mode">
          <Radio.Group
            optionType="button"
            options={[
              { value: "add", label: "充值" },
              { value: "sub", label: "扣回", disabled: maxSub <= 0 },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="amount"
          label="数量"
          rules={[{ required: true }]}
          extra={
            mode === "sub"
              ? `最多扣回 ${maxSub.toLocaleString()} 张（不能低于已生成数）`
              : `调整后共 ${Math.max(0, after).toLocaleString()} 张`
          }
        >
          <InputNumber
            min={1}
            max={mode === "sub" ? Math.max(1, maxSub) : 10_000_000}
            style={{ width: "100%" }}
            addonAfter="张"
          />
        </Form.Item>
        <Form.Item name="note" label="备注" extra="例如收款单号，会记入操作日志，代理也能看到">
          <Input maxLength={200} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface LimitsForm {
  apps: string[];
  kinds: CardKind[];
  permanent: boolean;
  max_days: number;
  max_devices: number;
  max_uses: number;
  note: string;
}

export function LimitsModal({
  row,
  onClose,
  onDone,
}: {
  row: ResellerRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<LimitsForm>();
  const permanent = Form.useWatch("permanent", form);
  const kinds = Form.useWatch("kinds", form) ?? [];
  useEffect(() => {
    if (row)
      form.setFieldsValue({
        apps: row.apps,
        kinds: row.kinds,
        permanent: row.max_days === 0,
        max_days: row.max_days || 365,
        max_devices: row.max_devices,
        max_uses: row.max_uses,
        note: row.note,
      });
  }, [row, form]);
  const save = useMutation({
    mutationFn: (v: LimitsForm) =>
      api.put(`/api/resellers/${row!.id}`, {
        apps: v.apps,
        kinds: v.kinds,
        max_days: v.permanent ? 0 : v.max_days,
        max_devices: v.max_devices,
        max_uses: v.max_uses,
        note: v.note ?? "",
      }),
    onSuccess: () => {
      message.success("发卡限制已保存");
      onDone();
      onClose();
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={!!row}
      title={row ? `发卡限制：${row.username}` : ""}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      width={560}
      forceRender
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item
          name="apps"
          label="允许的应用"
          extra="输入包名后回车；* 表示所有应用（也能发「全部应用」通用卡）"
          rules={[
            { required: true, message: "至少一个" },
            {
              validator: (_, v: string[]) =>
                (v ?? []).every((a) => APP_RULE.pattern.test(a))
                  ? Promise.resolve()
                  : Promise.reject(new Error(APP_RULE.message)),
            },
          ]}
        >
          <Select mode="tags" className="mono" tokenSeparators={[",", " "]} open={false} suffixIcon={null} />
        </Form.Item>
        <Form.Item name="kinds" label="卡类型" rules={[{ required: true, message: "至少一种" }]}>
          <Checkbox.Group
            options={Object.entries(KIND_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="最长有效期" required>
              <Form.Item name="max_days" noStyle rules={[{ required: !permanent }]}>
                <InputNumber min={0.5} max={36500} disabled={permanent} style={{ width: "100%" }} addonAfter="天" />
              </Form.Item>
              <Form.Item name="permanent" valuePropName="checked" noStyle>
                <Checkbox style={{ marginTop: 6 }}>不限（允许永久卡）</Checkbox>
              </Form.Item>
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="max_devices" label="每张卡最多设备" rules={[{ required: true }]}>
              <InputNumber min={1} max={100} style={{ width: "100%" }} addonAfter="台" />
            </Form.Item>
          </Col>
        </Row>
        {kinds.includes("count") && (
          <Form.Item name="max_uses" label="按次卡最多次数" rules={[{ required: true }]}>
            <InputNumber min={1} max={100000} style={{ width: "100%" }} addonAfter="次" />
          </Form.Item>
        )}
        <Form.Item name="note" label="备注" extra="只有管理员能看到">
          <Input maxLength={255} placeholder="例如 华东区 · 月结" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
