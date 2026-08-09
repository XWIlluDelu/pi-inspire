import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import { bundledLicenseNotices } from "./scripts/vite-license-notices.js";

const require = createRequire(import.meta.url);
const piTuiFuzzyModule = resolve(dirname(require.resolve("@earendil-works/pi-tui")), "fuzzy.js");

// Development proxy targets the local insπre host (server/index.ts, port 4587).
// The host uses the deterministic development-only token INSPIRE_TOKEN=inspire-dev-token
// (see the dev:host script); production keeps its random per-launch token.
export default defineConfig({
  plugins: [react(), bundledLicenseNotices()],
  resolve: {
    // pi-tui publicly exports fuzzyFilter from its Node-only package root. The
    // browser consumes that exact module without pulling in the terminal UI.
    alias: [{ find: /^@earendil-works\/pi-tui$/, replacement: piTuiFuzzyModule }],
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4587",
        changeOrigin: false,
      },
      "/events": {
        target: "ws://127.0.0.1:4587",
        ws: true,
      },
    },
  },
});
