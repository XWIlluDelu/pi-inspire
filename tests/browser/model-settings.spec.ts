import { expect, test } from "@playwright/test";
import { modelSettingsSnapshot } from "../web/fixtures/model-settings";
import { modelSettingsScenario, pairAndOpen } from "./fixtures/model-settings";

test.use({ serviceWorkers: "block" });

test("Manage models carries New's prospective project only for its Settings visit", async ({
  page,
}) => {
  const target = "/tmp/inspire-browser-prospective-models";
  let settingsOwner: Record<string, string> | undefined;
  await page.route("**/api/models**", (route) =>
    route.fulfill({
      json: { models: modelSettingsSnapshot().models, commonModels: [] },
    }),
  );
  await page.route("**/api/model-settings**", (route) => {
    settingsOwner = Object.fromEntries(
      new URL(route.request().url()).searchParams,
    );
    return route.fulfill({
      json: modelSettingsSnapshot({
        projectOverrides:
          settingsOwner.cwd === target ? ["defaultThinkingLevel"] : [],
      }),
    });
  });
  await page.route("**/api/provider-auth**", (route) =>
    route.fulfill({ json: { result: [] } }),
  );
  await pairAndOpen(page);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Project directory", exact: true })
    .fill(target);
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await page
    .getByRole("button", { name: "Manage models", exact: true })
    .click();
  await expect.poll(() => settingsOwner).toEqual({ cwd: target });
  await expect(page.getByText(/This project uses/)).toBeVisible();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(
    settings.getByRole("button", { name: "Models", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await expect(
    settings.getByRole("heading", { name: "Models", exact: true }),
  ).toBeInViewport();
  await settings
    .getByRole("button", { name: "Add provider", exact: true })
    .click();
  await settings
    .getByLabel("Provider ID", { exact: true })
    .fill("prospective-draft");
  await settings.getByRole("button", { name: "Display", exact: true }).click();
  await settings.getByRole("button", { name: "Models", exact: true }).click();
  await expect(settings.getByLabel("Provider ID", { exact: true })).toHaveValue(
    "prospective-draft",
  );
  expect(settingsOwner).toEqual({ cwd: target });

  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .press("Escape");
  await page
    .getByRole("button", { name: /Review extension event lifecycle/ })
    .first()
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  settingsOwner = undefined;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Models", exact: true })
    .click();
  await expect.poll(() => settingsOwner).toEqual({ sessionId: "mock-history" });
});

test("model search and refresh preserve defaults and browsing position", async ({
  page,
}) => {
  const scenario = await modelSettingsScenario(page);
  const models = scenario.snapshot().models;
  models.push(
    ...Array.from({ length: 20 }, (_, index) => ({
      ...models[0]!,
      id: `catalog-${index}`,
      name: `Catalog model ${index}`,
    })),
  );
  await pairAndOpen(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "Settings",
    exact: true,
  });
  await settings.getByRole("button", { name: "Models", exact: true }).click();
  const defaults = settings.locator(".models-results");
  await expect(defaults).toBeInViewport();
  await settings
    .getByRole("button", { name: "Refresh available models" })
    .click();
  await expect(settings.getByRole("row").first()).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(settings.getByRole("row", { selected: true })).toHaveCount(0);
  expect(scenario.snapshot().saved.defaultModel).toBeNull();
  const search = settings.getByRole("combobox", {
    name: "Search available models",
  });
  await search.click();
  await expect(settings.getByRole("row").first()).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(search).not.toHaveAttribute("aria-activedescendant");
  await search.fill("gpt");
  await expect(settings.getByRole("row").first()).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await search.press("Enter");
  expect(scenario.snapshot().saved.defaultModel).toBeNull();
  await search.press("ArrowDown");
  await expect(settings.getByRole("row").first()).toHaveClass(
    /dropdown__option--active/,
  );
  await search.press("Tab");
  await expect(search).not.toHaveAttribute("aria-activedescendant");
  await search.fill("");
  const grid = settings.getByRole("grid", { name: "Available models" });
  const position = await grid.evaluate((element) => {
    element.scrollTop = 120;
    return element.scrollTop;
  });
  expect(position).toBeGreaterThan(0);
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes("/api/model-settings") &&
      response.request().method() === "GET",
  );
  await settings
    .getByRole("button", { name: "Refresh available models" })
    .click();
  await refreshed;
  await expect(
    settings.getByRole("button", { name: "Refresh available models" }),
  ).toBeEnabled();
  await expect
    .poll(() => grid.evaluate((element) => element.scrollTop))
    .toBe(position);
  await search.fill("local");
  await expect
    .poll(() => grid.evaluate((element) => element.scrollTop))
    .toBe(0);
});

test("Common and Default choices navigate unmounted rows without losing saved focus", async ({
  page,
}) => {
  const scenario = await modelSettingsScenario(page);
  scenario.snapshot().models.push(
    ...Array.from({ length: 40 }, (_, index) => ({
      provider: "openai",
      id: `z-${String(index).padStart(3, "0")}`,
      name: `Model ${index}`,
      reasoning: true,
    })),
  );
  const writes: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/model-settings") &&
      request.method() === "PATCH"
    )
      writes.push(request.postDataJSON());
  });
  await pairAndOpen(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Models", exact: true }).click();
  const firstDefault = settings.getByRole("radio", {
    name: "Default: Claude Haiku",
  });
  await firstDefault.click();
  await expect(firstDefault).toBeChecked();
  await expect(firstDefault).toBeFocused();
  await firstDefault.click();
  expect(writes).toHaveLength(1);
  await expect(settings.getByRole("radio", { checked: true })).toHaveCount(1);

  await firstDefault.press("End");
  const lastDefault = settings.getByRole("radio", {
    name: "Default: Model 39",
    exact: true,
  });
  await expect(lastDefault).toBeChecked();
  await expect(lastDefault).toBeFocused();
  await expect(lastDefault).toBeInViewport();
  expect(await settings.getByRole("row").count()).toBeLessThan(20);
  await expect
    .poll(() => scenario.snapshot().saved.defaultModel)
    .toEqual({
      provider: "openai",
      id: "z-039",
    });
  await lastDefault.press("ArrowDown");
  await expect(firstDefault).toBeChecked();
  await expect(firstDefault).toBeFocused();

  const firstCommon = settings.getByRole("checkbox", {
    name: "Common: Claude Haiku",
  });
  await firstCommon.focus();
  await firstCommon.press("Space");
  await expect(firstCommon).toBeChecked();
  await expect(firstCommon).toBeFocused();
  const selected = scenario.snapshot().saved.defaultModel;
  await firstCommon.press("End");
  const lastCommon = settings.getByRole("checkbox", {
    name: "Common: Model 39",
    exact: true,
  });
  await expect(lastCommon).toBeFocused();
  await expect(lastCommon).not.toBeChecked();
  expect(scenario.snapshot().saved.defaultModel).toEqual(selected);
  await lastCommon.press("Tab");
  await expect(lastDefault).toBeFocused();
  await lastDefault.press("ArrowUp");
  const previousDefault = settings.getByRole("radio", {
    name: "Default: Model 38",
    exact: true,
  });
  await expect(previousDefault).toBeChecked();
  await expect(previousDefault).toBeFocused();

  await settings.getByRole("button", { name: "Clear default model" }).click();
  await expect(settings.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(
    settings.getByRole("combobox", { name: "Default thinking" }),
  ).toBeFocused();
  expect(scenario.snapshot().saved.defaultModel).toBeNull();
  expect(scenario.errors).toEqual([]);
});

