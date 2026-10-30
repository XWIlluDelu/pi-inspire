import { expect, type Page } from "@playwright/test";

export const browserTestToken = "inspire-browser-test-token";

export async function pairedPage(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill(browserTestToken);
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("main")).toBeVisible();
}

export async function openMockSession(page: Page, title: RegExp) {
  const toggle = page.getByRole("button", {
    name: /^(Toggle|Expand|Collapse) navigation$/,
    exact: true,
  });
  if (
    (await toggle.getAttribute("aria-expanded")) === "false" ||
    (await page.locator(".nav--rail").count())
  )
    await toggle.click();
  await page.locator(".nav__row-main").filter({ hasText: title }).click();
  await expect(page.locator(".topbar__title-button")).toHaveText(title);
}

export async function pairAndOpen(page: Page) {
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
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
