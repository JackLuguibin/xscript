// 概览 趋势 card: range switch, legend toggles, hover / keyboard tooltip, accessible table, empty and error states.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import { AuthProvider } from "../src/auth";
import { createQueryClient } from "../src/queryClient";
import type { DailyStats } from "../src/api";
import TrendCard, { niceMax } from "../src/pages/overview/TrendCard";
import OverviewPage from "../src/pages/Overview";

const admin = { id: 1, username: "admin", role: "admin", disabled: false, created_at: 0, last_login_at: null,
  totp_enabled: false, needs_totp_setup: false };

function stats(days: number, fill = true): DailyStats {
  const labels = Array.from({ length: days }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  const ser = (f: (i: number) => number) => labels.map((_, i) => (fill ? f(i) : 0));
  return {
    days: labels,
    series: { activations: ser((i) => i % 3), expirations: ser((i) => (i === 2 ? 4 : 0)),
      new_devices: ser((i) => (i === 0 ? 2 : 0)), online_devices: ser((i) => 5 + i) },
    totals: { activations: fill ? 6 : 0, expirations: fill ? 4 : 0, new_devices: fill ? 2 : 0, online_peak: fill ? 5 + days - 1 : 0 },
    expiring_7d: fill ? 3 : 0,
    by_app: fill ? [{ name: "com.game.a", count: 5 }, { name: "com.game.b", count: 1 }] : [],
    by_batch: fill ? [{ name: "b1", count: 4 }] : [],
    timezone: "-0400",
  };
}

const overview = {
  devices: { online: 1, running: 0, total: 2, active_24h: 2 },
  cards: { unused: 50, active: 1, expired: 0, exhausted: 0, unbound: 0, revoked: 0, total: 51 },
  tasks: { total: 0, enabled: 0 }, pack: { queued: 0, running: 0 }, events: [], crashes: [],
  scripts: { total: 0, published: 0 }, alerts_24h: 0, last_backup: { time: 1, ok: true },
};

let fail = false;
let empty = false;
const calls: string[] = [];

beforeEach(() => {
  fail = false;
  empty = false;
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const [path, query] = url.split("?");
      if (path === "/api/stats/daily") {
        if (fail) return new Response(JSON.stringify({ detail: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
        const days = Number(new URLSearchParams(query).get("days"));
        return new Response(JSON.stringify(stats(days, !empty)), { headers: { "content-type": "application/json" } });
      }
      const body = path === "/api/auth/me" ? admin : path === "/api/overview" ? overview : { items: [], total: 0 };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }),
  );
});

function renderCard(node = <TrendCard />) {
  return render(
    <AntApp>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <AuthProvider>{node}</AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </AntApp>,
  );
}

const legend = () => screen.getByRole("group", { name: "显示的数据" });

describe("niceMax", () => {
  it("rounds the axis to 1/2/5 steps", () => {
    expect(niceMax(0)).toEqual({ top: 4, step: 1 });
    expect(niceMax(3)).toEqual({ top: 3, step: 1 });
    expect(niceMax(37)).toEqual({ top: 40, step: 10 });
    expect(niceMax(1234)).toEqual({ top: 1500, step: 500 });
  });
});

describe("TrendCard", () => {
  it("loads 30 days, shows totals, rankings and the expiring note", async () => {
    renderCard();
    await screen.findByRole("img", { name: /2026-10-01 至 2026-10-30/ });
    expect(calls).toContain("/api/stats/daily?days=30");
    const btn = within(legend()).getByRole("button", { name: /激活/ });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.textContent).toContain("6");
    // 到期 starts hidden so the chart is not dominated by expiry spikes
    expect(within(legend()).getByRole("button", { name: /到期/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("com.game.a")).toBeTruthy();
    expect(screen.getByText("b1")).toBeTruthy();
    expect(screen.getByText("未来 7 天到期的卡密")).toBeTruthy();
    expect(screen.getByText(/UTC-04:00/)).toBeTruthy();
    // accessible table mirrors the visible series
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(31);
    expect(within(table).queryByRole("columnheader", { name: "到期" })).toBeNull();
  });

  it("switches the range and toggles series (never all off)", async () => {
    renderCard();
    await screen.findByRole("img");
    fireEvent.click(screen.getByText("7 天"));
    await screen.findByRole("img", { name: /2026-10-01 至 2026-10-07/ });
    expect(calls).toContain("/api/stats/daily?days=7");
    const svg = screen.getByRole("img");
    expect(svg.querySelectorAll("[data-series]")).toHaveLength(3);
    fireEvent.click(within(legend()).getByRole("button", { name: /到期/ }));
    expect(svg.querySelectorAll("[data-series]")).toHaveLength(4);
    for (const name of [/激活/, /在线设备/, /新设备/, /到期/]) fireEvent.click(within(legend()).getByRole("button", { name }));
    // the last visible series stays on
    expect(svg.querySelectorAll("[data-series]")).toHaveLength(1);
    expect(screen.getByRole("img", { name: /到期 4 张/ })).toBeTruthy();
  });

  it("shows a tooltip on hover and with the arrow keys", async () => {
    renderCard();
    const svg = await screen.findByRole("img");
    fireEvent.mouseEnter(svg.querySelectorAll("rect.hit")[4]);
    const tip = screen.getByRole("status");
    expect(tip.textContent).toContain("2026-10-05");
    expect(tip.textContent).toContain("在线设备9");
    fireEvent.mouseLeave(svg);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => svg.focus());
    fireEvent.keyDown(svg, { key: "ArrowLeft" });
    expect(screen.getByRole("status").textContent).toContain("2026-10-30");
    fireEvent.keyDown(svg, { key: "ArrowLeft" });
    expect(screen.getByRole("status").textContent).toContain("2026-10-29");
    fireEvent.keyDown(svg, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("explains empty and failed loads", async () => {
    empty = true;
    const { unmount } = renderCard();
    expect(await screen.findByText("所选时间段内还没有激活或设备数据")).toBeTruthy();
    expect(screen.getAllByText("暂无激活")).toHaveLength(2);
    unmount();
    fail = true;
    renderCard();
    await waitFor(() => expect(screen.getByText("趋势数据加载失败")).toBeTruthy(), { timeout: 5000 });
  });

  it("is part of the overview page", async () => {
    renderCard(<OverviewPage />);
    expect(await screen.findByText("趋势")).toBeTruthy();
    await screen.findByRole("img", { name: /至/ });
  });
});
