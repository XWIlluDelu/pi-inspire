import { expect, test } from "@playwright/test";
import { modelSettingsScenario, pairAndOpen } from "./fixtures/model-settings";
import { openCommandPalette } from "./support/navigation";

test("Tab from a Settings dropdown skips collapsed content and reaches its disclosure", async ({
  page,
}) => {
  await modelSettingsScenario(page);
  await pairAndOpen(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Models", exact: true }).click();
  const thinking = settings.getByRole("combobox", { name: "Default thinking" });
  await thinking.click();
  await expect(
    page.getByRole("listbox", { name: "Default thinking" }),
  ).toBeVisible();
  await thinking.press("Tab");
  await expect(
    settings.locator(".models-saved-entries > summary"),
  ).toBeFocused();
  await expect(
    page.getByRole("listbox", { name: "Default thinking" }),
  ).toHaveCount(0);
});

test("category switches retain model browsing, provider drafts and a login arriving while hidden", async ({
  page,
}) => {
  const scenario = await modelSettingsScenario(page);
  const models = scenario.snapshot().models;
  models.push(
    ...Array.from({ length: 80 }, (_, index) => ({
      ...models[0]!,
      id: `catalog-${String(index).padStart(3, "0")}`,
      name: `Catalog model ${index}`,
    })),
  );
  let releaseLogin!: () => void;
  const loginResponse = new Promise<void>((resolve) => {
    releaseLogin = resolve;
  });
  await page.route("**/api/provider-auth**", async (route) => {
    if (route.request().postDataJSON().operation === "start")
      await loginResponse;
    await route.fallback();
  });
  await pairAndOpen(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const nav = settings.getByRole("navigation", { name: "Settings categories" });
  // The list has loaded while its category is initially hidden.
  await expect(
    settings.locator('[data-category="models"] .models-results'),
  ).toHaveCount(1);
  await nav.getByRole("button", { name: "Models", exact: true }).click();
  const grid = settings.getByRole("grid", { name: "Available models" });
  await expect(grid.getByRole("row").first()).toBeVisible();
  expect(await grid.getByRole("row").count()).toBeLessThan(30);
  const search = settings.getByRole("combobox", {
    name: "Search available models",
  });
  await search.fill("catalog-079");
  await expect(grid.getByRole("row")).toHaveCount(1);
  await expect(grid.getByRole("row")).toContainText("Catalog model 79");

  await settings
    .getByRole("button", { name: "Add provider", exact: true })
    .click();
  await settings
    .getByLabel("Provider ID", { exact: true })
    .fill("draft-provider");
  await settings
    .getByLabel("Base URL", { exact: true })
    .fill("https://draft.invalid/v1");
  const credentials = settings.getByRole("region", {
    name: "Login & API keys",
  });
  await credentials
    .getByRole("button", { name: "Manage Anthropic", exact: true })
    .click();
  await credentials
    .getByRole("button", { name: "Anthropic API key", exact: true })
    .click();
  const display = nav.getByRole("button", { name: "Display", exact: true });
  await display.click();
  releaseLogin();
  const hiddenSecret = settings
    .locator('[data-category="models"] .models-auth')
    .getByLabel("API key", { exact: true });
  await expect(hiddenSecret).toHaveCount(1);
  await expect(display).toBeFocused();
  await expect(
    settings.getByRole("textbox", { name: "API key", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      settings
        .locator(".settings__content")
        .evaluate((element) => element.scrollTop),
    )
    .toBe(0);
  expect(
    scenario.authOperations.some(
      (operation) => operation.operation === "cancel",
    ),
  ).toBe(false);

  await nav.getByRole("button", { name: "Models", exact: true }).click();
  await expect(search).toHaveValue("catalog-079");
  await expect(grid.getByRole("row")).toContainText("Catalog model 79");
  await expect(settings.getByLabel("Provider ID", { exact: true })).toHaveValue(
    "draft-provider",
  );
  await expect(settings.getByLabel("Base URL", { exact: true })).toHaveValue(
    "https://draft.invalid/v1",
  );
  const secret = credentials.getByLabel("API key", { exact: true });
  await secret.fill("SYNTHETIC_CATEGORY_KEY");
  await nav.getByRole("button", { name: "Conversation", exact: true }).click();
  await nav.getByRole("button", { name: "Models", exact: true }).click();
  await expect(secret).toHaveValue("SYNTHETIC_CATEGORY_KEY");
  await credentials
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    credentials.getByText("Login complete.", { exact: true }),
  ).toBeVisible();
  expect(
    scenario.authOperations.filter(
      (operation) => operation.operation === "start",
    ),
  ).toHaveLength(1);
  expect(
    scenario.authOperations.some(
      (operation) => operation.operation === "cancel",
    ),
  ).toBe(false);

  await settings.getByRole("button", { name: "Close settings" }).click();
  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("/login");
  await palette.getByRole("option", { name: /^\/login/ }).click();
  await expect(
    nav.getByRole("button", { name: "Models", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await expect(
    settings.getByRole("heading", { name: "Login & API keys" }),
  ).toBeInViewport();
  expect(scenario.errors).toEqual([]);
});

for (const touch of [false, true]) {
  test.describe(touch ? "touch settings" : "desktop settings", () => {
    test.use({
      viewport: { width: touch ? 320 : 540, height: 900 },
      hasTouch: touch,
      serviceWorkers: "block",
    });
    test("keeps labels readable, category navigation inside the dialog, and versions compact and copyable", async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await modelSettingsScenario(page);
      await page.route("**/api/bootstrap**", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        data.updateStatus = {
          revision: 999,
          piUpdateCheck: {
            currentVersion: "1.0.0",
            pi: {
              kind: "available",
              latestVersion: "1.0.2",
              releaseUrl: "https://example.invalid/pi",
            },
            extensions: { kind: "none" },
          },
          inspireUpdateCheck: { kind: "unreleased" },
          piUpdateChecking: false,
          inspireUpdateChecking: false,
          availableUpdateIdentity: null,
          updateSnoozedUntil: Date.now() + 3600000,
        };
        await route.fulfill({ response, json: data });
      });
      await pairAndOpen(page);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      const nav = settings.getByRole("navigation", {
        name: "Settings categories",
      });
      const content = settings.locator(".settings__content");
      await expect(settings.locator(".settings__page:visible")).toHaveCount(1);
      await expect(
        settings.getByRole("combobox", { name: "On launch" }),
      ).toHaveCount(0);
      await expect(
        settings.getByRole("group", { name: "Project location" }),
      ).toBeVisible();
      for (const [category, name] of [
        ["Display", "Project location"],
        ["Conversation", "Send key"],
      ]) {
        await nav.getByRole("button", { name: category, exact: true }).click();
        const control = settings.getByRole("group", { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        for (const button of await control.getByRole("button").all()) {
          expect(
            await button.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          ).toBe(true);
          const label = button.locator("span");
          const height = (await label.boundingBox())!.height;
          expect(height).toBeLessThan(24);
        }
      }
      const system = nav.getByRole("button", { name: "System", exact: true });
      await system.focus();
      await system.press("Enter");
      await expect(system).toBeInViewport();
      await expect(system).toBeFocused();
      await expect(settings.locator(".settings__page:visible")).toHaveCount(1);
      await expect
        .poll(() => content.evaluate((element) => element.scrollTop))
        .toBe(0);
      await expect(
        settings.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeInViewport();
      await expect(nav).toBeInViewport();
      const versions = settings.getByRole("region", {
        name: "Versions",
        exact: true,
      });
      await expect(versions).toBeInViewport();
      const piRow = versions.locator(".system-versions__row").first();
      const labels = await versions
        .getByRole("term")
        .evaluateAll((terms) =>
          terms.map((term) => term.firstElementChild?.textContent),
        );
      expect(labels).toEqual(["Pi", "Extensions", "INSΠRE"]);
      if (!touch) {
        const heights = await versions
          .locator(".system-versions__row")
          .evaluateAll((rows) =>
            rows.map((row) => row.getBoundingClientRect().height),
          );
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
      }
      const copy = piRow.getByRole("button", {
        name: "Copy pi update",
        exact: true,
      });
      await expect(copy).toHaveClass(/file-path-action/);
      await copy.click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe("pi update");
      const host = settings.getByRole("button", {
        name: "Restart Host",
        exact: true,
      });
      const all = settings.getByRole("button", {
        name: "Restart all",
        exact: true,
      });
      expect((await host.boundingBox())!.height).toBe(
        (await all.boundingBox())!.height,
      );
      await expect(host).toHaveClass(/button--danger-outline/);
      await expect(all).toHaveClass(/button--danger-outline/);
      await nav.getByRole("button", { name: "Models", exact: true }).click();
      const custom = settings.getByRole("button", {
        name: "Add provider",
        exact: true,
      });
      await expect(custom).toHaveClass("button");
      await content.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(
        nav.getByRole("button", { name: "Models", exact: true }),
      ).toHaveAttribute("aria-current", "location");
      await nav
        .getByRole("button", { name: "Conversation", exact: true })
        .click();
      await expect
        .poll(() => content.evaluate((element) => element.scrollTop))
        .toBe(0);
      await expect(
        settings.getByRole("region", { name: "Conversation", exact: true }),
      ).toBeInViewport();
      await expect(
        settings.getByRole("region", { name: "Versions", exact: true }),
      ).toHaveCount(0);
      // Native focus and modal Tab must both skip inactive category controls.
      await settings
        .locator('[data-category="models"] input')
        .first()
        .evaluate((element) => (element as HTMLElement).focus());
      await expect(
        nav.getByRole("button", { name: "Conversation", exact: true }),
      ).toBeFocused();
      await system.focus();
      await system.press("Tab");
      await expect(
        settings.getByRole("combobox", { name: "Reasoning detail" }),
      ).toBeFocused();
    });
  });
}
