import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeMode = "system" | "light" | "dark";
const KEY = "xscript.theme";
const ORDER: ThemeMode[] = ["system", "light", "dark"];

export function readStoredMode(): ThemeMode {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system"; // storage can be unavailable (private profile): the theme just is not remembered
  }
}

/** "system" removes data-theme so the prefers-color-scheme block in tokens.css decides; light/dark pin it. */
export function applyMode(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

export function nextMode(m: ThemeMode): ThemeMode {
  return ORDER[(ORDER.indexOf(m) + 1) % ORDER.length];
}

interface ThemeCtx {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  cycle: () => void;
}
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  useEffect(() => applyMode(mode), [mode]);
  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try {
      if (m === "system") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, m);
    } catch {
      /* not persisted */
    }
  }, []);
  const cycle = useCallback(() => setMode(nextMode(mode)), [mode, setMode]);
  const value = useMemo(() => ({ mode, setMode, cycle }), [mode, setMode, cycle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("ThemeProvider is missing");
  return c;
}
