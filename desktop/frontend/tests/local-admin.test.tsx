import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { BackendPage } from "../src/components/BackendPage";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { createDemoTransport } from "../src/demo";

it("opens native local administration with no cloud connection or embedded browser", async () => {
  const transport = createDemoTransport();
  transport.setHandler("admin.catalog", () => ({ local: true, operations: [
    { id: "GET /api/overview", method: "GET", path: "/api/overview", group: "overview", title: "Overview", parameters: [], body: {}, media: "" },
    { id: "POST /api/scripts", method: "POST", path: "/api/scripts", group: "scripts", title: "Create", parameters: [], body: { type: "object", required: ["name", "project_name"], properties: { name: { type: "string" }, project_name: { type: "string" } } }, media: "application/json" },
  ] }));
  transport.setHandler("admin.execute", (params) => params.operation === "GET /api/overview" ? { devices: 0 } : { name: (params.body as {name: string}).name });
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  render(<ServicesContext.Provider value={{ rpc, api, inShell: true }}><BackendPage /></ServicesContext.Provider>);
  await screen.findByText("本地服务");
  await screen.findByRole("navigation", { name: "后台管理分区" });
  expect(screen.queryByRole("button", { name: "连接后台" })).toBeNull();
  expect(document.querySelector("webview, iframe")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "小程序" }));
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), { target: { value: "local" } });
  fireEvent.change(screen.getByRole("textbox", { name: "工程名" }), { target: { value: "example" } });
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  await waitFor(() => expect(transport.sent.some((m) => m.method === "admin.execute" && m.params?.operation === "POST /api/scripts")).toBe(true));
  expect(transport.sent.some((m) => ["cloud.connect", "cloud.console", "cloud.manage"].includes(m.method))).toBe(false);
});
