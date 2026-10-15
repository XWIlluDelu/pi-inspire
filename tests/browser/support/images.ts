import { expect, type Locator, type Page } from "@playwright/test";

export async function imageFile(
  page: Page,
  { width = 1200, height = 800, opaque = false, name = "alpha.png" } = {},
) {
  // Real raster bytes; transparent, half-alpha, black and white regions exercise
  // decoding, intrinsic geometry and compositing without binary fixtures.
  const png = await page.evaluate(
    ({ width, height, opaque }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.scale(width / 1200, height / 800);
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
    { width, height, opaque },
  );
  return { name, mimeType: "image/png", buffer: Buffer.from(png, "base64") };
}

export async function attachImage(
  page: Page,
  options: Parameters<typeof imageFile>[1] = {},
) {
  const file = await imageFile(page, options);
  await page
    .locator('input[type="file"][aria-label="Attach files"]')
    .setInputFiles(file);
  const thumbnail = page.getByRole("button", {
    name: `Preview ${file.name}`,
    exact: true,
  });
  await expect(thumbnail).toBeVisible();
  await thumbnail.click();
  const dialog = page.getByRole("dialog", { name: "Image preview" });
  const image = dialog.locator("img");
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty("naturalWidth", options.width ?? 1200);
  return { thumbnail, dialog, image, file };
}

export async function imagePixels(page: Page, image: Locator) {
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
  return page.screenshot({
    clip: {
      x: Math.ceil(box.x) + 1,
      y: Math.ceil(box.y) + 1,
      width: Math.floor(box.width) - 3,
      height: Math.floor(box.height) - 3,
    },
  });
}
