import { useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Col, Form, Input, InputNumber, Modal, Popconfirm, QRCode, Row, Space, Table, Typography } from "antd";
import { DesktopOutlined, PlusOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { api, type ApiToken, type TotpSetup, type User } from "../api";
import { useAuth } from "../auth";
import { PageHeader, Pill, useSecretModal } from "../components";
import { fmtAgo, fmtTime, ROLE_LABELS } from "../format";

interface SessionRow {
  id: number;
  ip: string;
  agent: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
  current: boolean;
}

/** 登录设备: browser sessions of this account, with sign-out. */
function SessionsCard() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["sessions"], queryFn: () => api.get<{ items: SessionRow[] }>("/api/auth/sessions") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["sessions"] });
  const end = useMutation({ mutationFn: (id: number) => api.del(`/api/auth/sessions/${id}`), onSuccess: refresh });
  const others = useMutation({
    mutationFn: () => api.post<{ ended: number }>("/api/auth/sessions/logout-others"),
    onSuccess: (r) => {
      message.success(`已退出 ${r.ended} 个其他登录`);
      refresh();
    },
  });
  const items = q.data?.items ?? [];
  return (
    <Card
      title="登录设备"
      style={{ marginTop: 16 }}
      className="table-card"
      extra={
        items.length > 1 && (
          <Popconfirm title="退出除当前浏览器以外的所有登录？" onConfirm={() => others.mutate()}>
            <Button danger loading={others.isPending}>
              退出其他设备
            </Button>
          </Popconfirm>
        )
      }
    >
      <Table<SessionRow>
        rowKey="id"
        loading={q.isLoading}
        dataSource={items}
        pagination={false}
        columns={[
          {
            title: "浏览器",
            key: "agent",
            render: (_, r) => (
              <Space size={8}>
                <span className={"icon-badge " + (r.current ? "green" : "gray")} style={{ width: 28, height: 28, fontSize: 13 }}>
                  <DesktopOutlined />
                </span>
                <span style={{ fontWeight: 500 }}>{r.agent || "未知"}</span>
                {r.current && <Pill tone="green">当前</Pill>}
              </Space>
            ),
          },
          { title: "IP", dataIndex: "ip", render: (ip: string) => <span className="mono">{ip || "-"}</span> },
          { title: "登录时间", dataIndex: "created_at", render: fmtTime },
          { title: "最近活动", dataIndex: "last_used_at", render: fmtAgo },
          {
            title: "",
            key: "ops",
            width: 90,
            render: (_, r) =>
              !r.current && (
                <Popconfirm title="退出这个登录？" onConfirm={() => end.mutate(r.id)}>
                  <Button type="link" size="small" danger>
                    退出
                  </Button>
                </Popconfirm>
              ),
          },
        ]}
      />
    </Card>
  );
}

/** 两步验证 (TOTP): scan a QR code with an authenticator app, confirm with one code. */
export function TotpCard({ style }: { style?: CSSProperties }) {
  const { user, setUser } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [offOpen, setOffOpen] = useState(false);
  const [offForm] = Form.useForm();

  const start = useMutation({
    mutationFn: () => api.post<TotpSetup>("/api/auth/totp/setup"),
    onSuccess: (r) => (setSetup(r), setCode("")),
    onError: (e) => message.error((e as Error).message),
  });
  const enable = useMutation({
    mutationFn: (c: string) => api.post<User>("/api/auth/totp/enable", { code: c }),
    onSuccess: (u) => {
      setSetup(null);
      setUser(u);
      qc.invalidateQueries({ queryKey: ["sessions"] });
      message.success("两步验证已开启，其他浏览器上的登录已退出");
    },
    onError: (e) => (message.error((e as Error).message), setCode("")),
  });
  const disable = useMutation({
    mutationFn: (v: { password: string; code: string }) => api.post<User>("/api/auth/totp/disable", v),
    onSuccess: (u) => {
      setOffOpen(false);
      offForm.resetFields();
      setUser(u);
      message.success("两步验证已关闭");
    },
    onError: (e) => message.error((e as Error).message),
  });
  if (!user) return null;

  return (
    <Card
      title={
        <Space size={8}>
          <SafetyCertificateOutlined />
          两步验证
          {user.totp_enabled ? <Pill tone="green">已开启</Pill> : <Pill tone="gray">未开启</Pill>}
        </Space>
      }
      style={style}
      extra={
        user.totp_enabled ? (
          <Button danger onClick={() => setOffOpen(true)}>
            关闭
          </Button>
        ) : (
          !setup && (
            <Button type="primary" loading={start.isPending} onClick={() => start.mutate()}>
              开启
            </Button>
          )
        )
      }
    >
      {user.totp_enabled ? (
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          登录时除了密码，还要输入手机验证器 App 上的 6 位验证码。手机丢失时请管理员在「用户」页重置。
        </Typography.Paragraph>
      ) : setup ? (
        <Row gutter={24} align="middle">
          <Col flex="none">
            <QRCode value={setup.uri} size={168} bordered={false} style={{ background: "#fff" }} />
          </Col>
          <Col flex="auto" style={{ minWidth: 240 }}>
            <ol style={{ paddingLeft: 18, margin: "0 0 12px", lineHeight: 1.9 }}>
              <li>用 Google Authenticator、Microsoft Authenticator、1Password 或微信小程序「腾讯身份验证器」扫描左侧二维码</li>
              <li>
                扫不了可以手动输入密钥 <Typography.Text code copyable>{setup.secret}</Typography.Text>
              </li>
              <li>输入 App 上显示的 6 位验证码</li>
            </ol>
            <Space wrap>
              <Input.OTP
                length={6}
                value={code}
                aria-label="6 位验证码"
                formatter={(s) => s.replace(/\D/g, "")}
                onChange={(v) => {
                  setCode(v);
                  if (v.length === 6) enable.mutate(v);
                }}
              />
              <Button type="primary" loading={enable.isPending} disabled={code.length < 6} onClick={() => enable.mutate(code)}>
                确认开启
              </Button>
              <Button onClick={() => setSetup(null)}>取消</Button>
            </Space>
          </Col>
        </Row>
      ) : (
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          开启后，登录需要密码加手机验证码，密码泄露也登录不了。管理员账号建议开启。
        </Typography.Paragraph>
      )}
      <Modal
        open={offOpen}
        title="关闭两步验证"
        onCancel={() => setOffOpen(false)}
        onOk={() => offForm.submit()}
        okText="关闭"
        okButtonProps={{ danger: true }}
        confirmLoading={disable.isPending}
      >
        <Form form={offForm} layout="vertical" onFinish={disable.mutate}>
          <Form.Item name="password" label="登录密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item name="code" label="当前验证码" rules={[{ required: true, len: 6, message: "6 位数字" }]}>
            <Input.OTP length={6} formatter={(s) => s.replace(/\D/g, "")} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

/** Full-screen gate shown when the system requires admins to turn on 两步验证 first. */
export function TotpGate() {
  const { user, logout } = useAuth();
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 720 }}>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          请先开启两步验证
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          系统要求管理员账号必须开启两步验证。完成下面的设置后（{user?.username}）即可进入后台。
        </Typography.Paragraph>
        <TotpCard />
        <Button type="link" onClick={logout} style={{ marginTop: 12, paddingLeft: 0 }}>
          退出登录
        </Button>
      </div>
    </div>
  );
}

