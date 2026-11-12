import { expect, test } from "@playwright/test";
import { PALETTE_PREFERENCES } from "../../shared/contracts";
import { PALETTE_LABELS } from "../../src/preference-labels";
import { VISUAL_PREFERENCES_STORAGE_KEY } from "../../src/visual-preferences";
import { renderedColors, resolvedColor } from "./support/colors";
import {
  openCommandPalette,
  openSettings,
  pairAndOpen,
} from "./support/navigation";

test("palette settings stay independent of luminosity from first paint through Host bootstrap", async ({
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
  const html = page.locator("html");
  const savePreference = (field: string) =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/preferences") &&
        response.request().method() === "PATCH" &&
        field in response.request().postDataJSON(),
    );

  await settings.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.setViewportSize({ width: 320, height: 900 });
  for (const palette of PALETTE_PREFERENCES)
    await expect(
      picker.getByRole("button", {
        name: PALETTE_LABELS[palette],
        exact: true,
      }),
    ).toBeVisible();
  expect(
    await picker.evaluate(
      (el) =>
        el.getBoundingClientRect().right <= innerWidth &&
        [...el.querySelectorAll("button"), el].every(
          (item) => item.scrollWidth <= item.clientWidth,
        ),
    ),
  ).toBe(true);

  const wisteria = picker.getByRole("button", {
    name: "Wisteria",
    exact: true,
  });
  const paletteSave = savePreference("palette");
  await wisteria.press("Enter");
  expect(await (await paletteSave).json()).toMatchObject({
    palette: "wisteria",
    theme: "dark",
  });
  await expect(html).toHaveAttribute("data-palette", "wisteria");
  await expect(wisteria).toHaveAttribute("aria-pressed", "true");
  await expect(picker.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(wisteria).toHaveCSS(
    "color",
    await resolvedColor(wisteria, "accent-deep"),
  );
  expect((await renderedColors(wisteria)).contrast).toBeGreaterThanOrEqual(4.5);

  const lightSave = savePreference("theme");
  await settings.getByRole("button", { name: "Light", exact: true }).click();
  expect(await (await lightSave).json()).toMatchObject({
    palette: "wisteria",
    theme: "light",
  });

  await settings.getByRole("button", { name: "Close settings" }).click();
  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("Palette:");
  await expect(
    palette.getByRole("option", { name: /^Palette: Wisteria/ }),
  ).toContainText("current");
  const commandSave = savePreference("palette");
  await palette
    .getByRole("option", { name: /^Palette: Carbon & Silicon/ })
    .click();
  expect((await commandSave).ok()).toBe(true);
  await expect(html).toHaveAttribute("data-palette", "mono");

  const visualCache = () =>
    page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
      VISUAL_PREFERENCES_STORAGE_KEY,
    );
  await expect
    .poll(visualCache)
    .toMatchObject({ palette: "mono", theme: "light" });
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          palette: "hydrangea",
          theme: "dark",
          contentTextSize: "large",
          readingWidth: "wide",
        }),
      ),
    VISUAL_PREFERENCES_STORAGE_KEY,
  );

  let releaseBootstrap!: () => void;
  const bootstrapGate = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  const bootstrapUrl = "**/api/bootstrap**";
  await page.route(bootstrapUrl, async (route) => {
    await bootstrapGate;
    await route.continue();
  });
  try {
    const bootstrap = page.waitForRequest(bootstrapUrl);
    await page.reload({ waitUntil: "domcontentloaded" });
    await bootstrap;
    await expect(html).toHaveAttribute("data-palette", "hydrangea");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(html).toHaveAttribute("data-content-text-size", "large");
    await expect(html).toHaveAttribute("data-reading-width", "wide");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#14171A",
    );
  } finally {
    releaseBootstrap();
  }
  await expect(page.getByRole("main")).toBeVisible();
  await expect(html).toHaveAttribute("data-palette", "mono");
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#F4F5F6",
  );
  await expect
    .poll(visualCache)
    .toMatchObject({ palette: "mono", theme: "light" });
});
