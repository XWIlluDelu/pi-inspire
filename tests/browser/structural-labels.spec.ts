import { expect, test } from "@playwright/test";
import { routeSnapshots } from "./support/host-events";
import {
  openFixtureSession,
  openSettings,
  pairedPage,
} from "./support/navigation";
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
    await openFixtureSession(page, /Formula rendering and spectral analysis/);
    const activity = page.locator(".activity-fold__disclosure").first();
    await expect(activity).toHaveCSS("text-transform", "none");
    await expect(activity).toHaveCSS("font-family", /Flux Mono SC/);
    await activity.click();
    const collapse = page.locator(".activity-fold__boundary--lower").first();
    await expect(collapse).toHaveCSS("font-family", /Flux Mono SC/);
    await expect(collapse).toHaveCSS("text-transform", "none");
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    const modes = page.locator(".ctx__modes");
    await expect(modes).toBeVisible();
    await expect(modes.locator(".ctx__mode-count")).toHaveText("99+");
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
    await expect(modes.locator(".ctx__mode-count")).toHaveText("99+");
    const [toolsBeforeScroll, toolsAfterScroll] = await modes.evaluate(
      (tools) => {
        const strip = tools
          .closest(".ctx__header")!
          .querySelector(".ctx__file-tabs")!;
        strip.scrollLeft = 0;
        const before = tools.getBoundingClientRect().toJSON();
        strip.scrollLeft = strip.scrollWidth;
        return [before, tools.getBoundingClientRect().toJSON()];
      },
    );
    expect(toolsAfterScroll.x).toBeCloseTo(toolsBeforeScroll.x, 1);
    expect(toolsAfterScroll.width).toBeCloseTo(toolsBeforeScroll.width, 1);
    const filesBox = (await fileTabs.boundingBox())!;
    if (filesBox.y + filesBox.height > toolsAfterScroll.y + 0.5)
      expect(filesBox.x + filesBox.width).toBeLessThanOrEqual(
        toolsAfterScroll.x + 0.5,
      );
    else
      expect(filesBox.y + filesBox.height).toBeLessThanOrEqual(
        toolsAfterScroll.y + 0.5,
      );
    const terminal = modes.getByRole("button", {
      name: "New terminal",
      exact: true,
    });
    await expect(terminal).toBeEnabled();
    await expect(terminal).toHaveAttribute("title", "New terminal");
    for (const name of ["Files", "Changes", "History"]) {
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
      const items = await modes.locator("button").evaluateAll((elements) =>
        elements.map((button) => {
          const box = button.getBoundingClientRect();
          const icon = button.querySelector("svg")!.getBoundingClientRect();
          const count = button
            .querySelector(".ctx__mode-count")
            ?.getBoundingClientRect();
          return {
            label: button.getAttribute("aria-label"),
            width: box.width,
            height: box.height,
            iconWidth: icon.width,
            iconHeight: icon.height,
            left: icon.left - box.left,
            right: box.right - (count?.right ?? icon.right),
            center: icon.y + icon.height / 2 - box.y - box.height / 2,
          };
        }),
      );
      expect(items).toHaveLength(4);
      const widths = items
        .filter((item) => item.label !== "Changes")
        .map((item) => item.width);
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
    await openSettings(page);
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("button", { name: "Display", exact: true }).click();
    const section = dialog.getByRole("heading", {
      name: "Display",
      exact: true,
    });
    await expect(section).toHaveCSS("font-family", /IBM Plex Sans SC/);
    const offsets = await section.locator("..").evaluate(textMarkOffsets, {
      label: ".settings__section-title",
      marks: ".settings__section-icon",
    });
    expect(offsets).toHaveLength(1);
    expect(Math.abs(offsets[0]!)).toBeLessThan(0.5);
    await expect(dialog.locator(".settings__field-label").first()).toHaveCSS(
      "font-family",
      /IBM Plex Sans SC/,
    );
    await expect
      .poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
      .toBe(true);
  });
}

test("Changes keeps the count readable beside its icon in both tab states", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let total = 1;
  await routeSnapshots(page, {
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
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const modes = page.locator(".ctx__modes");
  await modes.getByRole("tab", { name: "Changes", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  const count = modes.locator(".ctx__mode-count");
  const changes = modes.getByRole("tab", { name: "Changes", exact: true });
  for (const value of [0, 1, 36, 123]) {
    total = value;
    await page.getByRole("button", { name: "Refresh context pane" }).click();
    if (!value) {
      await expect(count).toHaveCount(0);
      await expect(changes).toHaveAttribute("title", "Changes");
      continue;
    }
    await expect(count).toHaveText(value > 99 ? "99+" : String(value));
    for (const selected of ["Files", "Changes"]) {
      const mode = modes.getByRole("tab", { name: selected, exact: true });
      await mode.focus();
      await expect(mode).toBeFocused();
      await mode.click();
      await expect(count).toBeVisible();
      await expect(changes).toHaveAttribute(
        "title",
        `Changes (${value} ${value === 1 ? "change" : "changes"})`,
      );
      const icon = (await changes.locator("svg").boundingBox())!;
      const target = (await changes.boundingBox())!;
      const box = (await count.boundingBox())!;
      expect(box.x - icon.x - icon.width).toBeGreaterThanOrEqual(2);
      expect(box.x + box.width).toBeLessThan(target.x + target.width);
      const centerOffset = box.y + box.height / 2 - icon.y - icon.height / 2;
      expect(Math.abs(centerOffset)).toBeLessThanOrEqual(1);
    }
  }
  await page.unrouteAll({ behavior: "wait" });
});
