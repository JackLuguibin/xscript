import type { ReactElement } from "react";
import { useServices } from "./app-context";
import { DevicePage } from "./components/DevicePage";
import { IconFlow, IconFolder, IconMark, IconMonitor, IconMoon, IconPhone, IconSun } from "./components/icons";
import { t } from "./strings";
import { ThemeProvider, useTheme, type ThemeMode } from "./theme";

const THEME_ICON: Record<ThemeMode, () => ReactElement> = { system: () => <IconMonitor />, light: () => <IconSun />, dark: () => <IconMoon /> };

function ThemeToggle() {
  const { mode, cycle } = useTheme();
  const Icon = THEME_ICON[mode];
  return (
    <button className="ghost nav-item" onClick={cycle} aria-label={`${t.theme.label}：${t.theme[mode]}（${t.theme.switchTo}）`} title={`${t.theme.label}：${t.theme[mode]}`}>
      <Icon />
      <span className="label">
        {t.theme.label}：{t.theme[mode]}
      </span>
    </button>
  );
}

function Shell() {
  const { inShell } = useServices();
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        {t.skip}
      </a>
      <aside className="sidebar" aria-label="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <IconMark size={16} />
          </span>
          <span className="brand-text">{t.appTitle}</span>
        </div>
        <nav className="nav" aria-label="main">
          <button className="nav-item" aria-current="page">
            <IconPhone />
            <span className="label">{t.nav.devices}</span>
          </button>
          <button className="nav-item" disabled title={`${t.nav.soon}（${t.nav.p1}）`}>
            <IconFolder />
            <span className="label">{t.nav.projects}</span>
            <span className="tag">{t.nav.p1}</span>
          </button>
          <button className="nav-item" disabled title={`${t.nav.soon}（${t.nav.p2}）`}>
            <IconFlow />
            <span className="label">{t.nav.flows}</span>
            <span className="tag">{t.nav.p2}</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <ThemeToggle />
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div>
            <h1>{t.nav.devices}</h1>
            <p className="sub">{t.subtitle}</p>
          </div>
        </header>
        {!inShell && (
          <div className="banner warn" style={{ margin: "0 var(--sp-5) var(--sp-4)" }}>
            {t.demoBanner}
          </div>
        )}
        <main id="main" tabIndex={-1}>
          <DevicePage />
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
