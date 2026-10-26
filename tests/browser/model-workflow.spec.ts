import { hostRequest } from "./support/host-request";
import { expect, type Page, test } from "@playwright/test";
import type { ModelOption } from "../../shared/contracts";

import { routeMockSnapshots } from "./support/mock-host";
import { pairAndOpen, pairedPage } from "./support/navigation";

test.use({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });

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
  await routeMockSnapshots(page, {
    snapshot: (snapshot) => {
      const active = snapshot.active;
      if (inherited && active?.sessionId === "mock-history")
        Object.assign(active, {
          model: router,
          thinkingLevel: "high",
          availableModels: models,
        });
    },
    bootstrap: (body) => {
      body.availableModels = models;
      body.snapshot.active = null;
    },
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
    const response = await hostRequest(page).get(
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

test.describe("touch model picker", () => {
  test.use({
    viewport: { width: 390, height: 900 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  test("New inherits selected Router/current effort rather than workspace defaults", async ({
    page,
  }) => {
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
    ).toHaveText("High");
    await page.getByRole("button", { name: "Model", exact: true }).click();
    const option = page.getByRole("option", { name: /Auto route.*Router/ });
    await expect(option.getByText("Router", { exact: true })).toBeVisible();
    const box = (await page.locator(".model-picker__menu").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);

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
});

test("prospective Router defaults are displayed but left to native startup", async ({
  page,
}) => {
  const scenario = await modelScenario(page, false);
  await pairedPage(page);
  await page
    .getByRole("textbox", { name: "Project directory", exact: true })
    .fill("/fixture-project");
  await expect(
    page.getByRole("button", { name: "Model", exact: true }),
  ).toHaveText("Auto route");
  await expect(
    page.getByRole("combobox", { name: "Thinking level", exact: true }),
  ).toHaveText("Low");
  await page
    .getByRole("textbox", { name: "First message", exact: true })
    .fill("Use the workspace default");

  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect.poll(scenario.submitted).toEqual({ cwd: "/fixture-project" });
  expect(scenario.errors).toEqual([]);
});
