import { expect, test } from "@playwright/test";
import { navigationGroupsFixture } from "./fixtures/navigation-groups";
import { hostRequest } from "./support/host-request";
import { openMockSession, pairedPage } from "./support/navigation";

for (const touch of [false, true]) {
  test.describe(touch ? "touch selection" : "pointer selection", () => {
    test.use({ hasTouch: touch });
    test("header controls have breathing room without compressing project groups", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await navigationGroupsFixture(page);
      await pairedPage(page);
      const nav = page
        .getByRole("navigation", { name: "Sessions", exact: true })
        .or(page.getByRole("dialog", { name: "Sessions", exact: true }));
      const group = (name: string) =>
        nav.locator(".nav__list > .nav__group").filter({
          has: page.locator(".nav__group-name", {
            hasText: new RegExp("^" + name + "$"),
          }),
        });
      await group("reports").locator(".nav__group-toggle").click();
      await group("reports").locator(".nav__row-main").click();
      await expect(page.locator(".topbar__title-button")).toHaveText(
        "Reports session",
      );
      await group("reports").locator(".nav__group-toggle").click();
      const gaps = () =>
        nav
          .locator(".nav__list > .nav__group")
          .evaluateAll((groups) =>
            groups
              .slice(1)
              .map(
                (el, i) =>
                  el.getBoundingClientRect().top -
                  groups[i]!.getBoundingClientRect().bottom,
              ),
          );
      for (const width of [1280, 820, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        );
        if (!(await nav.isVisible()))
          await page
            .getByRole("button", { name: "Toggle navigation", exact: true })
            .click();
        await expect(nav.locator(".nav__list > .nav__group")).toHaveCount(3);
        await expect
          .poll(() =>
            nav.evaluate((el) => {
              const create = el
                .querySelector(".nav__new-session")!
                .getBoundingClientRect();
              const search = el
                .querySelector(".nav__search")!
                .getBoundingClientRect();
              const folder = el
                .querySelector(".nav__list > .nav__group")!
                .getBoundingClientRect();
              return [search.top - create.bottom, folder.top - search.bottom];
            }),
          )
          .toEqual([8, 16]);
        await expect.poll(gaps).toEqual([18, 22]);
        const before = await group("calibration")
          .locator(".nav__group-title")
          .boundingBox();
        await group("calibration").locator(".nav__group-toggle").click();
        await expect(
          group("calibration").locator(".nav__group-toggle"),
        ).toHaveAttribute("aria-expanded", "true");
        await expect.poll(gaps).toEqual([18, 22]);
        const after = await group("calibration")
          .locator(".nav__group-title")
          .boundingBox();
        expect(after!.height).toBe(before!.height);
        await group("calibration").locator(".nav__group-toggle").click();

        await nav.locator(".nav__hidden-toggle").click();
        const hidden = nav.locator(".nav__hidden-content > .nav__group");
        await expect(hidden).toHaveCount(2);
        // A hidden former pin does not create a visible pinned-section break.
        await expect(hidden.first()).toHaveClass(/nav__group--pinned-folder/);
        await expect
          .poll(() =>
            hidden.evaluateAll(
              (groups) =>
                groups[1]!.getBoundingClientRect().top -
                groups[0]!.getBoundingClientRect().bottom,
            ),
          )
          .toBe(10);
        await nav.locator(".nav__hidden-toggle").click();

        const search = nav.getByRole("searchbox", { name: "Search sessions" });
        await search.fill("session");
        await expect(nav.locator(".nav__list .nav__row")).toHaveCount(3);
        await expect.poll(gaps).toEqual([18, 22]);
        await search.fill("");
        await expect(nav.locator(".nav__list .nav__row")).toHaveCount(0);
        await expect.poll(gaps).toEqual([18, 22]);
        if (
          await page
            .getByRole("button", { name: "Close navigation", exact: true })
            .isVisible()
        )
          await page
            .getByRole("button", { name: "Close navigation", exact: true })
            .click();
      }
    });

    test("collapsed project selection leaves the icon clear and preserves the label axis", async ({
      page,
    }) => {
      await pairedPage(page);
      const initial = await hostRequest(page).get("/api/bootstrap");
      const preferences = (await initial.json()).preferences;
      // Selection geometry owns its collapse state, including failed assertions
      // and retries; it must not hide shared sessions from subsequent tests.
      await page.route("**/api/preferences", (route) =>
        route.fulfill({
          headers: {
            "X-Inspire-Authority": initial.headers()["x-inspire-authority"]!,
          },
          json: Object.assign(preferences, route.request().postDataJSON()),
        }),
      );
      await openMockSession(page, /Formula rendering and spectral analysis/);
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        if (width < 768)
          await page.getByRole("button", { name: "Toggle navigation" }).click();
        const current = page
          .locator(".nav__group:has(.nav__row--active)")
          .first();
        const id = await current.getAttribute("aria-labelledby");
        const group = page.locator(`.nav__group[aria-labelledby="${id}"]`);
        const axes = await group.evaluate((element) => ({
          folder: element
            .querySelector(".nav__group-name")!
            .getBoundingClientRect().left,
          session: element
            .querySelector(".nav__row-name")!
            .getBoundingClientRect().left,
        }));
        expect(Math.abs(axes.folder - axes.session)).toBeLessThanOrEqual(1);
        if (!touch && width === 1440) {
          const rows = group.locator(".nav__row");
          await rows.nth(0).locator(".nav__row-main").click();
          await rows.nth(1).hover();
          await expect(rows.nth(0).locator(".nav__row-actions")).toHaveCSS(
            "opacity",
            "0",
          );
          await expect(rows.nth(0).locator(".nav__row-meta")).toHaveCSS(
            "opacity",
            "1",
          );
          await expect(rows.nth(1).locator(".nav__row-actions")).toHaveCSS(
            "opacity",
            "1",
          );
        }
        const toggle = group.locator(".nav__group-toggle");
        await toggle.click();
        await expect(group.locator(".nav__group-title")).toHaveClass(
          /--active/,
        );
        const clearance = await toggle.evaluate((element) => {
          const heading = element.parentElement!;
          const marker = getComputedStyle(heading, "::before");
          const markerRight =
            heading.getBoundingClientRect().left +
            parseFloat(marker.left) +
            parseFloat(marker.width);
          const icon = element.querySelector("svg")!.getBoundingClientRect();
          return { gap: icon.left - markerRight, width: icon.width };
        });
        expect(clearance.gap).toBeGreaterThanOrEqual(3);
        expect(clearance.width).toBeCloseTo(16, 2);
        await toggle.press("Enter");
        await expect(group.locator(".nav__group-title")).not.toHaveClass(
          /--active/,
        );
        await expect(group.locator(".nav__row--active")).toBeVisible();
        if (width < 768)
          await page.getByRole("button", { name: "Close navigation" }).click();
      }
    });
  });
}
