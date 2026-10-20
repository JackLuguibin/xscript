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

const ledger = {
  items: [
    { id: 2, time: 1792500000, kind: "payment", amount_cents: 1500, batch: "", count: 0, unit_cents: 0, app: "",
      card_kind: "", days: 0, note: "微信转账", actor: "admin" },
    { id: 1, time: 1792400000, kind: "charge", amount_cents: 2500, batch: "B20261019", count: 5, unit_cents: 500,
      app: "com.demo.app", card_kind: "normal", days: 30, note: "", actor: "agent1" },
  ],
  total: 2, charged: 2500, paid: 1500, adjusted: 0, balance: 1000,
};
const prices = { unpriced: "deny", items: [{ id: 1, app: "*", kind: "normal", days: 30, price_cents: 500 }] };

let routes: Record<string, unknown>;
let calls: string[];
let sent: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      calls.push(path);
      if (init?.method && init.method !== "GET")
        sent.push({ method: init.method, path, body: init.body ? JSON.parse(String(init.body)) : null });
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
      "/api/reseller/ledger": ledger,
      "/api/reseller/balance": { ...ledger, prices },
    };
  });

  it("home shows the own ledger, balance and price list", async () => {
    renderPage(<ResellerHome />);
    expect(await screen.findByText("账单")).toBeTruthy();
    expect(await screen.findByText("微信转账")).toBeTruthy();
    expect(screen.getAllByText("¥10.00").length).toBeGreaterThan(0);              // 待结算
    expect(screen.getByText("5 张 × ¥5.00")).toBeTruthy();
    expect(screen.getByText("我的批发价")).toBeTruthy();
    expect(screen.getByText(/不能生成/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /导出对账单/ })).toBeTruthy();
    expect(calls).toContain("/api/reseller/ledger");
    expect(calls.some((c) => c.startsWith("/api/resellers"))).toBe(false);
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

  it("shows balances and records a payment from the settlement drawer", async () => {
    routes = {
      "/api/auth/me": user("admin"),
      "/api/resellers": {
        items: [{ id: 7, username: "agent1", disabled: false, last_login_at: null, note: "", cards: stats,
          activations_30d: 2, ...limits }],
      },
      "/api/resellers/balances": { items: [{ id: 7, username: "agent1", charged: 2500, paid: 1500, adjusted: 0,
        balance: 1000 }] },
      "/api/resellers/7/ledger": ledger,
      "/api/resellers/7/prices": prices,
    };
    renderPage(<ResellersPage />);
    expect(await screen.findByText("agent1")).toBeTruthy();
    await vi.waitFor(() => expect(screen.getAllByText("¥10.00").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /结算/ }));
    expect(await screen.findByText("代理 agent1 的结算")).toBeTruthy();
    expect(await screen.findByText("微信转账")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /登记收款/ }));
    const dialog = (await screen.findByText("收款金额")).closest(".ant-modal") as HTMLElement;
    fireEvent.change(within(dialog).getByLabelText("金额"), { target: { value: "12.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /确\s*定|OK/ }));
    await vi.waitFor(() =>
      expect(sent).toContainEqual({ method: "POST", path: "/api/resellers/7/ledger",
        body: { kind: "payment", amount_cents: 1250, note: "" } }),
    );
  });

  it("edits and saves the price table", async () => {
    routes = {
      "/api/auth/me": user("admin"),
      "/api/resellers": {
        items: [{ id: 7, username: "agent1", disabled: false, last_login_at: null, note: "", cards: stats,
          activations_30d: 2, ...limits }],
      },
      "/api/resellers/7/prices": prices,
    };
    renderPage(<ResellersPage />);
    fireEvent.click(await screen.findByRole("button", { name: /结算/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "批发价" }));
    await vi.waitFor(() => expect(screen.getByDisplayValue("5.00")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("5.00"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: /保存批发价/ }));
    await vi.waitFor(() =>
      expect(sent).toContainEqual({ method: "PUT", path: "/api/resellers/7/prices",
        body: { unpriced: "deny", items: [{ app: "*", kind: "normal", days: 30, price_cents: 600 }] } }),
    );
  });
});
