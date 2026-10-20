// APK 打包 → 打包机 (remote pack workers) against a stub API.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import { AuthProvider } from "../src/auth";
import { createQueryClient } from "../src/queryClient";
import PackPage from "../src/pages/Pack";
import { workerCommand } from "../src/pages/pack/Workers";

const user = (role: string) => ({
  id: 1,
  username: role,
  role,
  disabled: false,
  created_at: 0,
  last_login_at: null,
  totp_enabled: true,
  needs_totp_setup: false,
});
const now = Math.floor(Date.now() / 1000);
const worker = (over: Record<string, unknown>) => ({
  id: 1,
  name: "构建机 A",
  hint: "xsw_…abcd",
  created_at: now - 3600,
  created_by: "admin",
  disabled: false,
  last_seen_at: now - 3,
  last_ip: "10.0.0.5",
  online: true,
  release: false,
  version: "0.4.0",
  host: "builder-a",
  job_id: null,
  ...over,
});
const job = {
  id: 12,
  status: "running",
  app_id: "com.example.demo",
  app_name: "演示",
  version: "1.0.0",
  version_code: 1,
  project_name: "demo",
  options: {},
  created_by: "admin",
  created_at: now - 60,
  started_at: now - 30,
  finished_at: null,
  apk_size: null,
  error: null,
  has_apk: false,
  queue_position: null,
  worker_name: "构建机 A",
  attempts: 2,
  cancel_requested: true,
};

let routes: Record<string, unknown>;
let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  routes = {
    "GET /api/auth/me": user("admin"),
    "GET /api/pack/info": {
      available: true,
      reason: "",
      release_signing: true,
      public_url: "https://x.example.com",
      mode: "remote",
    },
    "GET /api/pack/jobs": { items: [job], total: 1 },
    "GET /api/pack/workers": {
      mode: "remote",
      items: [
        worker({ job_id: 12, release: true }),
        worker({ id: 2, name: "构建机 B", online: false, last_seen_at: null, host: "" }),
        worker({ id: 3, name: "旧机器", disabled: true, online: false }),
      ],
    },
    "POST /api/pack/workers": worker({ id: 4, name: "新打包机", token: "xsw_test-only-token", online: false }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.split("?")[0];
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = `${method} ${path}`;
      const body = key in routes ? routes[key] : method === "GET" ? { items: [], total: 0 } : { ok: true };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }),
  );
});

function renderPack() {
  render(
    <AntApp>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/pack"]}>
          <AuthProvider>
            <PackPage />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </AntApp>,
  );
}

const card = async () => (await screen.findByText("在线 1 / 3")).closest(".ant-card") as HTMLElement;

describe("APK 打包 → 打包机", () => {
  it("lists workers with their state and shows which machine builds a job", async () => {
    renderPack();
    const c = within(await card());
    expect(c.getByText("构建中")).toBeTruthy();
    expect(c.getByText("#12")).toBeTruthy();
    expect(c.getByText("有证书")).toBeTruthy();
    expect(c.getByText("离线")).toBeTruthy();
    expect(c.getByText("还没连接过")).toBeTruthy();
    expect(c.getByText("已停用")).toBeTruthy();
    expect(c.queryByText("当前在这台服务器上打包")).toBeNull();
    expect(await screen.findByText(/打包机 构建机 A（第 2 次）/)).toBeTruthy();
    expect(screen.getByText("正在取消…")).toBeTruthy();
    expect(screen.getByText(/构建交给打包机/)).toBeTruthy();
  });

  it("adds a worker and shows its token and start command once", async () => {
    renderPack();
    fireEvent.click(within(await card()).getByRole("button", { name: /添加打包机/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "新打包机" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /添\s*加/ }));
    await waitFor(() =>
      expect(calls.find((x) => x.method === "POST" && x.path === "/api/pack/workers")?.body).toEqual({
        name: "新打包机",
      }),
    );
    expect((await screen.findAllByText("打包机「新打包机」已添加")).length).toBeGreaterThan(0);
    const cmd = workerCommand("https://x.example.com", "xsw_test-only-token");
    expect(screen.getAllByRole("textbox").some((el) => (el as HTMLTextAreaElement).value === cmd)).toBe(true);
    expect(screen.getByText("只显示这一次，关闭后无法再次查看。")).toBeTruthy();
  });

  it("disables, enables and deletes", async () => {
    renderPack();
    const c = within(await card());
    fireEvent.click(c.getAllByRole("button", { name: /停\s*用/ })[0]);
    expect(await screen.findByText(/正在打的任务会在 90 秒后转给其他打包机/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /确\s*定|OK/ }).at(-1)!);
    await waitFor(() =>
      expect(calls.some((x) => x.method === "POST" && x.path === "/api/pack/workers/1/disable")).toBe(true),
    );
    fireEvent.click(c.getByRole("button", { name: /启\s*用/ }));
    await waitFor(() =>
      expect(calls.some((x) => x.method === "POST" && x.path === "/api/pack/workers/3/enable")).toBe(true),
    );
    fireEvent.click(c.getByRole("button", { name: /删\s*除/ }));
    fireEvent.click((await screen.findAllByRole("button", { name: /确\s*定|OK/ })).at(-1)!);
    await waitFor(() =>
      expect(calls.some((x) => x.method === "DELETE" && x.path === "/api/pack/workers/3")).toBe(true),
    );
  });

  it("explains local mode and hides the card from non-admins", async () => {
    routes["GET /api/pack/info"] = {
      available: true,
      reason: "",
      release_signing: false,
      public_url: "",
      mode: "local",
    };
    routes["GET /api/pack/workers"] = { mode: "local", items: [] };
    renderPack();
    expect(await screen.findByText("当前在这台服务器上打包")).toBeTruthy();
    expect(screen.getByText(/构建在服务器上进行/)).toBeTruthy();
  });

  it("is admin only", async () => {
    routes["GET /api/auth/me"] = user("operator");
    renderPack();
    expect(await screen.findByText("打包记录")).toBeTruthy();
    expect(screen.queryByText("添加打包机")).toBeNull();
    expect(calls.some((x) => x.path === "/api/pack/workers")).toBe(false);
  });
});