test.describe("scalar default rows", () => {
  test.use({ hasTouch: true });
  test("keeps default rows and existing model actions readable at desktop and narrow widths", async ({
    page,
  }) => {
    const scenario = await modelSettingsScenario(page);
    await pairAndOpen(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings.getByRole("button", { name: "Models", exact: true }).click();
    const defaults = settings.locator(".models-results");
    await expect(defaults).toBeInViewport();
    for (const width of [1280, 540, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await defaults.evaluate((element) =>
        element.scrollIntoView({ block: "center", behavior: "instant" }),
      );
      for (const field of await defaults.locator(".settings__field").all()) {
        const label = (await field
          .locator(".settings__field-label")
          .boundingBox())!;
        const control = (await field
          .locator(".settings__field-control")
          .boundingBox())!;
        const fieldBox = (await field.boundingBox())!;
        expect(control.x + control.width).toBeLessThanOrEqual(
          fieldBox.x + fieldBox.width + 1,
        );
        expect(
          label.x + label.width <= control.x + 1 ||
            label.y + label.height <= control.y + 1,
        ).toBe(true);
      }
      const thinking = settings.getByRole("combobox", {
        name: "Default thinking",
      });
      expect((await thinking.boundingBox())!.height).toBeGreaterThanOrEqual(32);
      await expect(thinking).toBeVisible();
      expect(scenario.snapshot().saved.defaultThinkingLevel).toBeNull();
      const common = settings.getByRole("checkbox", {
        name: "Common: Local model",
      });
      const makeDefault = settings.getByRole("radio", {
        name: "Default: Local model",
      });
      const commonBox = (await common.locator("..").boundingBox())!;
      const defaultBox = (await makeDefault.locator("..").boundingBox())!;
      expect(Math.abs(commonBox.y - defaultBox.y)).toBeLessThan(1);
      expect(defaultBox.x + defaultBox.width).toBeLessThanOrEqual(width);
      expect(commonBox.width).toBe(defaultBox.width);
      const otherDefault = (await settings
        .getByRole("radio", { name: "Default: Claude Haiku" })
        .locator("..")
        .boundingBox())!;
      expect(defaultBox.x).toBe(otherDefault.x);
      const modelRow = settings.getByRole("row").filter({
        has: page.getByRole("radio", { name: "Default: Local model" }),
      });
      const rowBox = (await modelRow.boundingBox())!;
      const modelName = (await modelRow
        .locator(".model-picker__name-text")
        .boundingBox())!;
      const editBox = (await modelRow
        .getByRole("button", { name: "Edit model custom/local" })
        .boundingBox())!;
      expect(editBox.x).toBeGreaterThanOrEqual(modelName.x + modelName.width);
      expect(rowBox.height).toBeLessThanOrEqual(width >= 540 ? 48 : 64);
      expect(defaultBox.y + defaultBox.height).toBeLessThanOrEqual(
        rowBox.y + rowBox.height,
      );
      if (width >= 540) {
        const emptyValue = (await defaults
          .locator(".models-default-result")
          .boundingBox())!;
        expect(emptyValue.x).toBe((await thinking.boundingBox())!.x);
      }
      expect(
        await settings
          .locator(".settings__main")
          .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
      ).toBe(false);
    }
  });
});

for (const touch of [false, true]) {
  test.describe(
    touch ? "narrow touch configuration" : "desktop configuration",
    () => {
      test.use({
        viewport: touch
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
        hasTouch: touch,
      });
      test("provider -> model -> common/default retains row focus, current model and composer draft", async ({
        page,
      }) => {
        const scenario = await modelSettingsScenario(page);
        await pairAndOpen(page);
        const draft = page.getByRole("textbox", {
          name: "Message",
          exact: true,
        });
        await draft.fill("Keep this unfinished draft while managing models");
        const model = page.getByRole("button", { name: "Model", exact: true });
        const currentModel = await model.textContent();
        await model.click();
        const pickerRow = page.getByRole("option").first();
        await expect(pickerRow).toBeVisible();
        await expect
          .poll(async () => (await pickerRow.boundingBox())?.height)
          .toBe(48);
        if (touch)
          await page
            .getByRole("button", { name: "Manage models", exact: true })
            .tap();
        else {
          await page
            .getByRole("combobox", { name: "Search models" })
            .press("Tab");
          await expect(
            page.getByRole("button", { name: "Manage models", exact: true }),
          ).toBeFocused();
          await page.keyboard.press("Enter");
        }
        const settings = page.getByRole("dialog", {
          name: "Settings",
          exact: true,
        });
        await settings
          .getByRole("region", { name: "Custom providers" })
          .getByRole("button", { name: "Show", exact: true })
          .click();
        const customProvider = settings.getByRole("region", {
          name: "Custom provider custom",
          exact: true,
        });
        const modelsDisclosure = customProvider.locator(
          ".models-provider-models__disclosure",
        );
        await expect(modelsDisclosure).not.toHaveAttribute("open", "");
        await expect(
          customProvider.getByRole("button", {
            name: "Edit declared model custom/local",
            exact: true,
          }),
        ).toBeHidden();
        await modelsDisclosure.locator("summary").click();
        await expect(
          customProvider.getByRole("button", {
            name: "Edit declared model custom/local",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          customProvider.locator(".models-declared-model__capabilities"),
        ).toHaveCount(0);
        await settings
          .getByRole("button", { name: "Add provider", exact: true })
          .click();
        await settings.getByLabel("Provider ID").fill("new-provider");
        await settings.getByLabel("Base URL").fill("http://localhost:9999/v1");
        await settings
          .getByLabel("API key", { exact: true })
          .fill("CONFIG_FIXTURE_SECRET");
        await settings
          .getByRole("button", { name: "Save provider", exact: true })
          .click();
        const addModel = settings.getByRole("button", {
          name: "Add model to new-provider",
          exact: true,
        });
        await expect(addModel).toBeFocused();
        await addModel.click();
        await settings
          .getByLabel("Model ID", { exact: true })
          .fill("new-model");
        await settings
          .getByLabel("Display name", { exact: true })
          .fill("New available model");
        // This endpoint-first provider has no inherited API; declare the required
        // model API rather than relying on a placeholder as an implicit default.
        await settings
          .getByLabel("API type", { exact: true })
          .fill("openai-completions");
        await page.screenshot({
          path: `output/playwright/model-form-${touch ? "touch" : "desktop"}.png`,
          animations: "disabled",
        });
        await settings
          .getByRole("button", { name: "Save model", exact: true })
          .click();
        const common = settings.getByRole("checkbox", {
          name: "Common: New available model",
        });
        await expect(common).toBeFocused();
        await common.click();
        await settings
          .getByRole("radio", { name: "Default: New available model" })
          .click();
        await expect
          .poll(() => scenario.snapshot().saved.defaultModel)
          .toEqual({ provider: "new-provider", id: "new-model" });
        const identity = settings.locator(".models-default-value__identity");
        const nameBox = (await identity
          .locator(".models-default-value__name")
          .boundingBox())!;
        const idBox = (await identity
          .locator(".models-default-value__id")
          .boundingBox())!;
        expect(nameBox.x).toBe(idBox.x);
        expect(nameBox.y + nameBox.height).toBeLessThanOrEqual(idBox.y);
        const thinking = settings.getByRole("combobox", {
          name: "Default thinking",
        });
        await thinking.click();
        await page
          .getByRole("listbox", { name: "Default thinking", exact: true })
          .getByRole("option", { name: "xhigh", exact: true })
          .click();
        await expect(thinking).toHaveText("xhigh");
        expect(scenario.snapshot().saved.defaultThinkingLevel).toBe("xhigh");
        await settings.getByText(/Common order/, { exact: false }).click();
        await settings
          .getByRole("button", { name: "Move custom/local:high down" })
          .click();
        await expect
          .poll(() => scenario.snapshot().saved.enabledModels)
          .toEqual([
            "openai/gpt-5",
            "custom/local:high",
            "new-provider/new-model",
          ]);
        await settings
          .getByRole("button", { name: "Edit provider new-provider" })
          .click();
        await expect(
          settings.getByLabel("API key", { exact: true }),
        ).toHaveValue("");
        await settings
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await settings
          .getByRole("region", { name: "Models", exact: true })
          .evaluate((element) =>
            element.scrollIntoView({ block: "start", behavior: "instant" }),
          );
        await page.screenshot({
          path: `output/playwright/model-settings-${touch ? "touch" : "desktop"}.png`,
          animations: "disabled",
        });
        expect(
          await settings
            .locator(".settings__main")
            .evaluate(
              (element) => element.scrollWidth > element.clientWidth + 1,
            ),
        ).toBe(false);
        await settings.getByRole("button", { name: "Close settings" }).click();
        await expect(draft).toHaveValue(
          "Keep this unfinished draft while managing models",
        );
        await expect(model).toHaveText(currentModel!);
        expect(scenario.modelChanges).toEqual([]);
        expect(scenario.errors).toEqual([]);
      });
    },
  );
}
