import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "development",
      INSPIRE_PI_COMMAND: resolve(import.meta.dirname, "node_modules/.bin/pi"),
    },
    include: ["tests/**/*.test.{ts,tsx,mjs}"],
    environment: "node",
    setupFiles: ["tests/web/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
