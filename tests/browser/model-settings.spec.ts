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
  await expect.poll(() => settingsOwner).toEqual({ cwd: target, refresh: "1" });
  await expect(page.getByText(/This project uses/)).toBeVisible();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const write = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/model-settings" &&
      request.method() === "PATCH",
  );
  await settings.getByRole("option", { name: /Claude Haiku/ }).click();
  const defaultModel = settings.getByRole("button", { name: "Set as default" });
  await defaultModel.click();
  expect(Object.fromEntries(new URL((await write).url()).searchParams)).toEqual(
    { cwd: target },
  );
  await expect(defaultModel).toBeDisabled();

  await settings.press("Escape");
  await page
    .getByRole("button", { name: /Review extension event lifecycle/ })
    .first()
    .click();
  await openModels(page);
  await expect
    .poll(() => settingsOwner)
    .toEqual({ sessionId: "fixture-history", refresh: "1" });
});

test.describe("touch model lists", () => {
  test.use({ hasTouch: true });
  test("search, refresh and keyboard actions preserve the virtual model list and saved choices", async ({
    page,
  }) => {
    const scenario = await modelSettingsScenario(page, "light", true);
    const snapshot = scenario.snapshot();
    snapshot.saved.defaultThinkingLevel = "xhigh";
    const providers = [
      "research-calibration-openai-compatible-service",
      "本地科研仪器校准与测量数据兼容服务",
    ];
    snapshot.models.push(
      ...Array.from({ length: 1_100 }, (_, index) => ({
        provider: providers[index] ?? "synthetic",
        id: `model-${String(index).padStart(4, "0")}`,
        name:
          index < providers.length ? "Calibration reader" : `Model ${index}`,
        reasoning: false,
      })),
    );
    const total = snapshot.models.length;
    const target = snapshot.models.at(-1)!;
    await pairAndOpen(page);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.getByRole("button", { name: "Model", exact: true }).click();
    const picker = page.getByRole("listbox", { name: "Available models" });
    await expect(picker).toBeFocused();
    const menu = page.locator(".model-picker__menu");
    const bounds = (await menu.boundingBox())!;
    expect(bounds.height).toBeLessThanOrEqual(457);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    await picker.press("End");
    const last = picker.locator(`[aria-posinset="${total}"]`);
    await expect(last).toBeInViewport();
    await expect(picker).toHaveAttribute(
      "aria-activedescendant",
      (await last.getAttribute("id"))!,
    );
    expect(await picker.getByRole("option").count()).toBeLessThan(25);
    const pickerSearch = page.getByRole("combobox", { name: "Search models" });
    await pickerSearch.fill(`${target.provider} ${target.id}`);
    await expect(
      picker.getByRole("option", { name: new RegExp(target.name!) }),
    ).toBeVisible();
    await pickerSearch.fill("calibration");
    for (const provider of providers) {
      const heading = menu
        .locator(".model-picker__heading")
        .filter({ hasText: provider });
      await expect(heading).toHaveAttribute("title", provider);
      await expect(heading).toHaveCSS("text-overflow", "ellipsis");
    }
    await page.getByRole("button", { name: "Manage models" }).click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    const list = settings.getByRole("listbox", { name: "Available models" });
    await expect(list).toBeAttached();
    expect(await list.getByRole("option").count()).toBeLessThan(16);
    expect(
      await settings
        .locator(".settings__main")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 1280, height: 900 });
    const search = settings.getByRole("combobox", {
      name: "Search available models",
    });
    const refresh = settings.getByRole("button", {
      name: "Refresh available models",
    });
    await expect(list.getByRole("option").first()).toBeVisible();
    const position = await list.evaluate((element) => {
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
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(position);
    await search.fill(`${target.provider}/${target.id}`);
    const matching = list.getByRole("option", {
      name: new RegExp(target.name!),
    });
    await expect(matching).toBeVisible();
    await search.press("Enter");
    await expect(matching).toHaveAttribute("aria-selected", "true");
    expect(scenario.snapshot().saved.defaultModel).toBeNull();
    await settings.getByRole("button", { name: "Set as default" }).click();
    await expect
      .poll(() => scenario.snapshot().saved.defaultModel)
      .toEqual({ provider: target.provider, id: target.id });
    await search.fill("Claude Haiku");
    await search.press("Enter");
    const commonChoice = settings.getByRole("checkbox", {
      name: "Common: Claude Haiku",
    });
    await commonChoice.press("Space");
    await expect(commonChoice).toBeChecked();
    await expect(commonChoice).toBeFocused();

    const thinking = settings.getByRole("combobox", {
      name: "Default thinking",
    });
    await settings.getByRole("button", { name: "Clear default model" }).click();
    await expect(thinking).toBeFocused();
    await expect(thinking).toHaveValue("xhigh");
    expect(scenario.snapshot().saved.defaultModel).toBeNull();
    await thinking.selectOption("unset");
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
    await search.press("Enter");
    const opener = settings.getByRole("button", {
      name: "Edit model custom/local",
      exact: true,
    });
    const content = settings.locator(".settings__content");
    await opener.scrollIntoViewIfNeeded();
    await expect(opener).toBeInViewport({ ratio: 1 });
    await expect(
      settings.getByRole("button", { name: "Set as default" }),
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
  const currentModel = /^(?:Offline model|offline) — workbench$/;
  await expect(model).toHaveAttribute("title", currentModel);
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
  await expect(common).toBeVisible();
  await common.click();
  await settings.getByRole("button", { name: "Set as default" }).click();
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
  await expect(model).toHaveAttribute("title", currentModel);
  expect(scenario.modelChanges).toEqual([]);
  expect(scenario.errors).toEqual([]);
});
