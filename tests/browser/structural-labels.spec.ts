import { expect, test } from "@playwright/test";
import { routeMockSnapshots } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";
import { textMarkOffsets } from "./support/text-baseline";

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
    const fileTabs = page.locator(".ctx__file-tabs");
    for (const file of ["page.html", "document.md", "interactive.js"]) {
      await modes.getByRole("tab", { name: "Files", exact: true }).click();
      await page
        .getByRole("searchbox", { name: "Search workspace files" })
        .fill(`file-previews/${file}`);
      await page
        .locator(
          `[data-workspace-path="tests/browser/fixtures/file-previews/${file}"]`,
        )
        .click();
      await expect(
        fileTabs.getByRole("tab", { name: file, exact: true }),
      ).toHaveAttribute("aria-selected", "true");
    }
    if (width === 1440) {
      const selected = fileTabs.locator(".ctx__file-tab--active");
      for (const narrowWidth of [390, 320]) {
        await page.setViewportSize({ width: narrowWidth, height: 1000 });
        await expect
          .poll(() =>
            selected.evaluate((element) => {
              const tab = element.getBoundingClientRect();
              const strip = element.parentElement!.getBoundingClientRect();
              return Math.max(strip.left - tab.left, tab.right - strip.right);
            }),
          )
          .toBeLessThanOrEqual(0.5);
        await expect(
          fileTabs.getByRole("tab", { name: "interactive.js", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
      }
      await page.setViewportSize({ width, height: 1000 });
      // CSS changes at once, while React restores the desktop pane on its
      // media-query update. Measure scrolling only after that owner transition.
      await expect(
        page.getByRole("complementary", { name: "Context panel", exact: true }),
      ).toBeVisible();
    }
    const toolsBeforeScroll = (await modes.boundingBox())!;
    await fileTabs.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await fileTabs.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const toolsAfterScroll = (await modes.boundingBox())!;
    expect(toolsAfterScroll.x).toBeCloseTo(toolsBeforeScroll.x, 1);
    expect(toolsAfterScroll.width).toBeCloseTo(toolsBeforeScroll.width, 1);
    const filesBox = (await fileTabs.boundingBox())!;
    expect(filesBox.x + filesBox.width).toBeLessThanOrEqual(toolsAfterScroll.x);
    for (const name of ["Files", "Changes", "History", "Terminal"]) {
      const tab = modes.getByRole("tab", { name, exact: true });
      await expect(tab).toHaveAttribute(
        "title",
        name === "Changes" ? "Changes (123 changes)" : name,
      );
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("tabpanel", { name, exact: true }),
      ).toBeVisible();
      const items = await modes.getByRole("tab").evaluateAll((elements) =>
        elements.map((button) => {
          const box = button.getBoundingClientRect();
          const icon = button.querySelector("svg")!.getBoundingClientRect();
          return {
            label: button.getAttribute("aria-label"),
            width: box.width,
            height: box.height,
            iconWidth: icon.width,
            iconHeight: icon.height,
            left: icon.left - box.left,
            right: box.right - icon.right,
            center: icon.y + icon.height / 2 - box.y - box.height / 2,
          };
        }),
      );
      expect(items).toHaveLength(4);
      const widths = items.map((item) => item.width);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.1);
      for (const item of items) {
        expect(item.left, JSON.stringify(item)).toBeGreaterThanOrEqual(2);
        expect(item.right, JSON.stringify(item)).toBeGreaterThanOrEqual(2);
        expect(Math.abs(item.center)).toBeLessThanOrEqual(1);
        expect([item.iconWidth, item.iconHeight]).toEqual([16, 16]);
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

test("resource count capsules center their numerals beside the Changes icon", async ({
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
  await modes.getByRole("tab", { name: "Changes", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  const count = modes.locator(".ctx__mode-badge");
  for (const value of [1, 10, 123]) {
    total = value;
    await page.getByRole("button", { name: "Refresh context pane" }).click();
    await expect(count).toHaveText(value > 99 ? "99+" : String(value));
    for (const selected of ["Files", "Changes"]) {
      const mode = modes.getByRole("tab", { name: selected, exact: true });
      await mode.focus();
      await expect(mode).toBeFocused();
      await mode.click();
      await expect(count).toBeVisible();
      const parent = count.locator("..");
      const offsets = await parent.evaluate(textMarkOffsets, {
        label: ".ctx__mode-badge",
        marks: ".ctx__mode-badge",
      });
      // Native digit ink can round by a pixel inside the small count capsule.
      expect(Math.abs(offsets[0]!)).toBeLessThan(1);
      await expect(parent).toHaveAttribute(
        "title",
        `Changes (${value} ${value === 1 ? "change" : "changes"})`,
      );
      const icon = (await parent.locator("svg").boundingBox())!;
      const target = (await parent.boundingBox())!;
      expect(icon.x + icon.width / 2).toBeCloseTo(
        target.x + target.width / 2,
        1,
      );
      const box = (await count.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(box.height);
    }
  }
});
