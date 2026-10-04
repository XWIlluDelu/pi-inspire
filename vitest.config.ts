import { defineConfig } from "vitest/config";
import { testPiCommand } from "./scripts/test-pi-command.mjs";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "development",
      INSPIRE_PI_COMMAND: testPiCommand,
    },
    include: ["tests/**/*.test.{ts,tsx,mjs}"],
    exclude: ["tests/portable/**"],
    environment: "node",
    setupFiles: ["tests/web/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
