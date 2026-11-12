import { expect, test } from "@playwright/test";
import {
  loginProviders,
  modelSettingsSnapshot,
} from "../web/fixtures/model-settings";
import { routeSnapshots } from "./support/host-events";
import { pairAndOpen } from "./support/navigation";

test.use({
  serviceWorkers: "block",
  viewport: { width: 320, height: 844 },
  hasTouch: true,
});

test("keeps a large catalog reachable on a narrow screen in the picker and Settings", async ({
  page,
}) => {
  const longProviders = [
    "research-calibration-openai-compatible-service",
    "本地科研仪器校准与测量数据兼容服务",
  ];
  const available = Array.from({ length: 1_100 }, (_, index) => {
    const number = String(index + 1).padStart(4, "0");
    return {
      provider: longProviders[index] ?? "synthetic",
      id: `model-${number}`,
      name:
        index < longProviders.length ? "Calibration reader" : `Model ${number}`,
      reasoning: false,
    };
  });
  const snapshot = modelSettingsSnapshot({ models: available });
  snapshot.saved.enabledModels = [];
  snapshot.savedCommonEntries = [];
  snapshot.commonModels = [];
  await routeSnapshots(page, {
    bootstrap: (body) => {
      body.availableModels = available;
    },
    snapshot: (body) => {
      if (body.active) body.active.availableModels = available;
    },
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
  const checkHeadings = async (scope: typeof trigger) => {
    for (const provider of longProviders) {
      const heading = scope
        .locator(".model-picker__heading")
        .filter({ hasText: provider });
      await expect(heading).toHaveAttribute("title", provider);
      await expect(heading).toHaveCSS("text-overflow", "ellipsis");
      await expect(heading).toHaveCSS("white-space", "nowrap");
      expect(
        await heading.evaluate((element) => {
          const row = element.getBoundingClientRect();
          return (
            element.nextElementSibling!.getBoundingClientRect().top - row.bottom
          );
        }),
      ).toBeCloseTo(0);
    }
  };
  await trigger.click();
  const search = page.getByRole("combobox", { name: "Search models" });
  const list = page.getByRole("listbox", { name: "Available models" });
  await expect(list).toBeFocused();
  expect(await list.getByRole("option").count()).toBeLessThan(25);
  const menu = page.locator(".model-picker__menu");
  const bounds = await menu.boundingBox();
  expect(Math.round(bounds!.height)).toBeLessThanOrEqual(456);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await list.press("End");
  const last = list.locator(`[aria-posinset="${available.length}"]`);
  await expect(last).toBeInViewport();
  await expect(list).toHaveAttribute(
    "aria-activedescendant",
    (await last.getAttribute("id"))!,
  );
  await list.press("ArrowUp");
  await expect(
    page.locator(`[id="${await list.getAttribute("aria-activedescendant")}"]`),
  ).toHaveAttribute("aria-posinset", String(available.length - 1));
  expect(await list.getByRole("option").count()).toBeLessThan(25);
  const target = available.at(-1)!;
  await search.tap();
  await expect(search).toBeFocused();
  await search.pressSequentially(`${target.provider} ${target.id}`);
  expect(await list.getByRole("option").count()).toBeLessThan(25);
  await expect(
    page.locator(
      `[id="${await search.getAttribute("aria-activedescendant")}"]`,
    ),
  ).toContainText(target.name);
  await search.fill("calibration");
  await page.evaluate(() => document.fonts.ready);
  await checkHeadings(menu);

  await page.getByRole("button", { name: "Manage models" }).click();
  const gridSearch = page.getByRole("combobox", {
    name: "Search available models",
  });
  await gridSearch.scrollIntoViewIfNeeded();
  await expect(gridSearch).toBeVisible();
  const grid = page.getByRole("grid", { name: "Available models" });
  await expect(grid).toHaveAttribute("aria-rowcount", String(available.length));
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
  await gridSearch.fill("missing-provider");
  await expect(grid.getByRole("row")).toHaveCount(0);
  await gridSearch.fill("calibration");
  await checkHeadings(grid);
  expect(await grid.getByRole("row").count()).toBeLessThan(16);

  expect(
    await grid.evaluate((element) => {
      const settings = element.closest(".settings__main")!;
      return settings.scrollWidth <= settings.clientWidth + 1;
    }),
  ).toBe(true);
  expect(errors).toEqual([]);
});
