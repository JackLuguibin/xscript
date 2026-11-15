import { useEffect, useRef, useState } from "react";
import { useServices } from "../app-context";
import type { AdminOperation, AdminSchema } from "../api";
import { getLanguage } from "../strings";
import { errorLine } from "../errors";
import { useConfirm } from "./ConfirmDialog";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { StatCard } from "./ui/stat-card";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";

const LABELS: Record<string, string> = {
  online: "在线", running: "运行中", active_24h: "24 小时活跃", unused: "未使用", active: "使用中", expired: "已过期", exhausted: "已用尽", queued: "排队中", published: "已发布", events: "最近事件", crashes: "异常退出", alerts_24h: "24 小时告警", last_backup: "最近备份",
  overview: "概览", devices: "设备管理", groups: "设备分组", apps: "应用", command: "设备命令",
  "device-keys": "设备密钥", tasks: "定时任务", cards: "卡密管理", resellers: "代理管理", reseller: "代理业务",
  "app-notices": "运营公告", "app-updates": "应用更新", scripts: "小程序", ai: "AI 写脚本", pack: "APK 打包",
  users: "用户管理", audit: "审计日志", settings: "系统设置", maintenance: "系统维护", alerts: "告警", auth: "账号与安全",
  username: "用户名", password: "密码", role: "角色", name: "名称", description: "描述", enabled: "启用", disabled: "禁用",
  page: "页码", page_size: "每页条数", q: "关键词", id: "编号", device: "设备", group: "分组", app: "应用包名",
  reason: "原因", count: "数量", days: "天数", batch: "批次", kind: "类型", note: "备注", title: "标题", body: "内容",
  version: "版本", notes: "说明", project_name: "工程名", protect: "代码保护", file: "文件", project: "工程",
  cron: "Cron 表达式", action: "动作", params: "参数", target: "目标", code: "验证码", old_password: "原密码", new_password: "新密码",
  value: "值", token: "令牌", items: "记录", total: "总数", ok: "成功", created_at: "创建时间", expires_at: "到期时间",
  batches: "批次", stats_daily: "每日统计", stats: "统计", bans: "封禁", abuse: "异常使用", export: "导出",
  actions: "批量操作", extend: "延期", offline: "离线授权", "public-key": "授权公钥", versions: "版本", publish: "发布", unpublish: "撤回发布",
  deploy: "部署", source: "源代码", jobs: "任务", workers: "打包机", log: "日志", apk: "APK", shares: "分享", cancel: "取消",
  quota: "配额", prices: "价格", ledger: "结算记录", statement: "账单", balances: "余额", backup: "备份", cleanup: "清理",
  recent: "最近记录", test: "测试", me: "当前账号", tokens: "API 令牌", sessions: "会话", "logout-others": "退出其他会话",
  setup: "设置", enable: "启用", disable: "禁用", revoke: "撤销", totp: "两步验证", status: "状态", save: "保存", script: "生成脚本",
};
function label(name: string, en: boolean) { return en ? name.replaceAll("_", " ") : LABELS[name] ?? name.replaceAll("_", " "); }
function actionLabel(operation: AdminOperation, en: boolean) {
  const verb = ({ GET: en ? "View" : "查询", POST: en ? "Create / Run" : "创建 / 执行", PUT: en ? "Save" : "保存", PATCH: en ? "Edit" : "修改", DELETE: en ? "Delete" : "删除" })[operation.method];
  return `${verb} · ${operation.path.split("/").slice(3).map((part) => label(part.replace(/[{}]/g, ""), en)).join(" / ") || label(operation.group, en)}`;
}
function defaults(operation: AdminOperation) {
  const result: Record<string, unknown> = {};
  for (const parameter of operation.parameters) if (parameter.schema.default !== undefined) result[`query:${parameter.name}`] = parameter.schema.default;
  for (const [name, schema] of Object.entries(operation.body.properties ?? {})) if (schema.default !== undefined && schema.default !== null) result[`body:${name}`] = typeof schema.default === "object" ? JSON.stringify(schema.default) : schema.default;
  return result;
}
function ResultValue({ value, en }: { value: unknown; en: boolean }) {
  if (value == null) return <span className="muted">—</span>;
  if (typeof value !== "object") return <span className="break-all">{typeof value === "boolean" ? (value ? (en ? "Yes" : "是") : (en ? "No" : "否")) : String(value)}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <p className="muted">{en ? "No records" : "暂无记录"}</p>;
    if (value.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
      const keys = [...new Set(value.flatMap((row) => Object.keys(row)))];
      return <div className="cloud-table-wrap"><table className="cloud-table"><thead><tr>{keys.map((key) => <th key={key}>{label(key, en)}</th>)}</tr></thead>
        <tbody>{value.map((row, index) => <tr key={index}>{keys.map((key) => <td key={key}><ResultValue value={row[key]} en={en} /></td>)}</tr>)}</tbody></table></div>;
    }
    return <ul>{value.map((item, index) => <li key={index}><ResultValue value={item} en={en} /></li>)}</ul>;
  }
  return <dl className="admin-result-fields">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{label(key, en)}</dt><dd><ResultValue value={item} en={en} /></dd></div>)}</dl>;
}

