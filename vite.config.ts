import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type ServerOptions } from "vite";
import { hostListener, instanceUrl } from "./server/instance-state.mjs";
import { developmentLaunch } from "./scripts/vite-dev-launch.js";
import { bundledLicenseNotices } from "./scripts/vite-license-notices.js";
import { pdfAssets } from "./scripts/vite-pdf-assets.js";

const require = createRequire(import.meta.url);
const piTuiFuzzyModule = resolve(
  dirname(require.resolve("@earendil-works/pi-tui")),
  "fuzzy.js",
);

function developmentServer(): ServerOptions {
  const backend = new URL(instanceUrl(hostListener())).origin;
  return {
    host: "127.0.0.1",
    port: Number(process.env.INSPIRE_DEV_PORT ?? "5173"),
    strictPort: true,
    proxy: {
      "/html-preview": { target: backend },
      "/api": { target: backend },
      "/events": { target: backend, ws: true },
      "/terminal": { target: backend, ws: true },
    },
  };
}

export default defineConfig(({ command }) => ({
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
  server: command === "serve" ? developmentServer() : undefined,
}));
