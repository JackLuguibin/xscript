import { useEffect, useState, type ReactElement } from "react";
import { useServices } from "./app-context";
import { DevicePage } from "./components/DevicePage";
import { useGlobalShortcuts } from "./components/GlobalShortcuts";
import { MirrorPage } from "./components/MirrorPage";
import { ProjectsPage } from "./components/ProjectsPage";
import { Alert } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { WallPage } from "./components/WallPage";
import { DeviceProvider, useCurrentDevice } from "./device-context";
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
    <Button variant="nav" onClick={cycle} aria-label={`${t.theme.label}：${t.theme[mode]}（${t.theme.switchTo}）`} title={`${t.theme.label}：${t.theme[mode]}`}>
      <Icon />
      <span className="label">
        {t.theme.label}：{t.theme[mode]}
      </span>
    </Button>
  );
}

function LangToggle({ lang, onChange }: { lang: "zh" | "en"; onChange: (l: "zh" | "en") => void }) {
  const next = lang === "zh" ? "en" : "zh";
  return (
    <Button variant="nav" onClick={() => onChange(next)} aria-label={`${t.lang.label}：${t.lang[lang]}（${t.lang.switchTo}）`} title={`${t.lang.label}：${t.lang[lang]}`}>
      <span aria-hidden="true" className="lang-mark">{lang === "zh" ? "中" : "EN"}</span>
      <span className="label">
        {t.lang.label}：{t.lang[lang]}
      </span>
    </Button>
  );
}

/** Top-bar device switcher: the app-wide current device (mirror and projects follow it; remembered across restarts). */
function DeviceSwitcher() {
  const { devices, devId, select } = useCurrentDevice();
  return (
    <label className="row device-switcher">
      <span className="muted">{t.flow.current}</span>
      <select aria-label={t.flow.current} value={devId} disabled={devices.length === 0} onChange={(e) => void select(e.target.value)}>
        {devId === "" && <option value="">{t.flow.noDevice}</option>}
        {devices.map((d) => (
          <option key={d.id} value={d.id} disabled={d.state !== "online" && d.id !== devId}>
            {(d.name || d.info.name || d.info.model || d.id) + (d.state !== "online" ? `（${t.state[d.state] ?? d.state}）` : "")}
          </option>
        ))}
      </select>
    </label>
  );
}

function Shell() {
  const { api, inShell } = useServices();
  const [lang, setLang] = useLanguage();
  const [page, setPage] = useState<ShellPage>("devices");
  // The projects page holds the editor buffer, open file and logs: once opened it stays mounted (hidden) so that
  // switching pages never throws unsaved edits away. Mirror/wall still unmount (they hold device viewer slots / polls).
  const [projectsOpened, setProjectsOpened] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const shortcuts = useGlobalShortcuts(page, setPage, lang, setLang);
  useEffect(() => {
    if (page === "projects") setProjectsOpened(true);
  }, [page]);
  // Tell the shell (MainWindow.closeEvent asks before closing; the language picks the prompt's wording).
  useEffect(() => {
    void api.setUnsaved(unsaved, lang).catch(() => undefined);
  }, [api, unsaved, lang]);
  return (
    // the provider owns the current device and asks before a switch would drop unsaved edits (the projects page may be hidden)
    <DeviceProvider unsaved={unsaved}>
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
            <Button variant="nav" aria-current={page === "devices" ? "page" : undefined} onClick={() => setPage("devices")}>
              <IconPhone />
              <span className="label">{t.nav.devices}</span>
            </Button>
            <Button variant="nav" aria-current={page === "mirror" ? "page" : undefined} onClick={() => setPage("mirror")}>
              <IconMonitor />
              <span className="label">{t.nav.mirror}</span>
            </Button>
            <Button
              variant="nav"
              aria-current={page === "projects" ? "page" : undefined}
              onClick={() => setPage("projects")}
              title={unsaved ? t.unsavedNav : undefined}
            >
              <IconFolder />
              <span className="label">{t.nav.projects}</span>
              {unsaved && (
                <span className="unsaved-dot" role="img" aria-label={t.unsavedNav} />
              )}
            </Button>
            <Button variant="nav" aria-current={page === "wall" ? "page" : undefined} onClick={() => setPage("wall")}>
              <IconGrid />
              <span className="label">{t.nav.wall}</span>
            </Button>
            <Button variant="nav" disabled title={`${t.nav.soon}（${t.nav.p2}）`}>
              <IconFlow />
              <span className="label">{t.nav.flows}</span>
              <span className="tag">{t.nav.p2}</span>
            </Button>
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
            <span className="grow" />
            <DeviceSwitcher />
          </header>
          {!inShell && (
            <Alert tone="warn" className="mx-sp-5 mb-sp-4">
              {t.demoBanner}
            </Alert>
          )}
          <main id="main" tabIndex={-1}>
            {page === "devices" ? (
              <DevicePage refreshToken={shortcuts.refreshToken} focusToken={shortcuts.focusToken} onNavigate={setPage} />
            ) : page === "mirror" ? (
              <MirrorPage />
            ) : page === "wall" ? (
              <WallPage />
            ) : null}
            {(projectsOpened || page === "projects") && (
              <div className="keep-alive" hidden={page !== "projects"}>
                <ProjectsPage onDirtyChange={setUnsaved} />
              </div>
            )}
          </main>
        </div>
        {shortcuts.dialog}
      </div>
    </DeviceProvider>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
