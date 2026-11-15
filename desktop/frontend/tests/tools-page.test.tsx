import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { App } from "../src/App";
import { ServicesContext } from "../src/app-context";
import { createApi } from "../src/api";
import { RpcClient } from "../src/bridge/client";
import { createDemoTransport } from "../src/demo";

it("opens device tools from a peer of the screen page", async () => {
  const transport = createDemoTransport();
  const rpc = new RpcClient(transport);
  const api = createApi(rpc);
  await api.connectAdb("emulator-5554");
  render(<ServicesContext.Provider value={{ rpc, api, inShell: true }}><App /></ServicesContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "工具" }));
  await screen.findByTitle("图色工具");
  expect(transport.sent.filter((m) => m.method === "tools.open").at(-1)?.params).toMatchObject({ page: "color", embed: true });
  expect(screen.queryByRole("tablist")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "屏幕" }));
  await screen.findByRole("button", { name: "刷新控件树" });
  expect(screen.queryByRole("button", { name: "图色工具" })).toBeNull();
});
