import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { modelSettingsSnapshot } from "../web/fixtures/model-settings";
import { browserFixtureHome } from "./fixtures/workspace.mjs";
import { expectConfigurationField } from "./support/configuration-form";
import { routeSnapshots } from "./support/host-events";
import {
  openFixtureSession,
  openSettings,
  pairedPage,
} from "./support/navigation";

const desktop = { width: 1280, height: 900 };
test.use({
  viewport: desktop,
  serviceWorkers: "block",
  reducedMotion: "reduce",
});

test.describe("touch model settings", () => {
  const viewport = { width: 320, height: 844 };
  test.use({ hasTouch: true });
  test("virtualized model browsing and the editor retain focus and context across resize and refresh", async ({
    page,
  }) => {
    const snapshot = modelSettingsSnapshot();
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
    snapshot.providers[0]!.models.push(
      { id: "same ", type: "embedding", name: "Embedding model" },
      {
        id: "same ",
        type: "chat",
        name: "Chat model",
        contextWindow: 0,
        maxTokens: 0.5,
      },
    );
    await routeSnapshots(page, {
      snapshot: (body) => {
        if (body.active) body.active.availableModels = snapshot.models;
      },
    });
    await page.route("**/api/models**", (route) =>
      route.fulfill({
        json: { models: snapshot.models, commonModels: snapshot.commonModels },
      }),
    );
    let reading: "available" | "catalog failed" | "preferences failed" =
      "available";
    const warning =
      "Model availability could not load. Saved configuration is still editable; refresh models to retry.";
    await page.route(/\/api\/model-settings\?/, (route) =>
      route.fulfill({
        json: {
          ...snapshot,
          ...(reading === "catalog failed"
            ? { models: [], modelsWarning: warning }
            : {}),
          ...(reading === "preferences failed"
            ? { settingsError: "Invalid Pi settings" }
            : {}),
        },
      }),
    );
    await page.route("**/api/model-settings/config?**", (route) =>
      route.fulfill({ json: { saved: true, snapshot } }),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const total = snapshot.models.length;
    const target = snapshot.models.at(-1)!;
    await pairedPage(page);
    await openFixtureSession(
      page,
      /Review extension event lifecycle/,
      "fixture-history",
    );
    await page.setViewportSize(viewport);
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

    await page.setViewportSize(desktop);
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
    await expect(
      settings.getByRole("button", { name: "Set as default" }),
    ).toBeEnabled();
    await page.setViewportSize(viewport);
    await expect(
      settings.getByRole("combobox", { name: "Default thinking" }),
    ).toBeInViewport({ ratio: 1 });
    await search.fill("local");
    await search.press("Enter");
    const opener = settings.getByRole("button", {
      name: "Edit model custom/local",
      exact: true,
    });
    const content = settings.locator(".settings__content");
    await opener.scrollIntoViewIfNeeded();
    const browsePosition = await content.evaluate((el) => el.scrollTop);
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
    const back = editor.getByRole("button", { name: "Back to models" });
    await back.scrollIntoViewIfNeeded();
    await expect(back).toBeInViewport();

    await page.setViewportSize(viewport);
    await back.click();
    await expect(search).toHaveValue("local");
    await expect(opener).toBeFocused();
    await expect
      .poll(() => content.evaluate((el) => el.scrollTop))
      .toBeCloseTo(browsePosition, 0);
    await page.setViewportSize(desktop);
    reading = "catalog failed";
    await refresh.click();
    await expect(settings.getByText(warning, { exact: true })).toBeVisible();
    const thinking = settings.getByRole("combobox", {
      name: "Default thinking",
    });
    await expect(thinking).toBeEnabled();
    await expect(
      settings.getByRole("button", { name: "Add provider" }),
    ).toBeEnabled();
    reading = "preferences failed";
    await refresh.click();
    await expect(settings.getByText("Invalid Pi settings")).toBeVisible();
    await expect(thinking).toBeDisabled();
    await expect(
      settings.getByRole("button", { name: "Set as default" }),
    ).toBeDisabled();

    await settings.getByLabel("Custom provider declarations").click();
    const declaration = settings.getByRole("combobox", {
      name: "Custom declaration",
    });
    const editModel = async (label: string) => {
      await declaration.selectOption({ label });
      await settings
        .getByRole("button", { name: `Edit declared model ${label}` })
        .click();
    };
    await editModel("custom/same (embedding)");
    await editor.getByLabel("Display name").fill("Unsaved embedding edit");
    await back.click();
    await editModel("custom/same");
    await expect(editor.getByLabel("Display name")).toHaveValue("Chat model");
    for (const name of ["Context window", "Maximum output tokens"])
      expect(
        await editor
          .getByLabel(name)
          .evaluate((input: HTMLInputElement) => input.validity.valid),
      ).toBe(true);
    const edited = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/model-settings/config",
    );
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    expect((await edited).postDataJSON().edit).toEqual({
      kind: "model",
      provider: "custom",
      originalId: "same ",
      originalType: "chat",
      values: { id: "same " },
    });
    expect(errors).toEqual([]);
  });
});

