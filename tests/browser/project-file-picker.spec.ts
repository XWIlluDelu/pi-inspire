import { expect, test } from "@playwright/test";
import { openFixtureSession, pairedPage } from "./support/navigation";

test.use({ serviceWorkers: "block" });

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
      await openFixtureSession(page, /Review extension event lifecycle/);
      await page.evaluate(() => document.fonts.ready);
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
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(anchor.y);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      if (!touch) {
        const hovered = list.getByRole("option").nth(1);
        await hovered.hover();
        await expect(search).not.toHaveAttribute("aria-activedescendant", /.+/);
        await search.press("ArrowDown");
        await expect(search).toHaveAttribute(
          "aria-activedescendant",
          (await list.getByRole("option").nth(2).getAttribute("id"))!,
        );
      }

      if (touch) await search.tap();
      await expect(search).toBeFocused();
      for (let index = 0; index < 4; index++) await search.press("ArrowUp");
      const lastId = (await search.getAttribute("aria-activedescendant"))!;
      const chosen = page.locator(`[id="${lastId}"]`);
      await expect(chosen).toBeInViewport();
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

test("keeps the project-file search field still and rejects a superseded response @cross-browser", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const files = Array.from({ length: 24 }, (_, index) => ({
    name: `candidate-${index}.ts`,
    path: `src/candidate-${index}.ts`,
    kind: "file",
  }));
  let denied = 0;
  await page.route("**/api/files?**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query === "denied") {
      denied++;
      return route.fulfill({ status: 403, json: { error: "Access denied" } });
    }
    if (query !== "retired")
      return route.fulfill({ json: { files, truncated: false } });
    requested.resolve();
    await release.promise;
    try {
      await route.fulfill({
        json: {
          files: [{ name: "retired.ts", path: "retired.ts", kind: "file" }],
          truncated: false,
        },
      });
    } catch {
      // Closing or superseding the owner may cancel its HTTP request.
    } finally {
      finished.resolve();
    }
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
    await search.fill("retired");
    await requested.promise;
    await expect(menu.getByText("Searching…", { exact: true })).toBeVisible();
    await expect(options).toHaveCount(0);
    await expect(search).toBeFocused();
    await search.fill("denied");
    await expect(menu.getByText("Project file search failed")).toBeVisible();
    await search.fill("candidate");
    await expect(options).toHaveCount(files.length);
  } finally {
    release.resolve();
  }
  await finished.promise;
  await expect(menu.getByText("retired.ts")).toHaveCount(0);
  expect(denied).toBe(1);
  await expect(options).toHaveCount(files.length);
  expect(Math.abs((await search.boundingBox())!.y - initialTop)).toBeLessThan(
    1,
  );
  await expect(search).toBeFocused();
});
