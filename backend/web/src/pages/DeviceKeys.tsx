import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Form, Input, Modal, Popconfirm, Table, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api, type DeviceKey, type Settings } from "../api";
import { PageHeader, Pill, useSecretModal } from "../components";
import { fmtAgo, fmtTime } from "../format";

function wsUrl(publicUrl: string): string {
  const base = publicUrl || window.location.origin;
  return (
    base
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:")
      .replace(/\/$/, "") + "/ws?token="
  );
}

export default function DeviceKeysPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const showSecret = useSecretModal();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const keys = useQuery({
    queryKey: ["device-keys"],
    queryFn: () => api.get<{ items: DeviceKey[] }>("/api/device-keys"),
    refetchInterval: 10000,
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });
  const base = wsUrl(settings.data?.public_url ?? "");

  const create = useMutation({
    mutationFn: (v: { name: string; value?: string }) =>
      api.post<DeviceKey>("/api/device-keys", { name: v.name, value: v.value || undefined }),
    onSuccess: (k) => {
      setOpen(false);
      form.resetFields();
      qc.invalidateQueries({ queryKey: ["device-keys"] });
      showSecret(
        "设备密钥已创建",
        base + k.token,
        <Typography.Text type="secondary">把整段地址填到手机 XScript → 云端控制。</Typography.Text>,
      );
    },
    onError: (e) => message.error((e as Error).message),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.post<{ disconnected: number }>(`/api/device-keys/${id}/revoke`),
    onSuccess: (r) => {
      message.success(`已停用，断开 ${r.disconnected} 台设备`);
      qc.invalidateQueries({ queryKey: ["device-keys"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/device-keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-keys"] }),
    onError: (e) => message.error((e as Error).message),
  });

  return (
    <>
      <PageHeader
        title="设备密钥"
        desc="设备凭密钥接入云控。可以按渠道或客户分别创建，停用后立即断开。"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            新建密钥
          </Button>
        }
      />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="设备用密钥连接云控"
        description={
          <>
            手机端填写 <span className="mono">{base}&lt;密钥&gt;</span>
            。可以按渠道或客户分别建密钥，停用某个密钥会立即断开用它连接的设备。
            {!settings.data?.public_url && " 地址按当前浏览器地址推算；公网部署请在「系统设置」里填写服务器地址。"}
          </>
        }
      />
      <Card className="table-card">
        <Table<DeviceKey>
          rowKey="id"
          loading={keys.isLoading}
          dataSource={keys.data?.items}
          pagination={false}
          columns={[
            { title: "名称", dataIndex: "name" },
            { title: "密钥", dataIndex: "hint", render: (h: string) => <span className="mono">{h}</span> },
            { title: "在线设备", dataIndex: "online", width: 100 },
            {
              title: "状态",
              dataIndex: "revoked",
              width: 90,
              render: (r: boolean) => (r ? <Pill tone="red">已停用</Pill> : <Pill tone="green">有效</Pill>),
            },
            { title: "最近使用", dataIndex: "last_used_at", render: fmtAgo },
            { title: "创建", key: "c", render: (_, k) => `${fmtTime(k.created_at)} · ${k.created_by}` },
            {
              title: "操作",
              key: "ops",
              width: 120,
              render: (_, k) =>
                k.revoked ? (
                  <Popconfirm title="删除这个密钥？" onConfirm={() => remove.mutate(k.id)}>
                    <Button type="link" size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                ) : (
                  <Popconfirm
                    title="停用后用它连接的设备会立即断开，且无法恢复。"
                    onConfirm={() => revoke.mutate(k.id)}
                    okButtonProps={{ danger: true }}
                  >
                    <Button type="link" size="small" danger>
                      停用
                    </Button>
                  </Popconfirm>
                ),
            },
          ]}
        />
      </Card>
      <Modal
        open={open}
        title="新建设备密钥"
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
      >
        <Form form={form} layout="vertical" onFinish={create.mutate}>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="例如 渠道 A" maxLength={64} />
          </Form.Item>
          <Form.Item
            name="value"
            label="指定密钥（可选）"
            extra="从旧版服务端迁移时填旧的 --token，设备不用改地址。留空自动生成。"
          >
            <Input.Password autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
