import { expect, test } from "@playwright/test";
import type { ModelOption } from "../../shared/contracts";
import { routeSnapshots } from "./support/host-events";
import { pairAndOpen } from "./support/navigation";

test.use({ serviceWorkers: "block" });

// The PTY integration owns native API semantics; this verifies the routed browser controls.
test("native model controls adopt Pi's effective results and preserve the draft", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const models: ModelOption[] = [
    {
      provider: "native-owner",
      id: "folder/chat",
      name: "Native first",
      reasoning: true,
    },
    {
      provider: "native-other",
      id: "folder/chat",
      name: "Native final",
      reasoning: true,
    },
  ];
  let model = models[1]!,
    thinkingLevel = "medium";
  const changes: Array<Record<string, unknown>> = [];
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
  await pairAndOpen(page);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep this draft while controlling native Pi");
  const picker = page.getByRole("button", { name: "Model", exact: true });
  const effort = page.getByRole("combobox", { name: "Thinking level" });
  await expect(picker).toBeEnabled();
  await expect(effort).toBeEnabled();
  await picker.click();
  const search = page.getByRole("combobox", { name: "Search models" });
  await search.fill("native-owner/folder/chat");
  const result = page.getByRole("option", { name: /Native first/ });
  await expect(result).toHaveCount(1);
  await search.press("Enter");
  await expect(effort).toContainText("Low");
  await expect(picker).toContainText("Native final");
  expect(changes[0]).toMatchObject({
    provider: "native-owner",
    modelId: "folder/chat",
  });
  await effort.click();
  await page
    .getByRole("listbox", { name: /thinking/i })
    .getByRole("option", { name: "High", exact: true })
    .click();
  await expect(effort).toContainText("Medium");
  expect(changes[1]).toMatchObject({ level: "high" });

  await expect(draft).toHaveValue(
    "Keep this draft while controlling native Pi",
  );
});
