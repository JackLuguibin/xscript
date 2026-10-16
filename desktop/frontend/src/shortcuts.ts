// Global shortcuts (design §14.13). On macOS the table's Ctrl is ⌘; elsewhere it is Ctrl.
// Single-key "?" can be turned off (WCAG 2.1.4). Chords still work while typing; "?" does not.

export type ShellPage = "devices" | "mirror" | "projects" | "wall";

/** Nav order for Ctrl/⌘+1…9. Index 4 is the disabled Flows item; 5–8 have no item. */
export const NAV_PAGES: readonly ShellPage[] = ["devices", "mirror", "projects", "wall"];

export type OverlayName = "palette" | "settings" | "help";

export interface Chord {
  key: string;
  mod?: boolean;
  shift?: boolean;
}

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

export type ShortcutAction =
  | { type: "palette" | "help" | "settings" | "sidebar" | "theme" | "refresh" | "address" | "close" | "noop" }
  | { type: "nav"; index: number };

export const CHORDS = {
  palette: { key: "k", mod: true },
  refresh: { key: "r", mod: true },
  address: { key: "l", mod: true },
  settings: { key: ",", mod: true },
  sidebar: { key: "b", mod: true },
  theme: { key: "t", mod: true, shift: true },
} as const satisfies Record<string, Chord>;

export function navChord(n: number): Chord {
  return { key: String(n), mod: true };
}

export function isApplePlatform(nav: Pick<Navigator, "platform" | "userAgent"> = navigator): boolean {
  return /Mac|iPhone|iPad|iPod/.test(nav.platform || "") || /Mac OS X/.test(nav.userAgent || "");
}

export function matchChord(e: KeyEventLike, chord: Chord, apple = isApplePlatform()): boolean {
  if (e.repeat || e.isComposing || e.altKey) return false;
  const wantMod = Boolean(chord.mod);
  const gotMod = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (wantMod !== gotMod) return false;
  if (Boolean(chord.shift) !== e.shiftKey) return false;
  const got = chord.key.length === 1 ? e.key.toLowerCase() : e.key;
  const want = chord.key.length === 1 ? chord.key.toLowerCase() : chord.key;
  return got === want;
}

/** "?" with no modifier. Shift is often held to type it, so shift is not rejected. */
export function isHelpKey(e: KeyEventLike): boolean {
  return e.key === "?" && !e.repeat && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey;
}

export function isBareF5(e: KeyEventLike): boolean {
  return e.key === "F5" && !e.repeat && !e.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** Text fields, Monaco, and contenteditable. Checkboxes and radios are not text entry. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    const type = (target.type || "text").toLowerCase();
    return !["button", "checkbox", "radio", "submit", "reset", "file", "image", "color", "range"].includes(type);
  }
  return Boolean(target.closest(".monaco-editor"));
}

export function formatChord(chord: Chord, apple = isApplePlatform()): string {
  const parts: string[] = [];
  if (chord.mod) parts.push(apple ? "⌘" : "Ctrl");
  if (chord.shift) parts.push(apple ? "⇧" : "Shift");
  parts.push(chord.key.length === 1 && /[a-z]/i.test(chord.key) ? chord.key.toUpperCase() : chord.key);
  return apple ? parts.join("") : parts.join("+");
}

export function filterCommands<T extends { label: string; keywords?: string }>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((item) => `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(q));
}

export interface ShortcutContext {
  overlay: OverlayName | null;
  page: ShellPage;
  singleKey: boolean;
  typing: boolean;
  apple?: boolean;
}

/**
 * What a keydown should do. `noop` means "swallow this chord" (Ctrl/⌘+R off the device page must not reload the shell).
 * F5 is only claimed on the device page, so the editor keeps F5 for debug.
 */
export function shortcutAction(e: KeyEventLike, ctx: ShortcutContext): ShortcutAction | null {
  if (e.repeat || e.isComposing) return null;
  const apple = ctx.apple ?? isApplePlatform();
  if (matchChord(e, CHORDS.palette, apple)) return { type: "palette" };
  if (ctx.overlay) {
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return { type: "close" };
    return null;
  }
  if (isHelpKey(e)) return ctx.typing || !ctx.singleKey ? null : { type: "help" };
  if (matchChord(e, CHORDS.settings, apple)) return { type: "settings" };
  if (matchChord(e, CHORDS.sidebar, apple)) return { type: "sidebar" };
  if (matchChord(e, CHORDS.theme, apple)) return { type: "theme" };
  if (matchChord(e, CHORDS.address, apple)) return { type: "address" };
  if (matchChord(e, CHORDS.refresh, apple)) return ctx.page === "devices" ? { type: "refresh" } : { type: "noop" };
  if (isBareF5(e) && ctx.page === "devices") return { type: "refresh" };
  if (/^[1-9]$/.test(e.key) && matchChord(e, { key: e.key, mod: true }, apple)) return { type: "nav", index: Number(e.key) - 1 };
  return null;
}

const SIDEBAR_KEY = "xscript.sidebar";
const SINGLE_KEY = "xscript.singleKeyShortcuts";

export function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "collapsed";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(SIDEBAR_KEY, "collapsed");
    else window.localStorage.removeItem(SIDEBAR_KEY);
  } catch {
    /* private mode: the choice just is not remembered */
  }
}

/** Default on. Stored as "0" when the user turns the single-key shortcut off. */
export function readSingleKeyEnabled(): boolean {
  try {
    return window.localStorage.getItem(SINGLE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeSingleKeyEnabled(on: boolean): void {
  try {
    if (on) window.localStorage.removeItem(SINGLE_KEY);
    else window.localStorage.setItem(SINGLE_KEY, "0");
  } catch {
    /* private mode */
  }
}
