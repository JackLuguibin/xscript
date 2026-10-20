import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  CheckCircleFilled,
  CopyOutlined,
  ExclamationCircleFilled,
  RobotOutlined,
  SaveOutlined,
  SendOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { api, type AiResult, type AiStatus, type Script, type ScriptVersion } from "../api";
import { useAuth } from "../auth";
import { PageHeader } from "../components";
import { DeployModal } from "./scripts/DeployModal";

const EXAMPLES = [
  "打开微信，进入「发现 → 朋友圈」，向下滑动 10 次，每次停 2 秒",
  "每隔 5 秒截图找红色的「领取」按钮，找到就点，最多循环 100 次",
  "启动 com.example.game，等出现「开始游戏」后点击，然后每 3 秒点一次屏幕中间",
];

type Mode = "new" | "revise";

/**
 * 后台 AI 写脚本: describe a task, the configured model writes the 小程序 entry (__init__.py), the server checks
 * the syntax (never runs it); the code can be edited, saved as a 小程序 version and deployed to devices to test.
 */
export default function AiWriterPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();

  const status = useQuery({ queryKey: ["ai-status"], queryFn: () => api.get<AiStatus>("/api/ai/status") });
  const scripts = useQuery({ queryKey: ["scripts"], queryFn: () => api.get<{ items: Script[] }>("/api/scripts") });

  const [mode, setMode] = useState<Mode>(params.get("script") ? "revise" : "new");
  const [scriptId, setScriptId] = useState<number | undefined>(Number(params.get("script")) || undefined);
  const [versionId, setVersionId] = useState<number | undefined>(Number(params.get("version")) || undefined);
  const [prompt, setPrompt] = useState("");
  const [code, setCode] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [result, setResult] = useState<AiResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ script: Script; version: ScriptVersion } | null>(null);
  const [deploying, setDeploying] = useState<ScriptVersion | null>(null);
  const loadedFor = useRef("");

  const versions = useQuery({
    queryKey: ["script-versions", scriptId],
    queryFn: () => api.get<{ items: ScriptVersion[] }>(`/api/scripts/${scriptId}/versions`),
    enabled: !!scriptId,
  });

  // Pick the published (else newest) version once a 小程序 is chosen. A set id is kept even before the list
  // refreshes (a version just saved here is not in the cached list yet).
  useEffect(() => {
    const items = versions.data?.items;
    if (!items?.length || versionId) return;
    setVersionId((items.find((v) => v.current) ?? items[0]).id);
  }, [versions.data, versionId]);

  const source = useQuery({
    queryKey: ["ai-source", scriptId, versionId],
    queryFn: () => api.get<{ code: string; version: string }>(`/api/ai/source/${scriptId}/${versionId}`),
    enabled: mode === "revise" && !!scriptId && !!versionId,
  });

  useEffect(() => {
    const key = `${scriptId}/${versionId}`;
    if (source.data && loadedFor.current !== key) {
      loadedFor.current = key;
      setCode(source.data.code);
      setHistory([]);
      setResult(null);
    }
  }, [source.data, scriptId, versionId]);

  const ready = !!status.data?.configured;
  const generate = useMutation({
    mutationFn: () =>
      api.post<AiResult>("/api/ai/script", { prompt: prompt.trim(), code: mode === "revise" ? code : "" }),
    onSuccess: (r) => {
      if (code.trim()) setHistory((h) => [...h.slice(-9), code]);
      setCode(r.code);
      setResult(r);
      setSaved(null);
      setMode("revise"); // follow-up requests refine this code
      setPrompt("");
    },
    onError: (e) => message.error((e as Error).message),
  });

  const syntax = useMemo(() => (result && result.code === code ? result.syntax_error : null), [result, code]);
  const script = scripts.data?.items.find((s) => s.id === scriptId);

  const run = () => {
    if (!prompt.trim()) return message.warning("先描述要做什么");
    if (mode === "revise" && !code.trim()) return message.warning("右侧还没有代码可以修改");
    generate.mutate();
  };

  const onEditorKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault(); // indent with four spaces instead of leaving the editor
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b } = el;
    setCode(code.slice(0, a) + "    " + code.slice(b));
    requestAnimationFrame(() => el.setSelectionRange(a + 4, a + 4));
  };

  return (
    <>
      <PageHeader
        title="AI 写脚本"
        desc="描述要自动化的操作，模型参照 XScript API 写出小程序入口 __init__.py。检查、修改后保存为小程序版本，再下发到设备测试。"
        extra={
          status.data && (
            <span className="ai-model" aria-label="当前模型">
              <RobotOutlined />
              {ready ? (
                <>
                  <b>{status.data.model}</b>
                  <small>{status.data.source === "settings" ? "系统设置" : "环境变量"}</small>
                </>
              ) : (
                <span>未配置模型</span>
              )}
            </span>
          )
        }
      />
      {status.data && !ready && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="还没有配置模型"
          description={
            <>
              任何 OpenAI 兼容接口都可以。在服务器上设置 <span className="mono">XSCRIPT_AI_BASE_URL</span>、
              <span className="mono">XSCRIPT_AI_MODEL</span> 和 <span className="mono">XSCRIPT_AI_KEY</span>
              （与设备脚本的 ai.config 相同），或由管理员在系统设置里填写接口地址和模型；密钥只放在服务器环境变量里。
            </>
          }
          action={
            can("admin") && (
              <Button size="small" onClick={() => navigate("/settings?tab=ai")}>
                去设置
              </Button>
            )
          }
        />
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={9}>
          <Card title="需求" className="ai-panel">
            <Segmented<Mode>
              block
              value={mode}
              onChange={setMode}
              options={[
                { label: "写新脚本", value: "new" },
                { label: "修改代码", value: "revise" },
              ]}
            />
            {mode === "revise" && (
              <div className="ai-source">
                <Typography.Text type="secondary">从小程序版本载入（可选，也可以直接修改右侧代码）</Typography.Text>
                <Space.Compact block>
                  <Select
                    placeholder="小程序"
                    allowClear
                    style={{ width: "60%" }}
                    value={scriptId}
                    loading={scripts.isLoading}
                    onChange={(v) => {
                      setScriptId(v);
                      setVersionId(undefined);
                    }}
                    options={scripts.data?.items.map((s) => ({ value: s.id, label: s.name }))}
                    showSearch={{ optionFilterProp: "label" }}
                  />
                  <Select
                    placeholder="版本"
                    style={{ width: "40%" }}
                    disabled={!scriptId}
                    value={versionId}
                    loading={versions.isLoading}
                    onChange={setVersionId}
                    options={versions.data?.items.map((v) => ({
                      value: v.id,
                      label: `v${v.version}${v.current ? "（已发布）" : ""}`,
                    }))}
                  />
                </Space.Compact>
                {source.isError && <Alert type="error" showIcon title={(source.error as Error).message} />}
              </div>
            )}
            <Input.TextArea
              className="ai-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
              }}
              maxLength={4000}
              showCount
              autoSize={{ minRows: 6, maxRows: 14 }}
              placeholder={
                mode === "new"
                  ? "例如：打开某个 App，找到「签到」按钮点击，失败就重试 3 次"
                  : "要怎么改？例如：每次点击后随机等待 1~3 秒，并把次数打印到日志"
              }
              aria-label="需求描述"
            />
            {mode === "new" && !prompt && (
              <div className="ai-examples">
                {EXAMPLES.map((x) => (
                  <Tag key={x} onClick={() => setPrompt(x)}>
                    {x}
                  </Tag>
                ))}
              </div>
            )}
            <Button
              type="primary"
              block
              size="large"
              icon={<RobotOutlined />}
              loading={generate.isPending}
              disabled={!ready || !can("operator")}
              onClick={run}
            >
              {generate.isPending ? "模型生成中…" : mode === "new" ? "生成脚本" : "按要求修改"}
            </Button>
            <Typography.Paragraph type="secondary" className="hint">
              ⌘/Ctrl + Enter 生成。生成内容只做语法检查，服务器不会运行；请检查选择器、坐标和包名后再下发到设备。
              {!can("operator") && " 只读账号不能生成。"}
            </Typography.Paragraph>
          </Card>
        </Col>
        <Col xs={24} xl={15}>
          <Card
            className="ai-panel"
            title={
              <Space size={8}>
                <span>__init__.py</span>
                {syntax === "" && (
                  <Tag color="success" icon={<CheckCircleFilled />}>
                    语法正确
                  </Tag>
                )}
                {syntax && (
                  <Tag color="error" icon={<ExclamationCircleFilled />}>
                    语法错误 · {syntax}
                  </Tag>
                )}
              </Space>
            }
            extra={
              <Space size={4}>
                {result && (
                  <span className="cell-sub">
                    {result.model} · {(result.ms / 1000).toFixed(1)} 秒
                    {result.usage.total_tokens ? ` · ${result.usage.total_tokens.toLocaleString()} tokens` : ""}
                  </span>
                )}
                <Tooltip title="撤销到上一次生成前">
                  <Button
                    type="text"
                    icon={<UndoOutlined />}
                    aria-label="撤销"
                    disabled={!history.length}
                    onClick={() => {
                      setCode(history[history.length - 1]);
                      setHistory((h) => h.slice(0, -1));
                    }}
                  />
                </Tooltip>
                <Tooltip title="复制代码">
                  <Button
                    type="text"
                    icon={<CopyOutlined />}
                    aria-label="复制代码"
                    disabled={!code}
                    onClick={() => navigator.clipboard.writeText(code).then(() => message.success("已复制"))}
                  />
                </Tooltip>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  disabled={!code.trim() || !!syntax || !can("operator")}
                  onClick={() => setSaving(true)}
                >
                  保存为版本
                </Button>
              </Space>
            }
          >
            {saved && (
              <Alert
                type="success"
                showIcon
                className="ai-saved"
                title={`已保存为 ${saved.script.name} v${saved.version.version}`}
                action={
                  <Space>
                    {can("admin") ? (
                      <Button
                        size="small"
                        type="primary"
                        icon={<SendOutlined />}
                        onClick={() => setDeploying(saved.version)}
                      >
                        下发到设备测试
                      </Button>
                    ) : (
                      <Typography.Text type="secondary">下发到设备需要管理员</Typography.Text>
                    )}
                    <Button size="small" onClick={() => navigate("/scripts")}>
                      查看小程序
                    </Button>
                  </Space>
                }
              />
            )}
            {code || generate.isPending ? (
              <Input.TextArea
                className="mono ai-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={onEditorKey}
                spellCheck={false}
                autoSize={{ minRows: 18, maxRows: 40 }}
                aria-label="代码"
                disabled={generate.isPending}
              />
            ) : (
              <Empty
                className="ai-empty"
                image={<RobotOutlined />}
                description={
                  mode === "new" ? "在左侧描述任务，生成的脚本会显示在这里" : "载入一个版本或粘贴代码，再描述要怎么改"
                }
              >
                {mode === "revise" && <Button onClick={() => setCode("# 在这里粘贴代码\n")}>手动输入代码</Button>}
              </Empty>
            )}
            {result?.notes && result.code === code && (
              <Alert type="info" showIcon className="ai-notes" title="模型说明" description={result.notes} />
            )}
          </Card>
        </Col>
      </Row>
      <SaveModal
        open={saving}
        code={code}
        scripts={scripts.data?.items ?? []}
        defaultScript={scriptId}
        defaultBase={mode === "revise" && scriptId ? versionId : undefined}
        onClose={() => setSaving(false)}
        onSaved={(s, v) => {
          setSaving(false);
          setSaved({ script: s, version: v });
          setScriptId(s.id);
          loadedFor.current = `${s.id}/${v.id}`; // already showing this code
          setVersionId(v.id);
          qc.invalidateQueries({ queryKey: ["scripts"] });
          qc.invalidateQueries({ queryKey: ["script-versions", s.id] });
        }}
      />
      {saved && script && <DeployModal script={script} version={deploying} onClose={() => setDeploying(null)} />}
    </>
  );
}

