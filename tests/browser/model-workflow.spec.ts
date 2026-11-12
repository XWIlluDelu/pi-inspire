import { expect, test } from "@playwright/test";
import type { ModelOption } from "../../shared/contracts";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import { pairAndOpen } from "./support/navigation";

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

test.use({
  viewport: { width: 390, height: 900 },
  hasTouch: true,
  serviceWorkers: "block",
  contextOptions: { reducedMotion: "reduce" },
});

test("New inherits the selected Router and hands off a multiline draft", async ({
  page,
}) => {
  await routeSnapshots(page, {
    snapshot(snapshot) {
      if (snapshot.active?.sessionId === "fixture-history")
        Object.assign(snapshot.active, {
          model: router,
          thinkingLevel: "high",
          availableModels: models,
          modelDiscovery: undefined,
        });
    },
    bootstrap(body) {
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
  let submitted: unknown;
  let prompted: string | undefined;
  await page.route("**/api/sessions/new", async (route) => {
    submitted = route.request().postDataJSON();
    const response = await hostRequest(page).get(
      "/api/snapshot?detail=fixture-history",
    );
    const payload = await response.json();
    Object.assign(payload.active, {
      model: router,
      thinkingLevel: "high",
      availableModels: models,
      modelDiscovery: undefined,
    });
    await route.fulfill({ response, json: payload });
  });
  await page.route("**/api/prompt", (route) => {
    prompted = route.request().postDataJSON().message;
    return route.fulfill({ status: 202, json: { accepted: true } });
  });
  await pairAndOpen(page);
  if (
    !(await page
      .getByRole("button", { name: "New session", exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .click();
  await page.getByRole("button", { name: "New session", exact: true }).click();
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
  expect(submitted).toBeUndefined();
  await message.pressSequentially("Review the next step");
  await start.click();
  await expect
    .poll(() => submitted)
    .toMatchObject({
      model: { provider: router.provider, id: router.id },
      thinkingLevel: "high",
    });
  await expect
    .poll(() => prompted)
    .toBe("Continue the selected router\nReview the next step");
});
