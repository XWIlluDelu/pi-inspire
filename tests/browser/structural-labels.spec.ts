import { expect, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

for (const width of [1440, 390, 320]) {
  test(`structural labels retain balanced controls and readable content at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/git/status**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.kind === "repository") body.total = 123;
      await route.fulfill({ response, json: body });
    });
    await pairedPage(page);
    await openMockSession(page, /Formula rendering and spectral analysis/);
    const activity = page.locator(".activity-fold__disclosure").first();
    await expect(activity).toHaveCSS("text-transform", "uppercase");
    await expect(activity).toHaveCSS("font-family", /Rajdhani/);
    await activity.click();
    const collapse = page.locator(".activity-fold__boundary--lower").first();
    await expect(collapse).toHaveCSS("font-family", /Rajdhani/);
    await expect(collapse).toHaveCSS("text-transform", "uppercase");
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    const modes = page.locator(".ctx__modes");
    await expect(modes).toBeVisible();
    await expect(modes.locator(".ctx__mode-badge")).toHaveText("99+");
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(
        () =>
          document.fonts.check('500 14px "Rajdhani"') &&
          document.fonts.check('600 14px "Rajdhani"'),
      ),
    ).toBe(true);
    for (const name of ["Files", "Changes", "History", "Terminal"]) {
      await modes.getByRole("button", { name, exact: true }).click();
      await expect(
        modes.getByRole("button", { name, exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      const items = await modes.locator("button").evaluateAll((elements) =>
        elements.map((button) => {
          const box = button.getBoundingClientRect();
          const label = button
            .querySelector(".ctx__mode-label")!
            .getBoundingClientRect();
          return {
            text: button.textContent,
            width: box.width,
            textWidth: label.width,
            naturalTextWidth:
              button.querySelector(".ctx__mode-label")!.scrollWidth,
            left: label.left - box.left,
            right: box.right - label.right,
            height: box.height,
            center: label.y + label.height / 2 - box.y - box.height / 2,
            overflow: button.scrollWidth > button.clientWidth + 1,
          };
        }),
      );
      for (const item of items) {
        expect(item.left, JSON.stringify(item)).toBeGreaterThanOrEqual(2);
        expect(item.right, JSON.stringify(item)).toBeGreaterThanOrEqual(2);
        expect(Math.abs(item.center)).toBeLessThanOrEqual(1);
        expect(item.overflow).toBe(false);
        expect(item.height).toBeGreaterThanOrEqual(26);
      }
    }
    if (width < 700) {
      await page.locator(".ctx__close").click();
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("button", { name: "Display", exact: true }).click();
    const section = dialog.getByRole("heading", {
      name: "Display",
      exact: true,
    });
    await expect(section).toHaveCSS("font-family", /Rajdhani/);
    await expect(
      dialog.locator(".settings__field-label").first(),
    ).not.toHaveCSS("font-family", /Rajdhani/);
    await expect
      .poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
      .toBe(true);
  });
}
