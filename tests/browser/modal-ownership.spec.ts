import { expect, type Locator, test } from "@playwright/test";
import { routeSnapshots } from "./support/host-events";
import { completeOperation } from "./support/host-operations";
import {
  openCommandPalette,
  openSettings,
  pairAndOpen,
} from "./support/navigation";

test("Escape closes the focused workbench surface before aborting an active run", async ({
  page,
}) => {
  const sessionId = "fixture-history";
  const transport = await routeSnapshots(page, {
    snapshot(snapshot) {
      if (snapshot.active?.sessionId !== sessionId) return;
      snapshot.active.isStreaming = true;
      snapshot.active.stats = {
        contextUsage: { tokens: 180, contextWindow: 1_000, percent: 18 },
      };
      snapshot.sessionStatuses[sessionId] = { runState: "running" };
    },
    event(event) {
      if (event.sessionId === sessionId && event.sessionStatus)
        event.sessionStatus.runState = "running";
    },
  });
  let aborts = 0;
  await page.route("**/api/control/abort", (route) => {
    aborts++;
    return completeOperation(route, "abort", { steering: [], followUp: [] });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await pairAndOpen(page);
  await expect.poll(() => transport.ready(sessionId)).toBe(true);
  await expect(
    page.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();

  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await page.keyboard.press("Control+k");
  await expect(palette).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await openCommandPalette(page);
  const filter = palette.getByRole("combobox");
  expect(await composingEscape(filter)).toBe(true);
  await expect(palette).toBeVisible();
  await palette
    .getByRole("option", { name: "New session", exact: true })
    .press("Escape");
  await expect(palette).toHaveCount(0);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  const hint = page.getByRole("tooltip");
  await draft.fill("/com");
  await expect(page.getByRole("option", { name: /\/compact/ })).toBeVisible();
  const meter = page.getByRole("button", { name: /^Session & usage, context/ });
  await meter.hover();
  await expect(hint).toContainText("18%");
  await draft.press("Escape");
  await expect(page.getByRole("option", { name: /\/compact/ })).toHaveCount(0);
  await meter.focus();
  expect(await composingEscape(draft)).toBe(true);
  await expect(hint).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hint).toHaveCount(0);
  await draft.fill("");

  expect(aborts).toBe(0);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .press("Escape");
  await expect.poll(() => aborts).toBe(1);
});

function composingEscape(field: Locator) {
  return field.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

test.describe("phone action dialogs", () => {
  test.use({ viewport: { width: 390, height: 600 }, hasTouch: true });
  test("consumes Back and explicit close for rename, palette and export", async ({
    page,
  }) => {
    await pairAndOpen(page);
    const inspireUrl = page.url();
    const entryKey = () => page.evaluate(() => window.navigation.currentEntry!.key);
    const workspaceEntry = await entryKey();
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    await draft.fill("Keep this unfinished input");
    const title = page.getByRole("button", { name: /^Session actions:/ });
    const openExport = async () => {
      await title.click();
      await page
        .getByRole("menuitem", { name: "Export session…", exact: true })
        .click();
    };
    const palette = await openCommandPalette(page);
    const filter = palette.getByRole("combobox", { name: "Filter commands" });
    await expect(palette).toBeFocused();
    await palette.press("ArrowDown");
    await expect(filter).toHaveAttribute("aria-activedescendant", /.+/);
    await filter.fill("rename");
    const name = page.getByRole("textbox", { name: "Session name" });
    await palette.getByRole("option", { name: /Rename session/ }).tap();
    await expect(name).toBeFocused();
    await page.goBack();
    await expect(name).toHaveCount(0);
    await expect(filter).toHaveValue("rename");
    await expect(palette).toBeFocused();
    const exportDialog = page.getByRole("dialog", {
      name: "Export session",
      exact: true,
    });
    const depth = () =>
      page.evaluate(() => history.state?.__inspireWorkbench?.depth ?? 0);
    for (const [dialog, open] of [
      [palette, () => openCommandPalette(page)],
      [exportDialog, openExport],
    ] as const) {
      if (dialog === exportDialog) await open();
      await expect(dialog).toBeVisible();
      await expect.poll(depth).toBe(1);
      await page.goBack();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(inspireUrl);
      await open();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect.poll(depth).toBe(0);
      await expect.poll(entryKey).toBe(workspaceEntry);
      await expect(draft).toHaveValue("Keep this unfinished input");
    }
  });
});

test("Settings keeps modal ownership when the workspace becomes a drawer @cross-browser", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairAndOpen(page);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await expect(
    page.getByRole("complementary", { name: "Context panel" }),
  ).toBeVisible();
  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  const system = dialog.getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "System", exact: true });
  await system.press("Enter");
  const content = dialog.locator(".settings__content");
  const position = await content.evaluate((el) => (el.scrollTop = 8, el.scrollTop));
  const background = page.getByRole("button", { name: "Toggle resources panel" });
  await background.evaluate((element) => element.focus());
  await expect(dialog.locator(":focus")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 760 });
  await expect(system).toHaveAttribute("aria-current", "location");
  if (position) await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBe(position);
  const close = dialog.getByRole("button", { name: "Close settings" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.locator(":focus")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const drawer = page.getByRole("dialog", { name: "Context panel" });
  await expect(drawer).toBeVisible();
  const files = drawer.getByRole("tab", { name: "Files", exact: true });
  await files.focus();
  await expect(files).toBeFocused();
  await files.press("Escape");
  await expect(drawer).toBeHidden();
});
