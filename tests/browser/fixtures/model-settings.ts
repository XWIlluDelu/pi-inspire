import type { Page } from "@playwright/test";
import { modelSettingsSnapshot } from "../../web/fixtures/model-settings";
import { routeSnapshots } from "../support/host-events";

/** Synthetic volume and label fixtures; native Host configuration handles writes. */
export async function modelSettingsScenario(page: Page, theme = "light") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = modelSettingsSnapshot();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await routeSnapshots(page, {
    bootstrap: (body) => {
      body.preferences.theme = theme;
      body.availableModels = snapshot.models;
    },
    snapshot: (body) => {
      if (body.active) body.active.availableModels = snapshot.models;
    },
  });
  await page.route("**/api/models**", (route) =>
    route.fulfill({
      json: { models: snapshot.models, commonModels: snapshot.commonModels },
    }),
  );
  await page.route("**/api/model-settings**", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: snapshot })
      : route.fallback(),
  );
  return { snapshot, errors };
}