function SaveModal({
  open,
  code,
  scripts,
  defaultScript,
  defaultBase,
  onClose,
  onSaved,
}: {
  open: boolean;
  code: string;
  scripts: Script[];
  defaultScript?: number;
  defaultBase?: number;
  onClose: () => void;
  onSaved: (s: Script, v: ScriptVersion) => void;
}) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const sid: number | undefined = Form.useWatch("script_id", form);
  const versions = useQuery({
    queryKey: ["script-versions", sid],
    queryFn: () => api.get<{ items: ScriptVersion[] }>(`/api/scripts/${sid}/versions`),
    enabled: open && !!sid,
  });
  const save = useMutation({
    mutationFn: (v: {
      script_id: number;
      base_version_id?: number;
      version?: string;
      notes?: string;
      publish?: boolean;
    }) =>
      api.post<ScriptVersion>("/api/ai/save", {
        ...v,
        code,
        version: v.version?.trim() ?? "",
        notes: v.notes?.trim() ?? "",
      }),
    onSuccess: (v, body) => {
      message.success(`已保存 v${v.version}`);
      onSaved(
        scripts.find((s) => s.id === body.script_id)!,
        v,
      );
    },
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Modal
      open={open}
      title="保存为小程序版本"
      okText="保存"
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      {scripts.length === 0 ? (
        <Alert type="info" showIcon title="还没有小程序。先在「小程序」页新建一个，再回来保存。" />
      ) : (
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{
            // With a single 小程序 there is nothing to choose.
            script_id: defaultScript ?? (scripts.length === 1 ? scripts[0].id : undefined),
            base_version_id: defaultBase,
            publish: false,
          }}
          onFinish={save.mutate}
        >
          <Form.Item name="script_id" label="小程序" rules={[{ required: true, message: "选择小程序" }]}>
            <Select
              options={scripts.map((s) => ({ value: s.id, label: `${s.name}（${s.project_name}）` }))}
              showSearch={{ optionFilterProp: "label" }}
              onChange={() => form.setFieldValue("base_version_id", undefined)}
            />
          </Form.Item>
          <Form.Item
            name="base_version_id"
            label="保留其他文件"
            extra="选一个版本时，保留它的资源、requirements.txt 等其他文件，只替换 __init__.py；不选则只有这一个文件。"
          >
            <Select
              allowClear
              placeholder="只保存 __init__.py"
              disabled={!sid}
              loading={versions.isLoading}
              options={versions.data?.items.map((v) => ({ value: v.id, label: `v${v.version}` }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="version"
                label="版本号"
                rules={[{ pattern: /^[0-9A-Za-z.\-_+]{0,32}$/, message: "只能包含字母、数字和 . - _ +" }]}
              >
                <Input placeholder="留空自动递增" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="publish"
                label="同时发布"
                valuePropName="checked"
                extra={can("admin") ? "开启热更新的 App 会切换到这个版本" : "发布需要管理员"}
              >
                <Switch disabled={!can("admin")} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="notes" label="更新说明">
            <Input.TextArea rows={2} maxLength={4000} placeholder="AI 写脚本生成" />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}
