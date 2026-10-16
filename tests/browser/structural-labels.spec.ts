import { expect, test } from "@playwright/test";
import { routeMockSnapshots } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";
import { textBaseline, textMarkOffsets } from "./support/text-baseline";

for (const width of [1440, 768, 390, 320]) {
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
          document.fonts.check('500 13px "Rajdhani"') &&
          document.fonts.check('600 13px "Rajdhani"'),
      ),
    ).toBe(true);
    for (const name of ["Files", "Changes", "History", "Terminal"]) {
      await modes.getByRole("button", { name, exact: true }).click();
      await expect(
        modes.getByRole("button", { name, exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      const count = modes.locator(".ctx__mode-badge");
      if (await count.isVisible()) {
        const labelBaseline = await count
          .locator("..")
          .locator("span")
          .first()
          .evaluate(textBaseline);
        const countBaseline = await count.evaluate(textBaseline);
        expect(Math.abs(countBaseline - labelBaseline)).toBeLessThan(0.5);
      }
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
      const widths = items.map((item) => item.width);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.1);
      for (const item of items) {
        expect(item.left, JSON.stringify(item)).toBeGreaterThanOrEqual(2);
        expect(item.right, JSON.stringify(item)).toBeGreaterThanOrEqual(2);
        expect(Math.abs(item.center)).toBeLessThanOrEqual(1);
        expect(item.overflow, JSON.stringify(item)).toBe(false);
        expect(item.height).toBeGreaterThanOrEqual(26);
      }
    }
    const modeBox = (await modes.boundingBox())!;
    const actionsBox = (await page
      .locator(".ctx__header-actions")
      .boundingBox())!;
    expect(actionsBox.x - modeBox.x - modeBox.width).toBeGreaterThanOrEqual(2);
    if (width <= 900) {
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
    const offsets = await section.locator("..").evaluate(textMarkOffsets, {
      label: ".settings__section-title",
      marks: ".settings__section-icon",
    });
    expect(offsets).toHaveLength(1);
    expect(Math.abs(offsets[0]!)).toBeLessThan(0.5);
    await expect(
      dialog.locator(".settings__field-label").first(),
    ).not.toHaveCSS("font-family", /Rajdhani/);
    await expect
      .poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
      .toBe(true);
  });
}

test("resource count capsules center their numerals without shifting label baselines", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let total = 1;
  await routeMockSnapshots(page, {
    bootstrap: (body) => {
      body.preferences.contextPaneWidth = 560;
      body.preferences.contextPaneOpen = false;
    },
  });
  await page.route("**/api/git/status**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.kind === "repository") body.total = total;
    await route.fulfill({ response, json: body });
  });
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const modes = page.locator(".ctx__modes");
  await modes.getByRole("button", { name: "Changes", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  const count = modes.locator(".ctx__mode-badge");
  for (const value of [1, 9, 10, 88, 123]) {
    total = value;
    await page.getByRole("button", { name: "Refresh context pane" }).click();
    await expect(count).toHaveText(value > 99 ? "99+" : String(value));
    for (const selected of ["Files", "Changes"]) {
      await modes.getByRole("button", { name: selected, exact: true }).click();
      await expect(count).toBeVisible();
      const parent = count.locator("..");
      const offsets = await parent.evaluate(textMarkOffsets, {
        label: ".ctx__mode-badge",
        marks: ".ctx__mode-badge",
      });
      expect(Math.abs(offsets[0]!)).toBeLessThan(0.5);
      const nameBaseline = await parent
        .locator("span")
        .first()
        .evaluate(textBaseline);
      const countBaseline = await count.evaluate(textBaseline);
      expect(Math.abs(nameBaseline - countBaseline)).toBeLessThan(0.5);
      const box = (await count.boundingBox())!;
      expect(box.height).toBeCloseTo(14, 2);
      expect(box.width).toBeGreaterThanOrEqual(box.height);
      await expect(parent).toHaveCSS("font-size", "13px");
    }
  }
});
