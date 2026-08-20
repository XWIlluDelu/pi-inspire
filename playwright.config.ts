import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  // MockRuntime is deliberately one host-owned session projection. Browser
  // scenarios must not overlap their prompts through concurrent workers.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { outputFolder: "output/playwright/report", open: "never" }],
      ]
    : "list",
  use: {
    baseURL: "http://127.0.0.1:4592",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "INSPIRE_TOKEN=inspire-browser-test-token INSPIRE_PI_COMMAND=./node_modules/.bin/pi INSPIRE_MOCK=1 INSPIRE_MOCK_WORKSPACE=. INSPIRE_MOCK_STREAM_INTERVAL_MS=250 INSPIRE_PORT=4592 npx tsx server/index.ts",
    url: "http://127.0.0.1:4592/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
