import { expect, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

test.describe("cross-project touch rows", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("Pinned retains a readable title above project and age", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/bootstrap**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      Object.assign(body.preferences, {
        pinnedSessionIds: ["mock-history"],
        hiddenSessionIds: [],
        hiddenProjectCwds: [],
      });
      await route.fulfill({ response, json: body });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await pairedPage(page);
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .click();
    const row = page.locator(".nav__group--pinned .nav__row").first();
    await expect(row).toBeVisible();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => document.fonts.ready);
      await expect
        .poll(async () => (await page.locator(".nav").boundingBox())!.width)
        .toBeLessThanOrEqual(width);
      const title = (await row.locator(".nav__row-name").boundingBox())!;
      const titleColumn = (await row.locator(".nav__row-title").boundingBox())!;
      const meta = (await row.locator(".nav__row-meta").boundingBox())!;
      const age = (await row.locator(".nav__row-age").boundingBox())!;
      // The 320px drawer also reserves scrim and persistent touch actions.
      // Long titles use their whole column, rather than sharing it with metadata.
      expect(title.width).toBeCloseTo(titleColumn.width, 2);
      expect(title.width).toBeGreaterThanOrEqual(width === 320 ? 120 : 150);
      expect(meta.y).toBeGreaterThanOrEqual(title.y + title.height);
      expect(age.width).toBeLessThan(40);
      expect(await row.locator(".nav__row-actions button").count()).toBe(2);
      expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
        true,
      );
    }
  });
});

test("session search distinguishes loading, error and an empty result", async ({
  page,
}) => {
  await pairedPage(page);
  const search = page.getByRole("searchbox", { name: "Search sessions" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/sessions(?:\?|$)/, async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "empty-fixture-query") {
      await gate;
      await route.continue();
    } else if (q === "failed-fixture-query") {
      await route.fulfill({
        status: 503,
        json: { error: "Search is unavailable" },
      });
    } else await route.continue();
  });
  await search.fill("empty-fixture-query");
  await expect(page.locator(".nav__pagination .pi-loading")).toBeVisible();
  await expect(page.locator(".nav__list .empty-state")).toHaveCount(0);
  release();
  await expect(page.locator(".nav__list .empty-state")).toContainText(
    "No sessions",
  );
  await search.fill("failed-fixture-query");
  await expect(page.locator(".nav__pagination-status")).toContainText(
    "Search is unavailable",
  );
  await expect(page.locator(".nav__list .empty-state")).toHaveCount(0);
});

test("hiding a session removes it from Welcome Recent as well as the normal list", async ({
  page,
}) => {
  let preferences: Record<string, unknown> = {};
  await page.route("**/api/bootstrap**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    Object.assign(body.preferences, {
      hiddenSessionIds: [],
      hiddenProjectCwds: [],
      pinnedSessionIds: [],
    });
    preferences = body.preferences;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/preferences", async (route) => {
    Object.assign(preferences, route.request().postDataJSON());
    await route.fulfill({ json: preferences });
  });
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const row = page.locator(".nav__row--active");
  await row.hover();
  await row
    .getByRole("button", {
      name: 'Hide "Formula rendering and spectral analysis"',
    })
    .click();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect(page.locator(".welcome")).toBeVisible();
  await page
    .getByRole("button", { name: "Collapse navigation", exact: true })
    .click();
  await expect(page.locator(".welcome__recent")).toBeVisible();
  await expect(page.locator(".welcome__recent")).not.toContainText(
    "Formula rendering and spectral analysis",
  );
});
