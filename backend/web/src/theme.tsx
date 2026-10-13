import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ConfigProvider, theme as antdTheme, type ThemeConfig } from "antd";
import zhCN from "antd/locale/zh_CN";

export type ThemeMode = "light" | "dark" | "system";

interface ThemeState {
  mode: ThemeMode;
  dark: boolean;
  setMode: (m: ThemeMode) => void;
}

const Ctx = createContext<ThemeState>({ mode: "system", dark: false, setMode: () => {} });
const STORAGE_KEY = "xs-theme";
const PRIMARY = "#4f5bd5";

function readMode(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function useSystemDark() {
  const mq = useMemo(() => window.matchMedia("(prefers-color-scheme: dark)"), []);
  const [dark, setDark] = useState(mq.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [mq]);
  return dark;
}

function buildTheme(dark: boolean): ThemeConfig {
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    cssVar: { key: "xs" },
    token: {
      colorPrimary: PRIMARY,
      colorInfo: PRIMARY,
      colorSuccess: "#16a34a",
      colorWarning: "#d97706",
      colorError: "#dc2626",
      borderRadius: 8,
      borderRadiusLG: 12,
      fontFamily:
        'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      fontFamilyCode: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
      colorBgLayout: dark ? "#0b0d12" : "#f5f6f8",
      colorBgContainer: dark ? "#13161d" : "#ffffff",
      colorBgElevated: dark ? "#1a1e27" : "#ffffff",
      colorBorder: dark ? "#2a303c" : "#e2e5ea",
      colorBorderSecondary: dark ? "#1f242e" : "#eceef2",
      colorText: dark ? "#e6e8ee" : "#111827",
      colorTextSecondary: dark ? "#9aa3b2" : "#5b6474",
      colorTextTertiary: dark ? "#6b7383" : "#8a93a3",
      controlHeight: 34,
      boxShadowTertiary: dark ? "0 0 0 1px rgba(255,255,255,.02)" : "0 1px 2px rgba(16,24,40,.04)",
    },
    components: {
      Layout: {
        siderBg: dark ? "#0f1218" : "#ffffff",
        headerBg: "transparent",
        bodyBg: dark ? "#0b0d12" : "#f5f6f8",
      },
      Menu: {
        itemBg: "transparent",
        subMenuItemBg: "transparent",
        itemHeight: 38,
        itemBorderRadius: 8,
        itemMarginInline: 10,
        itemMarginBlock: 2,
        itemColor: dark ? "#a8b0bf" : "#4b5563",
        itemHoverBg: dark ? "rgba(255,255,255,.05)" : "#f1f3f6",
        itemSelectedBg: dark ? "rgba(99,112,241,.18)" : "#eef0fd",
        itemSelectedColor: dark ? "#a5adff" : PRIMARY,
        groupTitleColor: dark ? "#5f6878" : "#9aa1ad",
        groupTitleFontSize: 12,
        activeBarBorderWidth: 0,
        iconSize: 16,
        collapsedIconSize: 17,
      },
      Card: {
        headerFontSize: 15,
        headerHeight: 52,
      },
      Table: {
        headerBg: dark ? "#161a22" : "#f8f9fb",
        headerColor: dark ? "#9aa3b2" : "#5b6474",
        headerSplitColor: "transparent",
        rowHoverBg: dark ? "#181c25" : "#f8f9fc",
        cellPaddingBlockMD: 12,
        borderColor: dark ? "#1f242e" : "#eef0f3",
      },
      Button: {
        primaryShadow: "none",
        defaultShadow: "none",
        dangerShadow: "none",
        fontWeight: 500,
      },
      Tabs: { horizontalMargin: "0 0 12px 0" },
      Tag: { defaultBg: dark ? "#1c212b" : "#f3f4f6" },
      Modal: { titleFontSize: 16 },
      Statistic: { contentFontSize: 28 },
    },
  };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const systemDark = useSystemDark();
  const dark = mode === "dark" || (mode === "system" && systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);

  const setMode = (m: ThemeMode) => {
    setModeState(m);
    if (m === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, m);
  };

  const config = useMemo(() => buildTheme(dark), [dark]);
  return (
    <Ctx.Provider value={{ mode, dark, setMode }}>
      <ConfigProvider
        locale={zhCN}
        theme={config}
        card={{ variant: "outlined" }}
        tag={{ variant: "filled" }}
      >
        {children}
      </ConfigProvider>
    </Ctx.Provider>
  );
}

export const useThemeMode = () => useContext(Ctx);
