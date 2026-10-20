// 代理 console: the reseller sees only its own scoped pages (quota, own cards, own log) and the admin manages 代理.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import type { ReactNode } from "react";
import { AuthProvider } from "../src/auth";
import { createQueryClient } from "../src/queryClient";
import CardsPage from "../src/pages/Cards";
import ResellersPage from "../src/pages/Resellers";
import ResellerHome from "../src/pages/reseller/ResellerHome";

const user = (role: string) => ({ id: 7, username: role === "reseller" ? "agent1" : "admin", role, disabled: false,
  created_at: 0, last_login_at: null, totp_enabled: false, needs_totp_setup: false });
const stats = { unused: 3, active: 2, expired: 0, exhausted: 0, unbound: 0, revoked: 0, total: 5 };
const limits = { quota: 100, used: 5, left: 95, apps: ["com.demo.app"], kinds: ["normal"], max_days: 30,
  max_devices: 2, max_uses: 1000 };
const trend = { days: ["2026-10-19"], series: { created: [5], activations: [2], expirations: [0] },
  totals: { created: 5, activations: 2, expirations: 0 }, expiring_7d: 0, by_app: [], by_batch: [], timezone: "UTC" };

let routes: Record<string, unknown>;
let calls: string[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      calls.push(path);
      const body = path in routes ? routes[path] : { items: [], total: 0 };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }),
  );
});

function renderPage(page: ReactNode) {
  return render(
    <AntApp>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <AuthProvider>{page}</AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </AntApp>,
  );
}

describe("reseller console", () => {
  beforeEach(() => {
    routes = {
      "/api/auth/me": user("reseller"),
      "/api/reseller/me": { username: "agent1", ...limits, cards: stats },
      "/api/reseller/cards/stats": stats,
      "/api/reseller/stats/daily": trend,
    };
  });

  it("home shows quota and the allowed card range", async () => {
    renderPage(<ResellerHome />);
    expect(await screen.findByText("你好，agent1")).toBeTruthy();
    expect(screen.getByText("额度")).toBeTruthy();
    expect(screen.getByText("发卡范围")).toBeTruthy();
    expect(calls.some((c) => c.startsWith("/api/settings") || c.startsWith("/api/cards"))).toBe(false);
  });

  it("cards page is scoped to /api/reseller and the modal enforces the limits", async () => {
    renderPage(<CardsPage />);
    expect(await screen.findByText("我的卡密")).toBeTruthy();
    expect(await screen.findByLabelText("剩余额度")).toBeTruthy();
    expect(screen.queryByText("滥用告警")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /生成卡密/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/剩余额度 95 张/)).toBeTruthy();
    expect(within(dialog).queryByText("体验卡")).toBeNull();
    // Staff endpoints are never touched by a 代理 session.
    expect(calls.filter((c) => c.startsWith("/api/cards") || c === "/api/resellers")).toEqual([]);
    expect(calls).toContain("/api/reseller/cards");
  });

  it("an exhausted quota disables generating", async () => {
    routes["/api/reseller/me"] = { username: "agent1", ...limits, used: 100, left: 0, cards: stats };
    renderPage(<CardsPage />);
    const btn = await screen.findByRole("button", { name: /生成卡密/ });
    await vi.waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
  });
});

describe("admin 代理 page", () => {
  it("lists resellers with quota and opens the quota dialog", async () => {
    routes = {
      "/api/auth/me": user("admin"),
      "/api/resellers": {
        items: [{ id: 7, username: "agent1", disabled: false, last_login_at: null, note: "华东", cards: stats,
          activations_30d: 2, ...limits }],
      },
    };
    renderPage(<ResellersPage />);
    expect(await screen.findByText("agent1")).toBeTruthy();
    expect(screen.getByRole("button", { name: /新建代理/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /充值|额度/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