export function BackendPage() {
  const { api } = useServices();
  const en = getLanguage() === "en";
  const [operations, setOperations] = useState<AdminOperation[]>([]);
  const [selected, setSelected] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const { confirm, dialog } = useConfirm();
  const operation = operations.find((item) => item.id === selected);
  const order = ["overview", "devices", "groups", "apps", "command", "device-keys", "tasks", "cards", "resellers", "app-notices", "app-updates", "scripts", "ai", "pack", "users", "audit", "stats", "settings", "alerts", "maintenance", "auth"];
  const groups = [...new Set(operations.map((item) => item.group))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  useEffect(() => {
    let active = true;
    setError("");
    void api.adminCatalog().then((catalog) => {
      if (!active) return;
      setOperations(catalog.operations);
      const first = catalog.operations.find((item) => item.path === "/api/overview") ?? catalog.operations[0];
      if (first) { setSelected(first.id); setValues(defaults(first)); }
    }).catch((e) => { if (active) setError(errorLine(e)); });
    return () => { active = false; generation.current++; };
  }, [api, reload]);

  const run = async (spec: AdminOperation, inputs: Record<string, unknown>) => {
    const token = ++generation.current;
    setBusy(true); setError("");
    try {
      const parameters: Record<string, unknown> = {}, body: Record<string, unknown> = {};
      const convert = (key: string, schema: AdminSchema) => {
        const value = inputs[key];
        if (value === "" || value === undefined || value === null) return undefined;
        if (schema.type === "object" || schema.type === "array") return typeof value === "string" ? JSON.parse(value) : value;
        if (schema.type === "integer" || schema.type === "number") return Number(value);
        return value;
      };
      for (const parameter of spec.parameters) { const value = convert(`query:${parameter.name}`, parameter.schema); if (value !== undefined) parameters[parameter.name] = value; }
      for (const [name, schema] of Object.entries(spec.body.properties ?? {})) { const value = convert(`body:${name}`, schema); if (value !== undefined) body[name] = value; }
      const data = await api.adminExecute(spec.id, parameters, body);
      if (generation.current === token) setResult(data ?? { ok: true });
    } catch (e) { if (generation.current === token) setError(errorLine(e)); }
    finally { if (generation.current === token) setBusy(false); }
  };
  const choose = (spec: AdminOperation) => {
    generation.current++; setSelected(spec.id); setValues(defaults(spec)); setResult(null); setError(""); setBusy(false);
  };
  useEffect(() => {
    if (operation?.method === "GET" && !operation.parameters.some((item) => item.required)) void run(operation, defaults(operation));
    // A newly selected read loads once; editing its filters waits for Submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const field = (name: string, schema: AdminSchema, key: string, required = false) => {
    const value = values[key] ?? "";
    const update = (next: unknown) => setValues((old) => ({ ...old, [key]: next }));
    if (schema.format === "binary") return <p key={key} className="hint">{label(name, en)}：{en ? "Choose a file when executing" : "执行时将打开本地文件选择器"}</p>;
    return <Field key={key} label={`${label(name, en)}${required ? " *" : ""}`} hint={schema.description}>
      {schema.enum ? <Select value={String(value)} required={required} onChange={(e) => update(e.target.value)}><option value="">—</option>{schema.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</Select>
        : schema.type === "boolean" ? <input type="checkbox" checked={value === true} onChange={(e) => update(e.target.checked)} />
        : schema.type === "object" || schema.type === "array" ? <Textarea aria-label={label(name, en)} required={required} value={String(value)} rows={3} placeholder={schema.type === "array" ? "[]" : "{}"} onChange={(e) => update(e.target.value)} />
        : <Input aria-label={label(name, en)} type={/password|secret/.test(name) ? "password" : schema.type === "integer" || schema.type === "number" ? "number" : "text"}
            required={required} value={String(value)} min={schema.minimum} max={schema.maximum} minLength={schema.minLength} maxLength={schema.maxLength}
            step={schema.type === "integer" ? 1 : "any"} autoComplete="off" onChange={(e) => update(e.target.value)} />}
    </Field>;
  };
  return <div className="page backend-page">
    <div className="row"><Badge tone="ok">{en ? "Local service" : "本地服务"}</Badge><span className="hint">{en ? "Stored on this computer · No remote connection required" : "数据保存在本机 · 无需连接远程后台"}</span></div>
    {error && <Alert tone="error" role="alert">{error}<Button size="sm" onClick={() => setReload((n) => n + 1)}>{en ? "Reload" : "重新加载"}</Button></Alert>}
    {!operations.length && !error && <p role="status">{en ? "Starting local services…" : "正在初始化本地服务…"}</p>}
    {!!operations.length && <div className="admin-workspace">
      <nav className="admin-nav" aria-label={en ? "Administration sections" : "后台管理分区"}>{groups.map((group) => <Button key={group} variant={operation?.group === group ? "primary" : "ghost"} aria-current={operation?.group === group ? "page" : undefined}
        onClick={() => choose(operations.find((item) => item.group === group)!)}>{label(group, en)}</Button>)}</nav>
      <div className="admin-content">
        {operation && <form className="panel admin-operation" onSubmit={(e) => { e.preventDefault(); void (async () => {
          if ((operation.method === "DELETE" || /\/(cleanup|revoke|disable|actions|unpublish)$/.test(operation.path)) && !(await confirm({ message: en ? "Execute this operation?" : "确认执行此操作？", danger: true }))) return;
          await run(operation, values);
        })(); }}>
          <h2>{label(operation.group, en)}</h2>
          {operations.filter((item) => item.group === operation.group).length > 1 && <Field label={en ? "Operation" : "操作"}><Select aria-label={en ? "Operation" : "操作"} value={selected} onChange={(e) => choose(operations.find((item) => item.id === e.target.value)!)}>
            {operations.filter((item) => item.group === operation.group).map((item) => <option key={item.id} value={item.id}>{actionLabel(item, en)}</option>)}</Select></Field>}
          <div className="admin-fields">
            {operation.parameters.map((item) => field(item.name, item.schema, `query:${item.name}`, item.required))}
            {Object.entries(operation.body.properties ?? {}).map(([name, schema]) => field(name, schema, `body:${name}`, operation.body.required?.includes(name)))}
          </div>
          <Button variant="primary" type="submit" disabled={busy}>{busy ? (en ? "Running…" : "正在执行…") : operation.method === "GET" ? (en ? "Query / Refresh" : "查询 / 刷新") : (en ? "Execute" : "执行")}</Button>
        </form>}
        {result !== null && <section className="panel admin-result" aria-label={en ? "Result" : "执行结果"}>{operation?.path === "/api/overview" && typeof result === "object" && result !== null
          ? <div className="admin-overview">{Object.entries(result).map(([name, value]) => <section key={name}><h3>{label(name, en)}</h3>
              {value && typeof value === "object" && !Array.isArray(value) ? <div className="admin-stat-grid">{Object.entries(value).map(([key, metric]) => <StatCard key={key} label={label(key, en)} value={String(metric ?? "—")} />)}</div> : <ResultValue value={value} en={en} />}
            </section>)}</div>
          : <ResultValue value={result} en={en} />}</section>}
      </div>
    </div>}
    {dialog}
  </div>;
}
