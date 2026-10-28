import { expect, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

test("Recent disclosure survives F5 and a visit to a session", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await pairedPage(page);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page
    .getByRole("button", { name: "Collapse navigation", exact: true })
    .click();
  const recent = page.getByRole("button", {
    name: "Recent sessions",
    exact: true,
  });
  await expect(recent).toHaveAttribute("aria-expanded", "true");
  await recent.click();
  await page.reload({ waitUntil: "commit" });
  await expect(recent).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".welcome__recent [role=list]")).toHaveCount(0);

  await openMockSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page
    .getByRole("button", { name: "Collapse navigation", exact: true })
    .click();
  await expect(recent).toHaveAttribute("aria-expanded", "false");
  await recent.click();
  await page.reload({ waitUntil: "commit" });
  await expect(recent).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".welcome__recent [role=list]")).toBeVisible();
});
