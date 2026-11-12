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

test("desktop session actions replace the trailing age without shifting the title", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  const row = page.locator(".nav__row--active");
  const title = row.locator(".nav__row-name");
  const meta = row.locator(".nav__row-meta");
  const actions = row.locator(".nav__row-actions");
  const titleBox = (await title.boundingBox())!;
  const metaBox = (await meta.boundingBox())!;
  const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
  // One line: the age trails the title on its own axis, at the row's end.
  expect(Math.abs(middle(metaBox) - middle(titleBox))).toBeLessThanOrEqual(1.5);
  expect(metaBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
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
});

test.describe("touch navigation", () => {
  test.use({ hasTouch: true });

  test("keeps touch actions beside two-line session rows across widths", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await navigationGroupsFixture(page);
    await pairedPage(page);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
      true,
    );
    const folder = page
      .locator(".nav__group")
      .filter({ has: page.getByRole("button", { name: /^calibration/ }) });
    await folder.locator(".nav__group-toggle").tap();
    const row = folder.locator(".nav__row");
    const title = (await row.locator(".nav__row-name").boundingBox())!;
    const actions = (await row.locator(".nav__row-actions").boundingBox())!;
    expect(title.x + title.width).toBeLessThanOrEqual(actions.x);
    expect((await row.boundingBox())!.height).toBe(44);

    const pin = row.getByRole("button", { name: 'Pin "Geometry session"' });
    expect(await pin.boundingBox()).toMatchObject({ width: 36, height: 36 });
    // Keep the row in place for one tap so curation cannot mask stale hover.
    await pin.evaluate((button) => {
      button.addEventListener("click", (event) => event.stopPropagation(), {
        once: true,
      });
    });
    await pin.tap();
    await expect(pin).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    await row.locator(".nav__row-main").tap();
    await expect(page.locator(".topbar__title-button")).toHaveText(
      "Geometry session",
    );
    await pin.tap();
    const pinned = page.locator(".nav__group--pinned .nav__row");
    await expect(
      pinned.getByRole("button", { name: 'Unpin "Geometry session"' }),
    ).toBeVisible();

    await page.setViewportSize({ width: 320, height: 844 });
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .click();
    const reports = page.getByRole("button", { name: "reports", exact: true });
    await reports.tap();
    for (const row of [
      pinned,
      page.locator(".nav__row").filter({ hasText: "Reports session" }),
    ]) {
      await expect(row).toBeVisible();
      const title = (await row.locator(".nav__row-name").boundingBox())!;
      const meta = (await row.locator(".nav__row-meta").boundingBox())!;
      const actions = row.locator(".nav__row-actions");
      const bounds = (await actions.boundingBox())!;
      expect(meta.y).toBeGreaterThanOrEqual(title.y + title.height);
      expect(meta.x).toBeCloseTo(title.x, 1);
      expect(
        Math.max(title.x + title.width, meta.x + meta.width),
      ).toBeLessThanOrEqual(bounds.x);
      await expect(actions).toHaveCSS("opacity", "1");
      for (const action of await actions.getByRole("button").all())
        expect(await action.boundingBox()).toMatchObject({
          width: 36,
          height: 36,
        });
    }
    await page.unrouteAll({ behavior: "wait" });
  });
});

test("Welcome Recent hides curated sessions and preserves its disclosure through reload", async ({
  page,
}) => {
  let preferences: Record<string, unknown>;
  await page.route("**/api/bootstrap**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    preferences = Object.assign(
      body.preferences,
      preferences ?? {
        hiddenSessionIds: [],
        hiddenProjectCwds: [],
        pinnedSessionIds: [],
      },
    );
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/preferences", async (route) => {
    Object.assign(preferences, route.request().postDataJSON());
    await route.fulfill({ json: preferences });
  });
  await pairedPage(page);
  const welcome = async () => {
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Collapse navigation", exact: true })
      .click();
  };
  const list = page.locator(".welcome__recent [role=list]");
  await welcome();
  await expect(list).toContainText("Formula rendering and spectral analysis");
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  const row = page.locator(".nav__row--active");
  await row.hover();
  await row
    .getByRole("button", {
      name: 'Hide "Formula rendering and spectral analysis"',
    })
    .click();
  await welcome();
  const recent = page.getByRole("button", {
    name: "Recent sessions",
    exact: true,
  });
  await expect(list).toBeVisible();
  await expect(list).not.toContainText(
    "Formula rendering and spectral analysis",
  );

  await recent.click();
  await page.reload();
  await expect(recent).toHaveAttribute("aria-expanded", "false");
  await openFixtureSession(page, /Review extension event lifecycle/);
  await welcome();
  await expect(recent).toHaveAttribute("aria-expanded", "false");
  await recent.click();
  await page.reload();
  await expect(list).toBeVisible();
  await expect(list).not.toContainText(
    "Formula rendering and spectral analysis",
  );
});

