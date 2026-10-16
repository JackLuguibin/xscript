import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// WCAG 2.2 contrast of the design tokens (docs/桌面端设计.md §14.13/§14.15). tokens.css is the single source of truth: parse it.
const css = readFileSync("src/styles/tokens.css", "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector + " {");
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("\n}", start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) vars[m[1]] = m[2];
  return vars;
}

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const light = block(":root");
const dark = block(':root[data-theme="dark"]');
const darkMedia = block("  :root:not([data-theme])");

// [foreground, background, minimum ratio, why]
const PAIRS: Array<[string, string, number, string]> = [
  ["text", "bg", 4.5, "body text on page"], ["text", "surface", 4.5, "body text on cards"], ["text", "surface-2", 4.5, "text on tiles/hover"],
  ["text-muted", "surface", 4.5, "secondary text on cards"], ["text-muted", "bg", 4.5, "secondary text on page"], ["text-muted", "surface-2", 4.5, "secondary text on hover"],
  ["text-muted", "sidebar", 4.5, "sidebar items"], ["text", "sidebar", 4.5, "sidebar brand"],
  ["primary", "surface", 4.5, "primary text/links on cards"], ["primary", "primary-soft", 4.5, "active nav item"],
  ["text-on-primary", "primary", 4.5, "primary button label"], ["text-on-primary", "primary-hover", 4.5, "primary button label (hover)"],
  ["success-fg", "success-bg", 4.5, "online badge"], ["warning-fg", "warning-bg", 4.5, "warning badge/banner"], ["danger-fg", "danger-bg", 4.5, "error badge/banner"],
  ["neutral-fg", "neutral-bg", 4.5, "neutral badge"], ["danger-fg", "surface", 4.5, "danger button"],
  ["border-strong", "surface", 3, "input/button boundary (WCAG 1.4.11)"], ["border-strong", "bg", 3, "empty-state dashed boundary"],
  ["focus-ring", "surface", 3, "focus ring"], ["focus-ring", "bg", 3, "focus ring on page"], ["focus-ring", "sidebar", 3, "focus ring in sidebar"],
  ["success-dot", "success-bg", 3, "status dot (non-text)"], ["danger-dot", "danger-bg", 3, "status dot (non-text)"],
];

describe.each([["light", light], ["dark", dark], ["dark via prefers-color-scheme", darkMedia]] as const)("contrast tokens: %s", (_n, v) => {
  it.each(PAIRS)("%s on %s ≥ %s (%s)", (fg, bg, min) => {
    expect(v[fg], `--${fg}`).toBeTruthy();
    expect(v[bg], `--${bg}`).toBeTruthy();
    expect(ratio(v[fg], v[bg])).toBeGreaterThanOrEqual(min);
  });
});

describe("token structure", () => {
  it("the prefers-color-scheme dark block is identical to the explicit dark theme (no drift)", () => {
    const keys = Object.keys(dark).filter((k) => /^[a-z-]+$/.test(k));
    for (const k of keys) expect(darkMedia[k], k).toBe(dark[k]);
  });

  it("light and dark define the same colour tokens", () => {
    for (const k of Object.keys(dark)) expect(light[k], k).toBeTruthy();
  });

  it("defines the spacing / radius / shadow / type / motion scales", () => {
    for (const n of ["--sp-1", "--sp-6", "--r-sm", "--r-lg", "--shadow-1", "--shadow-2", "--fs-xs", "--fs-xl", "--font-sans", "--font-mono", "--dur", "--ease"]) expect(css).toContain(n + ":");
  });

  it("components never hard-code colours (everything goes through tokens)", () => {
    const comp = readFileSync("src/styles/components.css", "utf8") + readFileSync("src/styles/base.css", "utf8");
    expect(comp.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  it("ratio helper sanity", () => {
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });
});
