// Smoke tests for the large pages and the dialogs / drawer / form split out of them: each page renders
// against a stub API and the extracted piece still opens from the page with its content.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import type { ReactNode } from "react";
import { AuthProvider } from "../src/auth";
import { createQueryClient } from "../src/queryClient";
import CardsPage from "../src/pages/Cards";
import DevicesPage from "../src/pages/Devices";
import PackPage from "../src/pages/Pack";

const admin = { id: 1, username: "admin", role: "admin", disabled: false, created_at: 0, last_login_at: null,
  totp_enabled: false, needs_totp_setup: false };
const device = { id: "dev1", device_id: "dev1", app: "com.xscript.app", model: "Pixel 8", brand: "Google", group: "g1",
  reported_group: "g1", group_override: "", note: "机房 A", online: true, running: false, project: null, data: { gold: 5 },
  remote: "10.0.0.2", first_seen: 1_700_000_000, last_seen: 1_700_000_100, connected_at: 1_700_000_000, status: {} };

const routes: Record<string, unknown> = {
  "/api/auth/me": admin,
  "/api/devices": { items: [device], total: 1 },
  "/api/devices/dev1": device,
  "/api/settings": { device_log_days: 7, site_name: "XScript" },
  "/api/cards/stats": { unused: 0, active: 0, expired: 0, exhausted: 0, unbound: 0, revoked: 0, total: 0 },
  "/api/pack/info": { available: true, reason: "", release_signing: false, public_url: "" },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.split("?")[0];
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

describe("split pages", () => {
  it("Cards: 生成卡密 opens the batch creation modal", async () => {
    renderPage(<CardsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /生成卡密/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("生成卡密")).toBeTruthy();
    expect(within(dialog).getByText("限定应用")).toBeTruthy();
  });

  it("Pack: the build form renders inside the page", async () => {
    renderPage(<PackPage />);
    expect(await screen.findByText("选择工程")).toBeTruthy();
    expect(screen.getByText("应用信息")).toBeTruthy();
  });

  it("Devices: clicking a device opens the detail drawer", async () => {
    renderPage(<DevicesPage />);
    fireEvent.click(await screen.findByText("Google Pixel 8"));
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("设备 ID")).toBeTruthy();
    expect(within(drawer).getByText("机房 A")).toBeTruthy();
    expect(within(drawer).getByText(/"gold": 5/)).toBeTruthy();
  });
});
