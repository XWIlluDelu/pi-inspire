import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { testPiCommand } from "./scripts/test-pi-command.mjs";
import { browserFixtureOutput } from "./tests/browser/fixtures/workspace.mjs";

// Native fixtures run in Playwright workers as well as the test Host.
process.env.INSPIRE_PI_COMMAND = testPiCommand;

const port = Number(process.env.INSPIRE_BROWSER_TEST_PORT ?? 4592);

export default defineConfig({
  testDir: "tests/browser",
  outputDir: join(browserFixtureOutput, "results"),
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `node scripts/start-browser-test-host.mjs ${port}`,
    url: `http://127.0.0.1:${port}/`,
    timeout: 30_000,
  },
});
