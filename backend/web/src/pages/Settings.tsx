import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Alert, App, Button, Card, Descriptions, Form, Input, Space, Switch, Tabs, Tag, Typography } from "antd";
import { api, type Settings } from "../api";
import { useAuth } from "../auth";
import { CopyText, PageHeader } from "../components";
import { AlertSettings, MaintenanceSettings } from "../ops";

/** 安全: require 两步验证 for every admin account. */
function SecuritySettings({ settings }: { settings?: Settings }) {
  const { user } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const save = useMutation({
    mutationFn: (on: boolean) => api.put<Settings>("/api/settings", { require_totp_admin: on }),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s);
      message.success(s.require_totp_admin ? "已要求管理员开启两步验证" : "已取消要求");
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Card title="登录安全" style={{ maxWidth: 880 }} loading={!settings}>
      <Space align="start" size={16}>
        <Switch
          checked={!!settings?.require_totp_admin}
          loading={save.isPending}
          disabled={!user?.totp_enabled && !settings?.require_totp_admin}
          onChange={(on) => save.mutate(on)}
          aria-label="要求管理员开启两步验证"
        />
        <div>
          <Typography.Text strong>要求管理员开启两步验证</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0" }}>
            开启后，没有开两步验证的管理员登录后只能先完成设置，才能进入后台。API 令牌不受影响。
          </Typography.Paragraph>
        </div>
      </Space>
      {!user?.totp_enabled && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 16 }}
          title="你自己还没有开启两步验证，先开启才能打开这个开关。"
          action={
            <Button size="small" onClick={() => navigate("/account")}>
              去开启
            </Button>
          }
        />
      )}
    </Card>
  );
}

export default function SettingsPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });
  useEffect(() => {
    if (q.data) form.setFieldsValue(q.data);
  }, [q.data, form]);
  const save = useMutation({
    mutationFn: (v: Partial<Settings>) => api.put<Settings>("/api/settings", { site_name: v.site_name, public_url: v.public_url }),
    onSuccess: (s) => {
      message.success("已保存");
      qc.setQueryData(["settings"], s);
      qc.invalidateQueries({ queryKey: ["pack-info"] });
    },
    onError: (e) => message.error((e as Error).message),
  });
  const s = q.data;
  const pub = s?.public_url || window.location.origin;

  const basic = (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 880 }}>
      <Card title="基本设置" loading={q.isLoading}>
        <Form form={form} layout="vertical" onFinish={save.mutate} disabled={!can("admin")}>
          <Form.Item name="site_name" label="站点名称">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item
            name="public_url"
            label="服务器公网地址"
            extra="打包出来的 App 用它激活卡密、连接云控、检查热更新，例如 https://cloud.example.com。App 发布后不要再改，否则旧 App 连不上。"
            rules={[{ pattern: /^(|https?:\/\/[^\s/?#]+(:\d+)?(\/[^\s?#]*)?)$/, message: "以 http:// 或 https:// 开头" }]}
          >
            <Input placeholder="https://cloud.example.com" />
          </Form.Item>
          {can("admin") && (
            <Button type="primary" htmlType="submit" loading={save.isPending}>
              保存
            </Button>
          )}
        </Form>
      </Card>

      <Card title="接入信息">
        <Descriptions
          column={1}
          bordered
          size="small"
          styles={{ label: { width: 180 } }}
          items={[
            {
              label: "设备云控地址",
              children: <CopyText text={pub.replace(/^http/, "ws").replace(/\/$/, "") + "/ws?token=<设备密钥>"} />,
            },
            { label: "卡密激活接口", children: <CopyText text={pub.replace(/\/$/, "") + "/license/activate"} /> },
            {
              label: "REST API 文档",
              children: (
                <a href="/api/docs" target="_blank" rel="noreferrer">
                  /api/docs
                </a>
              ),
            },
            {
              label: "正式签名证书",
              children: s?.release_signing ? <Tag color="green">已配置</Tag> : <Tag>未配置（XSCRIPT_KEYSTORE）</Tag>,
            },
            { label: "版本", children: s?.version },
          ]}
        />
      </Card>

      <Card title="卡密签名公钥">
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="每个开启卡密或热更新的 App 都内嵌这把公钥。对应的私钥在数据目录 keys/private.pem，务必备份（「备份与存储」里的备份包含它）；丢失或更换后，已发布的 App 都无法再激活和更新。"
        />
        {s && <Input.TextArea value={s.license_public_key} readOnly autoSize className="mono" />}
        {s && (
          <div style={{ marginTop: 8 }}>
            <CopyText text={s.license_public_key} mono={false}>
              复制公钥
            </CopyText>
          </div>
        )}
      </Card>
    </Space>
  );

  return (
    <>
      <PageHeader title="系统设置" desc="站点信息、接入地址、告警通知、备份与存储清理。" />
      <Tabs
        items={[
          { key: "basic", label: "基本", children: basic },
          ...(can("admin")
            ? [
                {
                  key: "alerts",
                  label: "告警通知",
                  children: (
                    <div style={{ maxWidth: 980 }}>
                      <AlertSettings settings={s} editable />
                    </div>
                  ),
                },
                { key: "security", label: "安全", children: <SecuritySettings settings={s} /> },
                {
                  key: "storage",
                  label: "备份与存储",
                  children: (
                    <div style={{ maxWidth: 980 }}>
                      <MaintenanceSettings settings={s} />
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />
    </>
  );
}
