/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The production build lands inside the Python package, where the xsapp://app/ scheme handler serves it from.
const outDir = fileURLToPath(new URL("../app/xscript_desktop/resources/app", import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, strictPort: true },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    // The page may not make network requests (CSP connect-src 'none'); the modulepreload polyfill uses fetch().
    modulePreload: { polyfill: false },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/**/*.d.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 85, statements: 85, functions: 80, branches: 75 },
    },
  },
});
