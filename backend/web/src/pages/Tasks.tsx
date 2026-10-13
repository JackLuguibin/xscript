import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  TimePicker,
  Tooltip,
  Typography,
} from "antd";
import { PlayCircleOutlined, PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api, type Script, type Task } from "../api";
import { useAuth } from "../auth";
import { PageHeader, Pill, TargetSelect } from "../components";
import { COMMAND_LABELS, describeTarget, fmtAgo, fmtTime } from "../format";

function describeCommand(c: Task["command"], scripts: Script[] = []): string {
  if (c.path === "script_deploy") {
    const sc = scripts.find((x) => x.id === Number(c.script_id));
    return `下发小程序 ${sc?.name ?? "#" + String(c.script_id)}${c.run === false ? "" : "并启动"}`;
  }
  const label = COMMAND_LABELS[c.path] ?? c.path;
  return c.path === "app_run" ? `${label} ${String(c.id ?? "")}` : label;
}

export default function TasksPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api.get<{ items: Task[] }>("/api/tasks"),
    refetchInterval: 10000,
  });
  const scripts = useQuery({ queryKey: ["scripts"], queryFn: () => api.get<{ items: Script[] }>("/api/scripts") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["tasks"] });
  const toggle = useMutation({
    mutationFn: (t: Task) => api.patch(`/api/tasks/${t.id}`, { enabled: !t.enabled }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/api/tasks/${id}`), onSuccess: refresh });
  const run = useMutation({
    mutationFn: (id: number) => api.post<NonNullable<Task["last_result"]>>(`/api/tasks/${id}/run`),
    onSuccess: (r) => {
      message.success(r.error ? "执行出错：" + r.error : `已执行：${r.ok}/${r.devices} 台成功`);
      refresh();
    },
  });

  return (
    <>
      <PageHeader
        title="定时任务"
        desc="服务端定时任务按时向一批设备下发指令，需要后台在线。设备本地的定时任务（离线也能跑）在手机 App 或 VS Code 插件里设置。"
        extra={
          can("operator") && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
              新建任务
            </Button>
          )
        }
      />
      <Card className="table-card">
        <Table<Task>
          rowKey="id"
          loading={tasks.isLoading}
          dataSource={tasks.data?.items}
          pagination={false}
          scroll={{ x: 900 }}
          columns={[
            { title: "名称", dataIndex: "name", render: (n: string, t) => n || `任务 #${t.id}` },
            { title: "目标", dataIndex: "target", render: describeTarget },
            { title: "指令", dataIndex: "command", render: (c: Task["command"]) => describeCommand(c, scripts.data?.items) },
            { title: "时间", key: "when", render: (_, t) => (t.daily ? `每天 ${t.daily}` : `每 ${t.every} 分钟`) },
            {
              title: "下次执行",
              dataIndex: "next_run",
              render: (n: number | null) => (n ? fmtTime(n) : <Typography.Text type="secondary">已暂停</Typography.Text>),
            },
            {
              title: "上次结果",
              dataIndex: "last_result",
              render: (r: Task["last_result"]) =>
                !r ? (
                  <Typography.Text type="secondary">-</Typography.Text>
                ) : r.error ? (
                  <Tooltip title={r.error}>
                    <span>
                      <Pill tone="red">出错</Pill>
                    </span>
                  </Tooltip>
                ) : (
                  <Tooltip title={fmtTime(r.time)}>
                    <span>
                      <Pill tone={r.ok === r.devices ? "green" : "amber"}>
                        {r.ok}/{r.devices} 成功 · {fmtAgo(r.time)}
                      </Pill>
                    </span>
                  </Tooltip>
                ),
            },
            {
              title: "启用",
              dataIndex: "enabled",
              width: 80,
              render: (_: boolean, t) => (
                <Switch size="small" checked={t.enabled} disabled={!can("operator")} onChange={() => toggle.mutate(t)} />
              ),
            },
            {
              title: "操作",
              key: "ops",
              width: 140,
              render: (_, t) =>
                can("operator") && (
                  <Space size={0}>
                    <Button
                      type="link"
                      size="small"
                      icon={<PlayCircleOutlined />}
                      loading={run.isPending && run.variables === t.id}
                      onClick={() => run.mutate(t.id)}
                    >
                      立即执行
                    </Button>
                    <Popconfirm title="删除这个任务？" onConfirm={() => remove.mutate(t.id)}>
                      <Button type="link" size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
            },
          ]}
        />
      </Card>
      <TaskModal open={open} onClose={() => setOpen(false)} onSaved={refresh} />
    </>
  );
}

function TaskModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const scripts = useQuery({
    queryKey: ["scripts"],
    queryFn: () => api.get<{ items: Script[] }>("/api/scripts"),
    enabled: open && can("admin"),
  });
  const [form] = Form.useForm();
  const mode = Form.useWatch("mode", form);
  const path = Form.useWatch("path", form);
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post("/api/tasks", v),
    onSuccess: () => {
      message.success("已创建");
      onSaved();
      onClose();
    },
    onError: (e) => message.error((e as Error).message),
  });

  const submit = (v: Record<string, any>) => {
    const command: Record<string, unknown> = { path: v.path };
    if (v.path === "app_run") {
      command.id = v.id;
      if (v.param?.trim()) command.param = JSON.parse(v.param);
    }
    if (v.path === "message") command.data = v.data;
    if (v.path === "script_deploy") {
      command.script_id = v.script_id;
      command.run = v.run !== false;
      if (v.param?.trim()) command.param = JSON.parse(v.param);
    }
    save.mutate({
      name: v.name ?? "",
      target: v.target,
      command,
      daily: v.mode === "daily" ? (v.time as dayjs.Dayjs).format("HH:mm") : undefined,
      every: v.mode === "every" ? v.every : undefined,
    });
  };

  return (
    <Modal
      open={open}
      title="新建定时任务"
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
      width={560}
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        onFinish={submit}
        initialValues={{ target: "all", path: "app_run", mode: "daily", time: dayjs("08:30", "HH:mm"), every: 60 }}
      >
        <Form.Item name="name" label="名称">
          <Input maxLength={64} placeholder="例如 早上启动" />
        </Form.Item>
        <Form.Item name="target" label="目标" rules={[{ required: true }]}>
          <TargetSelect style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="path" label="指令">
          <Select
            options={[
              ...["app_run", "app_stop", "message"].map((p) => ({ value: p, label: COMMAND_LABELS[p] })),
              ...(can("admin") ? [{ value: "script_deploy", label: "下发小程序（安装发布版本）" }] : []),
            ]}
          />
        </Form.Item>
        {path === "script_deploy" && (
          <>
            <Form.Item
              name="script_id"
              label="小程序"
              rules={[{ required: true, message: "选择小程序" }]}
              extra="每次执行时安装这个小程序当前发布的版本，然后启动。适合定时把设备统一到最新版本"
            >
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="选择小程序"
                options={(scripts.data?.items ?? []).map((x) => ({
                  value: x.id,
                  label: `${x.name}（${x.current ? "v" + x.current.version : "未发布"}）`,
                }))}
              />
            </Form.Item>
            <Form.Item name="run" valuePropName="checked" initialValue>
              <Checkbox>安装后立即启动</Checkbox>
            </Form.Item>
          </>
        )}
        {path === "app_run" && (
          <Form.Item name="id" label="小程序（工程名）" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        )}
        {(path === "app_run" || path === "script_deploy") && (
          <>
            <Form.Item
              name="param"
              label="启动参数（JSON，可选）"
              rules={[
                {
                  validator: (_, v) => {
                    if (!v?.trim()) return Promise.resolve();
                    try {
                      JSON.parse(v);
                      return Promise.resolve();
                    } catch {
                      return Promise.reject(new Error("不是合法的 JSON"));
                    }
                  },
                },
              ]}
            >
              <Input.TextArea rows={2} className="mono" />
            </Form.Item>
          </>
        )}
        {path === "message" && (
          <Form.Item name="data" label="消息内容" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        )}
        <Form.Item name="mode" label="执行时间">
          <Radio.Group
            options={[
              { value: "daily", label: "每天定时" },
              { value: "every", label: "固定间隔" },
            ]}
          />
        </Form.Item>
        {mode === "daily" ? (
          <Form.Item name="time" rules={[{ required: true }]}>
            <TimePicker format="HH:mm" minuteStep={5} />
          </Form.Item>
        ) : (
          <Form.Item name="every" rules={[{ required: true }]}>
            <InputNumber min={1} max={43200} addonAfter="分钟" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
