import { expect, test } from "@playwright/test";
import type { ModelOption } from "../../shared/contracts";
import { routeMockSnapshots } from "./support/mock-host";
import { openCommandPalette, pairAndOpen } from "./support/navigation";

// The PTY integration owns native API semantics. This routed scenario exercises
// browser controls, focus/cancellation and effective results at both widths.
for (const width of [1280, 390]) {
  test(`connected-native controls preserve Pi's result and the draft at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
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
    await routeMockSnapshots(page, {
      snapshot: (snapshot) => {
        if (!snapshot.active) return;
        const id = snapshot.active.sessionId;
        snapshot.active = {
          ...snapshot.active,
          model,
          thinkingLevel,
          availableModels: models,
        };
        snapshot.runState = "running";
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
    await expect(effort).toHaveText("low");
    await expect(picker).toContainText("Native final");
    expect(changes[0]).toMatchObject({
      provider: "native-owner",
      modelId: "a",
    });
    await effort.click();
    await page.getByRole("option", { name: "high", exact: true }).click();
    await expect(effort).toHaveText("medium");
    expect(changes[1]).toMatchObject({ level: "high" });

    const palette = await openCommandPalette(page);
    await palette.getByRole("combobox").fill("reload");
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
}
