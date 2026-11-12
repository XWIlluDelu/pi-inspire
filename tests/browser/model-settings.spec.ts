import { expect, type Page, test } from "@playwright/test";
import { modelSettingsScenario } from "./fixtures/model-settings";
import { expectConfigurationField } from "./support/configuration-form";
import { openSettings, pairAndOpen } from "./support/navigation";

test.use({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });

async function openModels(page: Page) {
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Models", exact: true }).click();
  return settings;
}

test("Manage models carries New's prospective project only for its Settings visit", async ({
  page,
}) => {
  const target = "/tmp/inspire-browser-prospective-models";
  const scenario = await modelSettingsScenario(page);
  scenario.snapshot().projectOverrides = ["defaultThinkingLevel"];
  let settingsOwner: Record<string, string> | undefined;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/model-settings" && request.method() === "GET")
      settingsOwner = Object.fromEntries(url.searchParams);
  });
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
  const write = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/model-settings" &&
      request.method() === "PATCH",
  );
  const defaultModel = settings.getByRole("radio", {
    name: "Default: Claude Haiku",
  });
  await defaultModel.click();
  expect(Object.fromEntries(new URL((await write).url()).searchParams)).toEqual(
    { cwd: target },
  );
  await expect(defaultModel).toBeChecked();

  await settings.press("Escape");
  await page
    .getByRole("button", { name: /Review extension event lifecycle/ })
    .first()
    .click();
  await openModels(page);
  await expect
    .poll(() => settingsOwner)
    .toEqual({ sessionId: "fixture-history" });
});

test("search, refresh and keyboard actions preserve the virtual model list and saved choices", async ({
  page,
}) => {
  const scenario = await modelSettingsScenario(page);
  scenario.snapshot().saved.defaultThinkingLevel = "xhigh";
  scenario.snapshot().models.push(
    ...Array.from({ length: 40 }, (_, index) => ({
      provider: "openai",
      id: `z-${String(index).padStart(3, "0")}`,
      name: `Model ${index}`,
      reasoning: true,
    })),
  );
  await pairAndOpen(page);
  const settings = await openModels(page);
  const search = settings.getByRole("combobox", {
    name: "Search available models",
  });
  const grid = settings.getByRole("grid", { name: "Available models" });
  const refresh = settings.getByRole("button", {
    name: "Refresh available models",
  });
  await search.fill("openai/z-039");
  const matching = grid.getByRole("row", { name: /Model 39/ });
  await expect(matching).toBeVisible();
  await search.press("Enter");
  await expect(matching.getByRole("radio")).not.toBeChecked();
  await search.press("ArrowDown");
  await expect(search).toHaveAttribute("aria-activedescendant", /.+/);
  await search.press("Tab");
  await expect(search).not.toHaveAttribute("aria-activedescendant");

  await search.fill("");
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
  await refresh.click();
  await refreshed;
  await expect(refresh).toBeEnabled();
  await expect
    .poll(() => grid.evaluate((element) => element.scrollTop))
    .toBe(position);
  await search.fill("custom/local");
  await expect(grid.getByRole("row", { name: /Local model/ })).toBeVisible();
  await expect
    .poll(() => grid.evaluate((element) => element.scrollTop))
    .toBe(0);
  expect(scenario.snapshot().saved.defaultModel).toBeNull();
  await search.fill("");

  const firstDefault = settings.getByRole("radio", {
    name: "Default: Claude Haiku",
  });
  await firstDefault.click();
  await expect(firstDefault).toBeChecked();
  await expect(firstDefault).toBeFocused();

  await firstDefault.press("End");
  const lastDefault = settings.getByRole("radio", {
    name: "Default: Model 39",
    exact: true,
  });
  await expect(lastDefault).toBeChecked();
  await expect(lastDefault).toBeFocused();
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

  await settings.getByRole("button", { name: "Clear default model" }).click();
  await expect(settings.getByRole("radio", { checked: true })).toHaveCount(0);
  const thinking = settings.getByRole("combobox", { name: "Default thinking" });
  await expect(thinking).toBeFocused();
  await expect(thinking).toHaveText(/^xhigh$/i);
  expect(scenario.snapshot().saved.defaultModel).toBeNull();
  await thinking.click();
  await page
    .getByRole("listbox", { name: "Default thinking", exact: true })
    .getByRole("option", { name: /^Model default\b/ })
    .click();
  await expect
    .poll(() => scenario.snapshot().saved.defaultThinkingLevel)
    .toBeNull();
  await settings.getByText(/Common order/, { exact: false }).click();
  await settings
    .getByRole("button", { name: "Move custom/local:high down" })
    .click();
  await expect
    .poll(() => scenario.snapshot().saved.enabledModels)
    .toEqual(["openai/gpt-5", "custom/local:high", "anthropic/claude-haiku"]);
  expect(scenario.errors).toEqual([]);
});

