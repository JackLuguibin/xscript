import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Alert, App, Checkbox, Form, Input, Modal, Table, Typography } from "antd";
import { api, type CommandReply, type Script, type ScriptVersion } from "../../api";
import { Pill, TargetSelect } from "../../components";

/** Install a 小程序 version on online devices over 云控 and optionally start it (admin). */
export function DeployModal({
  script,
  version,
  onClose,
}: {
  script: Script;
  version: ScriptVersion | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [result, setResult] = useState<{ results: Record<string, CommandReply>; devices: number; ok: number } | null>(
    null,
  );
  const deploy = useMutation({
    mutationFn: (v: { target: string; run: boolean; params?: string }) =>
      api.post<{ results: Record<string, CommandReply>; devices: number; ok: number }>(
        `/api/scripts/${script.id}/deploy`,
        {
          target: v.target,
          version_id: version!.id,
          run: v.run,
          params: v.params?.trim() ? JSON.parse(v.params) : {},
        },
      ),
    onSuccess: (r) => {
      if (!r.devices) message.warning("目标里没有在线设备");
      setResult(r);
    },
    onError: (e) => message.error((e as Error).message),
  });
  const close = () => {
    setResult(null);
    onClose();
  };
  return (
    <Modal
      open={!!version}
      title={version && `下发 ${script.name} v${version.version} 到设备`}
      onCancel={close}
      okText={result ? "完成" : "下发"}
      confirmLoading={deploy.isPending}
      onOk={() => (result ? close() : form.submit())}
      width={620}
      destroyOnHidden
    >
      {!result ? (
        <Form
          form={form}
          layout="vertical"
          initialValues={{ target: "all", run: true, params: "" }}
          onFinish={deploy.mutate}
          preserve={false}
        >
          <Typography.Paragraph type="secondary">
            通过云控连接把工程安装到设备的 <span className="mono">{script.project_name}</span>
            ，会覆盖设备上的同名工程。{script.protect && "已开启代码保护，只发送字节码。"}
          </Typography.Paragraph>
          <Form.Item name="target" label="目标设备" rules={[{ required: true }]}>
            <TargetSelect style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="run" valuePropName="checked">
            <Checkbox>安装后立即启动</Checkbox>
          </Form.Item>
          <Form.Item
            name="params"
            label="启动参数（JSON，可选）"
            rules={[
              {
                validator: (_, v) => {
                  if (!v?.trim()) return Promise.resolve();
                  try {
                    const x = JSON.parse(v);
                    return typeof x === "object" && x && !Array.isArray(x)
                      ? Promise.resolve()
                      : Promise.reject(new Error("需要 JSON 对象"));
                  } catch {
                    return Promise.reject(new Error("不是合法的 JSON"));
                  }
                },
              },
            ]}
          >
            <Input.TextArea rows={2} className="mono" placeholder='{"level": 3}' />
          </Form.Item>
        </Form>
      ) : (
        <>
          <Alert
            type={result.ok === result.devices ? "success" : "warning"}
            showIcon
            style={{ marginBottom: 12 }}
            title={`${result.ok}/${result.devices} 台设备成功`}
          />
          <Table<[string, CommandReply]>
            size="small"
            rowKey={(r) => r[0]}
            dataSource={Object.entries(result.results)}
            pagination={Object.keys(result.results).length > 10 ? { pageSize: 10 } : false}
            columns={[
              { title: "设备", render: (_, r) => <span className="mono">{r[0]}</span> },
              {
                title: "结果",
                width: 80,
                render: (_, r) => (r[1].code === 1 ? <Pill tone="green">成功</Pill> : <Pill tone="red">失败</Pill>),
              },
              { title: "信息", render: (_, r) => r[1].msg ?? "" },
            ]}
          />
        </>
      )}
    </Modal>
  );
}
