// 系统设置 → 接入信息 shows which database the server uses (the address is never sent).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import { AuthProvider } from "../src/auth";
import { createQueryClient } from "../src/queryClient";
import SettingsPage from "../src/pages/Settings";

const admin = {
  id: 1,
  username: "admin",
  role: "admin",
  disabled: false,
  created_at: 0,
  last_login_at: null,
  totp_enabled: false,
  needs_totp_setup: false,
};
let settings: Record<string, unknown>;

beforeEach(() => {
  settings = { site_name: "XScript", public_url: "", version: "0.3.0", your_ip: "1.2.3.4" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      const body = path === "/api/auth/me" ? admin : path === "/api/settings" ? settings : { items: [], total: 0 };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }),
  );
});

function renderSettings() {
  render(
    <AntApp>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/settings"]}>
          <AuthProvider>
            <SettingsPage />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </AntApp>,
  );
}

describe("系统设置 → 接入信息 → 数据库", () => {
  it("shows PostgreSQL when the server uses it", async () => {
    settings.database = "postgresql";
    renderSettings();
    expect(await screen.findByText("PostgreSQL")).toBeTruthy();
    expect(screen.getByText("数据库")).toBeTruthy();
  });

  it("shows SQLite as the default and how to switch", async () => {
    settings.database = "sqlite";
    renderSettings();
    expect(await screen.findByText(/SQLite（默认/)).toBeTruthy();
    expect(screen.queryByText("PostgreSQL")).toBeNull();
  });
});
