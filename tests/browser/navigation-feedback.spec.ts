import { expect, test } from "@playwright/test";
import { navigationGroupsFixture } from "./fixtures/navigation-groups";
import { focusRingClipping } from "./support/focus-bounds";
import { pairedPage } from "./support/navigation";

test.use({ serviceWorkers: "block" });

test.describe("touch navigation", () => {
  test.use({ hasTouch: true });

  test("tap feedback clears when a curation row stays in place", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await navigationGroupsFixture(page);
    await pairedPage(page);
    const folder = page
      .locator(".nav__group")
      .filter({ has: page.getByRole("button", { name: /^calibration/ }) });
    await folder.locator(".nav__group-toggle").tap();
    const row = folder.locator(".nav__row");
    // Touch keeps curation visible on the selected session.
    const session = row.locator(".nav__row-main");
    await session.tap();
    await expect(session).toHaveAttribute("aria-current", "page");
    const selectedFill = await row.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const pin = row.getByRole("button", { name: 'Pin "Geometry session"' });
    // Keep the row in place for one tap so curation cannot mask stale hover.
    await pin.evaluate((button) => {
      button.addEventListener("click", (event) => event.stopPropagation(), {
        once: true,
      });
    });
    await pin.tap();
    await expect(pin).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(row).toHaveCSS("background-color", selectedFill);

    await page.unrouteAll({ behavior: "wait" });
  });
});

test("Welcome Recent hides curated sessions and preserves its disclosure through reload", async ({
  page,
}) => {
  let preferences: Record<string, unknown>;
  let revision = 0;
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
    body.preferenceRevision = ++revision;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/preferences", async (route) => {
    Object.assign(preferences, route.request().postDataJSON());
    await route.fulfill({ json: { preferences, revision: ++revision } });
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
  const target = list.getByRole("button").first();
  const title = (await target.getAttribute("title"))!;
  const matching = list.getByTitle(title, { exact: true });
  const originalCount = await matching.count();
  await target.click();
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  const row = page.locator(".nav__row--active");
  await row.hover();
  await row.getByRole("button", { name: `Hide "${title}"`, exact: true }).click();
  await welcome();
  const recent = page.getByRole("button", {
    name: "Recent sessions",
    exact: true,
  });
  await recent.click();
  await page.reload();
  await expect(recent).toHaveAttribute("aria-expanded", "false");
  await recent.click();
  await expect(list).toBeVisible();
  await expect(matching).toHaveCount(originalCount - 1);
});

test.describe("short navigation drawer", () => {
  test.use({
    viewport: { width: 568, height: 260 },
    hasTouch: true,
    contextOptions: { reducedMotion: "reduce" },
  });

  test("switches the catalog view without losing focus in a short window", async ({
    page,
  }) => {
    await navigationGroupsFixture(page);
    await pairedPage(page);
    const nav = page.locator(".nav");
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .click();
    await nav.evaluate((el) => {
      el.style.setProperty("--safe-top", "8px");
      el.style.setProperty("--safe-bottom", "12px");
    });

    const hidden = nav.getByRole("button", { name: "Hidden", exact: true });
    await page.keyboard.press("Tab");
    await hidden.focus();
    await expect(hidden).toHaveCSS("outline-style", "solid");
    await hidden.press("Enter");
    await expect(hidden).toHaveAttribute("aria-expanded", "true");
    await expect(hidden).toBeFocused();
    expect(await hidden.evaluate(focusRingClipping)).toBeLessThanOrEqual(0.5);

    const body = nav.getByRole("region", { name: "Hidden", exact: true });
    await expect(body).toBeVisible();
    const close = (await nav
      .getByRole("button", { name: "Close navigation" })
      .boundingBox())!;
    const clear = (await body
      .getByRole("button", { name: "Clear Hidden" })
      .boundingBox())!;
    expect(clear.x + clear.width / 2).toBeCloseTo(close.x + close.width / 2, 1);
    await hidden.press("Enter");
    await expect(hidden).toBeFocused();
    await expect(hidden).toHaveAttribute("aria-expanded", "false");
  });
});
