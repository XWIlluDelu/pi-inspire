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
    name: "Toggle navigation",
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