for (const viewport of [
  { width: 901, height: 390, hasTouch: false },
  { width: 568, height: 260, hasTouch: true },
]) {
  test.describe(`short navigation · ${viewport.hasTouch ? "drawer" : "rail"}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.hasTouch,
      contextOptions: { reducedMotion: "reduce" },
      serviceWorkers: "block",
    });

    test("Hidden preserves focus and keeps both lists reachable", async ({
      page,
    }) => {
      await navigationGroupsFixture(page);
      await pairedPage(page);
      const nav = page.locator(".nav");
      if (viewport.hasTouch)
        await page
          .getByRole("button", { name: "Toggle navigation", exact: true })
          .click();
      await nav.evaluate((el) => {
        el.style.setProperty("--safe-top", "8px");
        el.style.setProperty("--safe-bottom", "12px");
      });

      const hidden = nav.getByRole("button", { name: "Hidden", exact: true });
      await page.keyboard.press("Tab");
      const before = (await hidden.boundingBox())!;
      await hidden.focus();
      await expect(hidden).toHaveCSS("outline-style", "solid");
      expect(await hidden.evaluate(focusRingClipping)).toBeLessThanOrEqual(0.5);
      expect((await hidden.boundingBox())!.height).toBeCloseTo(
        before.height,
        0,
      );
      await hidden.press("Enter");
      await expect(hidden).toHaveAttribute("aria-expanded", "true");
      await expect(hidden).toBeFocused();
      expect(await hidden.evaluate(focusRingClipping)).toBeLessThanOrEqual(0.5);

      const body = nav.locator(".nav__hidden-content");
      const group = body.getByRole("button", {
        name: "archived-b",
        exact: true,
      });
      await expect
        .poll(async () => {
          const { row, scrollport, viewport } =
            await navigationRowBounds(group);
          return (
            scrollport.height >= row.height &&
            scrollport.bottom <= viewport.bottom + 1
          );
        })
        .toBe(true);
      await group.focus();
      if ((await group.getAttribute("aria-expanded")) !== "true")
        await group.press("Enter");
      const session = body.locator(".nav__row-main").last();
      await session.focus();
      await expect(session).toBeFocused();
      const visible = await navigationRowBounds(session);
      expect(visible.row.top).toBeGreaterThanOrEqual(
        Math.max(visible.viewport.top, visible.scrollport.top) - 1,
      );
      expect(visible.row.bottom).toBeLessThanOrEqual(
        Math.min(visible.viewport.bottom, visible.scrollport.bottom) + 1,
      );

      await hidden.press("Enter");
      await expect(hidden).toBeFocused();
      await expect(body).toHaveCount(0);
      const catalog = nav.locator(".nav__list");
      const folder = catalog.getByRole("button", {
        name: "calibration",
        exact: true,
      });
      if ((await folder.getAttribute("aria-expanded")) !== "true")
        await folder.press("Enter");
      const catalogRow = catalog.locator(".nav__row-main").first();
      await catalogRow.focus();
      await expect(catalogRow).toBeFocused();
      const bounds = await navigationRowBounds(catalogRow);
      expect(bounds.row.bottom).toBeLessThanOrEqual(
        Math.min(bounds.scrollport.bottom, bounds.viewport.bottom) + 1,
      );
    });
  });
}
