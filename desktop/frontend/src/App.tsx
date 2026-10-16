import { useState, type ReactElement } from "react";
import { useServices } from "./app-context";
import { DevicePage } from "./components/DevicePage";
import { useGlobalShortcuts } from "./components/GlobalShortcuts";
import { MirrorPage } from "./components/MirrorPage";
import { ProjectsPage } from "./components/ProjectsPage";
import { WallPage } from "./components/WallPage";
import { IconFlow, IconFolder, IconGrid, IconMark, IconMonitor, IconMoon, IconPhone, IconSun } from "./components/icons";
import { useLanguage } from "./i18n";
import type { ShellPage } from "./shortcuts";
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

function LangToggle({ lang, onChange }: { lang: "zh" | "en"; onChange: (l: "zh" | "en") => void }) {
  const next = lang === "zh" ? "en" : "zh";
  return (
    <button className="ghost nav-item" onClick={() => onChange(next)} aria-label={`${t.lang.label}：${t.lang[lang]}（${t.lang.switchTo}）`} title={`${t.lang.label}：${t.lang[lang]}`}>
      <span aria-hidden="true" className="lang-mark">{lang === "zh" ? "中" : "EN"}</span>
      <span className="label">
        {t.lang.label}：{t.lang[lang]}
      </span>
    </button>
  );
}

function Shell() {
  const { inShell } = useServices();
  const [lang, setLang] = useLanguage();
  const [page, setPage] = useState<ShellPage>("devices");
  const shortcuts = useGlobalShortcuts(page, setPage, lang, setLang);
  return (
    <div className={shortcuts.collapsed ? "app sidebar-collapsed" : "app"}>
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
          <button className="nav-item" aria-current={page === "devices" ? "page" : undefined} onClick={() => setPage("devices")}>
            <IconPhone />
            <span className="label">{t.nav.devices}</span>
          </button>
          <button className="nav-item" aria-current={page === "mirror" ? "page" : undefined} onClick={() => setPage("mirror")}>
            <IconMonitor />
            <span className="label">{t.nav.mirror}</span>
          </button>
          <button className="nav-item" aria-current={page === "projects" ? "page" : undefined} onClick={() => setPage("projects")}>
            <IconFolder />
            <span className="label">{t.nav.projects}</span>
          </button>
          <button className="nav-item" aria-current={page === "wall" ? "page" : undefined} onClick={() => setPage("wall")}>
            <IconGrid />
            <span className="label">{t.nav.wall}</span>
          </button>
          <button className="nav-item" disabled title={`${t.nav.soon}（${t.nav.p2}）`}>
            <IconFlow />
            <span className="label">{t.nav.flows}</span>
            <span className="tag">{t.nav.p2}</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <ThemeToggle />
          <LangToggle lang={lang} onChange={setLang} />
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div>
            <h1>{t.nav[page]}</h1>
            <p className="sub">{page === "devices" ? t.subtitle : page === "mirror" ? t.mirror.subtitle : page === "wall" ? t.wall.subtitle : t.projects.subtitle}</p>
          </div>
        </header>
        {!inShell && (
          <div className="banner warn" style={{ margin: "0 var(--sp-5) var(--sp-4)" }}>
            {t.demoBanner}
          </div>
        )}
        <main id="main" tabIndex={-1}>
          {page === "devices" ? (
            <DevicePage refreshToken={shortcuts.refreshToken} focusToken={shortcuts.focusToken} />
          ) : page === "mirror" ? (
            <MirrorPage />
          ) : page === "wall" ? (
            <WallPage />
          ) : (
            <ProjectsPage />
          )}
        </main>
      </div>
      {shortcuts.dialog}
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
