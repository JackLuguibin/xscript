import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Col, Empty, Progress, Row, Skeleton, Tooltip } from "antd";
import {
  ArrowRightOutlined,
  BugOutlined,
  BuildOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  ClockCircleOutlined,
  KeyOutlined,
  LoginOutlined,
  LogoutOutlined,
  MobileOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { api, type Overview } from "../api";
import { useAuth } from "../auth";
import { CARD_STATUS, toneColor, type Tone } from "../components";
import { fmtAgo, fmtTime } from "../format";

function StatTile({
  label,
  icon,
  tone,
  value,
  total,
  foot,
  onClick,
  loading,
}: {
  label: string;
  icon: ReactNode;
  tone: Tone;
  value: number;
  total?: number;
  foot?: ReactNode;
  onClick?: () => void;
  loading?: boolean;
}) {
  return (
    <Card className={"stat-tile" + (onClick ? " clickable" : "")} hoverable={!!onClick} onClick={onClick}>
      <div className="top">
        <span className="label">{label}</span>
        <span className={"icon-badge " + tone}>{icon}</span>
      </div>
      {loading ? (
        <Skeleton active paragraph={{ rows: 1 }} title={false} />
      ) : (
        <>
          <div className="value">
            {value.toLocaleString()}
            {total !== undefined && <small>/ {total.toLocaleString()}</small>}
          </div>
          {foot && <div className="foot">{foot}</div>}
        </>
      )}
    </Card>
  );
}

/** 需要关注: crashes in the last 24 h, backup problems, low 卡密 stock. Calm when nothing is wrong. */
function AttentionCard({ data, loading }: { data?: Overview; loading: boolean }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  if (loading || !data) {
    return (
      <Card title="需要关注">
        <Skeleton active paragraph={{ rows: 2 }} />
      </Card>
    );
  }
  const items: { tone: Tone; icon: ReactNode; title: ReactNode; sub?: ReactNode; to?: string }[] = [];
  for (const c of data.crashes) {
    items.push({
      tone: "red",
      icon: <BugOutlined />,
      title: (
        <>
          {c.model || c.device} 上的 <b>{c.project}</b> 异常退出
        </>
      ),
      sub: (c.error || "退出码 " + c.exit) + " · " + fmtAgo(c.time),
      to: "/devices?q=" + encodeURIComponent(c.device),
    });
  }
  const b = data.last_backup;
  if (can("admin")) {
    if (b && !b.ok) {
      items.push({ tone: "red", icon: <CloudDownloadOutlined />, title: "自动备份失败", sub: b.error, to: "/settings" });
    } else if (!b) {
      items.push({
        tone: "amber",
        icon: <CloudDownloadOutlined />,
        title: "服务启动以来还没有备份",
        sub: "自动备份每天执行一次，也可以在系统设置里立即备份",
        to: "/settings",
      });
    }
  }
  if (data.cards.total > 0 && data.cards.unused < 20) {
    items.push({
      tone: "amber",
      icon: <SafetyCertificateOutlined />,
      title: `未使用的卡密只剩 ${data.cards.unused} 张`,
      sub: "到卡密管理生成新的一批",
      to: "/cards",
    });
  }
  return (
    <Card
      title="需要关注"
      extra={data.alerts_24h > 0 && <span className="muted">24 小时内告警 {data.alerts_24h} 条</span>}
    >
      {items.length === 0 ? (
        <div className="all-good">
          <span className="icon-badge green">
            <CheckCircleOutlined />
          </span>
          <div>
            <b>一切正常</b>
            <span className="muted">最近 24 小时没有脚本崩溃{b?.ok ? `，上次备份 ${fmtAgo(b.time)}` : ""}</span>
          </div>
        </div>
      ) : (
        <ul className="attention">
          {items.slice(0, 6).map((it, i) => (
            <li key={i}>
              <button type="button" onClick={() => it.to && navigate(it.to)}>
                <span className={"icon-badge " + it.tone}>{it.icon}</span>
                <span className="body">
                  <span className="title">{it.title}</span>
                  {it.sub && <span className="sub">{it.sub}</span>}
                </span>
                <ArrowRightOutlined className="muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function eventStyle(text: string): [Tone, ReactNode] {
  if (text.includes("上线")) return ["green", <LoginOutlined key="i" />];
  if (text.includes("离线")) return ["gray", <LogoutOutlined key="i" />];
  return ["blue", <SendOutlined key="i" />];
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<Overview>("/api/overview"),
    refetchInterval: 5000,
  });
  const d = data?.devices;
  const c = data?.cards;
  const onlinePct = d?.total ? Math.round((100 * d.online) / d.total) : 0;
  const busyPct = d?.online ? Math.round((100 * d.running) / d.online) : 0;
  const cardTotal = c?.total ?? 0;
  const hour = new Date().getHours();
  const greet = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";

  return (
    <>
      <div className="hero">
        <div>
          <h2>
            {greet}，{user?.username}
          </h2>
          <p>这里是设备、授权与打包的实时概况，每 5 秒自动刷新。</p>
        </div>
        <span className="live-dot">实时 · {new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" })}</span>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <StatTile
            label="在线设备"
            icon={<MobileOutlined />}
            tone="green"
            value={d?.online ?? 0}
            total={d?.total ?? 0}
            loading={isLoading}
            onClick={() => navigate("/devices?online=1")}
            foot={
              <>
                <Progress percent={onlinePct} size={[80, 6]} showInfo={false} strokeColor="var(--xs-green)" />
                在线率 {onlinePct}% · 24h 活跃 {d?.active_24h ?? 0}
              </>
            }
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatTile
            label="正在运行"
            icon={<PlayCircleOutlined />}
            tone="blue"
            value={d?.running ?? 0}
            loading={isLoading}
            foot={
              <>
                <Progress percent={busyPct} size={[80, 6]} showInfo={false} />
                占在线设备 {busyPct}%
              </>
            }
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatTile
            label="已激活卡密"
            icon={<SafetyCertificateOutlined />}
            tone="violet"
            value={c?.active ?? 0}
            total={cardTotal}
            loading={isLoading}
            onClick={() => navigate("/cards")}
            foot={<>未使用 {c?.unused ?? 0} 张可发放</>}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatTile
            label="定时任务 / 打包队列"
            icon={<ClockCircleOutlined />}
            tone="amber"
            value={data?.tasks.enabled ?? 0}
            total={data?.tasks.total ?? 0}
            loading={isLoading}
            onClick={() => navigate("/tasks")}
            foot={
              <>
                <BuildOutlined /> 打包中 {data?.pack.running ?? 0} · 排队 {data?.pack.queued ?? 0}
              </>
            }
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={15}>
          <Card
            title="最近动态"
            style={{ height: "100%" }}
            extra={
              can("admin") && (
                <Button type="link" size="small" onClick={() => navigate("/audit")}>
                  操作日志 <ArrowRightOutlined />
                </Button>
              )
            }
          >
            {isLoading ? (
              <Skeleton active />
            ) : data?.events.length ? (
              <ul className="feed">
                {data.events.slice(0, 10).map((e, i) => {
                  const [tone, icon] = eventStyle(e.text);
                  return (
                    <li key={i}>
                      <span className={"dot icon-badge " + tone}>{icon}</span>
                      <span className="body">{e.text}</span>
                      <Tooltip title={fmtTime(e.time)}>
                        <time dateTime={new Date(e.time * 1000).toISOString()}>{fmtAgo(e.time)}</time>
                      </Tooltip>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="服务启动后还没有设备动态" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <AttentionCard data={data} loading={isLoading} />
            </Col>
            <Col span={24}>
              <Card title="卡密分布">
                {isLoading ? (
                  <Skeleton active paragraph={{ rows: 2 }} />
                ) : (
                  <>
                    <div className="dist-bar" role="img" aria-label="卡密状态分布">
                      {cardTotal > 0 &&
                        (Object.keys(CARD_STATUS) as (keyof typeof CARD_STATUS)[]).map((k) =>
                          c?.[k] ? (
                            <Tooltip key={k} title={`${CARD_STATUS[k][1]} ${c[k]}`}>
                              <span style={{ flexGrow: c[k], background: toneColor(CARD_STATUS[k][0]) }} />
                            </Tooltip>
                          ) : null,
                        )}
                    </div>
                    <div className="dist-legend">
                      {(Object.keys(CARD_STATUS) as (keyof typeof CARD_STATUS)[]).map((k) => (
                        <div key={k}>
                          <i style={{ background: toneColor(CARD_STATUS[k][0]) }} />
                          {CARD_STATUS[k][1]}
                          <b>{c?.[k] ?? 0}</b>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </Card>
            </Col>
            {can("operator") && (
              <Col span={24}>
                <Card title="快捷操作">
                  <div className="quick">
                    <button type="button" onClick={() => navigate("/devices")}>
                      <span className="icon-badge green">
                        <SendOutlined />
                      </span>
                      批量下发
                    </button>
                    <button type="button" onClick={() => navigate("/cards")}>
                      <span className="icon-badge violet">
                        <PlusOutlined />
                      </span>
                      生成卡密
                    </button>
                    <button type="button" onClick={() => navigate("/pack")}>
                      <span className="icon-badge amber">
                        <BuildOutlined />
                      </span>
                      打包 APK
                    </button>
                    {can("admin") ? (
                      <button type="button" onClick={() => navigate("/device-keys")}>
                        <span className="icon-badge blue">
                          <KeyOutlined />
                        </span>
                        设备密钥
                      </button>
                    ) : (
                      <button type="button" onClick={() => navigate("/tasks")}>
                        <span className="icon-badge blue">
                          <ClockCircleOutlined />
                        </span>
                        定时任务
                      </button>
                    )}
                  </div>
                </Card>
              </Col>
            )}
          </Row>
        </Col>
      </Row>
    </>
  );
}
