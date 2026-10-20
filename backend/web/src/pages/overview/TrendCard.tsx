import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, Empty, Segmented, Skeleton, Tooltip } from "antd";
import { api, type TrendData } from "../../api";

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
  total: (d: TrendData) => number;
  unit: string;
}

export const TREND_SERIES: SeriesDef[] = [
  { key: "activations", label: "激活", color: "var(--xs-violet)", total: (d) => d.totals.activations, unit: "张" },
  { key: "online_devices", label: "在线设备", color: "var(--xs-green)", total: (d) => d.totals.online_peak, unit: "台峰值" },
  { key: "new_devices", label: "新设备", color: "var(--xs-blue)", total: (d) => d.totals.new_devices, unit: "台" },
  { key: "expirations", label: "到期", color: "var(--xs-amber)", total: (d) => d.totals.expirations, unit: "张" },
];

/** A 代理's cards: generated, activated and expired per day (no fleet-wide device numbers). */
export const CARD_TREND_SERIES: SeriesDef[] = [
  { key: "created", label: "生成", color: "var(--xs-blue)", total: (d) => d.totals.created, unit: "张" },
  { key: "activations", label: "激活", color: "var(--xs-violet)", total: (d) => d.totals.activations, unit: "张" },
  { key: "expirations", label: "到期", color: "var(--xs-amber)", total: (d) => d.totals.expirations, unit: "张" },
];

const RANGES = [
  { label: "7 天", value: 7 },
  { label: "30 天", value: 30 },
  { label: "90 天", value: 90 },
];

const H = 240;
const PAD = { l: 36, r: 12, t: 12, b: 26 };

/** 1, 2, 5 × 10^n step so the y axis gets about four round gridlines. */
export function niceMax(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const s = Math.max(1, step);
  return { top: Math.ceil(max / s) * s, step: s };
}

const short = (day: string) => day.slice(5).replace("-", "/");