test("New model settings save native declarations and defaults for the prospective owner", async ({
  page,
}) => {
  const target = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-model-project-")),
  );
  const agent = join(browserFixtureHome, "agent");
  const configuration = join(agent, "models.json");
  const preferences = join(agent, "settings.json");
  const original = await readFile(preferences);
  const originalConfig = await readFile(configuration).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const savedPreferences = async () =>
    JSON.parse(await readFile(preferences, "utf8"));
  const writes: { owner: Record<string, string>; patch: unknown }[] = [];
  let settingsOwner: Record<string, string> | undefined;
  let modelChanges = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/control/model") modelChanges++;
    if (url.pathname !== "/api/model-settings") return;
    const owner = Object.fromEntries(url.searchParams);
    if (request.method() === "GET") settingsOwner = owner;
    if (request.method() === "PATCH")
      writes.push({ owner, patch: request.postDataJSON().patch });
  });
  try {
    await mkdir(join(target, ".pi"));
    await writeFile(
      join(target, ".pi/settings.json"),
      '{"defaultProvider":"workbench","defaultThinkingLevel":"low"}',
    );
    await writeFile(
      preferences,
      JSON.stringify({
        ...(await savedPreferences()),
        defaultProvider: "missing",
      }),
    );
    await pairedPage(page);
    await page.getByRole("textbox", { name: "Project directory" }).fill(target);
    const draft = page.getByRole("textbox", {
      name: "First message",
      exact: true,
    });
    const text = "Keep this unfinished draft while managing models";
    await draft.fill(text);
    const model = page.getByRole("button", { name: "Model", exact: true });
    await expect(model).toHaveAttribute(
      "title",
      "Use workspace model defaults",
    );
    await model.click();
    const search = page.getByRole("combobox", { name: "Search models" });
    const manage = page.getByRole("button", {
      name: "Manage models",
      exact: true,
    });
    await expect(search).toBeFocused();
    await search.press("Tab");
    await expect(manage).toBeFocused();
    await manage.press("Enter");
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await expect
      .poll(() => settingsOwner)
      .toEqual({ cwd: target, refresh: "1" });
    await expect(
      settings.getByText("This project uses Low.", { exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByTitle("missing/offline · Not currently available"),
    ).toBeVisible();
    await expect(
      settings.getByText(/This project uses Offline model\./),
    ).toBeVisible();
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
    const tokens = form.getByLabel("Maximum output tokens");
    await tokens.fill("-1");
    await save.click();
    const error = form.getByRole("alert");
    await expect(error).toContainText("Pi rejected this declaration");
    await expect(error).toBeFocused();
    expect(
      JSON.parse(await readFile(configuration, "utf8")).providers[
        "new-provider"
      ].models ?? [],
    ).toEqual([]);
    await tokens.fill("512");
    await save.click();
    const common = settings.getByRole("checkbox", {
      name: "Common: New available model",
    });
    await expect(common).toBeVisible();
    await common.press("Space");
    await expect(common).toBeFocused();
    await settings.getByRole("button", { name: "Set as default" }).click();
    await expect.poll(savedPreferences).toMatchObject({
      defaultProvider: "new-provider",
      defaultModel: "new-model",
      enabledModels: ["new-provider/new-model"],
    });
    await settings.getByRole("button", { name: "Clear default model" }).click();
    const thinking = settings.getByRole("combobox", {
      name: "Default thinking",
    });
    await expect(thinking).toBeFocused();
    await expect(thinking).toHaveValue("medium");
    await thinking.selectOption("unset");
    await expect
      .poll(savedPreferences)
      .not.toHaveProperty("defaultThinkingLevel");
    expect(writes).toContainEqual({
      owner: { cwd: target },
      patch: { defaultModel: { provider: "new-provider", id: "new-model" } },
    });
    const refresh = settings.getByRole("button", {
      name: "Refresh available models",
    });
    const setCommon = async (enabledModels: string[]) => {
      await writeFile(
        preferences,
        JSON.stringify({ ...(await savedPreferences()), enabledModels }),
      );
      await refresh.click();
    };
    const pattern = settings.getByRole("button", {
      name: "Edit common pattern for New available model",
    });
    await setCommon([
      "new-provider/new-model:high",
      "new-provider/*:high",
      "new-provider/new-model",
    ]);
    await expect(common).toHaveCount(0);
    await pattern.click();
    const modelPattern = settings.getByRole("textbox", {
      name: "Model pattern",
    });
    await expect(modelPattern).toHaveValue("new-provider/*:high");
    await modelPattern.fill("new-provider/*:medium");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(savedPreferences).toMatchObject({
      enabledModels: [
        "new-provider/new-model:high",
        "new-provider/*:medium",
        "new-provider/new-model",
      ],
    });
    await setCommon([
      "new-provider/new-model:high",
      "workbench/*",
      "new-provider/new-model",
    ]);
    await expect(common).toBeChecked();
    await common.click();
    await expect
      .poll(savedPreferences)
      .toMatchObject({ enabledModels: ["workbench/*"] });
    await settings
      .getByRole("button", { name: "Connect provider", exact: true })
      .click();
    await settings.getByLabel("Search providers").fill("new-provider");
    await settings
      .getByRole("button", { name: "Set up new-provider", exact: true })
      .click();
    await settings
      .getByRole("button", { name: "API key", exact: true })
      .click();
    await expect(
      settings.getByLabel("Enter API key", { exact: true }),
    ).toBeVisible();
    await settings
      .getByRole("button", { name: "Cancel login", exact: true })
      .click();
    await settings
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await settings
      .getByRole("combobox", { name: "Custom declaration" })
      .selectOption({ label: "new-provider" });
    await settings
      .getByRole("button", { name: "Edit provider new-provider" })
      .click();
    await expect(settings.getByLabel("API key", { exact: true })).toHaveValue(
      "",
    );
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await settings.getByRole("button", { name: "Close settings" }).click();
    await expect(draft).toHaveValue(text);
    await expect(model).toHaveAttribute(
      "title",
      "Use workspace model defaults",
    );
    await openFixtureSession(
      page,
      /Review extension event lifecycle/,
      "fixture-history",
    );
    const selected = /^(?:Offline model|offline) — workbench$/;
    await expect(model).toHaveAttribute("title", selected);
    await openSettings(page);
    await settings.getByRole("button", { name: "Models", exact: true }).click();
    await expect
      .poll(() => settingsOwner)
      .toEqual({ sessionId: "fixture-history", refresh: "1" });
    await expect(model).toHaveAttribute("title", selected);
    expect(modelChanges).toBe(0);
  } finally {
    await writeFile(preferences, original);
    if (originalConfig) await writeFile(configuration, originalConfig);
    else await rm(configuration, { force: true });
    await rm(target, { recursive: true, force: true });
  }
});
