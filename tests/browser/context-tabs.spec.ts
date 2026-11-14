import { expect, test } from "@playwright/test";
import { hostRequest } from "./support/host-request";
import {
  openFixtureSession,
  openPreviewFixture,
  openResourceFixture,
  openWorkspaceFile,
  pairedPage,
} from "./support/navigation";
import { terminalOperation } from "./support/terminal-operations";

test.use({ contextOptions: { reducedMotion: "reduce" } });

test("finds an open tab by name and keeps it reachable in the narrow workbench @cross-browser", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 850 });
  const pane = await openResourceFixture(page);
  await openWorkspaceFile(pane, "src/components/TerminalSettingsDialog.tsx");
  await openPreviewFixture(pane, "document.md");
  const documentTab = pane.getByRole("tab", {
    name: "document.md",
    exact: true,
  });
  await expect(documentTab).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 320, height: 850 });
  const dialog = page.getByRole("dialog", {
    name: "Context panel",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Open tabs", exact: true }).click();
  const tabs = page.getByRole("dialog", { name: "Open tabs", exact: true });
  const filter = tabs.getByRole("combobox", { name: "Find open tab" });
  await filter.fill("TerminalSettings");
  await expect(tabs.getByRole("option", { name: /document\.md/ })).toHaveCount(
    0,
  );
  await filter.press("ArrowDown");
  const match = tabs.getByRole("option", { name: /TerminalSettingsDialog/ });
  await expect(filter).toHaveAttribute(
    "aria-activedescendant",
    (await match.getAttribute("id"))!,
  );
  await filter.press("Enter");
  const selected = dialog.getByRole("tab", {
    name: "TerminalSettingsDialog.tsx",
    exact: true,
  });
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(selected).toBeFocused();
  const strip = dialog.locator(".dock-tabs__scroll");
  const active = (await selected.locator("..").boundingBox())!;
  const bounds = (await strip.boundingBox())!;
  expect(active.x).toBeGreaterThanOrEqual(bounds.x - 1);
  expect(active.x + active.width).toBeLessThanOrEqual(
    bounds.x + bounds.width + 1,
  );
  await selected.press("ArrowRight");
  await expect(documentTab).toHaveAttribute("aria-selected", "true");
});

test("shared terminal tabs reactivate the same shell and keep rename editing in the tab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const pane = page.locator(".ctx");
  await pane.getByRole("button", { name: "New terminal", exact: true }).click();
  const tab = pane.locator('[role=tab][data-dock-tab^="terminal:"]').first();
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
    await pane.getByRole("button", { name: "Open tabs", exact: true }).click();
    const openTabs = page.getByRole("dialog", {
      name: "Open tabs",
      exact: true,
    });
    const terminalLabel = (await tab.getAttribute("aria-label"))!;
    await openTabs
      .getByRole("combobox", { name: "Find open tab" })
      .fill(terminalLabel);
    await openTabs
      .getByRole("option", { name: terminalLabel, exact: false })
      .click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
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
      const label = (await tab.locator(".dock-tab__label").boundingBox())!;
      await tab.dblclick();
      const editor = pane.getByRole("textbox", {
        name: "Terminal name",
        exact: true,
      });
      await expect(editor).toBeFocused();
      const geometry = await editor.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const parent = el.closest(".dock-tab")!.getBoundingClientRect();
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
    const closed = await terminalOperation(page, {
      command: "remove",
      params: { id, force: false },
    });
    expect(closed.ok()).toBe(true);
  }
});

test("@cross-browser Files search retains compact type and usable controls across widths", async ({
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
