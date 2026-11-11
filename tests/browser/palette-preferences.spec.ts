import { expect, test } from "@playwright/test";
import { PALETTE_PREFERENCES } from "../../shared/contracts";
import { PALETTE_LABELS } from "../../src/preference-labels";
import { renderedColors, resolvedColor } from "./support/colors";
import {
  openCommandPalette,
  openSettings,
  pairAndOpen,
} from "./support/navigation";

test("botanical swatches persist independently of luminosity and fit narrow Settings", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairAndOpen(page);
  await openSettings(page);
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
      await expect(choice).toHaveCSS(
        "color",
        await resolvedColor(choice, "accent-deep"),
      );
      expect((await renderedColors(choice)).contrast).toBeGreaterThanOrEqual(
        4.5,
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
  await settings.getByRole("button", { name: "Close settings" }).click();
  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("Palette:");
  for (const choice of PALETTE_PREFERENCES)
    await expect(
      palette.getByRole("option", {
        name: new RegExp(`^Palette: ${PALETTE_LABELS[choice]}`),
      }),
    ).toBeVisible();
  await expect(
    palette.getByRole("option", { name: /^Palette: Wisteria/ }),
  ).toContainText("current");
  const paletteSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/preferences") &&
      response.request().method() === "PATCH" &&
      response.request().postDataJSON().palette === "mono",
  );
  await palette
    .getByRole("option", { name: /^Palette: Carbon & Silicon/ })
    .click();
  expect((await paletteSaved).ok()).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "mono");
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "mono");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
