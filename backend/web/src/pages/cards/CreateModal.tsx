import { useMutation } from "@tanstack/react-query";
import { Alert, App, Button, Col, Form, Input, InputNumber, Modal, Radio, Row, Switch, Typography } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { api } from "../../api";
import { copy } from "../../format";

export const APP_RULE = { pattern: /^(\*|[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+)$/, message: "填 * 或包名，例如 com.me.game" };

export function CreateModal({
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
  const kind = Form.useWatch("kind", form);
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
        onFinish={(v) =>
          save.mutate(
            v.kind === "trial"
              ? { count: v.count, kind: "trial", hours: v.hours, app: v.app, note: v.note, prefix: v.prefix }
              : v.kind === "count"
              ? { count: v.count, kind: "count", uses: v.uses, days: v.days, max_devices: v.max_devices, app: v.app, note: v.note, prefix: v.prefix }
              : { count: v.count, kind: "normal", days: v.days, max_devices: v.max_devices, stack: v.stack, app: v.app, note: v.note, prefix: v.prefix },
          )
        }
        initialValues={{ kind: "normal", count: 50, days: 30, hours: 24, uses: 100, max_devices: 1, stack: true, app: "*", prefix: "XS" }}
      >
        <Form.Item name="kind" label="卡类型">
          <Radio.Group
            optionType="button"
            options={[
              { value: "normal", label: "正式卡" },
              { value: "trial", label: "体验卡" },
              { value: "count", label: "按次卡" },
            ]}
          />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="count" label="数量" rules={[{ required: true }]}>
              <InputNumber min={1} max={10000} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            {kind === "trial" ? (
              <Form.Item name="hours" label="有效小时" extra="从激活开始算，最长 720 小时" rules={[{ required: true }]}>
                <InputNumber min={0.5} max={720} style={{ width: "100%" }} />
              </Form.Item>
            ) : (
              <Form.Item name="days" label="有效天数" extra="从激活开始算，0 = 永久" rules={[{ required: true }]}>
                <InputNumber min={0} max={36500} style={{ width: "100%" }} />
              </Form.Item>
            )}
          </Col>
        </Row>
        {kind === "trial" ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title="每台设备在每个应用上只能用一张体验卡（解绑、删除卡也不会重置）；体验卡只绑定一台设备，不参与续期叠加。"
          />
        ) : kind === "count" ? (
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="uses" label="可用次数" extra="App 每启动一次扣一次，用完即失效" rules={[{ required: true }]}>
                <InputNumber min={1} max={100000} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="max_devices" label="可绑定设备数" extra="多台设备共用同一份次数">
                <InputNumber min={1} max={100} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
        ) : (
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="max_devices" label="可绑定设备数" extra="1 = 普通卡；大于 1 为多设备卡，共用同一个到期时间">
                <InputNumber min={1} max={100} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="stack"
                label="续期叠加"
                valuePropName="checked"
                extra="设备已有未到期的卡时，新卡从旧卡到期后开始算（多设备卡不叠加）"
              >
                <Switch />
              </Form.Item>
            </Col>
          </Row>
        )}
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

export function CreatedModal({
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
