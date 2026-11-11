import { expect, type Page, test } from "@playwright/test";
import type { ModelOption } from "../../shared/contracts";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
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
  let defaultEffort = "low";
  let thinkingReads = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await routeSnapshots(page, {
    snapshot: (snapshot) => {
      const active = snapshot.active;
      if (inherited && active?.sessionId === "fixture-history")
        Object.assign(active, {
          model: router,
          thinkingLevel: "high",
          availableModels: models,
          modelDiscovery: undefined,
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
          thinkingLevel: defaultEffort,
        },
      },
    }),
  );
  await page.route("**/api/new-session/thinking**", (route) => {
    thinkingReads++;
    return route.fulfill({ json: { level: "off" } });
  });
  let submitted: unknown;
  let prompted: string | undefined;
  await page.route("**/api/sessions/new", async (route) => {
    submitted = route.request().postDataJSON();
    // Capture the startup contract without creating a fixture-only session that
    // cannot appear in the fixture catalog. Native startup has its own fixture.
    const response = await hostRequest(page).get(
      "/api/snapshot?detail=fixture-history",
    );
    const payload = await response.json();
    Object.assign(payload.active, {
      model: router,
      thinkingLevel: inherited ? "high" : defaultEffort,
      availableModels: models,
      modelDiscovery: undefined,
    });
    await route.fulfill({ response, json: payload });
  });
  await page.route("**/api/prompt", (route) => {
    prompted = route.request().postDataJSON().message;
    return route.fulfill({ status: 202, json: { accepted: true } });
  });
  return {
    submitted: () => submitted,
    prompted: () => prompted,
    thinkingReads: () => thinkingReads,
    updateDefaultEffort: () => {
      defaultEffort = "high";
    },
    errors,
  };
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

    await page.getByRole("combobox", { name: "Search models" }).press("Escape");
    const message = page.getByRole("textbox", { name: "First message" });
    const start = page.getByRole("button", { name: "Start session" });
    await message.fill("Continue the selected router");
    await expect(start).toBeEnabled();
    await message.press("Enter");
    await expect(message).toHaveValue("Continue the selected router\n");
    expect(scenario.submitted()).toBeUndefined();
    await message.pressSequentially("Review the next step");
    await start.click();
    await expect.poll(scenario.submitted).toMatchObject({
      model: { provider: router.provider, id: router.id },
      thinkingLevel: "high",
    });
    await expect
      .poll(scenario.prompted)
      .toBe("Continue the selected router\nReview the next step");
    expect(scenario.thinkingReads()).toBe(0);
    expect(scenario.errors).toEqual([]);
  });
});

for (const explicit of [false, true]) {
  test(`New submits the refreshed Router only when it is explicitly chosen · ${explicit ? "chosen" : "preview"}`, async ({
    page,
  }) => {
    const scenario = await modelScenario(page, false);
    await pairedPage(page);
    const directory = page.getByRole("textbox", { name: "Project directory" });
    const message = page.getByRole("textbox", { name: "First message" });
    const model = page.getByRole("button", { name: "Model", exact: true });
    const thinking = page.getByRole("combobox", { name: "Thinking level" });
    const start = page.getByRole("button", { name: "Start session" });
    await expect(message).toBeFocused();
    await directory.fill("/fixture-project");
    await expect(model).toHaveText("Auto route");
    await expect(thinking).toHaveText("Low");
    scenario.updateDefaultEffort();
    await model.click();
    await expect(thinking).toHaveText("High");
    if (explicit)
      await page.getByRole("option", { name: /Auto route.*Router/ }).click();
    else
      await page
        .getByRole("combobox", { name: "Search models" })
        .press("Escape");
    await message.fill("Use the workspace default");
    await expect(start).toBeEnabled();
    await directory.press("Enter");
    expect(scenario.submitted()).toBeUndefined();
    await expect(message).toHaveValue("Use the workspace default");
    await start.click();
    await expect.poll(scenario.submitted).toEqual({
      cwd: "/fixture-project",
      ...(explicit
        ? {
            model: { provider: router.provider, id: router.id },
            thinkingLevel: "high",
          }
        : {}),
    });
    await expect.poll(scenario.prompted).toBe("Use the workspace default");
    expect(scenario.thinkingReads()).toBe(0);
    expect(scenario.errors).toEqual([]);
  });
}
