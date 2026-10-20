// 后台 AI 写脚本 page and its settings tab against a stub API (no model is contacted).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import type { ReactNode } from "react";
import { AuthProvider } from "../src/auth";
import { createQueryClient } from "../src/queryClient";
import AiWriterPage from "../src/pages/AiWriter";
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
const version = {
  id: 2,
  version: "1.0.0",
  version_code: 1,
  notes: "",
  sha256: "",
  size: 1,
  files: 1,
  downloads: 0,
  created_by: "admin",
  created_at: 0,
  current: true,
};
const script = {
  id: 1,
  name: "签到",
  project_name: "sign_in",
  description: "",
  protect: false,
  channel: "c",
  created_by: "admin",
  created_at: 0,
  updated_at: 0,
  versions: 1,
  current: version,
  latest: version,
};
const ready = {
  configured: true,
  base_url: "http://127.0.0.1:9/v1",
  model: "mock-coder",
  key_set: true,
  source: "env",
};
const generated = {
  code: "from xscript.android import action\naction.click(1, 2)\n",
  notes: "把坐标换成你的按钮。",
  syntax_error: "",
  model: "mock-coder",
  usage: { total_tokens: 960 },
  ms: 1200,
};

let routes: Record<string, unknown>;
let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  routes = {
    "GET /api/auth/me": admin,
    "GET /api/ai/status": ready,
    "GET /api/scripts": { items: [script] },
    "GET /api/scripts/1/versions": { items: [version] },
    "GET /api/ai/source/1/2": { code: "print('v1')\n", version: "1.0.0" },
    "POST /api/ai/script": generated,
    "POST /api/ai/save": { ...version, id: 3, version: "1.0.1", current: false },
    "GET /api/settings": { site_name: "XScript", public_url: "", ai_base_url: "", ai_model: "", your_ip: "1.2.3.4" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.split("?")[0];
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = `${method} ${path}`;
      const body = key in routes ? routes[key] : { items: [], total: 0 };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }),
  );
});

function renderAt(page: ReactNode, url = "/ai") {
  return render(
    <AntApp>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[url]}>
          <AuthProvider>{page}</AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </AntApp>,
  );
}

const posts = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

describe("AI 写脚本", () => {
  it("asks for a model when none is configured", async () => {
    routes["GET /api/ai/status"] = { configured: false, base_url: "", model: "", key_set: false, source: "env" };
    renderAt(<AiWriterPage />);
    expect(await screen.findByText("还没有配置模型")).toBeTruthy();
    expect(screen.getByRole("button", { name: "去设置" })).toBeTruthy();
    expect((screen.getByRole("button", { name: /生成脚本/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("generates, shows the checked code and refines it on the next request", async () => {
    renderAt(<AiWriterPage />);
    expect(await screen.findByText("mock-coder")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("需求描述"), { target: { value: "点一下屏幕" } });
    fireEvent.click(screen.getByRole("button", { name: /生成脚本/ }));
    const editor = (await screen.findByLabelText("代码")) as HTMLTextAreaElement;
    expect(editor.value).toBe(generated.code);
    expect(screen.getByText("语法正确")).toBeTruthy();
    expect(screen.getByText("把坐标换成你的按钮。")).toBeTruthy();
    expect(posts("/api/ai/script")[0].body).toEqual({ prompt: "点一下屏幕", code: "" });

    // Follow-ups revise the code on the right.
    fireEvent.change(screen.getByLabelText("需求描述"), { target: { value: "点两次" } });
    fireEvent.click(screen.getByRole("button", { name: /按要求修改/ }));
    await waitFor(() => expect(posts("/api/ai/script")).toHaveLength(2));
    expect(posts("/api/ai/script")[1].body).toEqual({ prompt: "点两次", code: generated.code });
  });

  it("a syntax error blocks saving", async () => {
    routes["POST /api/ai/script"] = { ...generated, code: "if True\n", syntax_error: "第 1 行: expected ':'" };
    renderAt(<AiWriterPage />);
    fireEvent.change(await screen.findByLabelText("需求描述"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /生成脚本/ }));
    expect(await screen.findByText(/语法错误 · 第 1 行/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /保存为版本/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("loads a version to revise and saves the result as the next version", async () => {
    renderAt(<AiWriterPage />, "/ai?script=1&version=2");
    const editor = (await screen.findByLabelText("代码")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("print('v1')\n"));
    fireEvent.click(screen.getByRole("button", { name: /保存为版本/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("保存为小程序版本")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(posts("/api/ai/save")).toHaveLength(1));
    expect(posts("/api/ai/save")[0].body).toMatchObject({
      script_id: 1,
      base_version_id: 2,
      code: "print('v1')\n",
      publish: false,
    });
    expect(await screen.findByText("已保存为 签到 v1.0.1")).toBeTruthy();
    expect(screen.getByRole("button", { name: /下发到设备测试/ })).toBeTruthy();
  });
});

describe("系统设置 → AI 写脚本", () => {
  it("shows whether the key is set (never the key) and saves endpoint and model", async () => {
    renderAt(<SettingsPage />, "/settings?tab=ai");
    expect(await screen.findByText("已设置")).toBeTruthy();
    expect(screen.getByText("mock-coder")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("接口地址"), { target: { value: "http://127.0.0.1:11434/v1" } });
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "qwen-coder" } });
    fireEvent.click(screen.getAllByRole("button", { name: /保\s*存/ }).at(-1)!);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT" && c.path === "/api/settings")?.body).toEqual({
        ai_base_url: "http://127.0.0.1:11434/v1",
        ai_model: "qwen-coder",
      }),
    );
  });
});

describe("AI 写脚本 after saving", () => {
  it("keeps the saved version selected and its check result", async () => {
    routes["GET /api/ai/source/1/3"] = { code: generated.code, version: "1.0.1" };
    renderAt(<AiWriterPage />, "/ai?script=1&version=2");
    await screen.findByLabelText("代码");
    fireEvent.change(screen.getByLabelText("需求描述"), { target: { value: "改一下" } });
    fireEvent.click(screen.getByRole("button", { name: /按要求修改/ }));
    expect(await screen.findByText("语法正确")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /保存为版本/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /保\s*存/ }));
    expect(await screen.findByText("已保存为 签到 v1.0.1")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("语法正确")).toBeTruthy();
    expect(
      calls.some(
        (c) => c.path === "/api/ai/source/1/2" && calls.indexOf(c) > calls.findIndex((x) => x.path === "/api/ai/save"),
      ),
    ).toBe(false);
  });
});
