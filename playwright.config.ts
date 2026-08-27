import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  // MockRuntime is deliberately one host-owned session projection. Browser
  // scenarios must not overlap their prompts through concurrent workers.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  outputDir: "output/playwright/test-results",
  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { outputFolder: "output/playwright/report", open: "never" }],
      ]
    : "list",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:4592",
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        baseURL: "http://127.0.0.1:4593",
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        baseURL: "http://127.0.0.1:4594",
      },
    },
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node scripts/start-browser-test-host.mjs chromium 4592",
      url: "http://127.0.0.1:4592/",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node scripts/start-browser-test-host.mjs firefox 4593",
      url: "http://127.0.0.1:4593/",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node scripts/start-browser-test-host.mjs webkit 4594",
      url: "http://127.0.0.1:4594/",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
