import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies the API to a local `python -m xscript_server serve` on :8765.
const target = process.env.XSCRIPT_API ?? "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/license": { target, changeOrigin: false },
      "/pub": { target, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        // Cache vendor code separately from the app: deploys only invalidate the small app chunks.
        advancedChunks: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ },
            { name: "antd", test: /node_modules[\\/](antd|@ant-design|rc-[^\\/]+|@rc-component)[\\/]/ },
            { name: "vendor", test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
});
