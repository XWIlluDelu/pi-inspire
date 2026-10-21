import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { developmentLaunch } from "./scripts/vite-dev-launch.js";
import { bundledLicenseNotices } from "./scripts/vite-license-notices.js";
import { pdfAssets } from "./scripts/vite-pdf-assets.js";

const require = createRequire(import.meta.url);
const piTuiFuzzyModule = resolve(
  dirname(require.resolve("@earendil-works/pi-tui")),
  "fuzzy.js",
);

const backendHost = process.env.INSPIRE_HOST ?? "127.0.0.1";
const backendPort = process.env.INSPIRE_PORT ?? "4587";
const backend = `http://${backendHost === "::1" ? "[::1]" : backendHost}:${backendPort}`;

export default defineConfig({
  plugins: [react(), pdfAssets(), bundledLicenseNotices(), developmentLaunch()],
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
    host: "127.0.0.1",
    port: Number(process.env.INSPIRE_DEV_PORT ?? "5173"),
    strictPort: true,
    proxy: {
      "/html-preview": {
        target: backend,
        changeOrigin: false,
      },
      "/api": {
        target: backend,
        changeOrigin: false,
      },
      "/events": {
        target: backend.replace(/^http:/u, "ws:"),
        ws: true,
      },
      "/terminal": {
        target: backend.replace(/^http:/u, "ws:"),
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
