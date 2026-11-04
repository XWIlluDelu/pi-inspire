import { expect, type Page } from "@playwright/test";

export const browserTestToken = "inspire-browser-test-token";

export async function pairedPage(page: Page) {
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
