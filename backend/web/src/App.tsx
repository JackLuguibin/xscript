import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Avatar, Button, Drawer, Dropdown, Grid, Layout, Menu, Result, Skeleton, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  ApiOutlined,
  AppstoreOutlined,
  NotificationOutlined,
  AuditOutlined,
  BorderInnerOutlined,
  BuildOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  KeyOutlined,
  LockOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  MobileOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { api, type Role, type Settings } from "./api";
import { useAuth } from "./auth";
import { ThemeSwitch } from "./components";
import { ROLE_LABELS } from "./format";
import LoginPage from "./pages/Login";

// Pages load on demand so the first screen only downloads what it needs.
const OverviewPage = lazy(() => import("./pages/Overview"));
const DevicesPage = lazy(() => import("./pages/Devices"));
const DeviceKeysPage = lazy(() => import("./pages/DeviceKeys"));
const TasksPage = lazy(() => import("./pages/Tasks"));
const CardsPage = lazy(() => import("./pages/Cards"));
const AppOpsPage = lazy(() => import("./pages/AppOps"));
const PackPage = lazy(() => import("./pages/Pack"));
const ScriptsPage = lazy(() => import("./pages/Scripts"));
const DownloadPage = lazy(() => import("./pages/Download"));
const WallPage = lazy(() => import("./pages/Wall"));
const UsersPage = lazy(() => import("./pages/Users"));
const AuditPage = lazy(() => import("./pages/Audit"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const AccountPage = lazy(() => import("./pages/Account"));
const TotpGate = lazy(() => import("./pages/Account").then((m) => ({ default: m.TotpGate })));

const { Sider, Content } = Layout;

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  role: Role;
  group: string;
}

const NAV: NavItem[] = [
  { path: "/", label: "概览", icon: <DashboardOutlined />, role: "viewer", group: "" },
  { path: "/devices", label: "设备管理", icon: <MobileOutlined />, role: "viewer", group: "云控" },
  { path: "/wall", label: "屏幕墙", icon: <BorderInnerOutlined />, role: "operator", group: "云控" },
  { path: "/tasks", label: "定时任务", icon: <ClockCircleOutlined />, role: "viewer", group: "云控" },
  { path: "/device-keys", label: "设备密钥", icon: <KeyOutlined />, role: "admin", group: "云控" },
  { path: "/cards", label: "卡密管理", icon: <SafetyCertificateOutlined />, role: "viewer", group: "授权" },
  { path: "/app-ops", label: "应用运营", icon: <NotificationOutlined />, role: "viewer", group: "发布" },
  { path: "/scripts", label: "小程序", icon: <AppstoreOutlined />, role: "viewer", group: "发布" },
  { path: "/pack", label: "APK 打包", icon: <BuildOutlined />, role: "viewer", group: "发布" },
  { path: "/users", label: "用户", icon: <TeamOutlined />, role: "admin", group: "系统" },
  { path: "/audit", label: "操作日志", icon: <AuditOutlined />, role: "admin", group: "系统" },
  { path: "/settings", label: "系统设置", icon: <SettingOutlined />, role: "viewer", group: "系统" },
];

function Guard({ role, children }: { role: Role; children: React.ReactNode }) {
  const { can } = useAuth();
  return can(role) ? <>{children}</> : <Result status="403" title="没有权限" subTitle="请联系管理员分配角色" />;
}

/** A page that throws shows a recoverable error instead of a blank screen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A new deploy renames chunks; reloading picks up the new ones.
    const stale = /dynamically imported module|Loading chunk|Failed to fetch/i.test(error.message);
    return (
      <Result
        status={stale ? "info" : "error"}
        title={stale ? "后台已更新" : "页面出错了"}
        subTitle={stale ? "刷新页面加载新版本" : error.message}
        extra={
          <Button type="primary" onClick={() => (stale ? location.reload() : this.setState({ error: null }))}>
            {stale ? "刷新" : "重试"}
          </Button>
        }
      />
    );
  }
}

function PageFallback() {
  return (
    <div style={{ paddingTop: 8 }}>
      <Skeleton active title={{ width: 180 }} paragraph={{ rows: 1, width: 420 }} />
      <Skeleton active paragraph={{ rows: 6 }} style={{ marginTop: 24 }} />
    </div>
  );
}

export default function App() {
  const { user, logout, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  // Below md the menu is a drawer instead of a fixed side bar.
  const mobile = screens.md === false;
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [location.pathname]);
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/api/settings"),
    enabled: !!user,
    staleTime: 60_000,
  });

  const narrow = collapsed && !mobile;
  const menuItems = useMemo<MenuProps["items"]>(() => {
    const groups = new Map<string, NavItem[]>();
    for (const n of NAV.filter((n) => can(n.role))) {
      groups.set(n.group, [...(groups.get(n.group) ?? []), n]);
    }
    const out: NonNullable<MenuProps["items"]> = [];
    for (const [group, items] of groups) {
      const entries = items.map((n) => ({ key: n.path, icon: n.icon, label: n.label }));
      if (group) out.push({ type: "group", key: "g-" + group, label: narrow ? "" : group, children: entries });
      else out.push(...entries);
    }
    return out;
  }, [can, narrow]);

  // Public download pages work with or without a session.
  if (location.pathname.startsWith("/d/")) {
    return (
      <Suspense fallback={null}>
        <Routes>
          <Route path="/d/:token" element={<DownloadPage />} />
        </Routes>
      </Suspense>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  if (user.needs_totp_setup) {
    return (
      <Suspense fallback={<PageFallback />}>
        <TotpGate />
      </Suspense>
    );
  }

  const current = NAV.filter((n) => n.path !== "/" && location.pathname.startsWith(n.path))[0];
  const selected = current?.path ?? "/";
  const crumbLabel = location.pathname === "/account" ? "账号与令牌" : (current?.label ?? "概览");
  const crumbGroup = location.pathname === "/account" ? "个人" : current?.group;

  const brand = (
    <div className="brand">
      <img src="/favicon.svg" alt="" />
      {!narrow && (
        <div className="brand-name">
          <strong>{settings.data?.site_name || "XScript"}</strong>
          <span>云控 · 授权 · 打包</span>
        </div>
      )}
    </div>
  );
  const menu = <Menu mode="inline" selectedKeys={[selected]} items={menuItems} onClick={(e) => navigate(e.key)} />;

  return (
    <Layout style={{ minHeight: "100vh" }}>
      {mobile ? (
        <Drawer
          open={drawer}
          onClose={() => setDrawer(false)}
          placement="left"
          size={260}
          closable={false}
          className="nav-drawer"
          styles={{ body: { padding: 0, display: "flex", flexDirection: "column" } }}
        >
          {brand}
          {menu}
        </Drawer>
      ) : (
        <Sider
          className="shell-sider"
          collapsible
          collapsed={collapsed}
          trigger={null}
          width={232}
          collapsedWidth={72}
          breakpoint="lg"
          onBreakpoint={setCollapsed}
        >
          {brand}
          {menu}
          <div className="sider-foot">
            <Button
              type="text"
              aria-label={collapsed ? "展开菜单" : "收起菜单"}
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
            >
              {!collapsed && "收起菜单"}
            </Button>
          </div>
        </Sider>
      )}
      <Layout style={{ minWidth: 0 }}>
        <header className="shell-header">
          <div className="crumbs">
            {mobile && (
              <Button type="text" aria-label="打开菜单" icon={<MenuOutlined />} onClick={() => setDrawer(true)} />
            )}
            {crumbGroup && !mobile && (
              <>
                <span>{crumbGroup}</span>
                <span aria-hidden>/</span>
              </>
            )}
            <b>{crumbLabel}</b>
          </div>
          <div className="header-actions">
            {!mobile && (
              <Tooltip title="API 文档">
                <Button type="text" aria-label="API 文档" icon={<ApiOutlined />} href="/api/docs" target="_blank" />
              </Tooltip>
            )}
            <ThemeSwitch />
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "account", icon: <LockOutlined />, label: "账号与令牌" },
                  { type: "divider" },
                  { key: "logout", icon: <LogoutOutlined />, label: "退出登录", danger: true },
                ],
                onClick: ({ key }) => (key === "logout" ? logout() : navigate("/account")),
              }}
            >
              <div className="user-chip" role="button" tabIndex={0} aria-label="账号菜单">
                <Avatar size={30} style={{ background: "linear-gradient(135deg,#6d7cff,#4338ca)", fontWeight: 600 }}>
                  {user.username.slice(0, 1).toUpperCase()}
                </Avatar>
                <div className="meta">
                  <strong>{user.username}</strong>
                  <span>{ROLE_LABELS[user.role]}</span>
                </div>
              </div>
            </Dropdown>
          </div>
        </header>
        <Content className="shell-content" key={location.pathname}>
          <ErrorBoundary key={location.pathname}>
            <Suspense fallback={<PageFallback />}>
              <Routes>
                <Route path="/" element={<OverviewPage />} />
                <Route path="/devices" element={<DevicesPage />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/scripts" element={<ScriptsPage />} />
                <Route
                  path="/wall"
                  element={
                    <Guard role="operator">
                      <WallPage />
                    </Guard>
                  }
                />
                <Route
                  path="/device-keys"
                  element={
                    <Guard role="admin">
                      <DeviceKeysPage />
                    </Guard>
                  }
                />
                <Route path="/cards" element={<CardsPage />} />
                <Route path="/app-ops" element={<AppOpsPage />} />
                <Route path="/pack" element={<PackPage />} />
                <Route
                  path="/users"
                  element={
                    <Guard role="admin">
                      <UsersPage />
                    </Guard>
                  }
                />
                <Route
                  path="/audit"
                  element={
                    <Guard role="admin">
                      <AuditPage />
                    </Guard>
                  }
                />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route path="/login" element={<Navigate to="/" replace />} />
                <Route path="*" element={<Result status="404" title="页面不存在" />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </Content>
      </Layout>
    </Layout>
  );
}
