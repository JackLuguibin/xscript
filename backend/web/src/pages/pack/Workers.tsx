import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Form, Input, Modal, Popconfirm, Space, Table, Tooltip, Typography } from "antd";
import { CloudServerOutlined, PlusOutlined } from "@ant-design/icons";
import { api, type PackWorker } from "../../api";
import { Pill, useSecretModal } from "../../components";
import { fmtAgo, fmtTime } from "../../format";

/** The command an admin runs on the packaging machine (the token goes in the environment, never argv). */
export function workerCommand(server: string, token: string): string {
  return `export XSCRIPT_WORKER_TOKEN=${token}\npython -m xscript_server pack-worker --server ${server}`;
}

function status(w: PackWorker) {
  if (w.disabled) return <Pill tone="red">已停用</Pill>;
  if (!w.online) return <Pill>离线</Pill>;
  return w.job_id ? (
    <Pill tone="blue" pulse>
      构建中
    </Pill>
  ) : (
    <Pill tone="green">空闲</Pill>
  );
}

/** 打包机 (admins): add a machine (its token is shown once), see who is online and building, disable / delete. */
export function WorkersCard({ mode, publicUrl }: { mode?: "local" | "remote"; publicUrl?: string }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const showSecret = useSecretModal();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ name: string }>();
  const server = (publicUrl || window.location.origin).replace(/\/$/, "");
  const workers = useQuery({
    queryKey: ["pack-workers"],
    queryFn: () => api.get<{ items: PackWorker[]; mode: string }>("/api/pack/workers"),
    refetchInterval: 10000,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pack-workers"] });
    qc.invalidateQueries({ queryKey: ["pack-info"] });
  };
  const fail = (e: unknown) => message.error((e as Error).message);
  const create = useMutation({
    mutationFn: (v: { name: string }) => api.post<PackWorker>("/api/pack/workers", v),
    onSuccess: (w) => {
      setOpen(false);
      form.resetFields();
      refresh();
      showSecret(
        `打包机「${w.name}」已添加`,
        workerCommand(server, w.token ?? ""),
        <Typography.Text type="secondary">
          在打包机上执行（需要 JDK 和 Android SDK，或用 full 镜像，见
          docs/部署.md）。打包机只需要能访问这个地址，不用开端口。
        </Typography.Text>,
      );
    },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (w: PackWorker) => api.post(`/api/pack/workers/${w.id}/${w.disabled ? "enable" : "disable"}`),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/pack/workers/${id}`),
    onSuccess: refresh,
    onError: fail,
  });
  const items = workers.data?.items ?? [];
  const online = items.filter((w) => w.online).length;

  return (
    <Card
      title={
        <Space size={8}>
          <CloudServerOutlined />
          打包机
          {items.length > 0 && (
            <span className="muted" style={{ fontWeight: 400 }}>
              在线 {online} / {items.length}
            </span>
          )}
        </Space>
      }
      className="table-card"
      style={{ marginTop: 20 }}
      extra={
        <Button size="small" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          添加打包机
        </Button>
      }
    >
      {mode !== "remote" && (
        <Alert
          type="info"
          showIcon
          style={{ margin: 16 }}
          title="当前在这台服务器上打包"
          description="服务器设置 XSCRIPT_PACK_MODE=remote 并重启后，打包任务改由这里的打包机领取，后台只负责排队和保存 APK。"
        />
      )}
      <Table<PackWorker>
        rowKey="id"
        size="middle"
        loading={workers.isLoading}
        dataSource={items}
        pagination={false}
        locale={{ emptyText: "还没有打包机。点「添加打包机」，在另一台机器上用令牌启动 pack-worker。" }}
        columns={[
          {
            title: "名称",
            dataIndex: "name",
            ellipsis: true,
            render: (_, w) => (
              <div style={{ minWidth: 0 }}>
                <b style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                  {w.name}
                </b>
                <div className="mono muted" style={{ fontSize: 12 }}>
                  {w.hint}
                </div>
              </div>
            ),
          },
          {
            title: "状态",
            key: "status",
            width: 132,
            render: (_, w) => (
              <Space size={6}>
                {status(w)}
                {w.job_id ? <span className="mono muted">#{w.job_id}</span> : null}
              </Space>
            ),
          },
          {
            title: "签名",
            dataIndex: "release",
            width: 84,
            render: (r: boolean) => (r ? <Pill tone="violet">有证书</Pill> : <span className="muted">无</span>),
          },
          {
            title: "主机 / 最近联系",
            key: "host",
            ellipsis: true,
            render: (_, w) =>
              w.last_seen_at ? (
                <Tooltip title={`${w.host} · v${w.version} · ${w.last_ip} · ${fmtTime(w.last_seen_at)}`}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {w.host || "—"}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {fmtAgo(w.last_seen_at)} · {w.last_ip}
                    </div>
                  </div>
                </Tooltip>
              ) : (
                <span className="muted">还没连接过</span>
              ),
          },
          {
            title: "操作",
            key: "ops",
            width: 108,
            render: (_, w) => (
              <Space size={0}>
                {w.disabled ? (
                  <>
                    <Button type="link" size="small" onClick={() => toggle.mutate(w)}>
                      启用
                    </Button>
                    <Popconfirm title="删除这台打包机？" onConfirm={() => remove.mutate(w.id)}>
                      <Button type="link" size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </>
                ) : (
                  <Popconfirm
                    title={
                      w.job_id
                        ? "停用后令牌立即失效；正在打的任务会在 90 秒后转给其他打包机。"
                        : "停用后令牌立即失效，这台打包机不再领取任务。"
                    }
                    okButtonProps={{ danger: true }}
                    onConfirm={() => toggle.mutate(w)}
                  >
                    <Button type="link" size="small" danger>
                      停用
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={open}
        title="添加打包机"
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="添加"
        confirmLoading={create.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={create.mutate}>
          <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true }]}>
            <Input placeholder="例如 构建机 A" maxLength={64} autoFocus />
          </Form.Item>
        </Form>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          添加后会显示一次令牌和启动命令。打包机拿到的任务里有卡密公钥和云控设备密钥，只在可信的机器上运行。
        </Typography.Paragraph>
      </Modal>
    </Card>
  );
}
