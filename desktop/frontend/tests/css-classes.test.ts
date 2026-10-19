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
  it("declares the layer order once, utilities last as in Tailwind's own setup", () => {
    expect(layerOrder()).toEqual(["theme", "controls", "base", "vendor", "ui", "components", "utilities"]);
    expect(stripComments(read("src/styles/tailwind.css"))).not.toMatch(/@layer\s+[\w\s,-]+;/);
  });

  it("imports every stylesheet into its layer", () => {
    expect(imports("src/styles.css")).toEqual([
      ["./styles/tokens.css", null],
      ["./styles/controls.css", "controls"],
      ["./styles/base.css", "base"],
      ["@xyflow/react/dist/style.css", "vendor"],
      ["./styles/ui.css", "ui"],
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
    for (const path of ["src/styles/controls.css", "src/styles/base.css", "src/styles/ui.css", "src/styles/components.css", "src/styles/overrides.css"]) {
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

describe("ui primitives", () => {
  const css = stripComments(read("src/styles/ui.css"));

  it("keep their look in ui.css: every class a primitive emits is defined there", () => {
    const emitted = ["button", "input", "textarea", "select"]
      .flatMap((name) => [...read("src/components/ui/" + name + ".tsx").matchAll(/"(ui-[\w-]+)"/g)].map((hit) => hit[1]));
    expect(emitted.length).toBeGreaterThan(10);
    for (const name of emitted) expect(css, name).toMatch(new RegExp("\\." + name + "[\\s,{]"));
  });

  it("carry no Tailwind utilities of their own any more, so a className utility always wins", () => {
    for (const name of ["button", "input", "textarea", "select"]) {
      const source = read("src/components/ui/" + name + ".tsx");
      expect(source, name).not.toMatch(/"[^"]*\b(min-h|px|py|rounded|border|bg)-[\w[\]-]+[^"]*"/);
    }
  });

  it("are written as @apply rules", () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(5);
    for (const [, selector, body] of rules) expect(body.trim(), selector.trim()).toMatch(/^@apply [^;]+;$/);
  });
});

describe("our class names and Tailwind utilities", () => {
  it("do not collide, so a rule of ours is never overridden by a same-named utility", async () => {
    // Utilities are the last layer, so a same-named utility beats every rule of ours. `.list-item` once lost
    // `display: flex` to Tailwind's `display: list-item` and stacked the ADB rows. `grow` and `sr-only` mean the same thing.
    const allowed = ["grow", "sr-only"];
    const clashes = await utilitiesAmong(classesIn(["src/styles/controls.css", "src/styles/base.css", "src/styles/ui.css", "src/styles/components.css"]));
    expect(clashes.filter((name) => !allowed.includes(name))).toEqual([]);
  });

  it("would catch the old list-item clash", async () => {
    expect(await utilitiesAmong(["list-item", "list-row"])).toEqual(["list-item"]);
  });
});
