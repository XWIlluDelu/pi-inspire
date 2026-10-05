import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { ActiveSnapshot } from "../../shared/contracts";

async function pairAndOpen(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill("inspire-browser-test-token");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("main")).toBeVisible();
  await page
    .locator(".nav__row-main")
    .filter({ hasText: /Review extension event lifecycle/ })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
}

test("model labels and selection retain text contrast across palettes and themes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairAndOpen(page);
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await expect(page.getByRole("option", { selected: true })).toBeVisible();
  for (const palette of ["amber", "teal"]) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        ({ palette, theme }) => {
          document.documentElement.dataset.palette = palette;
          document.documentElement.dataset.theme = theme;
        },
        { palette, theme },
      );
      const result = await new AxeBuilder({ page })
        .include(".model-picker__menu")
        .withRules(["color-contrast"])
        .analyze();
      expect(result.violations, `${palette}/${theme}`).toEqual([]);
    }
  }
});

test("cached model choices open immediately and background updates preserve selection/search/draft", async ({
  page,
}) => {
  let release!: () => void;
  let failed = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/models**", async (route) => {
    await gate;
    if (failed) {
      await route.fulfill({
        status: 503,
        json: { error: "Fixture catalog unavailable" },
      });
      return;
    }
    const response = await route.fetch();
    const data = await response.json();
    data.models.push({
      provider: "fixture",
      id: "fresh-model",
      name: "Fresh model",
      reasoning: true,
    });
    await route.fulfill({ response, json: data });
  });
  await pairAndOpen(page);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Catalog refresh must preserve this draft");
  const trigger = page.getByRole("button", { name: "Model", exact: true });
  const selected = await trigger.textContent();
  await trigger.click();
  const list = page.getByRole("listbox", { name: "Available models" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option").first()).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Refreshing models" }),
  ).toBeVisible();
  const search = page.getByRole("combobox", { name: "Search models" });
  await search.fill("fresh-model");
  release();
  await expect(list.getByRole("option", { name: /Fresh model/ })).toBeVisible();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("fresh-model");
  await expect(trigger).toHaveText(selected!);
  await expect(draft).toHaveValue("Catalog refresh must preserve this draft");
  await page.screenshot({
    path: "output/playwright/model-catalog-updated.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  failed = true;
  await trigger.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Could not refresh models" }),
  ).toBeVisible();
  await search.fill("fresh-model");
  await list.getByRole("option", { name: /Fresh model/ }).click();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("fresh-model");
  await expect(draft).toHaveValue("Catalog refresh must preserve this draft");
});

test("the first-message model transition clamps max to high and sends explicit startup effort", async ({
  page,
}) => {
  const extended = {
    provider: "fixture",
    id: "extended",
    name: "Extended fixture",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  };
  const ordinary = {
    provider: "fixture",
    id: "ordinary",
    name: "Ordinary fixture",
    reasoning: true,
  };
  const decorate = (snapshot: ActiveSnapshot) => {
    if (snapshot.active) {
      snapshot.active.model = extended;
      snapshot.active.thinkingLevel = "max";
      snapshot.active.availableModels = [extended, ordinary];
    }
    return snapshot;
  };
  await page.routeWebSocket("**/events**", (ws) => {
    const upstream = ws.connectToServer();
    upstream.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.type === "snapshot" && event.data)
        event.data = decorate(event.data);
      ws.send(JSON.stringify(event));
    });
    ws.onMessage((message) => upstream.send(message));
  });
  for (const pattern of [
    "**/api/bootstrap**",
    "**/api/snapshot**",
    "**/api/sessions/open",
  ]) {
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      if (data.snapshot) data.snapshot = decorate(data.snapshot);
      else if (data.active) decorate(data);
      await route.fulfill({ response, json: data });
    });
  }
  await page.route("**/api/models**", (route) =>
    route.fulfill({ json: { models: [extended, ordinary] } }),
  );
  await page.route("**/api/new-session/thinking**", (route) => {
    const current = new URL(route.request().url()).searchParams.get("current");
    return route.fulfill({ json: { level: current } });
  });
  let startup: Record<string, unknown> | undefined;
  await page.route("**/api/sessions/new", async (route) => {
    startup = route.request().postDataJSON();
    await route.fulfill({
      status: 400,
      json: { error: "Fixture observes startup without creating a session" },
    });
  });
  await pairAndOpen(page);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page
    .getByRole("textbox", { name: "First message" })
    .fill("Start with native clamped thinking");
  const thinking = page.getByRole("combobox", { name: "Thinking level" });
  await expect(thinking).toHaveText("max");
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: /Ordinary fixture/ }).click();
  await expect(thinking).toHaveText("high");
  await expect(
    page.getByRole("button", { name: "Start session", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: "output/playwright/model-start-thinking-high.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect
    .poll(() => startup)
    .toMatchObject({
      model: { provider: "fixture", id: "ordinary" },
      thinkingLevel: "high",
    });
});
