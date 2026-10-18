import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "../src/auth";
import { api } from "../src/api";
import { createQueryClient } from "../src/queryClient";

const admin = { id: 1, username: "admin", role: "admin", disabled: false, created_at: 0, last_login_at: null,
  totp_enabled: false, needs_totp_setup: false };

let auth: ReturnType<typeof useAuth>;
function Probe() {
  auth = useAuth();
  return <div>{auth.user ? `user:${auth.user.username}` : "signed out"}</div>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function setup(logoutStatus = 200) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/auth/me") return json(admin);
    if (url === "/api/auth/logout") return json(logoutStatus === 200 ? { ok: true } : { error: "x" }, logoutStatus);
    return json({ error: "登录已失效" }, 401);
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = createQueryClient();
  client.setQueryData(["cards"], { items: ["secret"], total: 1 });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("user:admin");
  return { client, fetchMock };
}

describe("AuthProvider", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("logout clears the user and every cached query", async () => {
    const { client, fetchMock } = await setup();
    expect(auth.can("operator")).toBe(true);
    await act(() => auth.logout());
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
    expect(screen.getByText("signed out")).toBeTruthy();
    expect(client.getQueryData(["cards"])).toBeUndefined();
    expect(auth.can("viewer")).toBe(false);
  });

  it("still signs out locally when the logout request fails", async () => {
    const { client } = await setup(500);
    await act(async () => {
      await auth.logout().catch(() => {});
    });
    expect(screen.getByText("signed out")).toBeTruthy();
    expect(client.getQueryData(["cards"])).toBeUndefined();
  });

  it("a 401 from any request signs out and clears the cache", async () => {
    const { client } = await setup();
    await act(async () => {
      await api.get("/api/cards").catch(() => {});
    });
    await waitFor(() => expect(screen.getByText("signed out")).toBeTruthy());
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});
