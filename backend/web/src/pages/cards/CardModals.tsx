import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Alert, App, Button, Col, Form, Input, InputNumber, Modal, Row, Table, Typography } from "antd";
import { api, type Card as CardT } from "../../api";
import { useSecretModal } from "../../components";
import { APP_RULE } from "./CreateModal";

export function DevicesModal({
  card,
  onClose,
  onUnbind,
}: {
  card: CardT | null;
  onClose: () => void;
  onUnbind: (card: string, device: string) => Promise<unknown>;
}) {
  return (
    <Modal open={!!card} title={`已绑定设备（${card?.devices.length ?? 0} / ${card?.max_devices ?? 1}）`} onCancel={onClose} footer={null}>
      <Typography.Paragraph type="secondary">
        解绑后这台设备的授权在联网复核时失效，空出的名额可以给另一台设备；到期时间不变。
      </Typography.Paragraph>
      <Table
        rowKey="device"
        size="small"
        pagination={false}
        dataSource={card?.devices}
        columns={[
          { title: "设备 ID", dataIndex: "device", render: (d: string) => <span className="mono">{d}</span> },
          { title: "型号", dataIndex: "model" },
          {
            title: "操作",
            key: "ops",
            render: (_, d) => (
              <Button type="link" size="small" danger onClick={() => card && onUnbind(card.card, d.device)}>
                解绑
              </Button>
            ),
          },
        ]}
      />
    </Modal>
  );
}

export function ExtendModal({
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

export function OfflineModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
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
