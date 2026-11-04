import { expect, type Page, test } from "@playwright/test";
import { hostRequest } from "./support/host-request";
import { openFixtureSession, pairedPage } from "./support/navigation";
import { terminalMutationHeaders } from "./support/terminal-operations";

test.use({ contextOptions: { reducedMotion: "reduce" } });

async function openFile(page: Page, path: string) {
  const pane = page.locator(".ctx");
  await pane.getByRole("tab", { name: "Files", exact: true }).click();
  await pane
    .getByRole("searchbox", { name: "Search workspace files" })
    .fill(path);
  await pane.locator(`[data-workspace-path="${path}"]`).click();
}

for (const hasTouch of [false, true]) {
  test.describe(`shared file tabs · ${hasTouch ? "touch" : "mouse"}`, () => {
    test.use({ hasTouch });
    test("fit a single long label and retain navigation through overflow", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await pairedPage(page);
      await openFixtureSession(
        page,
        /Resource virtualization and sandbox fixture/,
      );
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      const pane = page.locator(".ctx");
      const resize = page.getByRole("separator", {
        name: "Resize files panel",
      });
      const handle = (await resize.boundingBox())!;
      const delta =
        Number(await resize.getAttribute("aria-valuenow")) -
        Number(await resize.getAttribute("aria-valuemin"));
      await page.mouse.move(
        handle.x + handle.width / 2,
        handle.y + handle.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        handle.x + handle.width / 2 + delta,
        handle.y + handle.height / 2,
      );
      await page.mouse.up();

      await openFile(page, "src/components/TerminalSettingsDialog.tsx");
      const longTab = pane.getByRole("tab", {
        name: "TerminalSettingsDialog.tsx",
        exact: true,
      });
      await expect(longTab).toBeVisible();
      await expect(
        pane.getByRole("combobox", { name: "More tabs", exact: true }),
      ).toHaveCount(0);
      const single = await longTab.locator("..").boundingBox();
      expect(single!.width).toBeGreaterThanOrEqual(132);
      expect(single!.width).toBeLessThanOrEqual(180);

      await openFile(page, "tests/browser/fixtures/file-previews/document.md");
      const documentTab = pane.getByRole("tab", {
        name: "document.md",
        exact: true,
      });
      await expect(documentTab).toHaveAttribute("aria-selected", "true");
      await expect(documentTab).toBeVisible();
      await pane.getByRole("tab", { name: "Files", exact: true }).click();
      await expect(longTab).toBeVisible();
      const more = pane.getByRole("combobox", {
        name: "More tabs",
        exact: true,
      });
      await more.click();
      await page.getByRole("option", { name: /^document\.md(?:\s|$)/ }).click();
      await expect(documentTab).toBeVisible();
      await expect(documentTab).toHaveAttribute("aria-selected", "true");

      for (const width of [390, 361, 360, 341, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(
          page.getByRole("dialog", { name: "Context panel", exact: true }),
        ).toBeVisible();
        await documentTab.hover();
        await expect(documentTab).toBeVisible();
        const header = (await pane.locator(".ctx__header").boundingBox())!;
        const strip = (await pane.locator(".ctx__file-tabs").boundingBox())!;
        const activeTab = (await documentTab.locator("..").boundingBox())!;
        const close = (await pane
          .getByRole("button", { name: "Close document.md", exact: true })
          .boundingBox())!;
        expect(activeTab.width).toBeGreaterThanOrEqual(132);
        expect(activeTab.x).toBeGreaterThanOrEqual(strip.x - 0.5);
        expect(activeTab.x + activeTab.width).toBeLessThanOrEqual(
          strip.x + strip.width + 0.5,
        );
        expect(close.width).toBeGreaterThanOrEqual(hasTouch ? 32 : 22);
        expect(close.x + close.width).toBeLessThanOrEqual(
          strip.x + strip.width + 0.5,
        );
        for (const control of await pane.locator(".ctx__header button").all()) {
          if (!(await control.isVisible())) continue;
          const box = (await control.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(header.x - 0.5);
          expect(box.x + box.width).toBeLessThanOrEqual(
            header.x + header.width + 0.5,
          );
          expect(box.y + box.height).toBeLessThanOrEqual(
            header.y + header.height + 0.5,
          );
        }
        expect(
          await pane.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
      }
      const withTabs = (await pane.locator(".ctx__header").boundingBox())!
        .height;
      await pane
        .getByRole("button", { name: "Close document.md", exact: true })
        .click();
      await pane
        .getByRole("button", {
          name: "Close TerminalSettingsDialog.tsx",
          exact: true,
        })
        .click();
      await expect
        .poll(
          async () =>
            (await pane.locator(".ctx__header").boundingBox())!.height,
        )
        .toBeLessThan(withTabs);
    });
  });
}

test("shared terminal rename keeps its label anchor and editor within the tab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const pane = page.locator(".ctx");
  await pane.getByRole("button", { name: "New terminal", exact: true }).click();
  const tab = pane.locator(".ctx__terminal-tabs [role=tab]").first();
  await expect(tab).toBeVisible();
  const id = (await tab.getAttribute("id"))!.slice("terminal-tab-".length);
  try {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(
        page.getByRole(width <= 900 ? "dialog" : "complementary", {
          name: "Context panel",
          exact: true,
        }),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      // Resize changes CSS before React transfers the pane into its drawer.
      await tab.hover();
      const label = (await tab.locator(".terminal-tab__label").boundingBox())!;
      await tab.dblclick();
      const editor = pane.getByRole("textbox", {
        name: "Terminal name",
        exact: true,
      });
      await expect(editor).toBeFocused();
      const geometry = await editor.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const parent = el.closest(".ctx__file-tab")!.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          textLeft:
            box.left +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.paddingLeft),
          contained:
            box.left >= parent.left &&
            box.right <= parent.right &&
            box.top >= parent.top &&
            box.bottom <= parent.bottom,
        };
      });
      expect(geometry.textLeft).toBeCloseTo(label.x, 1);
      expect(geometry.contained).toBe(true);
      await editor.fill("A terminal with a deliberately long readable name");
      if (width === 390) {
        await editor.press("Enter");
        await expect(tab).toHaveAccessibleName(
          "A terminal with a deliberately long readable name",
        );
      } else {
        await editor.press("Escape");
        await expect(tab).toBeVisible();
      }
    }
  } finally {
    const closed = await hostRequest(page).delete(`/api/terminals/${id}`, {
      headers: await terminalMutationHeaders(page),
    });
    expect(closed.ok()).toBe(true);
  }
});
