import { expect, type Locator, type Page } from "@playwright/test";

export const browserTestToken = "inspire-browser-test-token";

/** Restore an API-created fixture into this tab's explicit selection. */
export async function reloadSession(page: Page, sessionId: string) {
  await page.evaluate((sessionId) => {
    sessionStorage.setItem(
      "inspire:workbench:v1:last-session",
      JSON.stringify({ sessionId }),
    );
  }, sessionId);
  await page.reload();
}

export async function pairedPage(page: Page) {
  // A fresh test tab owns an explicit Welcome selection, not another tab\'s last Host selection.
  await page.addInitScript(() => {
    const key = "inspire:workbench:v1:last-session";
    if (sessionStorage.getItem(key) === null)
      sessionStorage.setItem(key, JSON.stringify({ sessionId: null }));
  });
  await page.goto("/");
  await page.getByLabel("Access token").fill(browserTestToken);
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("main")).toBeVisible();
}

export async function openFixtureSession(
  page: Page,
  title: RegExp,
  sessionId?: string,
) {
  const toggle = page.getByRole("button", {
    name: /^(Toggle|Expand|Collapse) navigation$/,
    exact: true,
  });
  if (
    (await toggle.getAttribute("aria-expanded")) === "false" ||
    (await page.locator(".nav--rail").count())
  )
    await toggle.click();
  const row = sessionId
    ? page.locator(`[data-session-id="${sessionId}"] .nav__row-main`)
    : page.locator(".nav__row-main").filter({ hasText: title });
  // Native creations can page an older sample out of Recent. Use real search
  // to locate that identity, then leave the next interaction an unfiltered nav.
  const searched = sessionId !== undefined && (await row.count()) === 0;
  const search = page.getByRole("searchbox", {
    name: "Search sessions",
    exact: true,
  });
  if (searched) await search.fill(title.source);
  await row.click();
  await expect(page.locator(".topbar__title-button")).toHaveText(title);
  if (searched) {
    const reopen = page.getByRole("button", {
      name: "Toggle navigation",
      exact: true,
    });
    const narrow = await reopen.isVisible();
    if (narrow) await reopen.click();
    await search.fill("");
    if (narrow)
      await page
        .getByRole("button", { name: "Close navigation", exact: true })
        .click();
  }
}

export async function pairAndOpen(page: Page) {
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
}

async function openContextPane(page: Page) {
  const toggle = page.getByRole("button", {
    name: "Toggle resources panel",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  const pane = page.locator(".ctx");
  await expect(pane).toBeVisible();
  return pane;
}

export async function openHistoryPane(page: Page) {
  const pane = await openContextPane(page);
  await pane.getByRole("tab", { name: "History", exact: true }).click();
  const history = pane.getByRole("region", { name: "Conversation history" });
  await expect(history).toBeVisible();
  return history;
}

export async function openResourceFixture(page: Page) {
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Resource virtualization and sandbox fixture/,
    "fixture-resources",
  );
  return openContextPane(page);
}

export async function openWorkspaceFile(pane: Locator, workspacePath: string) {
  const search = pane.getByRole("searchbox", {
    name: "Search workspace files",
  });
  if (!(await search.isVisible()))
    await pane.getByRole("tab", { name: "Files", exact: true }).click();
  await search.fill(workspacePath);
  await pane
    .locator(`[data-workspace-path=${JSON.stringify(workspacePath)}]`)
    .click();
}

export async function openPreviewFixture(pane: Locator, name: string) {
  await openWorkspaceFile(pane, `tests/browser/fixtures/file-previews/${name}`);
}

export async function openCommandPalette(page: Page) {
  const trigger = page.getByRole("button", {
    name: "Open command palette",
    exact: true,
  });
  await trigger.click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  return palette;
}

/** Open an existing shell without the top-bar New terminal creation action. */
export async function openProjectTerminal(page: Page) {
  const existing = page.locator(".ctx__terminal-tabs [role=tab]").first();
  if (await existing.count()) {
    await existing.click();
    return;
  }
  // Empty and failed catalogs still expose the existing palette entry.
  // A narrow drawer owns focus and suppresses global shortcuts; leave it
  // before opening the palette, whose command reopens the terminal surface.
  const close = page.getByRole("button", {
    name: "Close context pane",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("Open Terminal");
  await palette.getByRole("option", { name: /^Open Terminal$/ }).click();
}

export async function showTerminalControls(page: Page) {
  const toggle = page.getByRole("button", {
    name: "Show terminal controls",
    exact: true,
  });
  if (await toggle.isVisible()) await toggle.click();
}

/** Opens Settings from the header, or from the navigation drawer on narrow layouts. */
export async function openSettings(page: Page) {
  // Decide from the viewport, not the header's current DOM: a resize just
  // before this call may still be unmounting the header control.
  if (page.viewportSize()!.width > 900) {
    await page
      .locator(".topbar")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    return;
  }
  const drawer = page
    .locator(".nav")
    .getByRole("button", { name: "Settings", exact: true });
  if (!(await drawer.isVisible()))
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .click();
  await drawer.click();
}

/** Use persistent desktop search or open the local narrow tool row. */
export async function openConversationSearch(page: Page) {
  const input = page.getByRole("searchbox", {
    name: "Search conversation",
    exact: true,
  });
  if (!(await input.isVisible()))
    await page
      .getByRole("button", { name: "Open conversation search", exact: true })
      .click();
  await expect(input).toBeVisible();
  await input.focus();
  return input;
}
