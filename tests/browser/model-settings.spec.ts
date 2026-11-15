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
  test("virtualized model browsing opens the selected declaration across resize", async ({
    page,
  }) => {
    const snapshot = modelSettingsSnapshot();
    snapshot.saved.defaultThinkingLevel = "xhigh";
    snapshot.models.push(
      ...Array.from({ length: 1_100 }, (_, index) => ({
        provider: "synthetic",
        id: `model-${index.toString().padStart(4, "0")}`,
        name: `Model ${index}`,
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
    await page.route(/\/api\/model-settings\?/, (route) =>
      route.fulfill({ json: snapshot }),
    );
    await page.route("**/api/model-settings/config?**", (route) =>
      route.fulfill({ json: { saved: true, snapshot } }),
    );
    const target = snapshot.models.at(-1)!;
    await pairedPage(page);
    await openFixtureSession(
      page,
      /Review extension event lifecycle/,
      "fixture-history",
    );
    await page.setViewportSize(viewport);
    await openSettings(page);
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings.getByRole("button", { name: "Models", exact: true }).click();
    const list = settings.getByRole("listbox", { name: "Available models" });
    await expect(list).toBeAttached();
    await page.setViewportSize(desktop);
    const search = settings.getByRole("combobox", {
      name: "Search available models",
    });
    await expect(list.getByRole("option").first()).toBeVisible();
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
    await settings.getByLabel("Custom provider declarations").click();
    await page.setViewportSize(viewport);
    const editor = settings.getByRole("region", {
      name: "Edit model",
      exact: true,
    });
    const back = editor.getByRole("button", { name: "Back to models" });
    const provider = settings.getByRole("region", {
      name: "Custom provider custom",
      exact: true,
    });
    await provider
      .getByText(`Models (${snapshot.providers[0]!.models.length})`, {
        exact: true,
      })
      .click();
    const editModel = (label: string) =>
      provider
        .getByRole("button", {
          name: `Edit declared model ${label}`,
          exact: true,
        })
        .click();
    await editModel("custom/same (embedding)");
    await editor.getByLabel("Display name").fill("Unsaved embedding edit");
    await back.click();
    await editModel("custom/same");
    await expect(editor.getByLabel("Display name")).toHaveValue("Chat model");
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
  let settingsOwner: Record<string, string> | undefined;
  let modelChanges = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/control/model") modelChanges++;
    if (url.pathname !== "/api/model-settings") return;
    const owner = Object.fromEntries(url.searchParams);
    if (request.method() === "GET") settingsOwner = owner;
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
    await form.getByLabel("Maximum output tokens").fill("512");
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
    await settings.getByRole("button", { name: "Close settings" }).click();
    await expect(draft).toHaveValue(text);
    await expect(model).toHaveAttribute(
      "title",
      "Use workspace model defaults",
    );
    expect(modelChanges).toBe(0);
  } finally {
    await writeFile(preferences, original);
    if (originalConfig) await writeFile(configuration, originalConfig);
    else await rm(configuration, { force: true });
    await rm(target, { recursive: true, force: true });
  }
});
