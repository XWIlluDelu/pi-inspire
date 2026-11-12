import { expect, test } from "@playwright/test";
import { hostRequest } from "./support/host-request";
import {
  openFixtureSession,
  openPreviewFixture,
  openResourceFixture,
  openWorkspaceFile,
  pairedPage,
} from "./support/navigation";
import { terminalMutationHeaders } from "./support/terminal-operations";

test.use({ contextOptions: { reducedMotion: "reduce" } });

test("@cross-browser keeps tab focus as a context tab moves through overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 850 });
  await page.addInitScript(() =>
    localStorage.setItem("inspire.ctx-width", "680"),
  );
  const pane = await openResourceFixture(page);
  await openWorkspaceFile(pane, "src/components/TerminalSettingsDialog.tsx");
  await openPreviewFixture(pane, "document.md");
  const selected = pane.getByRole("tab", { name: "document.md", exact: true });
  const closeOther = pane.getByRole("button", {
    name: "Close TerminalSettingsDialog.tsx",
    exact: true,
  });
  const overflow = pane.getByRole("combobox", {
    name: "More tabs",
    exact: true,
  });
  await selected.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(closeOther).toBeFocused();

  await page.setViewportSize({ width: 901, height: 850 });
  await expect(closeOther).toBeHidden();
  await expect(overflow).toBeFocused();
  await expect(selected).toHaveAttribute("aria-selected", "true");

  await page.setViewportSize({ width: 1500, height: 850 });
  await expect(overflow).toBeHidden();
  await expect(closeOther).toBeVisible();
  await expect(selected).toBeFocused();
});

for (const hasTouch of [false, true]) {
  test.describe(`shared file tabs · ${hasTouch ? "touch" : "mouse"}`, () => {
    test.use({ hasTouch });
    test("fit a single long label and retain navigation through overflow", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.route("**/api/git/status**", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        if (body.kind === "repository") body.total = 123;
        await route.fulfill({ response, json: body });
      });
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

      await openWorkspaceFile(
        pane,
        "src/components/TerminalSettingsDialog.tsx",
      );
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

      await openPreviewFixture(pane, "document.md");
      const documentTab = pane.getByRole("tab", {
        name: "document.md",
        exact: true,
      });
      await expect(documentTab).toHaveAttribute("aria-selected", "true");
      await expect(documentTab).toBeVisible();
      await expect(pane.locator(".ctx__mode-count")).toHaveText("99+");
      const desktopFile = (await documentTab.locator("..").boundingBox())!;
      const desktopStrip = (await pane
        .locator(".ctx__file-tabs")
        .boundingBox())!;
      expect(desktopFile.x + desktopFile.width).toBeLessThanOrEqual(
        desktopStrip.x + desktopStrip.width + 0.5,
      );
      await pane.getByRole("tab", { name: "Files", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 900 });
      await expect(pane).toHaveAttribute("role", "dialog");
      await expect(longTab).toBeVisible();
      const more = pane.getByRole("combobox", {
        name: "More tabs",
        exact: true,
      });
      await more.click();
      await page.getByRole("option", { name: /^document\.md(?:\s|$)/ }).click();
      await expect(documentTab).toBeVisible();
      await expect(documentTab).toHaveAttribute("aria-selected", "true");

      // Exercise the narrowest drawer with the larger touch controls, and the
      // adjacent compact layout with fine-pointer controls.
      await page.setViewportSize({ width: hasTouch ? 320 : 361, height: 900 });
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
      await page.unrouteAll({ behavior: "wait" });
    });
  });
}

test("shared terminal tabs reactivate the same shell and keep rename editing in the tab", async ({
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
    const catalogIds = async () => {
      const response = await hostRequest(page).get("/api/terminals");
      expect(response.ok()).toBe(true);
      return (await response.json()).terminals.map(
        ({ id }: { id: string }) => id,
      );
    };
    const originalIds = await catalogIds();
    await pane.getByRole("tab", { name: "Files", exact: true }).click();
    await openWorkspaceFile(pane, "README.md");
    const file = pane.getByRole("tab", { name: "README.md", exact: true });
    await expect(file).toHaveAttribute("aria-selected", "true");
    await expect(tab).toHaveAttribute("aria-selected", "false");
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await tab.press("Home");
    await expect(file).toBeFocused();
    await tab.click();
    expect(await catalogIds()).toEqual(originalIds);
    await pane
      .getByRole("button", { name: "Close README.md", exact: true })
      .click();

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
      const title = "测量终端 with a deliberately long readable name";
      await editor.fill(title);
      if (width === 390) {
        for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
          for (const key of ["Enter", "Escape"])
            await editor.dispatchEvent("keydown", { key, ...ime });
          await expect(editor).toHaveValue(title);
        }
        await editor.press("Enter");
        await expect(tab).toHaveAccessibleName(title);
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

test("@cross-browser Files and History searches retain compact type and usable controls across widths", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Calibration history fixture/,
    "fixture-calibration-history",
  );
  const toggle = page.getByRole("button", {
    name: "Toggle resources panel",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [tab, name, query, clearLabel] of [
      ["Files", "Search workspace files", "README", "Clear workspace search"],
      ["History", "Find in history", "calibration", "Clear history search"],
    ]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      const input = page.getByRole("searchbox", { name, exact: true });
      const field = input.locator("..");
      await expect(input).toBeVisible();
      await expect(input).toHaveCSS("font-size", "12.5px");
      expect(
        await input.evaluate(
          (el) => getComputedStyle(el, "::placeholder").fontSize,
        ),
      ).toBe("12.5px");
      await expect(field).toHaveCSS("height", width <= 900 ? "40px" : "34px");
      const icon = field.locator(".search-field__icon svg").first();
      await expect(icon).toHaveCSS("width", "13px");
      await expect(icon).toHaveCSS("height", "13px");

      await input.fill(query);
      await expect(input).toBeFocused();
      const clear = field.getByRole("button", {
        name: clearLabel,
        exact: true,
      });
      await expect(clear).toBeInViewport();
      await clear.click();
      await expect(input).toHaveValue("");
      await expect(input).toBeFocused();
      await expect(clear).toHaveCount(0);
    }
  }
});
