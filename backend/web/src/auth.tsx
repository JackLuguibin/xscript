import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Spin } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { api, setUnauthorizedHandler, type Role, type TotpRequired, type User } from "./api";

// 代理 has no staff rank: can() is false for every staff page; the 代理 console checks the role itself.
const RANK: Record<Role, number> = { reseller: -1, viewer: 0, operator: 1, admin: 2 };

interface AuthState {
  user: User | null;
  /** Resolves to "totp" when the password is right but a 两步验证 code is still needed. */
  login: (username: string, password: string, code?: string) => Promise<"ok" | "totp">;
  logout: () => Promise<void>;
  /** Replace the cached user, e.g. after turning 两步验证 on or off. */
  setUser: (u: User) => void;
  can: (role: Role) => boolean;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();
  // Signing out (or losing the session) must not leave the previous account's data in the cache
  // for whoever signs in next in this tab, possibly with a lower role.
  const signedOut = useCallback(() => {
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(signedOut);
    api
      .get<User>("/api/auth/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [signedOut]);

  const login = useCallback(async (username: string, password: string, code?: string) => {
    const r = await api.post<User | TotpRequired>("/api/auth/login", { username, password, code: code || undefined });
    if ("totp_required" in r) return "totp" as const;
    setUser(r);
    return "ok" as const;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      signedOut();
    }
  }, [signedOut]);

  const can = useCallback((role: Role) => !!user && RANK[user.role] >= RANK[role], [user]);

  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
        <Spin size="large" />
      </div>
    );
  }
  return <Ctx.Provider value={{ user, login, logout, setUser, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
