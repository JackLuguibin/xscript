import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/** Class names our own stylesheets define. */
function ownClasses(): string[] {
  const css = ["src/styles/components.css", "src/styles/base.css"].map((path) => readFileSync(path, "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((hit) => hit[1]))].sort();
}

/** Classes Tailwind turns into a utility. Its utilities are emitted after our stylesheets (tailwind.css), so they win. */
async function utilitiesAmong(names: string[]): Promise<string[]> {
  const compiler = await compile('@import "tailwindcss/utilities.css";', {
    base: process.cwd(),
    loadStylesheet: async (id: string, base: string) => {
      const path = require.resolve(id);
      return { path, base, content: readFileSync(path, "utf8") };
    },
  });
  const out = compiler.build(names);
  return names.filter((name) => new RegExp("(^|[^\\w-])\\." + name.replace(/[-]/g, "\\-") + "\\s*\\{").test(out));
}

describe("our class names and Tailwind utilities", () => {
  it("do not collide, so a component rule is never overridden by a same-named utility", async () => {
    // `.list-item` once lost `display: flex` to Tailwind's `display: list-item` and stacked the ADB rows.
    // The allowed ones are utilities we style on purpose (button variants) or that mean the same thing (`grow`, `sr-only`).
    const allowed = ["bg-primary", "grow", "sr-only", "text-danger-fg"];
    const clashes = await utilitiesAmong(ownClasses());
    expect(clashes.filter((name) => !allowed.includes(name))).toEqual([]);
  });

  it("would catch the old list-item clash", async () => {
    expect(await utilitiesAmong(["list-item", "list-row"])).toEqual(["list-item"]);
  });
});
