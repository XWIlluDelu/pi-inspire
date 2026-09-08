import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

async function pair(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill("inspire-browser-test-token");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("main")).toBeVisible();
  await page
    .locator(".nav__row-main")
    .filter({ hasText: "Review extension event lifecycle" })
    .click();
  await expect(page.locator(".topbar__title-button")).toHaveText(
    "Review extension event lifecycle",
  );
  await expect(page.locator('input[type="file"]')).toBeEnabled();
}

async function imagePixels(page: Page, image: Locator) {
  await image.evaluate(async (element) => {
    await document.fonts.ready;
    await Promise.all(
      element
        .closest(".overlay")!
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  const box = (await image.boundingBox())!;
  // Exclude fractional boundary pixels that also cover the surrounding scrim.
  return page.screenshot({
    clip: {
      x: Math.ceil(box.x) + 1,
      y: Math.ceil(box.y) + 1,
      width: Math.floor(box.width) - 3,
      height: Math.floor(box.height) - 3,
    },
  });
}

async function attachImage(
  page: Page,
  opaque = false,
  dimensions = { width: 1200, height: 800 },
) {
  // A real PNG with transparent, half-alpha, black, and white regions. Generate
  // it in memory so the test exercises upload/preview without fixture artifacts.
  const png = await page.evaluate(
    ({ opaque, dimensions }) => {
      const canvas = document.createElement("canvas");
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext("2d")!;
      context.scale(dimensions.width / 1200, dimensions.height / 800);
      if (opaque) {
        context.fillStyle = "#4080c0";
        context.fillRect(0, 0, 1200, 800);
      }
      context.fillStyle = "rgba(255, 0, 0, 0.5)";
      context.fillRect(400, 0, 400, 800);
      context.fillStyle = "black";
      context.fillRect(800, 0, 400, 400);
      context.fillStyle = "white";
      context.fillRect(800, 400, 400, 400);
      return canvas.toDataURL("image/png").split(",")[1]!;
    },
    { opaque, dimensions },
  );
  await page
    .locator('input[type="file"][aria-label="Attach files"]')
    .setInputFiles({
      name: opaque ? "opaque.png" : "alpha.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
  const thumbnail = page.getByRole("button", {
    name: "Preview attached image",
  });
  await expect(thumbnail).toBeVisible();
  await thumbnail.click();
  const dialog = page.getByRole("dialog", { name: "Image preview" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("img")).toHaveJSProperty(
    "naturalWidth",
    dimensions.width,
  );
  return { thumbnail, dialog, image: dialog.locator("img") };
}

for (const theme of ["light", "dark"]) {
  for (const palette of ["amber", "jade"]) {
    test(`image backgrounds isolate alpha in ${palette} ${theme}`, async ({
      page,
    }) => {
      await pair(page);
      await page.evaluate(
        ({ theme, palette }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.palette = palette;
        },
        { theme, palette },
      );
      const { dialog, image } = await attachImage(page);
      const backgrounds = dialog.getByRole("group", {
        name: "Image background",
      });
      await expect(
        backgrounds.getByRole("button", { name: "Checkerboard" }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(image).toHaveCSS("background-color", "rgb(238, 238, 238)");
      await expect(image).not.toHaveCSS("background-image", "none");
      await expect(page.locator(".image-lightbox")).toHaveCSS(
        "backdrop-filter",
        "blur(2px)",
      );
      // Compare against the real shared overlay rule, not a source-code regex.
      const standardBackdrop = await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.className = "overlay";
        document.body.append(overlay);
        const color = getComputedStyle(overlay).backgroundColor;
        overlay.remove();
        return color;
      });
      await expect(page.locator(".image-lightbox")).toHaveCSS(
        "background-color",
        standardBackdrop,
      );

      // Controls follow the shell theme; inspection colors deliberately do not.
      const tokens = await dialog.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          surface: style.getPropertyValue("--bg-raised").trim(),
          ink: style.getPropertyValue("--ink").trim(),
        };
      });
      const normalized = await page.evaluate((tokens) => {
        const element = document.createElement("div");
        document.body.append(element);
        element.style.color = tokens.surface;
        const surface = getComputedStyle(element).color;
        element.style.color = tokens.ink;
        const ink = getComputedStyle(element).color;
        element.remove();
        return { surface, ink };
      }, tokens);
      const close = dialog.getByRole("button", { name: "Close image preview" });
      await expect(close).toHaveCSS("background-color", normalized.surface);
      await expect(close).toHaveCSS("color", normalized.ink);
      await expect(backgrounds).toHaveCSS(
        "background-color",
        normalized.surface,
      );
      await expect(backgrounds.locator('[aria-pressed="true"]')).toHaveCSS(
        "background-color",
        normalized.ink,
      );
      const checkerboard = await imagePixels(page, image);
      await page.screenshot({
        path: test.info().outputPath(`${palette}-${theme}.png`),
      });
      // Shell content must not bleed through any alpha pixel.
      await page.locator(".image-lightbox").evaluate((element) => {
        element.style.backgroundColor = "rgb(0, 255, 0)";
      });
      expect((await imagePixels(page, image)).equals(checkerboard)).toBe(true);
      await backgrounds
        .getByRole("button", { name: "White", exact: true })
        .click();
      await expect(image).toHaveCSS("background-image", "none");
      await expect(image).toHaveCSS("background-color", "rgb(255, 255, 255)");
      const white = await imagePixels(page, image);
      await backgrounds
        .getByRole("button", { name: "Black", exact: true })
        .click();
      await expect(image).toHaveCSS("background-color", "rgb(0, 0, 0)");
      expect((await imagePixels(page, image)).equals(white)).toBe(false);
      await expect(
        dialog.getByRole("button", { name: "Zoom image" }),
      ).toHaveAttribute("aria-pressed", "false");
      await expect(dialog).toBeVisible();
      const audit = await new AxeBuilder({ page })
        .include(".image-lightbox")
        .analyze();
      expect(audit.violations).toEqual([]);
    });
  }
}

test("settings header meets its body without inherited dialog spacing", async ({
  page,
}) => {
  await pair(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.locator(".settings__layout")).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(dialog).toHaveCSS("row-gap", "0px");
    const gap = await dialog.evaluate((element) => {
      const header = element
        .querySelector(".settings__header")!
        .getBoundingClientRect();
      const body = element
        .querySelector(".settings__layout")!
        .getBoundingClientRect();
      return body.top - header.bottom;
    });
    expect(gap).toBeCloseTo(0, 1);
  }
});

test("opaque images are unchanged by inspection backgrounds", async ({
  page,
}) => {
  await pair(page);
  const { dialog, image } = await attachImage(page, true);
  const original = await imagePixels(page, image);
  for (const name of ["White", "Black", "Checkerboard"]) {
    await dialog.getByRole("button", { name, exact: true }).click();
    expect((await imagePixels(page, image)).equals(original)).toBe(true);
  }
});

test("narrow image controls preserve zoom, pan, focus, and dismissal", async ({
  page,
}) => {
  await pair(page);
  await page.setViewportSize({ width: 320, height: 640 });
  const { thumbnail, dialog, image } = await attachImage(page);
  for (const button of await dialog
    .locator(".image-lightbox__backgrounds button, .image-lightbox__close")
    .all()) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
  const canvas = dialog.locator(".image-lightbox__canvas");
  await canvas.click();
  await expect(canvas).toHaveAttribute("aria-pressed", "true");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2);
  await expect(canvas).toHaveClass(/--panning/);
  await page.mouse.up();
  await expect(canvas).toHaveAttribute("aria-pressed", "true");
  const transform = await image.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await dialog.getByRole("button", { name: "White", exact: true }).click();
  await expect(image).toHaveCSS("transform", transform);
  await canvas.focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Checkerboard" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).toBeFocused();
  const close = dialog.getByRole("button", { name: "Close image preview" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Black", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(thumbnail).toBeFocused();
  await thumbnail.click();
  await expect(
    dialog.getByRole("button", { name: "Checkerboard" }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Close image preview" }).click();
  await expect(dialog).not.toBeVisible();
  await thumbnail.click();
  await page.locator(".image-lightbox").click({ position: { x: 2, y: 2 } });
  await expect(dialog).not.toBeVisible();
});

for (const scenario of [
  {
    name: "wide screenshot",
    viewport: { width: 2560, height: 1300 },
    image: { width: 1008, height: 484 },
  },
  {
    name: "phone",
    viewport: { width: 320, height: 640 },
    image: { width: 1200, height: 800 },
  },
  {
    name: "portrait",
    viewport: { width: 1280, height: 800 },
    image: { width: 800, height: 1600 },
  },
  {
    name: "landscape phone",
    viewport: { width: 740, height: 360 },
    image: { width: 1200, height: 800 },
  },
  {
    name: "small image",
    viewport: { width: 1280, height: 800 },
    image: { width: 64, height: 64 },
  },
]) {
  test(`image layout stays centered and grouped: ${scenario.name}`, async ({
    page,
  }) => {
    await pair(page);
    await page.setViewportSize(scenario.viewport);
    const { dialog, image } = await attachImage(page, false, scenario.image);
    await imagePixels(page, image);
    const imageBox = (await image.boundingBox())!;
    const backgrounds = (await dialog
      .getByRole("group", { name: "Image background" })
      .boundingBox())!;
    const close = (await dialog
      .getByRole("button", { name: "Close image preview" })
      .boundingBox())!;
    const dialogBox = (await dialog.boundingBox())!;
    expect(imageBox.x + imageBox.width / 2).toBeCloseTo(
      scenario.viewport.width / 2,
      0,
    );
    expect(
      Math.abs(imageBox.y + imageBox.height / 2 - scenario.viewport.height / 2),
    ).toBeLessThanOrEqual(4);
    expect(imageBox.width / imageBox.height).toBeCloseTo(
      scenario.image.width / scenario.image.height,
      2,
    );
    expect(backgrounds.y - imageBox.y - imageBox.height).toBeCloseTo(12, 0);
    expect(imageBox.y - close.y - close.height).toBeCloseTo(12, 0);
    expect(backgrounds.x + backgrounds.width / 2).toBeCloseTo(
      scenario.viewport.width / 2,
      0,
    );
    expect(close.x + close.width).toBeCloseTo(dialogBox.x + dialogBox.width, 0);
    for (const box of [imageBox, backgrounds, close]) {
      expect(box.x).toBeGreaterThanOrEqual(16);
      expect(box.y).toBeGreaterThanOrEqual(16);
      expect(box.x + box.width).toBeLessThanOrEqual(
        scenario.viewport.width - 16,
      );
      expect(box.y + box.height).toBeLessThanOrEqual(
        scenario.viewport.height - 16,
      );
    }
    await page.screenshot({ path: test.info().outputPath("layout.png") });
  });
}