export default function AccountPage() {
  const { user } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const showSecret = useSecretModal();
  const [pwForm] = Form.useForm();
  const [tokenForm] = Form.useForm();
  const [open, setOpen] = useState(false);
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api.get<{ items: ApiToken[] }>("/api/auth/tokens") });

  const password = useMutation({
    mutationFn: (v: { old_password: string; new_password: string }) => api.post("/api/auth/password", v),
    onSuccess: () => {
      message.success("密码已修改，其他设备上的登录已退出");
      pwForm.resetFields();
    },
    onError: (e) => message.error((e as Error).message),
  });
  const create = useMutation({
    mutationFn: (v: { name: string; days: number }) => api.post<ApiToken>("/api/auth/tokens", v),
    onSuccess: (t) => {
      setOpen(false);
      tokenForm.resetFields();
      qc.invalidateQueries({ queryKey: ["tokens"] });
      showSecret(
        "API 令牌已创建",
        t.token!,
        <Typography.Text type="secondary">
          请求头 <span className="mono">Authorization: Bearer &lt;令牌&gt;</span>，权限与你的账号（{ROLE_LABELS[user!.role]}
          ）相同。
        </Typography.Text>,
      );
    },
    onError: (e) => message.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/auth/tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens"] }),
  });

  return (
    <>
      <PageHeader title="账号与令牌" desc="修改登录密码，或为脚本和 CI 创建 API 令牌。" />
      <Row gutter={16}>
        <Col xs={24} lg={10}>
          <Card title="修改密码">
            <Form form={pwForm} layout="vertical" onFinish={password.mutate}>
              <Form.Item name="old_password" label="原密码" rules={[{ required: true }]}>
                <Input.Password autoComplete="current-password" />
              </Form.Item>
              <Form.Item name="new_password" label="新密码" rules={[{ required: true }, { min: 8, message: "至少 8 位" }]}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Form.Item
                name="confirm"
                label="确认新密码"
                dependencies={["new_password"]}
                rules={[
                  { required: true },
                  ({ getFieldValue }) => ({
                    validator: (_, v) =>
                      v === getFieldValue("new_password") ? Promise.resolve() : Promise.reject(new Error("两次输入不一致")),
                  }),
                ]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={password.isPending}>
                修改密码
              </Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card
            title="API 令牌"
            extra={
              <Button icon={<PlusOutlined />} onClick={() => setOpen(true)}>
                新建令牌
              </Button>
            }
          >
            <Typography.Paragraph type="secondary">
              给脚本、CI 或其他系统调用 REST API 用（文档见 /api/docs）。
            </Typography.Paragraph>
            <Table<ApiToken>
              rowKey="id"
              size="small"
              loading={tokens.isLoading}
              dataSource={tokens.data?.items}
              pagination={false}
              columns={[
                { title: "名称", dataIndex: "name" },
                { title: "最近使用", dataIndex: "last_used_at", render: fmtAgo },
                { title: "过期", dataIndex: "expires_at", render: (e: number | null) => (e ? fmtTime(e) : "永不") },
                {
                  title: "",
                  key: "ops",
                  width: 70,
                  render: (_, t) => (
                    <Popconfirm title="删除后使用它的程序会立即失效" onConfirm={() => remove.mutate(t.id)}>
                      <Button type="link" size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
      <TotpCard style={{ marginTop: 16 }} />
      <SessionsCard />
      <Modal
        open={open}
        title="新建 API 令牌"
        onCancel={() => setOpen(false)}
        onOk={() => tokenForm.submit()}
        confirmLoading={create.isPending}
      >
        <Form form={tokenForm} layout="vertical" onFinish={create.mutate} initialValues={{ days: 90 }}>
          <Form.Item name="name" label="用途" rules={[{ required: true }]}>
            <Input maxLength={64} placeholder="例如 发卡脚本" />
          </Form.Item>
          <Form.Item name="days" label="有效天数" extra="0 = 永不过期">
            <InputNumber min={0} max={3650} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
