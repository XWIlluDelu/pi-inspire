import { expect, test } from "@playwright/test";

for (const touch of [false, true]) {
  test.describe(touch ? "touch file picker" : "desktop file picker", () => {
    test.use({
      viewport: touch
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 },
      hasTouch: touch,
      isMobile: touch,
    });

    test("anchors to its toolbar button, preserves navigation/scroll, and dismisses only on interaction", async ({
      page,
    }, testInfo) => {
      await page.goto("/");
      await page.getByLabel("Access token").fill("inspire-browser-test-token");
      await page.getByRole("button", { name: "Pair", exact: true }).click();
      if (touch)
        await page.getByRole("button", { name: "Toggle navigation" }).tap();
      await page
        .locator(".nav__row-main")
        .filter({ hasText: "Review extension event lifecycle" })
        .click();
      const trigger = page.getByRole("button", {
        name: "Add project files",
        exact: true,
      });
      if (touch) await trigger.tap();
      else await trigger.click();
      const menu = page.getByRole("dialog", { name: "Add project files" });
      const search = menu.getByRole("combobox", {
        name: "Search project files",
      });
      const list = menu.getByRole("listbox", { name: "Project files" });
      await expect(list.getByRole("option").first()).toBeVisible();
      await expect(search).toBeFocused();
      await expect(menu).toHaveAttribute("data-placement", "up");
      const anchor = (await trigger.boundingBox())!;
      const bounds = (await menu.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(Math.abs(bounds.y + bounds.height - (anchor.y - 4))).toBeLessThan(
        1,
      );
      expect(bounds.x).toBeGreaterThanOrEqual(16);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 16);
      if (!touch) expect(Math.abs(bounds.x - anchor.x)).toBeLessThan(1);

      if (!touch) {
        const hovered = list.getByRole("option").nth(1);
        const keyboardHighlight = await list
          .locator(".picker__row--active")
          .evaluate((el) => getComputedStyle(el).backgroundColor);
        await hovered.hover();
        await expect(menu.locator(".picker__row--active")).toHaveCount(0);
        await expect(hovered).toHaveCSS("background-color", keyboardHighlight);
        await page.mouse.move(viewport.width - 8, 400);
        await expect(hovered).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(search).toBeFocused();
        await expect(menu).toBeVisible();
        await hovered.hover();
        await search.press("ArrowDown");
        await expect(hovered).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(list.getByRole("option").nth(2)).toHaveClass(
          /picker__row--active/,
        );
        await page.mouse.move(viewport.width - 8, 400);
        await expect(list.getByRole("option").nth(2)).toHaveClass(
          /picker__row--active/,
        );
      }
      await page.screenshot({
        path: testInfo.outputPath("picker-open.png"),
        animations: "disabled",
      });

      await search.press("ArrowUp");
      await search.press("ArrowUp");
      await search.press("ArrowUp");
      const lastId = (await search.getAttribute("aria-activedescendant"))!;
      await expect(page.locator(`[id="${lastId}"]`)).toBeInViewport();
      await expect
        .poll(() => list.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
      await search.press("Enter");
      await expect(page.locator(`[id="${lastId}"]`)).toBeDisabled();
      await expect(search).toBeFocused();
      await expect(menu).toBeVisible();

      if (touch) await page.touchscreen.tap(viewport.width - 8, 400);
      else await page.mouse.click(viewport.width - 8, 400);
      await expect(menu).toHaveCount(0);
      if (touch) await trigger.tap();
      else await trigger.click();
      const hidden = menu.getByRole("button", { name: "Show hidden files" });
      await hidden.focus();
      await hidden.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  });
}

test("settings dropdown escapes a clipped scroller and keeps pointer hover separate from keyboard selection", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("inspire-browser-test-token");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const trigger = page.getByRole("combobox", {
    name: "Steering delivery",
    exact: true,
  });
  await trigger.evaluate((el) => {
    const content = el.closest(".settings__content")!;
    const row = el.getBoundingClientRect();
    content.scrollTop +=
      row.bottom - (content.getBoundingClientRect().bottom - 12);
  });
  await trigger.click();
  const menu = page.getByRole("listbox", {
    name: "Steering delivery",
    exact: true,
  });
  const last = menu.getByRole("option").last();
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((el) => Boolean(el.closest(".settings__content"))),
  ).toBe(false);
  expect(
    await last.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        ),
      );
    }),
  ).toBe(true);
  await last.hover();
  await page.mouse.move(100, 100);
  await expect(menu.locator(".dropdown__option--active")).toHaveCount(0);
  await expect(last).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(trigger).toBeFocused();
  await last.hover();
  await trigger.press("Home");
  await expect(last).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(menu.getByRole("option").first()).toHaveClass(
    /dropdown__option--active/,
  );
  await page.screenshot({
    path: testInfo.outputPath("dropdown-unclipped.png"),
    animations: "disabled",
  });
  await trigger.press("Escape");
  await expect(menu).toHaveCount(0);
});
