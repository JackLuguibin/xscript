import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Col, Descriptions, Row, Skeleton, Tag } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api, type ResellerMe } from "../../api";
import { PageHeader, toneColor } from "../../components";
import { fmtDays } from "../../format";
import TrendCard, { CARD_TREND_SERIES } from "../overview/TrendCard";
import { KIND_LABELS, QuotaBar } from "../resellers/ResellerModals";

/** 代理 home: quota, own card counts, what may be issued, and the daily sales trend. */
export default function ResellerHome() {
  const navigate = useNavigate();
  const me = useQuery({
    queryKey: ["reseller-me"],
    queryFn: () => api.get<ResellerMe>("/api/reseller/me"),
  });
  const d = me.data;
  const stats: [string, number | undefined, string][] = [
    ["已生成", d?.cards.total, toneColor("blue")],
    ["未使用", d?.cards.unused, toneColor("gray")],
    ["已激活", d?.cards.active, toneColor("green")],
    ["已过期", d?.cards.expired, toneColor("amber")],
  ];
  return (
    <>
      <PageHeader
        title={d ? `你好，${d.username}` : "我的概览"}
        desc="你的额度、发出的卡密和每天的销量。数据只包含你自己生成的卡。"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={!d || d.left === 0}
            onClick={() => navigate("/cards")}
          >
            去生成卡密
          </Button>
        }
      />
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={10}>
          <Card title="额度" className="quota-card">
            {!d ? (
              <Skeleton active paragraph={{ rows: 2 }} />
            ) : (
              <>
                <div className="quota-big">
                  <b>{d.left.toLocaleString()}</b>
                  <span>张可生成</span>
                </div>
                <QuotaBar used={d.used} quota={d.quota} />
                {d.left === 0 && (
                  <p className="muted" style={{ marginTop: 8 }}>
                    额度已用完，请联系管理员充值。
                  </p>
                )}
              </>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Row gutter={[12, 12]}>
            {stats.map(([label, value, color]) => (
              <Col key={label} xs={12} md={6}>
                <Card className="mini-stat static">
                  <div className="label">
                    <i style={{ background: color }} />
                    {label}
                  </div>
                  <div className="value">{(value ?? 0).toLocaleString()}</div>
                </Card>
              </Col>
            ))}
            <Col span={24}>
              <Card size="small" title="发卡范围">
                {d ? (
                  <Descriptions size="small" column={{ xs: 1, md: 2 }}>
                    <Descriptions.Item label="卡类型">
                      {d.kinds.map((k) => (
                        <Tag key={k}>{KIND_LABELS[k]}</Tag>
                      ))}
                    </Descriptions.Item>
                    <Descriptions.Item label="最长有效期">
                      {d.max_days ? fmtDays(d.max_days) : "不限"}
                    </Descriptions.Item>
                    <Descriptions.Item label="应用">
                      {d.apps.includes("*") ? "全部应用" : <span className="mono">{d.apps.join("、")}</span>}
                    </Descriptions.Item>
                    <Descriptions.Item label="每卡设备">最多 {d.max_devices} 台</Descriptions.Item>
                  </Descriptions>
                ) : (
                  <Skeleton active paragraph={{ rows: 1 }} />
                )}
              </Card>
            </Col>
          </Row>
        </Col>
      </Row>
      <TrendCard
        title="我的销量"
        url={(days) => `/api/reseller/stats/daily?days=${days}`}
        cacheKey="reseller-trend"
        defs={CARD_TREND_SERIES}
        defaultHidden={[]}
        emptyText="所选时间段内还没有生成或激活卡密"
      />
    </>
  );
}
