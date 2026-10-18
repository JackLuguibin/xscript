/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The production build lands inside the Python package, where the xsapp://app/ scheme handler serves it from.
const outDir = fileURLToPath(new URL("../app/xscript_desktop/resources/app", import.meta.url));

export default defineConfig({
  plugins: [tailwindcss(), react()],
  // Monaco is imported file-by-file (src/editor/monaco-lean.ts) to leave out ~80 language packs; the package's
  // "exports" map only allows *.js, so the CSS it needs is reached through this alias. Everything is bundled (no CDN).
  resolve: { alias: { "monaco-esm": fileURLToPath(new URL("./node_modules/monaco-editor/esm/vs", import.meta.url)) } },
  base: "./",
  server: { port: 5173, strictPort: true, fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        spike: fileURLToPath(new URL("./spike.html", import.meta.url)),
      },
    },
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    // The page may not make network requests (CSP connect-src 'none'); the modulepreload polyfill uses fetch().
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 4500, // the lazily loaded Monaco chunk (~4 MB, local file, never over the network)
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // monaco.ts / monaco-lean.ts only run in a real browser: covered by app/tests/test_e2e_projects.py
      exclude: ["src/main.tsx", "src/**/*.d.ts", "src/editor/monaco.ts", "src/editor/monaco-lean.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 85, statements: 85, functions: 80, branches: 75 },
    },
  },
});
