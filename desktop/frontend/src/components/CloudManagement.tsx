import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useServices } from "../app-context";
import type { CloudAccount } from "../api";
import { getLanguage } from "../strings";
import { errorLine } from "../errors";
import { useConfirm } from "./ConfirmDialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { Alert } from "./ui/alert";

type Row = Record<string, unknown>;
type Field = {
  key: string;
  zh: string;
  en: string;
  type?: "number" | "checkbox" | "textarea";
  initial?: string | boolean;
  required?: boolean;
};
type Resource = {
  id: string;
  zh: string;
  en: string;
  admin?: boolean;
  operator?: boolean;
  fields?: Field[];
  create?: boolean;
  update?: boolean;
  remove?: boolean;
};
const field = (
  key: string,
  zh: string,
  en: string,
  type?: Field["type"],
  initial?: string | boolean,
  required = false,
): Field => ({ key, zh, en, type, initial, required });
const RESOURCES: Resource[] = [
  { id: "trends", zh: "概览趋势", en: "Daily trends" },
  {
    id: "devices",
    zh: "设备详情",
    en: "Device details",
    update: true,
    remove: true,
    fields: [
      field("note", "备注", "Note"),
      field("group_override", "分组", "Group"),
    ],
  },
  {
    id: "scripts",
    zh: "小程序与版本",
    en: "Scripts and versions",
    create: true,
    update: true,
    remove: true,
    fields: [
      field("name", "名称", "Name", undefined, "", true),
      field("project_name", "工程名", "Project name", undefined, "", true),
      field("description", "描述", "Description", "textarea"),
      field("protect", "代码保护", "Code protection", "checkbox", false),
    ],
  },
  {
    id: "notices",
    zh: "运营公告",
    en: "Announcements",
    create: true,
    update: true,
    remove: true,
    fields: [
      field(
        "app",
        "应用包名（* 表示全部）",
        "App package (* for all)",
        undefined,
        "*",
      ),
      field("title", "标题", "Title", undefined, "", true),
      field("body", "内容", "Message", "textarea"),
      field(
        "level",
        "级别（info/warning/urgent）",
        "Level (info/warning/urgent)",
        undefined,
        "info",
      ),
      field("enabled", "启用", "Enabled", "checkbox", true),
      field("starts_at", "开始时间戳", "Start timestamp", "number"),
      field("ends_at", "结束时间戳", "End timestamp", "number"),
    ],
  },
  {
    id: "updates",
    zh: "应用更新",
    en: "App updates",
    update: true,
    remove: true,
    fields: [
      field("latest_name", "版本", "Version"),
      field("latest_code", "版本号", "Version code", "number"),
      field("url", "下载地址", "Download URL"),
      field("sha256", "SHA-256", "SHA-256"),
      field("notes", "更新说明", "Release notes", "textarea"),
      field(
        "min_code",
        "最低版本号（低于此版本强制更新）",
        "Minimum version code",
        "number",
        "0",
      ),
    ],
  },
  {
    id: "keys",
    zh: "设备密钥",
    en: "Device keys",
    admin: true,
    create: true,
    remove: true,
    fields: [field("name", "名称", "Name", undefined, "", true)],
  },
  { id: "cards", zh: "卡密", en: "License cards", operator: true },
  { id: "cardStats", zh: "卡密统计", en: "License statistics", operator: true },
  { id: "batches", zh: "卡密批次", en: "License batches", operator: true },
  { id: "bans", zh: "封禁列表", en: "Banned devices", operator: true },
  { id: "workers", zh: "打包机", en: "Pack workers", admin: true },
  { id: "builds", zh: "新建打包", en: "New APK build" },
  { id: "audit", zh: "审计日志", en: "Audit log", admin: true },
  { id: "users", zh: "用户", en: "Users", admin: true },
  { id: "resellers", zh: "代理商", en: "Resellers", admin: true },
  { id: "balances", zh: "代理结算", en: "Reseller balances", admin: true },
  { id: "settings", zh: "系统设置", en: "System settings", admin: true },
  { id: "maintenance", zh: "系统维护", en: "Maintenance", admin: true },
  { id: "account", zh: "账号信息", en: "Account" },
  { id: "tokens", zh: "API 令牌", en: "API tokens" },
  { id: "ai", zh: "AI 写脚本", en: "AI script writer" },
];
const LABELS: Record<string, string> = {
  id: "编号",
  name: "名称",
  username: "用户名",
  role: "角色",
  enabled: "启用",
  group: "分组",
  note: "备注",
  created_at: "创建时间",
  updated_at: "更新时间",
  version: "版本",
  version_code: "版本号",
  project_name: "工程名",
  description: "描述",
  channel: "更新渠道",
  current_version_id: "当前版本",
  title: "标题",
  body: "内容",
  app: "应用",
  status: "状态", protect: "代码保护",
  total: "总数",
  online: "在线",
  expires_at: "过期时间",
  last_used_at: "最后使用",
  token: "密钥（仅显示一次）",
  hint: "提示",
  items: "记录",
  code: "代码",
  notes: "说明",
  source: "源码",
  date: "日期",
};
function rowsOf(data: unknown): Row[] {
  if (Array.isArray(data))
    return data.filter((x) => x && typeof x === "object") as Row[];
  if (data && typeof data === "object") {
    const object = data as Row;
    if (
      Array.isArray(object.days) &&
      object.series &&
      typeof object.series === "object"
    )
      return object.days.map((date, index) => ({
        date,
        ...Object.fromEntries(
          Object.entries(object.series as Row).map(([key, values]) => [
            key,
            Array.isArray(values) ? values[index] : 0,
          ]),
        ),
      }));
    for (const key of [
      "items",
      "devices",
      "scripts",
      "rows",
      "days",
      "versions",
      "series",
    ])
      if (Array.isArray(object[key])) return rowsOf(object[key]);
    return [object];
  }
  return [];
}
function Value({
  value,
  label,
}: {
  value: unknown;
  label: (key: string) => string;
}): ReactNode {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (typeof value !== "object")
    return (
      <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {String(value)}
      </span>
    );
  if (Array.isArray(value))
    return (
      <ul>
        {value.map((item, index) => (
          <li key={index}>
            <Value value={item} label={label} />
          </li>
        ))}
      </ul>
    );
  return (
    <dl>
      {Object.entries(value as Row).map(([key, item]) => (
        <div key={key}>
          <dt>{label(key)}</dt>
          <dd>
            <Value value={item} label={label} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function CloudManagement({ account }: { account: CloudAccount }) {
  const { api } = useServices();
  const en = getLanguage() === "en";
  const w = (zh: string, english: string) => (en ? english : zh);
  const label = (key: string) =>
    en ? key.replaceAll("_", " ") : LABELS[key] || key.replaceAll("_", " ");
  const [resource, setResource] = useState("scripts");
  const spec = RESOURCES.find((r) => r.id === resource)!;
  const [data, setData] = useState<unknown>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [days, setDays] = useState(7);
  const [selected, setSelected] = useState<Row | null>(null);
  const [form, setForm] = useState<Row>({});
  const [showForm, setShowForm] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiCode, setAiCode] = useState("");
  const [scriptId, setScriptId] = useState("");
  const [packName, setPackName] = useState("");
  const [packId, setPackId] = useState("");
  const [release, setRelease] = useState(false);
  const [chooseIcon, setChooseIcon] = useState(false);
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  const [group, setGroup] = useState("");
  const [filters, setFilters] = useState<Row>({});
  const { confirm, dialog } = useConfirm();
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setData(
        await api.cloudManage(resource, "list", {
          query: {
            ...filters,
            page,
            q: filter,
            ...(resource === "trends" ? { days } : {}),
          },
        }),
      );
    } catch (e) {
      setError(errorLine(e));
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [api, resource, page, filter, days, filters]);
  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setShowForm(false);
    void load();
  }, [load]);
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorLine(e));
    } finally {
      setBusy(false);
    }
  };
  const itemId = (row: Row) => String(row.id ?? row.app ?? row.device_id ?? "");
  const action = async (
    action: string,
    row: Row,
    body?: Row,
    child?: string | number,
  ) => {
    if (
      !(await confirm({
        message: w("确认执行此操作？", "Confirm this operation?"),
        danger: ["delete", "revoke", "disable", "deleteVersion"].includes(
          action,
        ),
      }))
    )
      return;
    await work(async () => {
      const result = await api.cloudManage(resource, action, {
        item: itemId(row),
        body,
        child,
      });
      await load();
      setDetail(result);
    });
  };
  const openForm = (row: Row | null) => {
    setSelected(row);
    setForm(
      Object.fromEntries(
        (spec.fields || []).map((f) => [
          f.key,
          row?.[f.key] ?? f.initial ?? "",
        ]),
      ),
    );
    setShowForm(true);
  };
  const canWrite = account.canOperate && (!spec.admin || account.isAdmin);
  const rows = rowsOf(data);
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))]
    .filter((key) => !["token", "content", "body", "files"].includes(key))
    .slice(0, 8);
  return (
    <div className="cloud-management">
      <div className="row toolbar">
        <Select
          aria-label={w("管理分区", "Management section")}
          value={resource}
          onChange={(e) => {
            setResource(e.target.value);
            setFilters({});
            setDeviceIds([]);
            setPage(1);
            setFilter("");
            setQuery("");
          }}
        >
          {RESOURCES.map((r) => (
            <option
              key={r.id}
              value={r.id}
              disabled={
                (r.admin && !account.isAdmin) ||
                (r.operator && !account.canOperate)
              }
            >
              {en ? r.en : r.zh}
            </option>
          ))}
        </Select>
        <Input
          aria-label={w("筛选", "Filter")} placeholder={w("输入关键词", "Search records")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setPage(1);
              setFilter(query);
            }
          }}
        />
        <Button
          disabled={busy}
          onClick={() => {
            setPage(1);
            setFilter(query);
            void load();
          }}
        >
          {w("查询 / 刷新", "Search / Refresh")}
        </Button>
        {resource === "trends" && (
          <Select
            aria-label={w("趋势天数", "Trend days")}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>7</option>
            <option value={30}>30</option>
          </Select>
        )}
        {resource === "updates" && (
          <Button
            disabled={busy || !account.isAdmin}
            onClick={() => openForm({ app: "" })}
          >
            {w("设置应用更新", "Set app update")}
          </Button>
        )}
        {spec.create && (
          <Button disabled={busy || !canWrite} onClick={() => openForm(null)}>
            {w("新建", "Create")}
          </Button>
        )}
      </div>
      {resource === "audit" && (
        <div className="row">
          {[
            ["actor", "用户", "Actor"],
            ["action", "动作", "Action"],
            ["since", "起始时间戳", "Since timestamp"],
            ["until", "结束时间戳", "Until timestamp"],
          ].map(([key, zh, english]) => (
            <label key={key}>
              {w(zh, english)}
              <Input
                value={String(filters[key] || "")}
                onChange={(e) => {
                  setPage(1);
                  setFilters((old) => ({
                    ...old,
                    [key]:
                      key === "since" || key === "until"
                        ? Number(e.target.value)
                        : e.target.value,
                  }));
                }}
              />
            </label>
          ))}
        </div>
      )}
      {resource === "devices" && (
        <div className="row">
          <Input
            aria-label={w("批量分组", "Batch group")}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          />
          <Button
            disabled={busy || !account.canOperate || !deviceIds.length}
            onClick={() =>
              void action(
                "group",
                {},
                { ids: deviceIds, group_override: group },
              )
            }
          >
            {w("批量改分组", "Change selected groups")}
          </Button>
        </div>
      )}
      {error && (
        <Alert role="alert" tone="error">
          {error}
        </Alert>
      )}
      {resource === "trends" && rows.length > 1 && <Trend rows={rows} />}
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              {keys.map((key) => (
                <th key={key}>{label(key)}</th>
              ))}
              <th>{w("操作", "Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={itemId(row) || index}>
                {keys.map((key) => (
                  <td key={key}>
                    <Value value={row[key]} label={label} />
                  </td>
                ))}
                <td>
                  <Button
                    size="sm"
                    onClick={() => {
                      setSelected(row);
                      if (resource === "devices")
                        void work(async () =>
                          setDetail(
                            await api.cloudManage(resource, "detail", {
                              item: itemId(row),
                            }),
                          ),
                        );
                      else setDetail(row);
                    }}
                  >
                    {w("详情", "Details")}
                  </Button>
                  {spec.update && (
                    <Button
                      size="sm"
                      disabled={busy || !canWrite}
                      onClick={() => openForm(row)}
                    >
                      {w("编辑", "Edit")}
                    </Button>
                  )}
                  {spec.remove && (
                    <Button
                      size="sm"
                      disabled={
                        busy ||
                        !canWrite ||
                        (resource !== "notices" && !account.isAdmin)
                      }
                      onClick={() => void action("delete", row)}
                    >
                      {w("删除", "Delete")}
                    </Button>
                  )}
                  {resource === "devices" && (
                    <>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={String(row.id)}
                          checked={deviceIds.includes(String(row.id))}
                          onChange={(e) =>
                            setDeviceIds((ids) =>
                              e.target.checked
                                ? [...ids, String(row.id)]
                                : ids.filter((id) => id !== String(row.id)),
                            )
                          }
                        />
                        {w("选择", "Select")}
                      </label>
                      <Button
                        onClick={() =>
                          void work(async () =>
                            setDetail(
                              await api.cloudExportLogs(String(row.id)),
                            ),
                          )
                        }
                      >
                        {w("导出日志", "Export logs")}
                      </Button>
                    </>
                  )}
                  {resource === "tokens" && (
                    <Button
                      disabled={busy || !!row.current}
                      onClick={() => void action("delete", row)}
                    >
                      {w("吊销", "Revoke")}
                    </Button>
                  )}
                  {resource === "keys" && (
                    <Button
                      disabled={!account.isAdmin || busy}
                      onClick={() => void action("revoke", row)}
                    >
                      {w("吊销", "Revoke")}
                    </Button>
                  )}
                  {resource === "workers" && (
                    <Button
                      disabled={!account.isAdmin || busy}
                      onClick={() =>
                        void action(row.disabled ? "enable" : "disable", row)
                      }
                    >
                      {row.disabled
                        ? w("启用", "Enable")
                        : w("停用", "Disable")}
                    </Button>
                  )}
                  {resource === "scripts" && (
                    <>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void work(async () => {
                            setSelected(row);
                            setDetail(
                              await api.cloudManage(resource, "versions", {
                                item: itemId(row),
                              }),
                            );
                          })
                        }
                      >
                        {w("版本历史", "Versions")}
                      </Button>
                      <Button
                        disabled={!canWrite || busy}
                        onClick={() =>
                          void work(async () => {
                            await api.cloudUpload("version", {
                              scriptId: Number(row.id),
                            });
                            await load();
                          })
                        }
                      >
                        {w("上传版本 ZIP", "Upload version ZIP")}
                      </Button>
                      <Button
                        disabled={!account.isAdmin || busy}
                        onClick={() => void action("unpublish", row)}
                      >
                        {w("取消发布", "Unpublish")}
                      </Button>
                    </>
                  )}
                  {resource === "resellers" && (
                    <Button
                      onClick={() =>
                        void work(async () =>
                          setDetail(
                            await api.cloudManage(resource, "ledger", {
                              item: itemId(row),
                            }),
                          ),
                        )
                      }
                    >
                      {w("结算明细", "Ledger")}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && !busy && <p>{w("暂无记录", "No records")}</p>}
      <div className="row">
        <Button
          disabled={page === 1 || busy}
          onClick={() => setPage((p) => p - 1)}
        >
          {w("上一页", "Previous")}
        </Button>
        <span>{page}</span>
        <Button
          disabled={busy || !rows.length || !data || typeof data !== "object" || typeof (data as Row).total !== "number" || page * 50 >= Number((data as Row).total)}
          onClick={() => setPage((p) => p + 1)}
        >
          {w("下一页", "Next")}
        </Button>
      </div>
      {showForm && (
        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void work(async () => {
              const body = Object.fromEntries(
                Object.entries(form).filter(([, value]) => value !== ""),
              );
              const result = await api.cloudManage(
                resource,
                selected ? "update" : "create",
                { item: selected ? itemId(selected) : undefined, body },
              );
              setShowForm(false);
              await load();
              setDetail(result);
            });
          }}
        >
          <h3>{selected ? w("编辑", "Edit") : w("新建", "Create")}</h3>
          {resource === "updates" && (
            <label>
              {w("应用包名", "App package")}
              <Input
                required
                value={String(selected?.app || "")}
                onChange={(e) =>
                  setSelected({ ...selected, app: e.target.value })
                }
              />
            </label>
          )}
          {spec.fields?.map((f) => (
            <label key={f.key}>
              {en ? f.en : f.zh}
              {f.type === "textarea" ? (
                <Textarea
                  value={String(form[f.key] || "")}
                  onChange={(e) =>
                    setForm((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                />
              ) : (
                <Input
                  required={f.required}
                  type={f.type || "text"}
                  checked={f.type === "checkbox" ? !!form[f.key] : undefined}
                  value={
                    f.type === "checkbox"
                      ? undefined
                      : String(form[f.key] ?? "")
                  }
                  onChange={(e) =>
                    setForm((v) => ({
                      ...v,
                      [f.key]:
                        f.type === "checkbox"
                          ? e.target.checked
                          : f.type === "number" && e.target.value !== ""
                            ? Number(e.target.value)
                            : e.target.value,
                    }))
                  }
                />
              )}
            </label>
          ))}
          <Button type="submit" disabled={busy || !canWrite}>
            {w("保存", "Save")}
          </Button>
          <Button type="button" onClick={() => setShowForm(false)}>
            {w("取消", "Cancel")}
          </Button>
        </form>
      )}
      {resource === "scripts" && selected && !!detail && (
        <section className="panel">
          <h3>{w("版本操作", "Version actions")}</h3>
          {rowsOf(detail)
            .filter((row) => row.version_code != null)
            .map((version) => (
              <div className="row" key={String(version.id)}>
                <span>{String(version.version)}</span>
                <Button
                  disabled={!account.isAdmin || busy}
                  onClick={() =>
                    void action("publish", selected, { version_id: version.id })
                  }
                >
                  {w("发布 / 回滚", "Publish / Roll back")}
                </Button>
                <Button
                  disabled={!account.isAdmin || busy}
                  onClick={() =>
                    void action(
                      "deleteVersion",
                      selected,
                      undefined,
                      String(version.id),
                    )
                  }
                >
                  {w("删除版本", "Delete version")}
                </Button>
                <Button
                  disabled={!account.canOperate || busy}
                  onClick={() =>
                    void work(async () =>
                      setDetail(
                        await api.cloudManage(resource, "source", {
                          item: itemId(selected),
                          child: String(version.id),
                        }),
                      ),
                    )
                  }
                >
                  {w("查看源码", "View source")}
                </Button>
              </div>
            ))}
        </section>
      )}
      {resource === "ai" && (
        <section className="panel">
          <label>
            {w("描述脚本需求", "Describe the script")}
            <Textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
            />
          </label>
          <Button
            disabled={!account.canOperate || busy || !aiPrompt}
            onClick={() =>
              void work(async () => {
                const generated = (await api.cloudManage("ai", "generate", {
                  body: { prompt: aiPrompt, code: aiCode },
                })) as Row;
                setAiCode(String(generated.code || ""));
                setDetail(generated);
              })
            }
          >
            {w("生成", "Generate")}
          </Button>
          <Textarea
            aria-label={w("生成的代码", "Generated code")}
            value={aiCode}
            onChange={(e) => setAiCode(e.target.value)}
          />
          <Input
            aria-label={w("保存到小程序 ID", "Destination script ID")}
            type="number"
            value={scriptId}
            onChange={(e) => setScriptId(e.target.value)}
          />
          <Button
            disabled={!account.canOperate || busy || !aiCode || !scriptId}
            onClick={() =>
              void work(async () =>
                setDetail(
                  await api.cloudManage("ai", "save", {
                    body: { script_id: Number(scriptId), code: aiCode },
                  }),
                ),
              )
            }
          >
            {w("保存新版本", "Save new version")}
          </Button>
        </section>
      )}
      {(resource === "workers" || resource === "builds") && (
        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void work(async () =>
              setDetail(
                await api.cloudUpload("pack", {
                  chooseIcon,
                  options: { app_name: packName, app_id: packId, release },
                }),
              ),
            );
          }}
        >
          <h3>{w("新建 APK 打包", "New APK build")}</h3>
          <label>
            {w("应用名", "App name")}
            <Input
              required
              value={packName}
              onChange={(e) => setPackName(e.target.value)}
            />
          </label>
          <label>
            {w("包名", "Package ID")}
            <Input
              required
              value={packId}
              onChange={(e) => setPackId(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={release}
              onChange={(e) => setRelease(e.target.checked)}
            />
            {w(
              "发布签名（使用服务器证书）",
              "Release signing (server certificate)",
            )}
          </label>
          <label>
            <input
              type="checkbox"
              checked={chooseIcon}
              onChange={(e) => setChooseIcon(e.target.checked)}
            />
            {w("自定义应用图标", "Custom app icon")}
          </label>
          <Button type="submit" disabled={!account.canOperate || busy}>
            {w("选择工程 ZIP 并打包", "Choose project ZIP and build")}
          </Button>
        </form>
      )}
      {!!detail && (
        <section className="panel">
          <div className="row">
            <h3>{w("详情", "Details")}</h3>
            <Button onClick={() => setDetail(null)}>
              {w("关闭", "Close")}
            </Button>
          </div>
          <Value value={detail} label={label} />
          {typeof detail === "object" && detail !== null && typeof (detail as Row).token === "string" && <Button onClick={() => void api.copyText(String((detail as Row).token)).catch(e => setError(errorLine(e)))}>{w("复制密钥", "Copy key")}</Button>}
        </section>
      )}
      {dialog}
    </div>
  );
}
function Trend({ rows }: { rows: Row[] }) {
  const fields = Object.keys(rows[0]).filter(
    (key) => typeof rows[0][key] === "number",
  );
  const maximum = Math.max(
    1,
    ...rows.flatMap((row) => fields.map((key) => Number(row[key]) || 0)),
  );
  return (
    <figure>
      <svg
        role="img"
        aria-label="Daily trends"
        viewBox="0 0 600 180"
        style={{ width: "100%", maxHeight: 220 }}
      >
        {fields.map((key, index) => (
          <polyline
            key={key}
            fill="none"
            stroke={["#2563eb", "#16a34a", "#d97706", "#dc2626"][index % 4]}
            strokeWidth={2}
            points={rows
              .map(
                (row, x) =>
                  `${(x * 600) / Math.max(1, rows.length - 1)},${175 - ((Number(row[key]) || 0) * 170) / maximum}`,
              )
              .join(" ")}
          />
        ))}
      </svg>
      <figcaption>{fields.join(" · ")}</figcaption>
    </figure>
  );
}
