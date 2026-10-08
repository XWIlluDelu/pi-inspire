import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ModelOption } from "../../shared/contracts";
import { modelIdentityKey } from "../../shared/contracts";
import {
  loginProviders,
  modelSettingsSnapshot,
} from "../web/fixtures/model-settings";
import { loadModelScale } from "./fixtures/model-scale";

let root: string, catalog: ModelOption[], available: ModelOption[];
const previous = {
  agent: process.env.PI_CODING_AGENT_DIR,
  sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
};
test.beforeAll(async () => {
  await mkdir(resolve("output/playwright"), { recursive: true });
  root = await mkdtemp(resolve("output/playwright/models-scale-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
  ({ catalog, available } = await loadModelScale(
    process.env.PI_CODING_AGENT_DIR,
  ));
  expect(catalog.length).toBeGreaterThan(available.length);
  expect(available.length).toBeGreaterThan(1000);
});
test.afterAll(async () => {
  for (const [key, value] of [
    ["PI_CODING_AGENT_DIR", previous.agent],
    ["PI_CODING_AGENT_SESSION_DIR", previous.sessions],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});
test.use({ serviceWorkers: "block" });
async function frame(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
for (const touch of [false, true]) {
  test.describe(
    touch
      ? "large available models · narrow touch"
      : "large available models · desktop",
    () => {
      test.use({
        viewport: touch
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
        hasTouch: touch,
      });
      test("bounds opening, search and far keyboard navigation in the picker and unique Settings grid", async ({
        page,
      }) => {
        const snapshot = modelSettingsSnapshot({ models: available });
        snapshot.saved.enabledModels = [];
        snapshot.savedCommonEntries = [];
        snapshot.commonModels = [];
        for (const pattern of [
          "**/api/bootstrap**",
          "**/api/snapshot**",
          "**/api/sessions/open",
        ])
          await page.route(pattern, async (route) => {
            const response = await route.fetch();
            const payload = await response.json();
            if (payload.snapshot) {
              payload.availableModels = available;
              if (payload.snapshot.active)
                payload.snapshot.active.availableModels = available;
            } else if (payload.active)
              payload.active.availableModels = available;
            await route.fulfill({ response, json: payload });
          });
        await page.route("**/api/models**", (route) =>
          route.fulfill({
            json: { models: snapshot.models, commonModels: [] },
          }),
        );
        await page.route("**/api/model-settings**", (route) =>
          route.fulfill({ json: snapshot }),
        );
        await page.route("**/api/provider-auth**", (route) =>
          route.fulfill({ json: { result: loginProviders() } }),
        );
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto("/");
        await page
          .getByLabel("Access token")
          .fill("inspire-browser-test-token");
        await page.getByRole("button", { name: "Pair", exact: true }).click();
        const nav = page.getByRole("button", {
          name: "Toggle navigation",
          exact: true,
        });
        if (
          (await nav.getAttribute("aria-expanded")) === "false" ||
          (await page.locator(".nav--rail").count())
        )
          await nav.click();
        await page
          .getByRole("button", { name: /Review extension event lifecycle/ })
          .first()
          .click();
        await expect(
          page.getByRole("textbox", { name: "Message", exact: true }),
        ).toBeVisible();
        const trigger = page.getByRole("button", {
          name: "Model",
          exact: true,
        });
        const measurements: Record<string, unknown> = {
          catalog: catalog.length,
          available: available.length,
        };
        await page.evaluate(() => {
          const metrics = { maxMounted: 0, maxAddedPerMutation: 0 };
          (
            window as unknown as { modelRendering: typeof metrics }
          ).modelRendering = metrics;
          new MutationObserver((records) => {
            metrics.maxMounted = Math.max(
              metrics.maxMounted,
              document.querySelectorAll(".model-picker__option").length,
            );
            const added = records
              .flatMap((record) => [...record.addedNodes])
              .reduce(
                (count, node) =>
                  count +
                  (node instanceof Element
                    ? Number(node.matches(".model-picker__option")) +
                      node.querySelectorAll(".model-picker__option").length
                    : 0),
                0,
              );
            metrics.maxAddedPerMutation = Math.max(
              metrics.maxAddedPerMutation,
              added,
            );
          }).observe(document.body, { childList: true, subtree: true });
        });
        const opened = Date.now();
        await trigger.click();
        await frame(page);
        measurements.pickerOpenMs = Date.now() - opened;
        const search = page.getByRole("combobox", { name: "Search models" });
        await expect(search).toBeFocused();
        measurements.pickerMounted = await page.getByRole("option").count();
        expect(measurements.pickerMounted).toBeLessThan(25);
        const menu = page.locator(".model-picker__menu");
        const bounds = await menu.boundingBox();
        expect(Math.round(bounds!.height)).toBeLessThanOrEqual(440);
        expect(Math.round(bounds!.width)).toBeLessThanOrEqual(
          touch ? 358 : 520,
        );
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(Math.round(bounds!.y + bounds!.height)).toBeLessThanOrEqual(
          touch ? 844 : 900,
        );
        const navigated = Date.now();
        await search.press("End");
        await frame(page);
        measurements.pickerEndMs = Date.now() - navigated;
        const last = page.locator(
          `[id="${await search.getAttribute("aria-activedescendant")}"]`,
        );
        await expect(last).toHaveAttribute(
          "aria-posinset",
          String(available.length),
        );
        await expect(last).toBeInViewport();
        await search.press("ArrowUp");
        await expect(
          page.locator(
            `[id="${await search.getAttribute("aria-activedescendant")}"]`,
          ),
        ).toHaveAttribute("aria-posinset", String(available.length - 1));
        const target = [...available]
          .sort((left, right) =>
            left.provider < right.provider
              ? -1
              : left.provider > right.provider
                ? 1
                : left.id < right.id
                  ? -1
                  : left.id > right.id
                    ? 1
                    : 0,
          )
          .at(-1)!;
        const typed = Date.now();
        await search.pressSequentially(`${target.provider} ${target.id}`);
        await frame(page);
        measurements.pickerSearchMs = Date.now() - typed;
        expect(await page.getByRole("option").count()).toBeLessThan(25);
        await expect(
          page.locator(
            `[id="${await search.getAttribute("aria-activedescendant")}"]`,
          ),
        ).toContainText(target.name ?? target.id);
        await page.screenshot({
          path: `output/playwright/models-scale-picker-${touch ? "touch" : "desktop"}.png`,
        });
        await page.getByRole("button", { name: "Manage models" }).click();
        const gridSearch = page.getByRole("combobox", {
          name: "Search available models",
        });
        await gridSearch.scrollIntoViewIfNeeded();
        await expect(gridSearch).toBeVisible();
        const grid = page.getByRole("grid", { name: "Available models" });
        await expect(grid).toHaveAttribute(
          "aria-rowcount",
          String(available.length),
        );
        measurements.settingsMounted = await grid.getByRole("row").count();
        expect(measurements.settingsMounted).toBeLessThan(16);
        await gridSearch.focus();
        const gridNavigated = Date.now();
        await gridSearch.press("End");
        await frame(page);
        measurements.settingsEndMs = Date.now() - gridNavigated;
        const lastRow = page.locator(
          `[id="${await gridSearch.getAttribute("aria-activedescendant")}"]`,
        );
        await expect(lastRow).toHaveAttribute(
          "aria-rowindex",
          String(available.length),
        );
        await expect(lastRow).toBeInViewport();
        await gridSearch.press("Tab");
        await expect(
          page.getByRole("button", { name: "Refresh available models" }),
        ).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(
          lastRow.getByRole("checkbox", { name: /^Common:/ }),
        ).toBeFocused();
        const gridTyped = Date.now();
        await gridSearch.fill(`${target.provider} ${target.id}`);
        await frame(page);
        measurements.settingsSearchMs = Date.now() - gridTyped;
        expect(await grid.getByRole("row").count()).toBeLessThan(16);
        await expect(grid).toContainText(target.name ?? target.id);
        const keys = new Set(available.map(modelIdentityKey));
        const unavailable = catalog.find(
          (model) => !keys.has(modelIdentityKey(model)),
        )!;
        await gridSearch.fill(`${unavailable.provider} ${unavailable.id}`);
        await expect(
          grid.getByText(unavailable.name ?? unavailable.id, { exact: true }),
        ).toHaveCount(0);
        await gridSearch.fill(`${target.provider} ${target.id}`);
        await frame(page);
        await page.screenshot({
          path: `output/playwright/models-scale-list-${touch ? "touch" : "desktop"}.png`,
        });
        const geometry = await grid.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            overflow:
              document.querySelector(".settings__main")!.scrollWidth >
              document.querySelector(".settings__main")!.clientWidth + 1,
          };
        });
        measurements.settingsGeometry = geometry;
        expect(geometry.height).toBeLessThanOrEqual(340);
        expect(geometry.overflow).toBe(false);
        expect(errors).toEqual([]);
        measurements.rendering = await page.evaluate(
          () =>
            (
              window as unknown as {
                modelRendering: {
                  maxMounted: number;
                  maxAddedPerMutation: number;
                };
              }
            ).modelRendering,
        );
        expect(
          (measurements.rendering as { maxMounted: number }).maxMounted,
        ).toBeLessThan(25);
        expect(
          (measurements.rendering as { maxAddedPerMutation: number })
            .maxAddedPerMutation,
        ).toBeLessThan(100);
        await writeFile(
          `output/playwright/models-scale-${touch ? "touch" : "desktop"}.json`,
          JSON.stringify(measurements, null, 2),
        );
        console.log(measurements);
      });
    },
  );
}
