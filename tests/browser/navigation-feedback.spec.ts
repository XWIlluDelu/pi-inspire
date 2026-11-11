import { expect, type Locator, test } from "@playwright/test";
import { navigationGroupsFixture } from "./fixtures/navigation-groups";
import { focusRingClipping } from "./support/focus-bounds";
import { openFixtureSession, pairedPage } from "./support/navigation";

function navigationRowBounds(row: Locator) {
  // Read one layout: opening or closing Hidden can move both scroll containers.
  return row.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    const scrollport = el
      .closest(".nav__hidden-content, .nav__list")!
      .getBoundingClientRect();
    const nav = el.closest(".nav")!;
    const viewport = nav.getBoundingClientRect();
    const style = getComputedStyle(nav);
    return {
      row: { top: bounds.top, bottom: bounds.bottom, height: bounds.height },
      scrollport: {
        top: scrollport.top,
        bottom: scrollport.bottom,
        height: scrollport.height,
      },
      viewport: {
        top: viewport.top + Number.parseFloat(style.paddingTop),
        bottom: viewport.bottom - Number.parseFloat(style.paddingBottom),
      },
    };
  });
}

test("desktop sessions keep one line with a trailing age and preserve a saved width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
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
  const rowBox = (await row.boundingBox())!;
  const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
  // One line: the age trails the title on its own axis, at the row's end.
  expect(Math.abs(middle(metaBox) - middle(titleBox))).toBeLessThanOrEqual(1.5);
  expect(metaBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
  expect(
    rowBox.x + rowBox.width - (metaBox.x + metaBox.width),
  ).toBeLessThanOrEqual(12);
  expect(rowBox.height).toBeLessThanOrEqual(34);
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
  // Pin/Hide take the age's place; the title keeps its width and fades.
  await expect(meta).toHaveCSS("visibility", "hidden");
  expect((await title.boundingBox())!.width).toBeCloseTo(titleBox.width, 2);
  for (const action of await actions.getByRole("button").all()) {
    const box = (await action.boundingBox())!;
    const icon = (await action.locator("svg").boundingBox())!;
    expect(Math.abs(middle(icon) - middle(titleBox))).toBeLessThanOrEqual(1.5);
    expect(box.width).toBeGreaterThanOrEqual(24);
  }
  await page.mouse.move(1000, 300);
  await row.locator(".nav__row-main").focus();
  await page.keyboard.press("Tab");
  await expect(actions.getByRole("button").first()).toBeFocused();
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(meta).toHaveCSS("visibility", "hidden");
  await page.evaluate(() => localStorage.setItem("inspire.nav-width", "360"));
  await page.reload();
  await expect
    .poll(async () => (await nav.boundingBox())!.width)
    .toBeCloseTo(360, 0);
});

test.describe("touch session rows", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("grouped and pinned sessions keep titles above metadata and clear of actions", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/bootstrap**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      Object.assign(body.preferences, {
        pinnedSessionIds: ["fixture-history"],
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
    const rows = [
      page.locator(".nav__group--pinned .nav__row").first(),
      page
        .locator(".nav__row")
        .filter({ hasText: "Formula rendering and spectral analysis" }),
    ];
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => document.fonts.ready);
      await expect
        .poll(async () => (await page.locator(".nav").boundingBox())!.width)
        .toBeLessThanOrEqual(width);
      for (const row of rows) {
        await expect(row).toBeVisible();
        const title = (await row.locator(".nav__row-name").boundingBox())!;
        const meta = (await row.locator(".nav__row-meta").boundingBox())!;
        const actions = row.locator(".nav__row-actions");
        const actionsBox = (await actions.boundingBox())!;
        // Both metadata types share the quieter second line. Touch actions
        // retain their own hit areas rather than overlapping the title.
        expect(title.width).toBeGreaterThanOrEqual(width === 320 ? 120 : 150);
        expect(meta.y).toBeGreaterThanOrEqual(title.y + title.height);
        expect(meta.x).toBeCloseTo(title.x, 1);
        expect(title.x + title.width).toBeLessThanOrEqual(actionsBox.x);
        expect(meta.x + meta.width).toBeLessThanOrEqual(actionsBox.x);
        await expect(actions).toHaveCSS("opacity", "1");
        for (const action of await actions.getByRole("button").all()) {
          const box = (await action.boundingBox())!;
          expect(box.width).toBeGreaterThanOrEqual(36);
          expect(box.height).toBeGreaterThanOrEqual(36);
        }
        expect(
          await row.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
      }
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
      await route.fulfill({
        json: { sessions: [], total: 0, offset: 0, limit: 40 },
      });
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
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
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
      contextOptions: { reducedMotion: "reduce" },
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
        const row = body.getByRole("button", {
          name: "archived-b",
          exact: true,
        });
        // Focus only after the expanded body can fit a row and is revealed.
        // Its bottom can already be visible while flex layout still clips it.
        await expect
          .poll(async () => {
            const bounds = await navigationRowBounds(row);
            return {
              rowFits: bounds.scrollport.height >= bounds.row.height,
              bodyRevealed:
                bounds.scrollport.bottom <= bounds.viewport.bottom + 1,
            };
          })
          .toEqual({ rowFits: true, bodyRevealed: true });
        await row.focus();
        await expect(row).toBeFocused();
        const bounds = await navigationRowBounds(row);
        expect(bounds.row.top).toBeGreaterThanOrEqual(
          Math.max(bounds.viewport.top, bounds.scrollport.top) - 1,
        );
        expect(bounds.row.bottom).toBeLessThanOrEqual(
          Math.min(bounds.viewport.bottom, bounds.scrollport.bottom) + 1,
        );
        if ((await row.getAttribute("aria-expanded")) !== "true")
          await row.press("Enter");
        await expect(row).toHaveAttribute("aria-expanded", "true");
        const session = body.locator(".nav__row-main").last();
        await session.focus();
        await expect(session).toBeFocused();
        const visible = await navigationRowBounds(session);
        expect(visible.scrollport.height).toBeGreaterThanOrEqual(
          visible.row.height,
        );
        expect(visible.row.top).toBeGreaterThanOrEqual(
          Math.max(visible.viewport.top, visible.scrollport.top) - 1,
        );
        expect(visible.row.bottom).toBeLessThanOrEqual(
          Math.min(visible.viewport.bottom, visible.scrollport.bottom) + 1,
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
        const catalogBounds = await navigationRowBounds(catalogRow);
        expect(catalogBounds.row.top).toBeGreaterThanOrEqual(
          catalogBounds.scrollport.top - 1,
        );
        expect(catalogBounds.row.bottom).toBeLessThanOrEqual(
          Math.min(
            catalogBounds.scrollport.bottom,
            catalogBounds.viewport.bottom,
          ) + 1,
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
      await openFixtureSession(page, /Geometry session/);
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
