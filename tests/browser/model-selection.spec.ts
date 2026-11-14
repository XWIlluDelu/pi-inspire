import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { ModelOption } from "../../shared/contracts";
import { routeSnapshots } from "./support/host-events";
import { openCommandPalette, pairAndOpen } from "./support/navigation";

test.use({ serviceWorkers: "block" });

test("model labels and selection retain text contrast in light and dark", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const models = [
    { provider: "openai", id: "alpha", name: "alpha", reasoning: false },
    { provider: "custom", id: "folder/chat", name: "Nested chat" },
    { provider: "local", id: "folder/chat", name: "Nested chat" },
  ];
  let commonModels: ModelOption[] = [models[2]!, models[0]!];
  let model = models[2]!;
  const selected: unknown[] = [];
  await routeSnapshots(page, {
    bootstrap(body) {
      body.preferences.recentModelIds = [models[1]!];
    },
    snapshot({ active }) {
      if (active)
        Object.assign(active, { model, availableModels: models, commonModels });
    },
  });
  await page.route("**/api/models**", (route) =>
    route.fulfill({ json: { models, commonModels } }),
  );
  await page.route("**/api/control/model", (route) => {
    const request = route.request().postDataJSON();
    selected.push(request);
    model = models.find(
      ({ provider, id }) =>
        provider === request.provider && id === request.modelId,
    )!;
    return route.fulfill({ json: { model, thinkingLevel: "off" } });
  });
  await pairAndOpen(page);
  const picker = page.getByRole("button", { name: "Model", exact: true });
  await picker.click();
  const options = page
    .getByRole("listbox", { name: "Available models" })
    .getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAttribute(
    "title",
    "Nested chat — local/folder/chat",
  );
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(1)).toContainText("No thinking");
  await expect(options.nth(2)).toContainText("Recent");
  for (const [palette, theme] of [
    ["chimonanthus", "light"],
    ["hydrangea", "dark"],
  ]) {
    await page.evaluate(
      ({ palette, theme }) =>
        Object.assign(document.documentElement.dataset, { palette, theme }),
      { palette, theme },
    );
    const result = await new AxeBuilder({ page })
      .include(".model-picker__menu")
      .withRules(["color-contrast"])
      .analyze();
    expect(result.violations, `${palette}/${theme}`).toEqual([]);
  }
  const search = page.getByRole("combobox", { name: "Search models" });
  await options.nth(1).hover();
  await search.hover();
  await expect(search).not.toHaveAttribute("aria-activedescendant", /.+/);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await search.fill("OPENAI/ALPHA");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveAccessibleName(/openai\/alpha/i);
  await search.fill("nedct");
  const match = page.getByTitle("Nested chat — custom/folder/chat");
  expect(
    (await match.locator(".search-match").allTextContents()).join(""),
  ).toBe("Nedct");
  await search.fill("custom/folder/chat");
  await expect(options).toHaveCount(1);
  await expect(options.first().locator(".search-match")).toHaveText(
    "folder/chat",
  );
  await expect(page.locator(".model-picker__heading .search-match")).toHaveText(
    "custom",
  );
  await search.press("Enter");
  await expect(picker).toBeFocused();
  expect(selected).toMatchObject([
    { provider: "custom", modelId: "folder/chat" },
  ]);

  commonModels = [];
  await picker.click();
  await expect(page.getByText("Common models", { exact: true })).toHaveCount(0);
  await expect(options).toHaveCount(3);
});

// The PTY integration owns native API semantics; this verifies the routed browser controls.
test("native model controls adopt Pi's effective results and preserve the draft", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const models: ModelOption[] = [
    {
      provider: "native-owner",
      id: "a",
      name: "Native first",
      reasoning: true,
    },
    {
      provider: "native-owner",
      id: "b",
      name: "Native final",
      reasoning: true,
    },
  ];
  let model = models[1]!,
    thinkingLevel = "medium",
    hostCommands = 0;
  const changes: Array<Record<string, unknown>> = [];
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "platform", { value: "Win32" }),
  );
  await routeSnapshots(page, {
    snapshot: (snapshot) => {
      if (!snapshot.active) return;
      const id = snapshot.active.sessionId;
      snapshot.active = {
        ...snapshot.active,
        model,
        thinkingLevel,
        availableModels: models,
      };

      snapshot.sessionStatuses[id] = {
        runState: "running",
        external: true,
        nativeModelControls: true,
      };
    },
  });
  await page.route("**/api/models**", (route) =>
    route.fulfill({ json: { models } }),
  );
  await page.route("**/api/control/model", (route) => {
    changes.push(route.request().postDataJSON());
    // A model_select extension may redirect the requested choice and effort.
    model = models[1]!;
    thinkingLevel = "low";
    return route.fulfill({ json: { model, thinkingLevel } });
  });
  await page.route("**/api/control/thinking", (route) => {
    changes.push(route.request().postDataJSON());
    thinkingLevel = "medium";
    return route.fulfill({ json: { model, thinkingLevel } });
  });
  await page.route("**/api/control/native-command", (route) => {
    hostCommands++;
    return route.fulfill({
      status: 409,
      json: { error: "No owned RPC worker" },
    });
  });
  await pairAndOpen(page);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep this draft while controlling native Pi");
  const picker = page.getByRole("button", { name: "Model", exact: true });
  const effort = page.getByRole("combobox", { name: "Thinking level" });
  await expect(picker).toBeEnabled();
  await expect(effort).toBeEnabled();
  await picker.click();
  await expect(
    page.getByRole("listbox", { name: "Available models" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeFocused();
  expect(changes).toEqual([]);
  await picker.click();
  await page.getByRole("option", { name: /Native first/ }).click();
  await expect(effort).toHaveValue("low");
  await expect(picker).toContainText("Native final");
  expect(changes[0]).toMatchObject({
    provider: "native-owner",
    modelId: "a",
  });
  await effort.selectOption("high");
  await expect(effort).toHaveValue("medium");
  expect(changes[1]).toMatchObject({ level: "high" });

  await draft.press("Alt+Shift+M");
  await expect(
    page.getByText(
      "Cycle models in the original Pi terminal. Choose a model here with /model.",
    ),
  ).toBeVisible();

  const palette = await openCommandPalette(page);
  const filter = palette.getByRole("combobox");
  await filter.fill("reload");
  await palette.getByText("Reload in native Pi…", { exact: true }).click();
  await expect(
    page.getByText("Run /reload in the original Pi terminal.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(hostCommands).toBe(0);
  await expect(draft).toHaveValue(
    "Keep this draft while controlling native Pi",
  );
  await expect(
    page.getByRole("button", {
      name: "Open terminal & copy command",
      exact: true,
    }),
  ).toBeVisible();
});
