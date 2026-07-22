import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Development proxy targets the local insπre host (server/index.ts, port 4587).
// The host uses the deterministic development-only token INSPIRE_TOKEN=inspire-dev-token
// (see the dev:host script); production keeps its random per-launch token.
export default defineConfig({
  plugins: [react()],
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
