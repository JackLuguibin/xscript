import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { useServices } from "../app-context";
import { CredentialsForm } from "./CredentialsForm";
import type { Lang } from "../strings";
import { t } from "../strings";
import { useTheme, type ThemeMode } from "../theme";
import { RpcError } from "../bridge/types";
import {
  CHORDS,
  NAV_PAGES,
  filterCommands,
  formatChord,
  isApplePlatform,
  isTextEntry,
  navChord,
  readSidebarCollapsed,
  readSingleKeyEnabled,
  shortcutAction,
  writeSidebarCollapsed,
  writeSingleKeyEnabled,
  type OverlayName,
  type ShellPage,
} from "../shortcuts";

export interface Command {
  id: string;
  label: string;
  keywords?: string;
  shortcut?: string;
  enabled?: boolean;
  run: () => void;
}

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
  );
}

/** Dialog shell: focus trap, backdrop click, and focus returned to whoever opened it (unless a command took focus). */
function Overlay({
  title,
  onClose,
  restoreFocus,
  initialFocus,
  children,
}: {
  title: string;
  onClose: () => void;
  restoreFocus: RefObject<boolean>;
  initialFocus?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = panel.current;
    // After every effect cleanup in this commit (the previous dialog may restore focus synchronously).
    queueMicrotask(() => {
      if (!root?.isConnected) return;
      const target = (initialFocus && root.querySelector<HTMLElement>(initialFocus)) || focusables(root)[0];
      target?.focus();
    });
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !root) return;
      const items = focusables(root);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    root?.addEventListener("keydown", onTab);
    return () => {
      root?.removeEventListener("keydown", onTab);
      if (restoreFocus.current && prev && document.contains(prev)) prev.focus();
      restoreFocus.current = true;
    };
  }, [initialFocus, restoreFocus]);
  return (
    <div className="overlay-backdrop" onMouseDown={onClose}>
      <div
        className="overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-dialog-title"
        ref={panel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="overlay-head">
          <h2 id="shortcut-dialog-title">{title}</h2>
          <button type="button" className="small" onClick={onClose}>
            {t.shortcuts.close}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CommandPalette({ commands, onRun, onClose, restoreFocus }: { commands: Command[]; onRun: (c: Command) => void; onClose: () => void; restoreFocus: RefObject<boolean> }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const shown = filterCommands(commands, query);
  const index = shown.length ? Math.min(active, shown.length - 1) : 0;
  const current = shown[index];
  return (
    <Overlay title={t.shortcuts.palette} onClose={onClose} restoreFocus={restoreFocus} initialFocus="#palette-input">
      <input
        id="palette-input"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={current ? `palette-opt-${current.id}` : undefined}
        aria-label={t.shortcuts.palette}
        placeholder={t.shortcuts.palettePlaceholder}
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (!shown.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(Math.min(shown.length - 1, index + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(Math.max(0, index - 1));
          } else if (e.key === "Home") {
            e.preventDefault();
            setActive(0);
          } else if (e.key === "End") {
            e.preventDefault();
            setActive(Math.max(0, shown.length - 1));
          } else if (e.key === "Enter" && current && current.enabled !== false) {
            e.preventDefault();
            onRun(current);
          }
        }}
      />
      {shown.length === 0 ? (
        <p role="status">{t.shortcuts.noMatch}</p>
      ) : (
        <ul id="palette-list" role="listbox" aria-label={t.shortcuts.palette} className="palette-list">
          {shown.map((cmd, i) => (
            <li key={cmd.id} role="presentation">
              <button
                type="button"
                role="option"
                id={`palette-opt-${cmd.id}`}
                aria-selected={i === index}
                aria-disabled={cmd.enabled === false}
                disabled={cmd.enabled === false}
                onMouseMove={() => setActive(i)}
                onClick={() => onRun(cmd)}
              >
                <span>{cmd.label}</span>
                {cmd.shortcut && <kbd className="kbd">{cmd.shortcut}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Overlay>
  );
}

function SettingsDialog({
  singleKey,
  onSingleKey,
  collapsed,
  onCollapsed,
  lang,
  setLang,
  onClose,
  restoreFocus,
}: {
  singleKey: boolean;
  onSingleKey: (on: boolean) => void;
  collapsed: boolean;
  onCollapsed: (on: boolean) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
  onClose: () => void;
  restoreFocus: RefObject<boolean>;
}) {
  const { api } = useServices();
  const { mode, setMode } = useTheme();
  const [adb, setAdb] = useState("");
  const [adbMsg, setAdbMsg] = useState("");
  const [adbErr, setAdbErr] = useState("");
  const [saving, setSaving] = useState(false);
  const edited = useRef(false);
  useEffect(() => {
    let dead = false;
    void api.hello(false).then(
      (h) => {
        if (!dead && !edited.current) setAdb(h.adbPath ?? "");
      },
      () => undefined,
    );
    return () => {
      dead = true;
    };
  }, [api]);
  const saveAdb = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setAdbMsg("");
    setAdbErr("");
    const typed = adb.trim();
    try {
      const res = await api.setAdbPath(typed);
      if (typed && !res.adbPath) setAdbErr(t.shortcuts.adbMissing);
      else {
        setAdb(res.adbPath ?? "");
        setAdbMsg(t.shortcuts.adbSaved);
      }
    } catch (err) {
      setAdbErr(err instanceof RpcError ? `${err.message} [${err.code}]` : err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const themes: ThemeMode[] = ["system", "light", "dark"];
  return (
    <Overlay title={t.shortcuts.settings} onClose={onClose} restoreFocus={restoreFocus}>
      <form onSubmit={(e) => void saveAdb(e)} className="settings-form">
        <fieldset>
          <legend>{t.theme.label}</legend>
          {themes.map((m) => (
            <label key={m}>
              <input type="radio" name="theme" checked={mode === m} onChange={() => setMode(m)} />
              {t.theme[m]}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>{t.lang.label}</legend>
          <label>
            <input type="radio" name="lang" checked={lang === "zh"} onChange={() => setLang("zh")} />
            {t.lang.zh}
          </label>
          <label>
            <input type="radio" name="lang" checked={lang === "en"} onChange={() => setLang("en")} />
            {t.lang.en}
          </label>
        </fieldset>
        <label>
          <input type="checkbox" checked={singleKey} onChange={(e) => onSingleKey(e.target.checked)} />
          {t.shortcuts.singleKey}
        </label>
        <p className="muted">{t.shortcuts.singleKeyHint}</p>
        <label>
          <input type="checkbox" checked={collapsed} onChange={(e) => onCollapsed(e.target.checked)} />
          {t.shortcuts.sidebarIcons}
        </label>
        <label className="stack">
          {t.shortcuts.adbPath}
          <input
            aria-label={t.shortcuts.adbPath}
            value={adb}
            onChange={(e) => {
              edited.current = true;
              setAdb(e.target.value);
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="muted">{t.shortcuts.adbPathHint}</p>
        {adbErr && (
          <p className="banner error" role="alert">
            {adbErr}
          </p>
        )}
        {adbMsg && (
          <p role="status" className="muted">
            {adbMsg}
          </p>
        )}
        <button type="submit" className="primary" disabled={saving}>
          {t.saved.save}
        </button>
      </form>
      <CredentialsForm />
    </Overlay>
  );
}

function HelpDialog({ onClose, restoreFocus }: { onClose: () => void; restoreFocus: RefObject<boolean> }) {
  const apple = isApplePlatform();
  const rows: Array<[string, string]> = [
    [t.shortcuts.palette, formatChord(CHORDS.palette, apple)],
    [`${t.shortcuts.refreshAdb}（${t.nav.devices}）`, `${formatChord(CHORDS.refresh, apple)} / F5`],
    [t.shortcuts.focusAddress, formatChord(CHORDS.address, apple)],
    [t.nav.devices, `${formatChord(navChord(1), apple)}…${formatChord(navChord(9), apple)}`],
    [t.shortcuts.settings, formatChord(CHORDS.settings, apple)],
    [t.shortcuts.sidebarCollapse, formatChord(CHORDS.sidebar, apple)],
    [t.theme.switchTo, formatChord(CHORDS.theme, apple)],
    [t.shortcuts.helpTitle, "?"],
    [t.shortcuts.close, "Esc"],
  ];
  return (
    <Overlay title={t.shortcuts.helpTitle} onClose={onClose} restoreFocus={restoreFocus}>
      <p className="muted">{t.shortcuts.modNote}</p>
      <table className="shortcut-table">
        <tbody>
          {rows.map(([label, keys]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>
                <kbd className="kbd">{keys}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Overlay>
  );
}

export function useGlobalShortcuts(page: ShellPage, setPage: (page: ShellPage) => void, lang: Lang, setLang: (lang: Lang) => void) {
  const { cycle } = useTheme();
  const [overlay, setOverlay] = useState<OverlayName | null>(null);
  const [collapsed, setCollapsedState] = useState(readSidebarCollapsed);
  const [singleKey, setSingleKeyState] = useState(readSingleKeyEnabled);
  const [refreshToken, setRefreshToken] = useState(0);
  const [focusToken, setFocusToken] = useState(0);
  const restoreFocus = useRef(true);
  const pageRef = useRef(page);
  pageRef.current = page;

  const setCollapsed = (on: boolean) => {
    setCollapsedState(on);
    writeSidebarCollapsed(on);
  };
  const setSingleKey = (on: boolean) => {
    setSingleKeyState(on);
    writeSingleKeyEnabled(on);
  };
  const close = () => setOverlay(null);

  const commands = useMemo<Command[]>(() => {
    const go = (p: ShellPage) => () => {
      close();
      setPage(p);
    };
    return [
      { id: "devices", label: t.nav.devices, keywords: "devices 设备", shortcut: formatChord(navChord(1)), run: go("devices") },
      { id: "mirror", label: t.nav.mirror, keywords: "mirror screen 屏幕", shortcut: formatChord(navChord(2)), run: go("mirror") },
      { id: "projects", label: t.nav.projects, keywords: "projects 工程", shortcut: formatChord(navChord(3)), run: go("projects") },
      { id: "wall", label: t.nav.wall, keywords: "wall 墙 thumbnails 设备墙", shortcut: formatChord(navChord(4)), run: go("wall") },
      { id: "flows", label: `${t.nav.flows}（${t.nav.p2}）`, keywords: "flows 流程", shortcut: formatChord(navChord(5)), enabled: false, run: () => undefined },
      {
        id: "refresh",
        label: t.shortcuts.refreshAdb,
        keywords: "adb refresh 刷新 f5",
        shortcut: `${formatChord(CHORDS.refresh)} / F5`,
        run: () => {
          close();
          setPage("devices");
          setRefreshToken((n) => n + 1);
        },
      },
      {
        id: "address",
        label: t.shortcuts.focusAddress,
        keywords: "address 地址 focus",
        shortcut: formatChord(CHORDS.address),
        run: () => {
          restoreFocus.current = false;
          close();
          setPage("devices");
          setFocusToken((n) => n + 1);
        },
      },
      { id: "theme", label: `${t.theme.label}：${t.theme.switchTo}`, keywords: "theme 主题", shortcut: formatChord(CHORDS.theme), run: () => { close(); cycle(); } },
      {
        id: "lang",
        label: `${t.lang.label}：${t.lang.switchTo}`,
        keywords: "language 语言 english 中文",
        run: () => {
          close();
          setLang(lang === "zh" ? "en" : "zh");
        },
      },
      {
        id: "sidebar",
        label: collapsed ? t.shortcuts.sidebarExpand : t.shortcuts.sidebarCollapse,
        keywords: "sidebar 侧边栏",
        shortcut: formatChord(CHORDS.sidebar),
        run: () => {
          close();
          setCollapsed(!collapsed);
        },
      },
      { id: "settings", label: t.shortcuts.settings, keywords: "settings 设置 adb", shortcut: formatChord(CHORDS.settings), run: () => setOverlay("settings") },
      { id: "help", label: t.shortcuts.helpTitle, keywords: "help shortcuts 快捷键 keyboard", shortcut: "?", run: () => setOverlay("help") },
    ];
    // `t` updates when `lang` changes; collapsed/cycle/setLang are the other live inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, collapsed, cycle, setLang, setPage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutAction(e, { overlay, page: pageRef.current, singleKey, typing: isTextEntry(e.target) });
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action.type === "palette") setOverlay((cur) => (cur === "palette" ? null : "palette"));
      else if (action.type === "close") setOverlay(null);
      else if (action.type === "help") setOverlay("help");
      else if (action.type === "settings") setOverlay("settings");
      else if (action.type === "sidebar") setCollapsed(!readSidebarCollapsed());
      else if (action.type === "theme") cycle();
      else if (action.type === "refresh") setRefreshToken((n) => n + 1);
      else if (action.type === "address") {
        setPage("devices");
        setFocusToken((n) => n + 1);
      } else if (action.type === "nav") {
        const next = NAV_PAGES[action.index];
        if (next) setPage(next);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [overlay, singleKey, cycle, setPage]);

  const run = (cmd: Command) => {
    if (cmd.enabled === false) return;
    cmd.run();
  };

  const dialog =
    overlay === "palette" ? (
      <CommandPalette commands={commands} onRun={run} onClose={close} restoreFocus={restoreFocus} />
    ) : overlay === "settings" ? (
      <SettingsDialog
        singleKey={singleKey}
        onSingleKey={setSingleKey}
        collapsed={collapsed}
        onCollapsed={setCollapsed}
        lang={lang}
        setLang={setLang}
        onClose={close}
        restoreFocus={restoreFocus}
      />
    ) : overlay === "help" ? (
      <HelpDialog onClose={close} restoreFocus={restoreFocus} />
    ) : null;

  return { collapsed, refreshToken, focusToken, dialog };
}
