import { expect, test } from "@playwright/test";
import { PALETTE_PREFERENCES } from "../../shared/contracts";
import { PALETTE_LABELS } from "../../src/preference-labels";
import { pairAndOpen } from "./support/navigation";

test("botanical swatches persist independently of luminosity and fit narrow Settings", async ({
  page,
}) => {
  await pairAndOpen(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const picker = settings.getByRole("group", {
    name: "Color palette",
    exact: true,
  });

  for (const theme of ["Light", "Dark"]) {
    await settings.getByRole("button", { name: theme, exact: true }).click();
    for (const palette of PALETTE_PREFERENCES) {
      const choice = picker.getByRole("button", {
        name: PALETTE_LABELS[palette],
        exact: true,
      });
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/preferences") &&
          response.request().method() === "PATCH" &&
          response.request().postDataJSON().palette === palette,
      );
      await choice.click();
      const response = await saved;
      expect(response.ok()).toBe(true);
      expect(await response.json()).toMatchObject({
        palette,
        theme: theme.toLowerCase(),
      });
      await expect(choice).toHaveAttribute("aria-pressed", "true");
      await expect(picker.locator('[aria-pressed="true"]')).toHaveCount(1);
      await expect(page.locator("html")).toHaveAttribute(
        "data-palette",
        palette,
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        theme.toLowerCase(),
      );
    }
  }

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const palette of PALETTE_PREFERENCES) {
      const choice = picker.getByRole("button", {
        name: PALETTE_LABELS[palette],
        exact: true,
      });
      await expect(choice).toBeVisible();
      expect(
        await choice.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    }
    expect(
      await picker.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          bounds.left >= 0 &&
          bounds.right <= innerWidth &&
          element.scrollWidth <= element.clientWidth
        );
      }),
    ).toBe(true);
  }

  await picker.getByRole("button", { name: "Wisteria", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute(
    "data-palette",
    "wisteria",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    picker.getByRole("button", { name: "Wisteria", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-palette",
    "wisteria",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