/** Width of the chart box in CSS px, so SVG text stays at its real size (no viewBox scaling). */
function useWidth(fallback = 720) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function Chart({ data, shown, defs }: { data: TrendData; shown: string[]; defs: SeriesDef[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, W] = useWidth();
  const titleId = useId();
  const n = data.days.length;
  const max = Math.max(0, ...shown.flatMap((k) => data.series[k]));
  const { top, step } = niceMax(max);
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i * (W - PAD.l - PAD.r)) / (n - 1));
  const y = (v: number) => H - PAD.b - (v / top) * (H - PAD.t - PAD.b);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const every = Math.max(1, Math.ceil(n / Math.max(4, Math.floor(W / 90))));
  // Regular ticks, plus the last day unless a regular tick sits too close to it.
  const showX = (i: number) => i === n - 1 || (i % every === 0 && n - 1 - i >= Math.ceil(every * 0.7));
  const series = defs.filter((s) => shown.includes(s.key));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setHover((h) => {
        const cur = h ?? (e.key === "ArrowRight" ? -1 : n);
        return Math.min(n - 1, Math.max(0, cur + (e.key === "ArrowRight" ? 1 : -1)));
      });
    } else if (e.key === "Escape") setHover(null);
  };

  const tipLeft = hover === null ? 0 : (x(hover) / W) * 100;
  return (
    <div className="trend-chart" ref={box}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-labelledby={titleId}
        tabIndex={0}
        onKeyDown={onKey}
        onMouseLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
      >
        <title id={titleId}>
          {`${data.days[0]} 至 ${data.days[n - 1]}：` + series.map((s) => `${s.label} ${s.total(data)} ${s.unit}`).join("，")}
        </title>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`${titleId}-${s.key}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((t) => (
          <g key={t} className="grid">
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
            <text x={PAD.l - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {t.toLocaleString()}
            </text>
          </g>
        ))}
        {data.days.map((d, i) =>
          showX(i) ? (
            <text key={d} className="xlabel" x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
              {short(d)}
            </text>
          ) : null,
        )}
        {series.map((s, si) => {
          const pts = data.series[s.key].map((v, i) => `${x(i)},${y(v)}`).join(" ");
          return (
            <g key={s.key} data-series={s.key}>
              {si === 0 && (
                <polygon points={`${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}`} fill={`url(#${titleId}-${s.key})`} />
              )}
              <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {hover !== null && <circle cx={x(hover)} cy={y(data.series[s.key][hover])} r={4} fill="var(--xs-surface)" stroke={s.color} strokeWidth={2} />}
            </g>
          );
        })}
        {hover !== null && <line className="guide" x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} />}
        {data.days.map((d, i) => (
          <rect
            key={d}
            className="hit"
            x={x(i) - (W - PAD.l - PAD.r) / Math.max(1, n - 1) / 2}
            width={(W - PAD.l - PAD.r) / Math.max(1, n - 1)}
            y={0}
            height={H}
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {hover !== null && (
        <div className={"trend-tip" + (tipLeft > 60 ? " left" : "")} style={{ left: `${tipLeft}%` }} role="status">
          <b>{data.days[hover]}</b>
          {series.map((s) => (
            <div key={s.key}>
              <i style={{ background: s.color }} />
              {s.label}
              <span>{data.series[s.key][hover].toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
      <table className="sr-only">
        <caption>按天数据</caption>
        <thead>
          <tr>
            <th>日期</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.days.map((d, i) => (
            <tr key={d}>
              <td>{d}</td>
              {series.map((s) => (
                <td key={s.key}>{data.series[s.key][i]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Ranking({ title, rows }: { title: string; rows: { name: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="trend-rank">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <span className="muted">暂无激活</span>
      ) : (
        <ol>
          {rows.slice(0, 5).map((r) => (
            <li key={r.name}>
              <Tooltip title={r.name}>
                <span className="name">{r.name}</span>
              </Tooltip>
              <span className="bar">
                <span style={{ width: `${(100 * r.count) / max}%` }} />
              </span>
              <b>{r.count.toLocaleString()}</b>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * 按天趋势 by server-local day with app and batch rankings. Defaults to the 概览 card (激活 / 在线设备 / 新设备 /
 * 到期 from /api/stats/daily); the 代理 pages pass their own endpoint and CARD_TREND_SERIES.
 */
export default function TrendCard({
  title = "趋势",
  url = (days: number) => `/api/stats/daily?days=${days}`,
  cacheKey = "stats-daily",
  defs = TREND_SERIES,
  defaultHidden = ["expirations"],
  emptyText = "所选时间段内还没有激活或设备数据",
}: {
  title?: string;
  url?: (days: number) => string;
  cacheKey?: string;
  defs?: SeriesDef[];
  defaultHidden?: string[];
  emptyText?: string;
}) {
  const [days, setDays] = useState(30);
  const [hidden, setHidden] = useState<string[]>(defaultHidden);
  const { data, isLoading, isError } = useQuery({
    queryKey: [cacheKey, days],
    queryFn: () => api.get<TrendData>(url(days)),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const shown = useMemo(() => defs.map((s) => s.key).filter((k) => !hidden.includes(k)), [defs, hidden]);
  const empty = data && defs.every((s) => (data.series[s.key] ?? []).every((v) => v === 0));
  const toggle = (k: string) =>
    setHidden((h) => (h.includes(k) ? h.filter((x) => x !== k) : h.length >= defs.length - 1 ? h : [...h, k]));

  return (
    <Card
      title={title}
      className="trend-card"
      extra={<Segmented size="small" options={RANGES} value={days} onChange={(v) => setDays(Number(v))} aria-label="时间范围" />}
    >
      {isLoading && !data ? (
        <Skeleton active paragraph={{ rows: 5 }} />
      ) : isError || !data ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="趋势数据加载失败" />
      ) : (
        <>
          <div className="trend-legend" role="group" aria-label="显示的数据">
            {defs.map((s) => {
              const on = shown.includes(s.key);
              return (
                <button key={s.key} type="button" aria-pressed={on} className={on ? "on" : ""} onClick={() => toggle(s.key)}>
                  <i style={{ background: s.color }} />
                  <span className="label">{s.label}</span>
                  <b>{s.total(data).toLocaleString()}</b>
                  <small>{s.unit}</small>
                </button>
              );
            })}
          </div>
          {empty ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
          ) : (
            <Chart data={data} shown={shown} defs={defs} />
          )}
          <div className="trend-foot">
            <Ranking title="激活最多的小程序" rows={data.by_app} />
            <Ranking title="激活最多的批次" rows={data.by_batch} />
            <div className="trend-note">
              <span className={"icon-badge " + (data.expiring_7d > 0 ? "amber" : "green")}>{data.expiring_7d}</span>
              <span>
                未来 7 天到期的卡密
                <small className="muted">按服务器时区（UTC{data.timezone.slice(0, 3)}:{data.timezone.slice(3)}）分天</small>
              </span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
