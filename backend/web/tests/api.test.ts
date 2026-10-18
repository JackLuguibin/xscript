import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiError, api, download, request, setUnauthorizedHandler } from "../src/api";

function reply(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) {
  const json = typeof body !== "string";
  return new Response(json ? JSON.stringify(body) : body, {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { "content-type": json ? "application/json" : "text/plain", ...init.headers },
  });
}

let fetchMock: Mock<typeof fetch>;
let unauthorized: Mock<() => void>;

/** The RequestInit of the n-th fetch call (request() always passes plain-object headers). */
const sent = (n: number) => fetchMock.mock.calls[n][1] as RequestInit & { headers: Record<string, string> };

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  unauthorized = vi.fn<() => void>();
  setUnauthorizedHandler(unauthorized);
});

describe("request", () => {
  it("sends the CSRF header, JSON bodies and a query string without empty values", async () => {
    fetchMock.mockResolvedValue(reply({ ok: true }));
    await expect(api.get("/api/devices", { q: "a b", page: 2, online: false, app: "", group: null })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/devices?q=a+b&page=2&online=false");
    expect(sent(0)).toMatchObject({ method: "GET", credentials: "same-origin", headers: { "X-XScript-Csrf": "1" } });

    fetchMock.mockResolvedValue(reply({ id: 1 }));
    await api.post("/api/tasks", { name: "t" });
    expect(sent(1).headers["Content-Type"]).toBe("application/json");
    expect(sent(1).body).toBe('{"name":"t"}');
  });

  it("passes FormData through untouched and returns non-JSON bodies as a Blob", async () => {
    fetchMock.mockResolvedValue(reply("PK..."));
    const form = new FormData();
    form.set("file", "x");
    const out = await request<Blob>("POST", "/api/scripts/1/versions", form);
    expect(sent(0).body).toBe(form);
    expect(sent(0).headers["Content-Type"]).toBeUndefined();
    expect(out).toBeInstanceOf(Blob);
    expect(await out.text()).toBe("PK...");
  });

  it.each([
    ["a string error", reply({ error: "设备不存在" }, { status: 404 }), 404, "设备不存在"],
    ["a structured error", reply({ error: [{ loc: ["body"], msg: "bad" }] }, { status: 422 }), 422, '[{"loc":["body"],"msg":"bad"}]'],
    ["JSON without error", reply({ detail: "x" }, { status: 400 }), 400, '{"detail":"x"}'],
    ["a non-JSON body", reply("<html>", { status: 502, statusText: "Bad Gateway" }), 502, "Bad Gateway"],
    ["no status text", reply("", { status: 500 }), 500, "HTTP 500"],
  ])("turns %s into an ApiError", async (_name, res, status, message) => {
    fetchMock.mockResolvedValue(res);
    const err = await api.get("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status, message });
  });

  it("reports 401 to the handler, except for the login call itself", async () => {
    fetchMock.mockResolvedValue(reply({ error: "未登录" }, { status: 401 }));
    await expect(api.get("/api/devices")).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(reply({ error: "用户名或密码错误" }, { status: 401 }));
    await expect(api.post("/api/auth/login", { username: "a" })).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(reply({ error: "权限不足" }, { status: 403 }));
    await expect(api.del("/api/users/1")).rejects.toMatchObject({ status: 403 });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
});

describe("download", () => {
  let names: string[];

  beforeEach(() => {
    names = [];
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
  });

  it.each([
    ['attachment; filename="logs-dev1-20260101.txt"', "logs-dev1-20260101.txt"],
    ["attachment; filename=cards.csv", "cards.csv"],
    ["attachment; filename*=UTF-8''%E5%8D%A1%E5%AF%86.csv", "卡密.csv"],
    ['attachment; filename="50%off.apk"', "50%off.apk"], // not percent-encoding: kept as is
    ["inline", "fallback.bin"],
  ])("names the file from %s", async (cd, name) => {
    fetchMock.mockResolvedValue(reply("data", { headers: { "content-disposition": cd } }));
    await download("/api/x", { a: 1 }, "fallback.bin");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/x?a=1");
    expect(names).toEqual([name]);
    expect(document.querySelector("a[download]")).toBeNull(); // the temporary link is removed
  });

  it("reports 401 and throws instead of saving an error page", async () => {
    fetchMock.mockResolvedValue(reply({ error: "登录已失效" }, { status: 401 }));
    await expect(download("/api/x")).rejects.toMatchObject({ status: 401, message: "登录已失效" });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(names).toEqual([]);
  });
});
