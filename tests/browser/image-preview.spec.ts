import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type {
  PalettePreference,
  ThemePreference,
} from "../../shared/contracts";
import { pairedPage } from "./support/navigation";

async function pair(page: Page) {
  await pairedPage(page);
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

test("inspection backgrounds isolate alpha and preserve image pixels across themes", async ({
  page,
}) => {
  await pair(page);
  const { dialog, image } = await attachImage(page);
  const source = await image.getAttribute("src");
  const backgrounds = dialog.getByRole("group", { name: "Image background" });
  await expect(
    backgrounds.getByRole("button", { name: "Checkerboard" }),
  ).toHaveAttribute("aria-pressed", "true");
  const reference = new Map<string, Buffer>();

  for (const palette of ["chimonanthus", "hydrangea"] satisfies PalettePreference[]) {
    for (const theme of ["light", "dark"] satisfies ThemePreference[]) {
      await test.step(`${palette}/${theme}: inspection pixels do not inherit the shell`, async () => {
        await page.evaluate(
          ({ palette, theme }) => {
            document.documentElement.dataset.palette = palette;
            document.documentElement.dataset.theme = theme;
          },
          { palette, theme },
        );

        for (const name of ["Checkerboard", "White", "Black"]) {
          const choice = backgrounds.getByRole("button", { name, exact: true });
          await choice.click();
          await expect(choice).toHaveAttribute("aria-pressed", "true");
          if (name === "Checkerboard") {
            await expect(image).not.toHaveCSS("background-image", "none");
          } else {
            await expect(image).toHaveCSS("background-image", "none");
            await expect(image).toHaveCSS(
              "background-color",
              name === "White" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
            );
          }
          const pixels = await imagePixels(page, image);
          const original = reference.get(name);
          if (original) {
            expect(
              pixels.equals(original),
              `${name} pixels changed with the theme`,
            ).toBe(true);
          } else {
            reference.set(name, pixels);
          }

          // A changed scrim must not show through transparent or half-alpha pixels.
          await page.locator(".image-lightbox").evaluate((element) => {
            element.style.backgroundColor = "rgb(0, 255, 0)";
          });
          expect(
            (await imagePixels(page, image)).equals(pixels),
            `${name} let the scrim bleed into the image`,
          ).toBe(true);
          await page.locator(".image-lightbox").evaluate((element) => {
            element.style.removeProperty("background-color");
          });
        }

        await expect(image).toHaveAttribute("src", source!);
        await expect(
          dialog.getByRole("button", { name: "Zoom image" }),
        ).toHaveAttribute("aria-pressed", "false");
        const audit = await new AxeBuilder({ page })
          .include(".image-lightbox")
          .analyze();
        expect(audit.violations).toEqual([]);
      });
    }
  }
  expect(reference.get("White")!.equals(reference.get("Black")!)).toBe(false);
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
    .locator(
      ".image-lightbox__backgrounds button, .image-lightbox__actions button",
    )
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
  const copy = dialog.getByRole("button", { name: "Copy image" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(copy).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Black", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(copy).toBeFocused();
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
    const actions = (await dialog
      .getByRole("group", { name: "Image actions" })
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
    expect(imageBox.y - actions.y - actions.height).toBeCloseTo(12, 0);
    expect(backgrounds.x + backgrounds.width / 2).toBeCloseTo(
      scenario.viewport.width / 2,
      0,
    );
    expect(actions.x + actions.width).toBeCloseTo(
      dialogBox.x + dialogBox.width,
      0,
    );
    for (const box of [imageBox, backgrounds, actions]) {
      expect(box.x).toBeGreaterThanOrEqual(16);
      expect(box.y).toBeGreaterThanOrEqual(16);
      expect(box.x + box.width).toBeLessThanOrEqual(
        scenario.viewport.width - 16,
      );
      expect(box.y + box.height).toBeLessThanOrEqual(
        scenario.viewport.height - 16,
      );
    }
  });
}
