import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { ModelOption } from "../../shared/contracts";
import { modelIdentityKey } from "../../shared/contracts";
import {
  loginProviders,
  modelSettingsSnapshot,
} from "../web/fixtures/model-settings";
import { loadModelScale } from "./fixtures/model-scale";
import { pairAndOpen } from "./support/navigation";

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
        await pairAndOpen(page);
        const trigger = page.getByRole("button", {
          name: "Model",
          exact: true,
        });
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
        await trigger.click();
        const search = page.getByRole("combobox", { name: "Search models" });
        const list = page.getByRole("listbox", { name: "Available models" });
        const navigation = touch ? list : search;
        await expect(navigation).toBeFocused();
        expect(await list.getByRole("option").count()).toBeLessThan(25);
        const menu = page.locator(".model-picker__menu");
        const bounds = await menu.boundingBox();
        expect(Math.round(bounds!.height)).toBeLessThanOrEqual(456);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(Math.round(bounds!.width)).toBeLessThanOrEqual(
          touch ? 358 : 384,
        );
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(Math.round(bounds!.y + bounds!.height)).toBeLessThanOrEqual(
          touch ? 844 : 900,
        );
        await navigation.press("End");
        const last = list.locator(`[aria-posinset="${available.length}"]`);
        await expect(last).toBeInViewport();
        await expect(navigation).toHaveAttribute(
          "aria-activedescendant",
          (await last.getAttribute("id"))!,
        );
        await navigation.press("ArrowUp");
        await expect(
          page.locator(
            `[id="${await navigation.getAttribute("aria-activedescendant")}"]`,
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
        if (touch) await search.tap();
        else await search.click();
        await expect(search).toBeFocused();
        await search.pressSequentially(`${target.provider} ${target.id}`);
        expect(await list.getByRole("option").count()).toBeLessThan(25);
        await expect(
          page.locator(
            `[id="${await search.getAttribute("aria-activedescendant")}"]`,
          ),
        ).toContainText(target.name ?? target.id);

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
        expect(await grid.getByRole("row").count()).toBeLessThan(16);
        await gridSearch.focus();
        await gridSearch.press("End");
        const lastRow = grid.locator(`[aria-rowindex="${available.length}"]`);
        await expect(lastRow).toBeInViewport();
        await expect(gridSearch).toHaveAttribute(
          "aria-activedescendant",
          (await lastRow.getAttribute("id"))!,
        );
        await gridSearch.press("Tab");
        await expect(
          page.getByRole("button", { name: "Refresh available models" }),
        ).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(
          lastRow.getByRole("checkbox", { name: /^Common:/ }),
        ).toBeFocused();
        await gridSearch.fill(`${target.provider} ${target.id}`);
        await expect(grid).toContainText(target.name ?? target.id);
        expect(await grid.getByRole("row").count()).toBeLessThan(16);
        const keys = new Set(available.map(modelIdentityKey));
        const unavailable = catalog.find(
          (model) => !keys.has(modelIdentityKey(model)),
        )!;
        await gridSearch.fill(`${unavailable.provider} ${unavailable.id}`);
        await expect(
          grid.getByText(unavailable.name ?? unavailable.id, { exact: true }),
        ).toHaveCount(0);
        await gridSearch.fill(`${target.provider} ${target.id}`);
        await expect(grid).toContainText(target.name ?? target.id);

        const geometry = await grid.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            height: rect.height,
            overflow:
              document.querySelector(".settings__main")!.scrollWidth >
              document.querySelector(".settings__main")!.clientWidth + 1,
          };
        });
        expect(geometry.height).toBeLessThanOrEqual(340);
        expect(geometry.overflow).toBe(false);
        expect(errors).toEqual([]);
        const rendering = await page.evaluate(
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
        expect(rendering.maxMounted).toBeLessThan(25);
        expect(rendering.maxAddedPerMutation).toBeLessThan(100);
      });
    },
  );
}
