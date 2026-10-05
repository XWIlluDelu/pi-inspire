import { expect, test, type Page } from "@playwright/test";
import type { ActiveSnapshot, ModelOption } from "../../shared/contracts";
import { pairAndOpen } from "./fixtures/model-settings";

const router: ModelOption = {
  provider: "fixture-router",
  id: "auto",
  name: "Auto route",
  virtual: true,
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    low: "low",
    medium: null,
    high: "high",
    max: null,
  },
};
const physical: ModelOption = {
  provider: "fixture-native",
  id: "a",
  name: "Physical A",
  reasoning: true,
};
const models = [router, physical];

async function modelScenario(page: Page, inherited: boolean) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const adapt = (payload: {
    snapshot?: ActiveSnapshot;
    active?: ActiveSnapshot["active"];
    data?: ActiveSnapshot;
    availableModels?: ModelOption[];
  }) => {
    const active = payload.active ?? payload.data?.active;
    if (inherited && active?.sessionId === "mock-history")
      Object.assign(active, {
        model: router,
        thinkingLevel: "high",
        availableModels: models,
      });
    if (payload.availableModels) payload.availableModels = models;
    return payload;
  };
  for (const pattern of [
    "**/api/bootstrap**",
    "**/api/snapshot**",
    "**/api/sessions/open",
  ])
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      if (route.request().url().includes("/api/bootstrap") && payload.snapshot)
        payload.snapshot.active = null;
      await route.fulfill({ response, json: adapt(payload) });
    });
  // HTTP and initial runtime frames describe the same deterministic selected
  // identity. Real Pi routing/recovery is covered by the native integration.
  await page.routeWebSocket(/\/events(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString();
      try {
        socket.send(JSON.stringify(adapt(JSON.parse(text))));
      } catch {
        socket.send(frame);
      }
    });
  });
  await page.route("**/api/models**", (route) =>
    route.fulfill({
      json: {
        models,
        commonModels: [],
        defaults: {
          cwd: "/fixture-project",
          model: router,
          thinkingLevel: "low",
        },
      },
    }),
  );
  await page.route("**/api/new-session/thinking**", (route) =>
    route.fulfill({ json: { level: "low" } }),
  );
  let submitted: unknown;
  await page.route("**/api/sessions/new", async (route) => {
    submitted = route.request().postDataJSON();
    // Capture the startup contract without creating a mock-only session that
    // cannot appear in the fixture catalog. Native startup has its own fixture.
    const response = await page.request.get(
      "/api/snapshot?detail=mock-history",
    );
    const payload = await response.json();
    Object.assign(payload.active, {
      model: router,
      thinkingLevel: inherited ? "high" : "low",
      availableModels: models,
    });
    await route.fulfill({ response, json: payload });
  });
  await page.route("**/api/prompt", (route) =>
    route.fulfill({ status: 202, json: { accepted: true } }),
  );
  return { submitted: () => submitted, errors };
}

for (const [name, width, touch] of [
  ["desktop", 1280, false],
  ["touch", 390, true],
] as const) {
  test.describe(name, () => {
    test.use({
      viewport: { width, height: 900 },
      hasTouch: touch,
      serviceWorkers: "block",
    });
    test("New inherits selected Router/current effort rather than workspace defaults", async ({
      page,
    }, info) => {
      const scenario = await modelScenario(page, true);
      await pairAndOpen(page);
      if (
        !(await page
          .getByRole("button", { name: "New session", exact: true })
          .isVisible())
      )
        await page
          .getByRole("button", { name: "Toggle navigation", exact: true })
          .click();
      await page
        .getByRole("button", { name: "New session", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Model", exact: true }),
      ).toHaveText("Auto route");
      await expect(
        page.getByRole("combobox", { name: "Thinking level", exact: true }),
      ).toHaveText("high");
      await page.getByRole("button", { name: "Model", exact: true }).click();
      const option = page.getByRole("option", { name: /Auto route.*Router/ });
      await expect(option.getByText("Router", { exact: true })).toBeVisible();
      const box = (await page.locator(".model-picker__menu").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath("inherited-router.png") });
      await option.click();
      await page
        .getByRole("textbox", { name: "First message", exact: true })
        .fill("Continue the selected router");
      await page
        .getByRole("button", { name: "Start session", exact: true })
        .click();
      await expect.poll(scenario.submitted).toMatchObject({
        model: { provider: router.provider, id: router.id },
        thinkingLevel: "high",
      });
      expect(scenario.errors).toEqual([]);
    });
    test("prospective Router defaults are displayed but left to native startup", async ({
      page,
    }, info) => {
      const scenario = await modelScenario(page, false);
      await page.goto("/");
      await page.getByLabel("Access token").fill("inspire-browser-test-token");
      await page.getByRole("button", { name: "Pair", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Project directory", exact: true })
        .fill("/fixture-project");
      await expect(
        page.getByRole("button", { name: "Model", exact: true }),
      ).toHaveText("Auto route");
      await expect(
        page.getByRole("combobox", { name: "Thinking level", exact: true }),
      ).toHaveText("low");
      await page
        .getByRole("textbox", { name: "First message", exact: true })
        .fill("Use the workspace default");
      await page.screenshot({ path: info.outputPath("default-router.png") });
      await page
        .getByRole("button", { name: "Start session", exact: true })
        .click();
      await expect
        .poll(scenario.submitted)
        .toEqual({ cwd: "/fixture-project" });
      expect(scenario.errors).toEqual([]);
    });
  });
}
