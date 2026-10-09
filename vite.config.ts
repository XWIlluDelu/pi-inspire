import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { bundledLicenseNotices } from "./scripts/vite-license-notices.js";
import { pdfAssets } from "./scripts/vite-pdf-assets.js";

const require = createRequire(import.meta.url);
const piTuiFuzzyModule = resolve(
  dirname(require.resolve("@earendil-works/pi-tui")),
  "fuzzy.js",
);

// Development proxy targets the local insπre host (server/index.ts, port 4587).
// The host uses the deterministic development-only token INSPIRE_TOKEN=inspire-dev-token
// (see the dev:host script); production keeps its random per-launch token.
export default defineConfig({
  plugins: [react(), pdfAssets(), bundledLicenseNotices()],
  resolve: {
    // pi-tui publicly exports fuzzyFilter from its Node-only package root. The
    // browser consumes that exact module without pulling in the terminal UI.
    alias: [
      { find: /^@earendil-works\/pi-tui$/, replacement: piTuiFuzzyModule },
      // Markdown runs in both the page and a worker. The package's browser
      // export needs document; its default decoder is DOM-independent.
      {
        find: /^decode-named-character-reference$/,
        replacement: require.resolve("decode-named-character-reference"),
      },
    ],
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/html-preview": {
        target: "http://127.0.0.1:4587",
        changeOrigin: false,
      },
      "/api": {
        target: "http://127.0.0.1:4587",
        changeOrigin: false,
      },
      "/events": {
        target: "ws://127.0.0.1:4587",
        ws: true,
      },
      "/terminal": {
        target: "ws://127.0.0.1:4587",
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