test.describe("touch model editor", () => {
  const viewport = { width: 320, height: 844 };
  test.use({ viewport, hasTouch: true });

  test("focused editors keep actions reachable and restore their browsing context", async ({
    page,
  }) => {
    const scenario = await modelSettingsScenario(page, "dark");
    await pairAndOpen(page);
    const settings = await openModels(page);
    await expect(
      settings.getByRole("combobox", { name: "Default thinking" }),
    ).toBeInViewport({ ratio: 1 });
    const search = settings.getByRole("combobox", {
      name: "Search available models",
    });
    await search.fill("local");
    const opener = settings.getByRole("button", {
      name: "Edit model custom/local",
      exact: true,
    });
    const content = settings.locator(".settings__content");
    await opener.scrollIntoViewIfNeeded();
    await expect(opener).toBeInViewport({ ratio: 1 });
    await expect(
      settings.getByRole("radio", { name: "Default: Local model" }),
    ).toBeInViewport({ ratio: 1 });
    expect(
      await settings
        .locator(".settings__main")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
    const position = await content.evaluate((el) => el.scrollTop);
    await opener.click();
    const editor = settings.getByRole("region", {
      name: "Edit model",
      exact: true,
    });
    await expect(search).toBeHidden();
    await expect(editor.getByLabel("Model ID", { exact: true })).toBeFocused();
    await editor.getByText("Connection overrides", { exact: true }).click();
    await page.setViewportSize({ width: 320, height: 460 });
    await expect(
      editor.getByRole("button", { name: "Save", exact: true }),
    ).toBeInViewport();
    await expect(
      editor.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeInViewport();
    await editor.getByLabel("Base URL override").focus();
    await expectConfigurationField(editor.getByLabel("Base URL override"));
    await editor
      .getByRole("button", { name: "Back to models" })
      .scrollIntoViewIfNeeded();
    await expect(
      editor.getByRole("button", { name: "Back to models" }),
    ).toBeInViewport();

    await page.setViewportSize(viewport);
    await editor.getByRole("button", { name: "Back to models" }).click();
    await expect(search).toHaveValue("local");
    await expect(opener).toBeFocused();
    await expect
      .poll(() => content.evaluate((el) => el.scrollTop))
      .toBeCloseTo(position, 0);
    expect(scenario.errors).toEqual([]);
  });
});

test("first provider and model setup preserves the current model and composer draft", async ({
  page,
}) => {
  const scenario = await modelSettingsScenario(page);
  const empty = scenario.snapshot();
  empty.models = [];
  empty.providers = [];
  empty.commonModels = [];
  empty.savedCommonEntries = [];
  empty.saved.enabledModels = [];
  empty.effective.enabledModels = [];
  scenario.providers().length = 0;
  await pairAndOpen(page);
  const draft = page.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  await draft.fill("Keep this unfinished draft while managing models");
  const model = page.getByRole("button", { name: "Model", exact: true });
  const currentModel = await model.textContent();
  await model.click();
  {
    const search = page.getByRole("combobox", { name: "Search models" });
    await expect(search).toBeFocused();
    await search.press("Tab");
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
    .getByRole("button", { name: "Add provider", exact: true })
    .click();
  await settings.getByLabel("Provider ID").fill("new-provider");
  await settings.getByLabel("Base URL").fill("http://localhost:9999/v1");
  await settings
    .getByLabel("API key", { exact: true })
    .fill("CONFIG_FIXTURE_SECRET");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  const addModel = settings.getByRole("button", {
    name: "Add model to new-provider",
    exact: true,
  });
  await expect(addModel).toBeFocused();
  await addModel.click();
  await settings.getByLabel("Model ID", { exact: true }).fill("new-model");
  await settings
    .getByLabel("Display name", { exact: true })
    .fill("New available model");
  const form = settings.locator("form").filter({
    has: page.getByLabel("API type", { exact: true }),
  });
  const api = form.getByLabel("API type", { exact: true });
  const save = form.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect(api).toBeFocused();
  await api.fill("openai-completions");
  await page.route(
    "**/api/model-settings/config?**",
    (route) =>
      route.fulfill({
        status: 400,
        json: { error: "Pi rejected this declaration" },
      }),
    { times: 1 },
  );
  await save.click();
  const error = form.getByRole("alert");
  await expect(error).toHaveText("Pi rejected this declaration");
  await expect(error).toBeFocused();
  await save.click();
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
  expect(scenario.snapshot().saved.enabledModels).toEqual([
    "new-provider/new-model",
  ]);
  await settings
    .getByRole("button", { name: "Edit provider new-provider" })
    .click();
  await expect(settings.getByLabel("API key", { exact: true })).toHaveValue("");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(draft).toHaveValue(
    "Keep this unfinished draft while managing models",
  );
  await expect(model).toHaveText(currentModel!);
  expect(scenario.modelChanges).toEqual([]);
  expect(scenario.errors).toEqual([]);
});
