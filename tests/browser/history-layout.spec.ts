import { expect, type Page, test } from "@playwright/test";
import type { BranchTreeResponse } from "../../shared/contracts";
import { openMockSession, pairedPage } from "./support/navigation";
import { firstTextBaseline } from "./support/text-baseline";
import { textOverflowsInlineBounds } from "./support/text-bounds";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });

async function openHistory(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openMockSession(page, /Calibration history fixture/);
  const toggle = page.getByRole("button", {
    name: "Toggle resources panel",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  return page.getByRole("region", { name: "Conversation history" });
}

test("History read errors wrap literal paths and leave preview retry reachable", async ({
  page,
}) => {
  const history = await openHistory(page);
  const diagnostic =
    "Cannot preview /workspace/calibration/instrument_calibration_reference_acquisition_results_archive.jsonl. Restore access and retry.";
  await page.route("**/api/branches/entry?**", (route) =>
    route.fulfill({
      // Exercise error layout immediately; transient 5xx reads recover first.
      status: 403,
      json: { error: diagnostic },
    }),
  );
  await history.locator(".history-prompt").first().click();
  const warning = history.getByRole("alert");
  const retry = history.getByRole("button", {
    name: "Retry preview",
    exact: true,
  });
  await expect(warning).toHaveText(diagnostic);
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1280, 820, 390, 320]) {
    for (const height of [900, 420]) {
      await page.setViewportSize({ width, height });
      await expect(warning).toBeInViewport();
      expect(await warning.evaluate(textOverflowsInlineBounds)).toBe(false);
      const clearance = await history.evaluate((el) => {
        // The responsive drawer can replace its layout between separate awaits.
        const warning = el
          .querySelector(".branches__stale")!
          .getBoundingClientRect();
        const header = el
          .querySelector(".history-detail__header")!
          .getBoundingClientRect();
        return header.top - warning.bottom;
      });
      expect(clearance).toBeGreaterThanOrEqual(-0.5);
      await retry.focus();
      await expect(retry).toBeFocused();
      await expect(retry).toBeInViewport();
    }
  }
  await page.unroute("**/api/branches/entry?**");
  await retry.click();
  await expect(warning).toHaveCount(0);
  await expect(history.locator(".rich-text")).toContainText(
    "Review calibration run",
  );
  await history
    .getByRole("button", { name: "Back to history", exact: true })
    .click();
  await expect(
    history.getByRole("searchbox", { name: "Find in history" }),
  ).toBeVisible();
});

test("History route labels keep first-line marks and metadata without shifting short touch rows", async ({
  page,
}) => {
  const descriptions = [
    "Compare the calibration residuals with the reference acquisition and retain the baseline correction before reviewing instrument repeatability.",
    "比较校准残差与参考采集结果，并在复查仪器重复性之前保留基线修正，再检查不同批次测量之间的偏差。",
  ];
  let description = descriptions[0]!;
  await page.route("**/api/branches/tree?**", async (route) => {
    if (!new URL(route.request().url()).searchParams.has("parentId")) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body: BranchTreeResponse = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        nodes: body.nodes.map((node) => ({
          ...node,
          snippet: node.active ? description : "Saved calibration route",
        })),
      },
    });
  });
  const history = await openHistory(page);
  await history
    .getByRole("button", { name: "Earlier conversation", exact: true })
    .click();
  const disclosure = history.getByRole("button", {
    name: "Other routes",
    exact: true,
  });
  await expect(disclosure).toBeVisible();
  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (description of descriptions) {
      await disclosure.click();
      const routes = history.getByRole("group", {
        name: "Routes from this point",
      });
      const current = routes
        .locator(".history-route")
        .filter({ has: page.locator("small") });
      const short = routes.getByRole("button", {
        name: "Saved calibration route",
        exact: true,
      });
      await expect(current.locator("span")).toHaveText(description);
      await page.evaluate(() => document.fonts.ready);
      for (const row of [current, short]) {
        const geometry = await row.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const label = el.querySelector("span")!;
          const text = label.getBoundingClientRect();
          const lineHeight = Number.parseFloat(
            getComputedStyle(label).lineHeight,
          );
          const icon = el.querySelector("svg")!.getBoundingClientRect();
          return {
            iconOffset: icon.y + icon.height / 2 - (text.y + lineHeight / 2),
            textCenter: text.y + text.height / 2 - (box.y + box.height / 2),
            height: box.height,
            lineHeight,
            lines: text.height / lineHeight,
            overflow: el.scrollWidth - el.clientWidth,
            iconWidth: icon.width,
            iconHeight: icon.height,
          };
        });
        expect(Math.abs(geometry.iconOffset)).toBeLessThanOrEqual(0.5);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        expect(geometry.iconWidth).toBe(13);
        expect(geometry.iconHeight).toBe(13);
        if (row === short) {
          expect(geometry.lines).toBe(1);
          expect(Math.abs(geometry.textCenter)).toBeLessThanOrEqual(0.5);
          expect(geometry.height).toBeCloseTo(
            width <= 760 ? 44 : geometry.lineHeight + 16,
            1,
          );
        }
      }
      const label = await current
        .locator("span")
        .evaluate(firstTextBaseline, ".history-route");
      const metadata = await current
        .locator("small")
        .evaluate(firstTextBaseline, ".history-route");
      expect(Math.abs(metadata! - label!)).toBeLessThanOrEqual(0.5);
      await short.focus();
      await expect(short).toBeFocused();
      await disclosure.click();
    }
  }
  await disclosure.click();
  await history
    .getByRole("button", { name: "Saved calibration route", exact: true })
    .click();
  await expect(
    history.getByText("Inspecting another route", { exact: true }),
  ).toBeVisible();
  await history
    .getByRole("button", { name: "Current conversation", exact: true })
    .click();
  await expect(
    history.getByText("Inspecting another route", { exact: true }),
  ).toHaveCount(0);
});
