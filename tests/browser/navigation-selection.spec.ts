import { expect, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

for (const touch of [false, true]) {
  test.describe(touch ? "touch selection" : "pointer selection", () => {
    test.use({ hasTouch: touch });
    test("collapsed project selection leaves the icon clear and preserves the label axis", async ({
      page,
    }) => {
      await pairedPage(page);
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
        expect(clearance.width).toBe(16);
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
