import { expect, test } from "@playwright/test";
import {
  openFixtureSession,
  openPreviewFixture,
  openResourceFixture,
  openWorkspaceFile,
  pairedPage,
} from "./support/navigation";
import { terminalOperation } from "./support/terminal-operations";

test.use({ contextOptions: { reducedMotion: "reduce" } });

test("finds overflowed tabs and keeps them reachable in the narrow workbench", async ({
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
  await dialog.getByRole("button", { name: "More tabs", exact: true }).click();
  const tabs = page.getByRole("dialog", { name: "More tabs", exact: true });
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
  await dialog.getByRole("button", { name: "More tabs", exact: true }).click();
  await page
    .getByRole("dialog", { name: "More tabs", exact: true })
    .getByRole("option", { name: /document\.md/ })
    .click();
  await expect(documentTab).toHaveAttribute("aria-selected", "true");
});

test("terminal tab rename keeps its input through IME composition", async ({
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
    await page.setViewportSize({ width: 320, height: 900 });
    const drawer = page.getByRole("dialog", { name: "Context panel" });
    await expect(drawer).toBeVisible();
    await tab.dblclick();
    const editor = drawer.getByRole("textbox", { name: "Terminal name" });
    await expect(editor).toBeFocused();
    const title = "测量终端 with a deliberately long readable name";
    await editor.fill(title);
    await editor.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await editor.dispatchEvent("keydown", { key: "Escape", keyCode: 229 });
    await expect(editor).toHaveValue(title);
    await editor.press("Enter");
    await expect(tab).toHaveAccessibleName(title);
    await tab.dblclick();
    await editor.fill("Cancelled name");
    await editor.press("Escape");
    await expect(tab).toHaveAccessibleName(title);
  } finally {
    const closed = await terminalOperation(page, {
      command: "remove",
      params: { id, force: false },
    });
    expect(closed.ok()).toBe(true);
  }
});
