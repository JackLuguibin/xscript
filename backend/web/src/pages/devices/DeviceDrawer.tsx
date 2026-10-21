import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Card, Descriptions, Drawer, Space, Tabs } from "antd";
import { api, type Device, type Settings } from "../../api";
import { useAuth } from "../../auth";
import { CopyText, Pill } from "../../components";
import { fmtTime } from "../../format";
import { RemoteControl } from "../../remote";
import { DeviceLogs } from "../../logs";
import { DeviceRuns } from "./DeviceRuns";

export function DeviceDrawer({
  id,
  onClose,
  onCommand,
}: {
  id: string | null;
  onClose: () => void;
  onCommand: (target: string, cmd: Record<string, unknown>) => void;
}) {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ["device", id],
    queryFn: () => api.get<Device>(`/api/devices/${encodeURIComponent(id!)}`),
    enabled: !!id,
    refetchInterval: 5000,
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/api/settings"),
    staleTime: 60_000,
  });
  const [tab, setTab] = useState("info");
  useEffect(() => setTab("info"), [id]);
  const d = q.data;
  const status = (d?.status ?? {}) as Record<string, unknown>;
  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      size={600}
      title={d ? [d.brand, d.model].filter(Boolean).join(" ") || d.id : "设备"}
      destroyOnHidden
    >
      {d && (
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: "info",
              label: "概况",
              children: (
                <Space orientation="vertical" size="large" style={{ width: "100%" }}>
                  <Descriptions
            column={1}
            size="small"
            bordered
            items={[
              { label: "设备 ID", children: <CopyText text={d.id} /> },
              {
                label: "状态",
                children: d.online ? (
                  d.running ? (
                    <Pill tone="green" pulse>
                      运行 {d.project}
                    </Pill>
                  ) : (
                    <Pill tone="blue">在线 · 空闲</Pill>
                  )
                ) : (
                  <Pill>离线</Pill>
                ),
              },
              { label: "应用", children: d.app || "-" },
              { label: "分组", children: d.group || "-" },
              { label: "备注", children: d.note || "-" },
              {
                label: "系统",
                children: status.release ? `Android ${String(status.release)}（SDK ${String(status.sdk)}）` : "-",
              },
              { label: "XScript", children: d.version ? "v" + d.version : "-" },
              { label: "自动化通道", children: String(status.channel ?? "-") },
              { label: "IP", children: d.remote || "-" },
              { label: "首次连接", children: fmtTime(d.first_seen) },
              { label: "最近活动", children: fmtTime(d.last_seen) },
            ]}
          />
          {Object.keys(d.data ?? {}).length > 0 && (
            <Card size="small" title="脚本数据（cloud.send）">
              <pre className="mono code-block">{JSON.stringify(d.data, null, 2)}</pre>
            </Card>
          )}
                </Space>
              ),
            },
            ...(can("operator")
              ? [
                  {
                    key: "remote",
                    label: "远程操控",
                    disabled: !d.online,
                    children: (
                      <RemoteControl
                        id={d.id}
                        width={d.width || Number(status.width) || undefined}
                        height={d.height || Number(status.height) || undefined}
                        running={d.running}
                        onStop={() => onCommand(d.id, { path: "app_stop" })}
                      />
                    ),
                  },
                  {
                    key: "logs",
                    label: d.last_run?.crashed ? (
                      <Badge dot offset={[6, 0]}>
                        运行日志
                      </Badge>
                    ) : (
                      "运行日志"
                    ),
                    children: tab === "logs" && (
                      <DeviceLogs
                        id={d.id}
                        online={d.online}
                        lastRun={d.last_run}
                        historyDays={settings.data?.device_log_days}
                      />
                    ),
                  },
                  {
                    key: "runs",
                    label: "最近运行",
                    children: tab === "runs" && (
                      <DeviceRuns id={d.id} online={d.online} defaultProject={d.project || d.last_run?.project} />
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
    </Drawer>
  );
}
