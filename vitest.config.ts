import { defineConfig } from "vitest/config";
import { testPiCommand } from "./scripts/test-pi-command.mjs";

const staticWebTests = [
  "tests/web/{browser-icon,theme-init,styles-contract,palette-colors}.test.ts",
];

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "development",
      INSPIRE_PI_COMMAND: testPiCommand,
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: [
            "tests/*.test.{ts,mjs}",
            "tests/!(web|portable|integration)/**/*.test.{ts,mjs}",
            ...staticWebTests,
          ],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "jsdom",
          setupFiles: ["tests/web/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "web",
          include: ["tests/web/**/*.test.{ts,tsx}"],
          exclude: staticWebTests,
          environment: "jsdom",
          setupFiles: ["tests/web/setup.ts"],
        },
      },
    ],
    restoreMocks: true,
    clearMocks: true,
  },
});
