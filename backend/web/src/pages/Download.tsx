import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button, QRCode, Result, Skeleton } from "antd";
import { AndroidOutlined, DownloadOutlined } from "@ant-design/icons";
import { api, type PublicShare } from "../api";
import { fmtSize, fmtTime } from "../format";

/** Public 分发 page: /d/<token>. No login; shows the app and a download button + QR code. */
export default function DownloadPage() {
  const { token = "" } = useParams();
  const [data, setData] = useState<PublicShare | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get<PublicShare>(`/pub/d/${encodeURIComponent(token)}`)
      .then((d) => {
        setData(d);
        document.title = `${d.app_name} · 下载`;
      })
      .catch((e) => setError((e as Error).message));
  }, [token]);

  const isPhone = /Android|iPhone|iPad/i.test(navigator.userAgent);

  return (
    <div className="dl-page">
      <div className="dl-card">
        {error ? (
          <Result status="404" title="链接不存在或已失效" subTitle="请向发给你链接的人索取新的下载地址" />
        ) : !data ? (
          <Skeleton active avatar paragraph={{ rows: 3 }} />
        ) : (
          <>
            <div className="dl-icon">
              <AndroidOutlined />
            </div>
            <h1>{data.app_name}</h1>
            <p className="muted mono">{data.app_id}</p>
            <div className="dl-meta">
              <span>版本 {data.version}</span>
              <span>{fmtSize(data.size)}</span>
              {data.built_at && <span>{fmtTime(data.built_at)}</span>}
            </div>
            <Button type="primary" size="large" block icon={<DownloadOutlined />} href={data.apk} style={{ height: 48 }}>
              下载安装包
            </Button>
            <p className="muted dl-hint">
              下载后点击安装。首次安装需要允许「安装未知来源应用」。
              {data.expires_at ? ` 链接 ${fmtTime(data.expires_at)} 失效。` : ""}
            </p>
            {!isPhone && (
              <div className="dl-qr">
                <QRCode value={window.location.href} size={160} bordered={false} />
                <span className="muted">用手机扫码下载</span>
              </div>
            )}
          </>
        )}
      </div>
      <footer className="muted">{data?.site_name || "XScript"}</footer>
    </div>
  );
}
