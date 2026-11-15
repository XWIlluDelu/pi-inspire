import { expect, test } from "@playwright/test";
import { preferenceChoices } from "../../src/preference-labels";
import { VISUAL_PREFERENCES_STORAGE_KEY } from "../../src/visual-preferences";
import {
  openCommandPalette,
  openSettings,
  pairAndOpen,
} from "./support/navigation";
import { renderedColors, resolvedColor } from "./support/colors";

test("palette settings stay independent of luminosity from first paint through Host bootstrap", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const picker = settings.getByRole("combobox", {
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

  const theme = settings.getByRole("combobox", { name: "Theme", exact: true });
  await theme.click();
  await settings.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.setViewportSize({ width: 320, height: 900 });
  await expect(picker).toBeInViewport();
  await picker.click();
  for (const { label } of preferenceChoices.palette.options)
    await expect(
      settings.getByRole("option", { name: label, exact: true }),
    ).toBeVisible();
  const paletteSave = savePreference("palette");
  await settings.getByRole("option", { name: "Wisteria", exact: true }).click();
  expect(await (await paletteSave).json()).toMatchObject({
    preferences: { palette: "wisteria", theme: "dark" },
  });
  await expect(html).toHaveAttribute("data-palette", "wisteria");
  await expect(picker).toContainText("Wisteria");

  const lightSave = savePreference("theme");
  await theme.click();
  await settings.getByRole("option", { name: "Light", exact: true }).click();
  expect(await (await lightSave).json()).toMatchObject({
    preferences: { palette: "wisteria", theme: "light" },
  });

  await settings.getByRole("button", { name: "Close settings" }).click();
  const resources = page.getByRole("button", {
    name: "Toggle resources panel",
  });
  if ((await resources.getAttribute("aria-expanded")) === "false")
    await resources.click();
  const files = page.getByRole("tab", { name: "Files", exact: true });
  await files.click();
  await page.keyboard.press("Tab");
  await files.focus();
  await expect(files).toHaveCSS(
    "outline-color",
    await resolvedColor(files, "accent-focus"),
  );
  expect((await renderedColors(files)).contrast).toBeGreaterThanOrEqual(4.5);
  await page.getByRole("button", { name: "Close context pane" }).click();
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
