import { expect, test } from "@playwright/test";
import { navigationGroupsFixture } from "./fixtures/navigation-groups";
import { focusRingClipping } from "./support/focus-bounds";
import { openMockSession, pairedPage } from "./support/navigation";

test("desktop sessions keep titles above metadata and preserve a saved width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const nav = page.locator(".nav");
  await expect
    .poll(async () => (await nav.boundingBox())!.width)
    .toBeCloseTo(240, 0);
  const row = page.locator(".nav__row--active");
  const title = row.locator(".nav__row-name");
  const meta = row.locator(".nav__row-meta");
  const actions = row.locator(".nav__row-actions");
  const titleBox = (await title.boundingBox())!;
  const metaBox = (await meta.boundingBox())!;
  expect(metaBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(46);
  expect(
    await meta.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).fontSize),
    ),
  ).toBeLessThan(
    await title.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).fontSize),
    ),
  );
  await page.mouse.move(1000, 300);
  await expect(actions).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(meta).toHaveCSS("opacity", "1");
  expect((await title.boundingBox())!.width).toBeCloseTo(titleBox.width, 2);
  for (const action of await actions.getByRole("button").all()) {
    const box = (await action.boundingBox())!;
    // The larger hit area can use the line gap; its visible mark stays below
    // the title rather than consuming the title's horizontal space.
    const icon = (await action.locator("svg").boundingBox())!;
    expect(icon.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
    expect(box.width).toBeGreaterThanOrEqual(24);
  }
  await page.mouse.move(1000, 300);
  await row.locator(".nav__row-main").focus();
  await page.keyboard.press("Tab");
  await expect(actions.getByRole("button").first()).toBeFocused();
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(meta).toHaveCSS("opacity", "1");
  await page.evaluate(() => localStorage.setItem("inspire.nav-width", "360"));
  await page.reload();
  await expect
    .poll(async () => (await nav.boundingBox())!.width)
    .toBeCloseTo(360, 0);
});

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

