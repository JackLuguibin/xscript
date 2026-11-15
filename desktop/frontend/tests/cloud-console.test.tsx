import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { CloudConsole } from "../src/components/CloudConsole";
import { createDemoTransport } from "../src/demo";

it("renders all backend sections inside an isolated desktop guest", async () => {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  await api.cloudConnect("https://cloud.example.com", "xsk_admin");
  window.xscriptElectron = transport;
  try {
    render(<ServicesContext.Provider value={{ rpc, api, inShell: true }}><CloudConsole /></ServicesContext.Provider>);
    await screen.findByRole("navigation", { name: "后台功能" });
    expect(document.querySelector("webview")?.getAttribute("src")).toBe("https://cloud.example.com/");
    for (const name of ["设备密钥", "卡密管理", "代理管理", "应用运营", "AI 写脚本", "用户管理", "系统设置", "账号与安全"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "卡密管理" }));
    const guest = document.querySelector("webview")!;
    expect(guest.getAttribute("src")).toBe("https://cloud.example.com/cards");
    expect(guest.getAttribute("partition")).toBe("xscript-cloud-console");
    expect(guest.outerHTML).not.toMatch(/xsk_|preload|nodeintegration/);
    expect(transport.sent.find((message) => message.method === "cloud.console")?.params).toEqual({ embed: true });
  } finally {
    delete window.xscriptElectron;
    rpc.dispose();
  }
});

