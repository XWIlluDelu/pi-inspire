import { defineConfig } from "vitest/config";
import { testPiCommand } from "./scripts/test-pi-command.mjs";

const staticWebTests = [
  "tests/web/{browser-icon,theme-init,styles-contract}.test.ts",
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
            "tests/!(web|portable)/**/*.test.{ts,mjs}",
            ...staticWebTests,
          ],
          environment: "node",
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
