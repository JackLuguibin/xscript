import { useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import { CloudServerOutlined, LockOutlined, RocketOutlined, SafetyCertificateOutlined, UserOutlined } from "@ant-design/icons";
import { useAuth } from "../auth";
import { ThemeSwitch } from "../components";

const FEATURES = [
  { icon: <CloudServerOutlined />, title: "设备云控", text: "实时查看在线设备，批量下发脚本、截图与按键指令" },
  { icon: <SafetyCertificateOutlined />, title: "卡密授权", text: "ECDSA 签名授权，支持批次、延期、解绑与离线授权码" },
  { icon: <RocketOutlined />, title: "APK 打包", text: "上传工程一键打包，自动内嵌授权与云控配置" },
];

/** Second login step: 6-digit code, submits by itself once all digits are typed. */
function TotpStep({ loading, onSubmit, onBack }: { loading: boolean; onSubmit: (code: string) => void; onBack: () => void }) {
  const [code, setCode] = useState("");
  return (
    <div>
      <Input.OTP
        length={6}
        size="large"
        autoFocus
        value={code}
        aria-label="6 位验证码"
        formatter={(s) => s.replace(/\D/g, "")}
        onChange={(v) => {
          setCode(v);
          if (v.length === 6) onSubmit(v);
        }}
        style={{ width: "100%" }}
      />
      <Button
        type="primary"
        block
        size="large"
        loading={loading}
        disabled={code.length < 6}
        onClick={() => onSubmit(code)}
        style={{ marginTop: 24, height: 44 }}
      >
        验证并登录
      </Button>
      <Button type="link" block onClick={onBack} style={{ marginTop: 8 }}>
        返回重新输入账号
      </Button>
    </div>
  );
}

export default function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Set after the password is accepted for an account with 两步验证 on.
  const [pending, setPending] = useState<{ username: string; password: string } | null>(null);

  const onFinish = async (v: { username: string; password: string }) => {
    setLoading(true);
    setError("");
    try {
      const username = v.username.trim();
      if ((await login(username, v.password)) === "totp") setPending({ username, password: v.password });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const onCode = async (code: string) => {
    if (!pending || code.length < 6) return;
    setLoading(true);
    setError("");
    try {
      await login(pending.username, pending.password, code);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login">
      <aside className="login-art" aria-hidden>
        <div className="logo">
          <img src="/favicon.svg" alt="" />
          XScript
        </div>
        <div>
          <h1>
            一个后台，
            <br />
            管好你的全部设备
          </h1>
          <p className="lead">云控、卡密授权与 APK 打包集中在一处，权限分级、操作留痕。</p>
          <div className="login-features">
            {FEATURES.map((f) => (
              <div key={f.title}>
                {f.icon}
                <p style={{ margin: 0 }}>
                  <b>{f.title}</b>
                  <span>{f.text}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
        <footer>© XScript · 自托管部署</footer>
      </aside>

      <main className="login-panel">
        <div className="theme-switch">
          <ThemeSwitch />
        </div>
        <div className="login-form">
          <img className="mobile-logo" src="/favicon.svg" alt="" />
          <h2>{pending ? "两步验证" : "欢迎回来"}</h2>
          <p className="sub">
            {pending ? `打开手机上的验证器 App，输入 ${pending.username} 的 6 位验证码` : "登录 XScript 管理后台"}
          </p>
          {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 20 }} />}
          {pending ? (
            <TotpStep loading={loading} onSubmit={onCode} onBack={() => (setPending(null), setError(""))} />
          ) : (
          <Form layout="vertical" onFinish={onFinish} requiredMark={false} autoComplete="on" size="large">
            <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
              <Input prefix={<UserOutlined className="muted" />} autoComplete="username" autoFocus placeholder="请输入用户名" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password prefix={<LockOutlined className="muted" />} autoComplete="current-password" placeholder="请输入密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading} style={{ marginTop: 8, height: 44 }}>
              登录
            </Button>
          </Form>
          )}
          <p className="muted" style={{ fontSize: 12.5, marginTop: 24 }}>
            {pending ? (
              <>
                手机丢了？请管理员在「用户」页重置两步验证，或在服务器上运行{" "}
                <span className="mono">python -m xscript_server reset-password &lt;用户名&gt; --totp-only</span>
              </>
            ) : (
              <>
                忘记密码？在服务器上运行 <span className="mono">python -m xscript_server reset-password &lt;用户名&gt;</span>
              </>
            )}
          </p>
        </div>
      </main>
    </div>
  );
}
