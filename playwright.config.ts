import { defineConfig, devices } from "@playwright/test";
import { testPiCommand } from "./scripts/test-pi-command.mjs";

// Native fixtures run in Playwright workers as well as the test Host.
process.env.INSPIRE_PI_COMMAND = testPiCommand;

const port = Number(process.env.INSPIRE_BROWSER_TEST_PORT ?? 4592);

export default defineConfig({
  testDir: "tests/browser",
  outputDir: "output/playwright/results",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { outputFolder: "output/playwright/report", open: "never" }],
      ]
    : "list",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `node scripts/start-browser-test-host.mjs ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