for (const touch of [false, true]) {
  test.describe(`navigation dock focus · ${touch ? "coarse" : "fine"} pointer`, () => {
    test.use({
      viewport: { width: 1366, height: 900 },
      hasTouch: touch,
      deviceScaleFactor: touch ? 2 : 1,
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });

    test("short navigation keeps rows reachable instead of shrinking its scrollports", async ({
      page,
    }) => {
      await navigationGroupsFixture(page);
      await pairedPage(page);
      const nav = page.locator(".nav");
      for (const [width, height] of [
        [1366, 900],
        [901, 390],
        [568, 320],
        [568, 260],
      ]) {
        await page.setViewportSize({ width, height });
        if (width <= 900) {
          const toggle = page.getByRole("button", {
            name: "Toggle navigation",
            exact: true,
          });
          await expect(toggle).toBeVisible();
          if (!(await nav.isVisible())) await toggle.click();
        }
        const hidden = nav.getByRole("button", { name: "Hidden", exact: true });
        if ((await hidden.getAttribute("aria-expanded")) === "true")
          await hidden.click();
        // Insets count against the same budget as content, as on a landscape phone.
        await nav.evaluate((el) => {
          el.style.setProperty("--safe-top", "8px");
          el.style.setProperty("--safe-bottom", "12px");
        });
        await hidden.click();
        const body = nav.locator(".nav__hidden-content");
        await expect
          .poll(async () =>
            body.evaluate((el) => {
              const nav = el.closest(".nav")!;
              return (
                el.getBoundingClientRect().bottom -
                (nav.getBoundingClientRect().bottom -
                  Number.parseFloat(getComputedStyle(nav).paddingBottom))
              );
            }),
          )
          .toBeLessThanOrEqual(1);
        const row = body.getByRole("button", {
          name: "archived-b",
          exact: true,
        });
        await row.focus();
        await expect(row).toBeFocused();
        const bounds = await row.boundingBox();
        const viewport = await nav.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            top: bounds.top + Number.parseFloat(style.paddingTop),
            bottom: bounds.bottom - Number.parseFloat(style.paddingBottom),
          };
        });
        const scrollport = await body.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.y).toBeGreaterThanOrEqual(
          Math.max(viewport.top, scrollport!.y) - 1,
        );
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
          Math.min(viewport.bottom, scrollport!.y + scrollport!.height) + 1,
        );
        if ((await row.getAttribute("aria-expanded")) !== "true")
          await row.press("Enter");
        await expect(row).toHaveAttribute("aria-expanded", "true");
        const session = body.locator(".nav__row-main").last();
        await session.focus();
        await expect(session).toBeFocused();
        const visible = await session.boundingBox();
        const bodyBounds = await body.boundingBox();
        expect(bodyBounds!.height).toBeGreaterThanOrEqual(visible!.height);
        expect(visible!.y).toBeGreaterThanOrEqual(
          Math.max(viewport.top, bodyBounds!.y) - 1,
        );
        expect(visible!.y + visible!.height).toBeLessThanOrEqual(
          Math.min(viewport.bottom, bodyBounds!.y + bodyBounds!.height) + 1,
        );
        // Closing keeps focus on its trigger and gives the catalog its space back.
        await hidden.focus();
        await hidden.press("Enter");
        await expect(hidden).toBeFocused();
        await expect(body).toHaveCount(0);
        const catalog = nav.locator(".nav__list");
        const folder = catalog.getByRole("button", {
          name: "calibration",
          exact: true,
        });
        await folder.focus();
        if ((await folder.getAttribute("aria-expanded")) !== "true")
          await folder.press("Enter");
        const catalogRow = catalog.locator(".nav__row-main").first();
        await catalogRow.focus();
        await expect(catalogRow).toBeFocused();
        const catalogBounds = await catalog.boundingBox();
        const catalogRowBounds = await catalogRow.boundingBox();
        expect(catalogRowBounds!.y).toBeGreaterThanOrEqual(
          catalogBounds!.y - 1,
        );
        expect(
          catalogRowBounds!.y + catalogRowBounds!.height,
        ).toBeLessThanOrEqual(
          Math.min(catalogBounds!.y + catalogBounds!.height, viewport.bottom) +
            1,
        );
        if (height === 900)
          expect(
            await nav.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
          ).toBe(true);
      }
    });

    test("Hidden retains a complete outline without moving its header", async ({
      page,
    }) => {
      await navigationGroupsFixture(page);
      await pairedPage(page);
      const group = page.locator(".nav__list").getByRole("button", {
        name: "calibration",
        exact: true,
      });
      if ((await group.getAttribute("aria-expanded")) !== "true")
        await group.click();
      await openMockSession(page, /Geometry session/);
      await page.addStyleTag({
        content:
          "*, *::before, *::after { transition: none !important; animation: none !important; }",
      });
      const nav = page.locator(".nav");
      for (const [width, height] of [
        [1366, 900],
        [1024, 768],
        [390, 844],
        [320, 640],
        [568, 320],
      ]) {
        await page.setViewportSize({ width, height });
        if (width <= 900) {
          const open = page.getByRole("button", {
            name: "Toggle navigation",
            exact: true,
          });
          await expect(open).toBeVisible();
          if (!(await nav.isVisible())) await open.click();
        }
        await expect(nav).toBeVisible();
        const hidden = nav.getByRole("button", { name: "Hidden", exact: true });
        const before = (await hidden.boundingBox())!;
        await page.keyboard.press("Tab");
        await hidden.focus();
        await expect(hidden).toBeFocused();
        await expect(hidden).toHaveCSS("outline-style", "solid");
        await expect(hidden).toHaveCSS("outline-width", "2px");
        expect(await hidden.evaluate(focusRingClipping)).toBeLessThanOrEqual(
          0.5,
        );
        const after = (await hidden.boundingBox())!;
        for (const key of ["x", "y", "width", "height"] as const)
          expect(after[key]).toBeCloseTo(before[key], 1);
        // Changing disclosure state must retain focus and the inset contour.
        const expanded = await hidden.getAttribute("aria-expanded");
        await hidden.press("Enter");
        await expect(hidden).toHaveAttribute(
          "aria-expanded",
          expanded === "true" ? "false" : "true",
        );
        await expect(hidden).toBeFocused();
        expect(await hidden.evaluate(focusRingClipping)).toBeLessThanOrEqual(
          0.5,
        );
        await expect(
          nav.getByRole("button", { name: "Clear Hidden", exact: true }),
        ).toBeVisible();
      }
    });
  });
}
