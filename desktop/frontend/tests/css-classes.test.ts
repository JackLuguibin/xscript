import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const read = (path: string) => readFileSync(path, "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Class names the given stylesheets define. */
function classesIn(paths: string[]): string[] {
  const css = stripComments(paths.map(read).join("\n"));
  return [...new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((hit) => hit[1]))].sort();
}

/** Classes Tailwind turns into a utility. */
async function utilitiesAmong(names: string[]): Promise<string[]> {
  const compiler = await compile('@import "tailwindcss/utilities.css";', {
    base: process.cwd(),
    loadStylesheet: async (id: string, base: string) => {
      const path = require.resolve(id);
      return { path, base, content: read(path) };
    },
  });
  const out = compiler.build(names);
  return names.filter((name) => new RegExp("(^|[^\\w-])\\." + name.replace(/[-]/g, "\\-") + "\\s*\\{").test(out));
}

/** The `@layer a, b, c;` order statement in styles.css. */
function layerOrder(): string[] {
  const statement = stripComments(read("src/styles.css")).match(/@layer\s+([\w\s,-]+);/);
  return statement ? statement[1].split(",").map((name) => name.trim()) : [];
}

/** `@import` lines of styles.css (and tailwind.css, which it pulls in), as [target, layer | null]. */
function imports(path: string): [string, string | null][] {
  return [...stripComments(read(path)).matchAll(/@import\s+"([^"]+)"(?:\s+layer\((\w+)\))?\s*;/g)].map((hit) => [hit[1], hit[2] ?? null]);
}

describe("cascade layers", () => {
  it("declares the layer order once: controls < base < vendor < utilities < components", () => {
    expect(layerOrder()).toEqual(["theme", "controls", "base", "vendor", "utilities", "components"]);
    expect(stripComments(read("src/styles/tailwind.css"))).not.toMatch(/@layer\s+[\w\s,-]+;/);
  });

  it("imports every stylesheet into its layer", () => {
    expect(imports("src/styles.css")).toEqual([
      ["./styles/tokens.css", null],
      ["./styles/controls.css", "controls"],
      ["./styles/base.css", "base"],
      ["@xyflow/react/dist/style.css", "vendor"],
      ["./styles/components.css", "components"],
      ["./styles/overrides.css", null],
      ["./styles/tailwind.css", null],
    ]);
    expect(imports("src/styles/tailwind.css")).toEqual([
      ["tailwindcss/theme.css", "theme"],
      ["tailwindcss/utilities.css", "utilities"],
    ]);
  });

  it("keeps the layered files free of their own @layer blocks, which would nest as sublayers", () => {
    for (const path of ["src/styles/controls.css", "src/styles/base.css", "src/styles/components.css", "src/styles/overrides.css"]) {
      expect(stripComments(read(path)), path).not.toMatch(/@layer\b/);
    }
  });

  it("leaves only Monaco decorations unlayered", () => {
    const selectors = [...stripComments(read("src/styles/overrides.css")).matchAll(/([^{}]+)\{/g)].map((hit) => hit[1].trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector).toMatch(/^\.monaco-host /);
    expect(stripComments(read("src/styles/tokens.css"))).not.toMatch(/\.[A-Za-z][\w-]*\s*[{,]/);
  });

  it("loads React Flow's CSS only through the vendor layer", () => {
    // An unlayered import from a component would beat every layer, components.css included.
    expect(read("src/components/FlowPage.tsx")).not.toContain("@xyflow/react/dist/style.css");
  });
});

describe("our class names and Tailwind utilities", () => {
  it("do not collide in the layers below utilities, where a same-named utility would win", async () => {
    // `.list-item` once lost `display: flex` to Tailwind's `display: list-item` and stacked the ADB rows. components.css now
    // sits above utilities, but controls.css and base.css do not. `grow` and `sr-only` mean the same thing in both.
    const allowed = ["grow", "sr-only"];
    const clashes = await utilitiesAmong(classesIn(["src/styles/controls.css", "src/styles/base.css"]));
    expect(clashes.filter((name) => !allowed.includes(name))).toEqual([]);
  });

  it("only share names with utilities in components.css on purpose", async () => {
    // A component rule wins over the utility of the same name now, so these are safe; the list stays explicit so a new
    // clash (and the confusion of a class meaning two things) is a decision, not an accident.
    const allowed = ["bg-primary", "grow", "sr-only", "text-danger-fg"];
    const clashes = await utilitiesAmong(classesIn(["src/styles/components.css"]));
    expect(clashes.filter((name) => !allowed.includes(name))).toEqual([]);
  });

  it("would catch the old list-item clash", async () => {
    expect(await utilitiesAmong(["list-item", "list-row"])).toEqual(["list-item"]);
  });
});
