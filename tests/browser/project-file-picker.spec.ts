import { expect, test } from "@playwright/test";
import { openFixtureSession, pairedPage } from "./support/navigation";

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
    }) => {
      await pairedPage(page);
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
      await expect(touch ? menu : search).toBeFocused();
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

      if (touch) await search.tap();
      await expect(search).toBeFocused();
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

test("keeps the project-file search field still while results refresh @cross-browser", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const files = Array.from({ length: 24 }, (_, index) => ({
    name: `candidate-${index}.ts`,
    path: `src/candidate-${index}.ts`,
    kind: "file",
  }));
  await page.route("**/api/files?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === "candidate")
      await pending;
    await route.fulfill({ json: { files, truncated: false } });
  });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  await page
    .getByRole("button", { name: "Add project files", exact: true })
    .click();
  const menu = page.getByRole("dialog", { name: "Add project files" });
  const search = menu.getByRole("combobox", { name: "Search project files" });
  const options = menu.getByRole("option");
  await expect(menu).toHaveAttribute("data-placement", "up");
  await expect(options).toHaveCount(files.length);
  const initialTop = (await search.boundingBox())!.y;
  try {
    await search.fill("candidate");
    await expect(menu.getByText("Searching…", { exact: true })).toBeVisible();
    await expect(options).toHaveCount(0);
    expect(Math.abs((await search.boundingBox())!.y - initialTop)).toBeLessThan(
      1,
    );
    await expect(search).toBeFocused();
  } finally {
    release();
  }
  await expect(options).toHaveCount(files.length);
  expect(Math.abs((await search.boundingBox())!.y - initialTop)).toBeLessThan(
    1,
  );
  await expect(search).toBeFocused();
});
