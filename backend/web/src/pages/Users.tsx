import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Avatar, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Tooltip } from "antd";
import { PlusOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { api, type Role, type User } from "../api";
import { useAuth } from "../auth";
import { PageHeader } from "../components";
import { fmtAgo, fmtTime, ROLE_LABELS } from "../format";

const ROLE_OPTIONS = [
  { value: "viewer", label: "只读：查看设备、卡密、打包记录" },
  { value: "operator", label: "操作员：下发指令、生成卡密、打包" },
  { value: "admin", label: "管理员：全部权限，含用户、密钥、日志" },
];

export default function UsersPage() {
  const { user: me } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reset, setReset] = useState<User | null>(null);
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ items: User[] }>("/api/users") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });
  const patch = useMutation({
    mutationFn: (v: { id: number; body: Record<string, unknown> }) => api.patch(`/api/users/${v.id}`, v.body),
    onSuccess: refresh,
    onError: (e) => message.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/users/${id}`),
    onSuccess: refresh,
    onError: (e) => message.error((e as Error).message),
  });

  return (
    <>
      <PageHeader
        title="用户"
        desc="管理员可管理一切；操作员能控制设备、发卡和打包；只读用户只能查看。"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            新建用户
          </Button>
        }
      />
      <Card className="table-card">
        <Table<User>
          rowKey="id"
          loading={users.isLoading}
          dataSource={users.data?.items}
          pagination={false}
          columns={[
            {
              title: "用户名",
              dataIndex: "username",
              render: (u: string, r) => (
                <Space size={10}>
                  <Avatar size={28} style={{ background: "var(--xs-primary-soft)", color: "var(--xs-primary)", fontWeight: 600 }}>
                    {u.slice(0, 1).toUpperCase()}
                  </Avatar>
                  <span style={{ fontWeight: 500 }}>{u}</span>
                  {r.id === me?.id && <Tag>我</Tag>}
                  {r.totp_enabled && (
                    <Tooltip title="已开启两步验证">
                      <SafetyCertificateOutlined style={{ color: "var(--ant-color-success)" }} aria-label="已开启两步验证" />
                    </Tooltip>
                  )}
                </Space>
              ),
            },
            {
              title: "角色",
              dataIndex: "role",
              width: 140,
              render: (role: Role, r) => (
                <Select
                  size="small"
                  value={role}
                  style={{ width: 110 }}
                  options={Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))}
                  onChange={(v) => patch.mutate({ id: r.id, body: { role: v } })}
                />
              ),
            },
            {
              title: "启用",
              dataIndex: "disabled",
              width: 80,
              render: (d: boolean, r) => (
                <Switch
                  size="small"
                  checked={!d}
                  disabled={r.id === me?.id}
                  onChange={(on) => patch.mutate({ id: r.id, body: { disabled: !on } })}
                />
              ),
            },
            { title: "最近登录", dataIndex: "last_login_at", render: fmtAgo },
            { title: "创建时间", dataIndex: "created_at", render: fmtTime },
            {
              title: "操作",
              key: "ops",
              width: 250,
              render: (_, r) => (
                <Space size={0}>
                  <Button type="link" size="small" onClick={() => setReset(r)}>
                    重置密码
                  </Button>
                  {r.totp_enabled && r.id !== me?.id && (
                    <Popconfirm
                      title={`重置 ${r.username} 的两步验证？`}
                      description="用于对方手机丢失。对方的登录会退出，下次只用密码登录后重新设置。"
                      onConfirm={() =>
                        patch.mutate(
                          { id: r.id, body: { reset_totp: true } },
                          { onSuccess: () => message.success("已重置两步验证") },
                        )
                      }
                    >
                      <Button type="link" size="small">
                        重置两步验证
                      </Button>
                    </Popconfirm>
                  )}
                  {r.id !== me?.id && (
                    <Popconfirm
                      title={`删除用户 ${r.username}？`}
                      onConfirm={() => remove.mutate(r.id)}
                      okButtonProps={{ danger: true }}
                    >
                      <Button type="link" size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <CreateUser open={open} onClose={() => setOpen(false)} onDone={refresh} />
      <ResetPassword user={reset} onClose={() => setReset(null)} />
    </>
  );
}

function CreateUser({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post("/api/users", v),
    onSuccess: () => {
      message.success("已创建");
      onDone();
      onClose();
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={open}
      title="新建用户"
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
        initialValues={{ role: "operator" }}
        autoComplete="off"
      >
        <Form.Item
          name="username"
          label="用户名"
          rules={[{ required: true }, { pattern: /^[\w.@-]{2,64}$/, message: "2–64 位字母、数字、_ . @ -" }]}
        >
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item name="password" label="初始密码" rules={[{ required: true }, { min: 8, message: "至少 8 位" }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="role" label="角色">
          <Select options={ROLE_OPTIONS} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function ResetPassword({ user, onClose }: { user: User | null; onClose: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: { password: string }) => api.patch(`/api/users/${user!.id}`, v),
    onSuccess: () => {
      message.success("已重置，该用户的登录会话已失效");
      onClose();
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={!!user}
      title={`重置 ${user?.username} 的密码`}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" preserve={false} onFinish={save.mutate}>
        <Form.Item name="password" label="新密码" rules={[{ required: true }, { min: 8, message: "至少 8 位" }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
