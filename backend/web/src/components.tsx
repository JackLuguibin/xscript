import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Dropdown, Input, Select, Space, Tooltip, Typography } from "antd";
import { CopyOutlined, DesktopOutlined, MoonOutlined, SearchOutlined, SunOutlined } from "@ant-design/icons";
import { api, type CardStatus, type Group, type JobStatus } from "./api";
import { copy } from "./format";
import { useThemeMode, type ThemeMode } from "./theme";

export function PageHeader({ title, desc, extra }: { title: ReactNode; desc?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h2>{title}</h2>
        {desc && <p>{desc}</p>}
      </div>
      {extra && <Space wrap>{extra}</Space>}
    </div>
  );
}

export type Tone = "green" | "blue" | "amber" | "red" | "violet" | "gray";

/** Small rounded status label with a leading dot. */
export function Pill({ tone = "gray", pulse, children }: { tone?: Tone; pulse?: boolean; children: ReactNode }) {
  return <span className={`pill ${tone === "gray" ? "" : tone}${pulse ? " pulse" : ""}`}>{children}</span>;
}

/** Search box that reports its value 300 ms after the user stops typing (Enter reports immediately). */
export function SearchInput({
  placeholder,
  onSearch,
  width = 260,
  initial = "",
}: {
  placeholder: string;
  onSearch: (q: string) => void;
  width?: number;
  initial?: string;
}) {
  const [text, setText] = useState(initial);
  const cb = useRef(onSearch);
  cb.current = onSearch;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => cb.current(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <Input
      prefix={<SearchOutlined className="muted" />}
      placeholder={placeholder}
      allowClear
      aria-label={placeholder}
      style={{ width }}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onPressEnter={() => cb.current(text.trim())}
    />
  );
}

/** Light / dark / system switcher. */
export function ThemeSwitch() {
  const { mode, dark, setMode } = useThemeMode();
  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        selectable: true,
        selectedKeys: [mode],
        items: [
          { key: "light", icon: <SunOutlined />, label: "浅色" },
          { key: "dark", icon: <MoonOutlined />, label: "深色" },
          { key: "system", icon: <DesktopOutlined />, label: "跟随系统" },
        ],
        onClick: ({ key }) => setMode(key as ThemeMode),
      }}
    >
      <Tooltip title="主题">
        <Button type="text" aria-label="切换主题" icon={dark ? <MoonOutlined /> : <SunOutlined />} />
      </Tooltip>
    </Dropdown>
  );
}

export function CopyText({ text, children, mono = true }: { text: string; children?: ReactNode; mono?: boolean }) {
  const { message } = App.useApp();
  return (
    <Space size={4}>
      <span className={mono ? "mono" : undefined}>{children ?? text}</span>
      <Tooltip title="复制">
        <Button
          type="text"
          size="small"
          aria-label="复制"
          icon={<CopyOutlined />}
          onClick={(e) => {
            e.stopPropagation();
            copy(text).then(() => message.success("已复制"));
          }}
        />
      </Tooltip>
    </Space>
  );
}

export const CARD_STATUS: Record<CardStatus, [Tone, string]> = {
  unused: ["gray", "未使用"],
  active: ["green", "已激活"],
  expired: ["amber", "已过期"],
  unbound: ["blue", "已解绑"],
  revoked: ["red", "已停用"],
};

export function CardStatusTag({ status }: { status: CardStatus }) {
  const [tone, label] = CARD_STATUS[status];
  return <Pill tone={tone}>{label}</Pill>;
}

export const CARD_STATUS_OPTIONS = Object.entries(CARD_STATUS).map(([value, [, label]]) => ({ value, label }));

const JOB_STATUS: Record<JobStatus, [Tone, string]> = {
  queued: ["gray", "排队中"],
  running: ["blue", "构建中"],
  succeeded: ["green", "成功"],
  failed: ["red", "失败"],
  cancelled: ["amber", "已取消"],
};

export function JobStatusTag({ status }: { status: JobStatus }) {
  const [tone, label] = JOB_STATUS[status];
  return (
    <Pill tone={tone} pulse={status === "running"}>
      {label}
    </Pill>
  );
}

/** CSS variable for a tone, for charts and legends. */
export const toneColor = (t: Tone) => `var(--xs-${t})`;

/** Target picker for commands and tasks: all / group:x / app:x / explicit device ids. */
export function TargetSelect({
  value,
  onChange,
  selectedIds,
  style,
}: {
  value?: string;
  onChange?: (v: string) => void;
  selectedIds?: string[];
  style?: React.CSSProperties;
}) {
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => api.get<{ items: Group[] }>("/api/groups") });
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.get<{ items: string[] }>("/api/apps") });
  const options = [
    { label: "范围", options: [{ value: "all", label: "全部在线设备" }] },
    ...(selectedIds?.length
      ? [{ label: "选中", options: [{ value: selectedIds.join(","), label: `已选中的 ${selectedIds.length} 台设备` }] }]
      : []),
    {
      label: "分组",
      options: (groups.data?.items ?? []).map((g) => ({
        value: "group:" + g.name,
        label: `${g.name}（在线 ${g.online}/${g.total}）`,
      })),
    },
    { label: "应用", options: (apps.data?.items ?? []).map((a) => ({ value: "app:" + a, label: a })) },
  ].filter((g) => g.options.length);
  return <Select value={value} onChange={onChange} options={options} style={{ minWidth: 220, ...style }} showSearch />;
}

/** Shows a secret exactly once with a copy button. */
export function useSecretModal() {
  const { modal } = App.useApp();
  return (title: string, secret: string, hint?: ReactNode) =>
    modal.success({
      title,
      width: 560,
      content: (
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Text type="warning">只显示这一次，关闭后无法再次查看。</Typography.Text>
          <Input.TextArea value={secret} readOnly autoSize className="mono" onFocus={(e) => e.target.select()} />
          <CopyText text={secret} mono={false}>
            复制
          </CopyText>
          {hint}
        </Space>
      ),
    });
}
