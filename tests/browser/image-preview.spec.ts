import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type {
  PalettePreference,
  ThemePreference,
} from "../../shared/contracts";
import { attachImage, imagePixels } from "./support/images";
import { pairAndOpen } from "./support/navigation";

test("inspection backgrounds isolate alpha and preserve image pixels across themes", async ({
  page,
}) => {
  await pairAndOpen(page);
  const { dialog, image } = await attachImage(page);
  const source = await image.getAttribute("src");
  const backgrounds = dialog.getByRole("combobox", {
    name: "Image background",
  });
  await expect(backgrounds).toHaveValue("Checkerboard");
  const reference = new Map<string, Buffer>();

  for (const palette of [
    "chimonanthus",
    "hydrangea",
  ] satisfies PalettePreference[]) {
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
          await backgrounds.selectOption(name);
          if (name === "Checkerboard")
            await expect(image).not.toHaveCSS("background-image", "none");
          else {
            await expect(image).toHaveCSS("background-image", "none");
            await expect(image).toHaveCSS(
              "background-color",
              name === "White" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
            );
          }
          const pixels = await imagePixels(page, image);
          const original = reference.get(name);
          if (original)
            expect(
              pixels.equals(original),
              `${name} pixels changed with theme`,
            ).toBe(true);
          else reference.set(name, pixels);
          await page.locator(".image-lightbox").evaluate((element) => {
            element.style.backgroundColor = "rgb(0, 255, 0)";
          });
          expect(
            (await imagePixels(page, image)).equals(pixels),
            "scrim bled into image",
          ).toBe(true);
          await page
            .locator(".image-lightbox")
            .evaluate((element) =>
              element.style.removeProperty("background-color"),
            );
        }
        await expect(image).toHaveAttribute("src", source!);
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
  await pairAndOpen(page);
  const { dialog, image } = await attachImage(page, { opaque: true });
  const original = await imagePixels(page, image);
  for (const name of ["White", "Black", "Checkerboard"]) {
    await dialog
      .getByRole("combobox", { name: "Image background" })
      .selectOption(name);
    expect((await imagePixels(page, image)).equals(original)).toBe(true);
  }
});

for (const scenario of [
  {
    name: "wide desktop",
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
  {
    name: "panorama",
    viewport: { width: 390, height: 844 },
    image: { width: 6000, height: 600 },
  },
]) {
  test(`viewport fits the image and leaves controls usable: ${scenario.name}`, async ({
    page,
  }) => {
    await pairAndOpen(page);
    await page.setViewportSize(scenario.viewport);
    const { dialog, image } = await attachImage(page, scenario.image);
    const canvas = dialog.getByRole("region", { name: "Image canvas" });
    const imageBox = (await image.boundingBox())!;
    const canvasBox = (await canvas.boundingBox())!;
    expect(imageBox.x + imageBox.width / 2).toBeCloseTo(
      canvasBox.x + canvasBox.width / 2,
      0,
    );
    expect(imageBox.y + imageBox.height / 2).toBeCloseTo(
      canvasBox.y + canvasBox.height / 2,
      0,
    );
    expect(imageBox.width / imageBox.height).toBeCloseTo(
      scenario.image.width / scenario.image.height,
      2,
    );
    expect(imageBox.width).toBeLessThanOrEqual(scenario.image.width + 1);
    expect(canvasBox.width).toBeGreaterThanOrEqual(
      scenario.viewport.width - 48,
    );
    expect(canvasBox.height).toBeGreaterThan(scenario.viewport.height - 180);
    for (const control of await dialog.locator("button, a, select").all()) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
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
