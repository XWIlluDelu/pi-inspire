import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { attachImage, imageFile, imagePixels } from "./support/images";
import { pairAndOpen } from "./support/navigation";

async function geometry(image: Locator) {
  return image.evaluate((element) => {
    const image = element.getBoundingClientRect();
    const canvas = element.parentElement!.getBoundingClientRect();
    const { naturalWidth, naturalHeight } = element as HTMLImageElement;
    return {
      image: {
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
      },
      canvas: {
        x: canvas.x,
        y: canvas.y,
        width: canvas.width,
        height: canvas.height,
      },
      intrinsic: { width: naturalWidth, height: naturalHeight },
      scale: image.width / naturalWidth,
    };
  });
}

async function fittedImage(image: Locator) {
  const fit = ({ intrinsic, canvas }: Awaited<ReturnType<typeof geometry>>) =>
    Math.min(
      1,
      canvas.width / intrinsic.width,
      canvas.height / intrinsic.height,
    );
  await expect
    .poll(async () => {
      const layout = await geometry(image);
      return Math.abs(layout.scale - fit(layout));
    })
    .toBeLessThan(0.01);
  const layout = await geometry(image);
  const { image: box, intrinsic, canvas } = layout;
  expect(box.height / intrinsic.height).toBeCloseTo(layout.scale, 2);
  expect(box.x + box.width / 2).toBeCloseTo(canvas.x + canvas.width / 2, 0);
  expect(box.y + box.height / 2).toBeCloseTo(canvas.y + canvas.height / 2, 0);
  return layout;
}

async function expectInBounds(image: Locator) {
  await expect
    .poll(async () => {
      const { image: box, canvas } = await geometry(image);
      const axis = (
        start: number,
        length: number,
        frame: number,
        size: number,
      ) =>
        length >= size
          ? start <= frame + 1 && start + length >= frame + size - 1
          : start >= frame - 1 && start + length <= frame + size + 1;
      return (
        axis(box.x, box.width, canvas.x, canvas.width) &&
        axis(box.y, box.height, canvas.y, canvas.height)
      );
    })
    .toBe(true);
}

async function drag(page: Page, canvas: Locator, dx: number, dy: number) {
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + dx,
    box.y + box.height / 2 + dy,
    { steps: 5 },
  );
  await page.mouse.up();
}

test("desktop zoom is anchored, continuous and independent of single clicks; scrolling and keys pan", async ({
  page,
}) => {
  await pairAndOpen(page);
  const { dialog, image } = await attachImage(page, {
    width: 3840,
    height: 2160,
  });
  const canvas = dialog.getByRole("region", { name: "Image canvas" });
  const fit = await fittedImage(image);
  const point = {
    x: fit.canvas.x + fit.canvas.width / 2 - 80,
    y: fit.canvas.y + fit.canvas.height / 2 - 40,
  };
  const source = {
    x: (point.x - fit.image.x) / fit.scale,
    y: (point.y - fit.image.y) / fit.scale,
  };
  await page.mouse.dblclick(point.x, point.y);
  let zoomed = await geometry(image);
  expect(zoomed.scale).toBe(1);
  expect(zoomed.image.x + source.x * zoomed.scale).toBeCloseTo(point.x, 0);
  expect(zoomed.image.y + source.y * zoomed.scale).toBeCloseTo(point.y, 0);

  await page.mouse.click(point.x, point.y);
  expect((await geometry(image)).scale).toBe(1);
  await canvas.press("ArrowRight");
  expect((await geometry(image)).image.x).toBeCloseTo(zoomed.image.x - 60, 0);
  await page.mouse.wheel(25, 70);
  await expect
    .poll(async () => (await geometry(image)).image.y)
    .toBeCloseTo(zoomed.image.y - 70, 0);

  zoomed = await geometry(image);
  const wheelSource = {
    x: (point.x - zoomed.image.x) / zoomed.scale,
    y: (point.y - zoomed.image.y) / zoomed.scale,
  };
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -30);
  await page.keyboard.up("Control");
  await expect
    .poll(async () => (await geometry(image)).scale)
    .toBeGreaterThan(1.2);
  const enlarged = await geometry(image);
  expect(enlarged.image.x + wheelSource.x * enlarged.scale).toBeCloseTo(
    point.x,
    0,
  );
  expect(enlarged.image.y + wheelSource.y * enlarged.scale).toBeCloseTo(
    point.y,
    0,
  );
  expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1);
  const transform = await image.evaluate((el) => el.style.transform);
  await dialog
    .getByRole("combobox", { name: "Image background" })
    .selectOption("White");
  expect(await image.evaluate((el) => el.style.transform)).toBe(transform);
  await canvas.press("0");
  expect((await geometry(image)).scale).toBeCloseTo(fit.scale);
  await canvas.press("1");
  await canvas.press("+");
  await expect(dialog.getByRole("button", { name: "Actual size" })).toHaveText(
    "125%",
  );
});

test("long screenshots reach actual size and stay visible after panning, resize and rotation", async ({
  page,
}) => {
  await pairAndOpen(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog, image } = await attachImage(page, {
    width: 1200,
    height: 8000,
  });
  await dialog.getByRole("button", { name: "Actual size" }).click();
  expect((await geometry(image)).image.width).toBe(1200);
  const canvas = dialog.getByRole("region", { name: "Image canvas" });
  // Keep captured pointer coordinates far beyond the canvas to exercise clamping.
  await drag(page, canvas, 2000, 8000);
  for (const viewport of [
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    await expectInBounds(image);
    expect((await geometry(image)).scale).toBe(1);
  }
  await dialog.getByRole("button", { name: "Fit image to window" }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  expect((await fittedImage(image)).scale).toBeLessThan(0.1);
});

test("gallery navigation keeps one Back entry, original downloads and a fresh fitted view", async ({
  page,
}) => {
  await pairAndOpen(page);
  const first = await imageFile(page, { name: "first.png" });
  const second = await imageFile(page, {
    name: "small.png",
    width: 64,
    height: 64,
  });
  await page.locator('input[type="file"]').setInputFiles([first, second]);
  const opener = page.getByRole("button", { name: "Preview first.png" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Image preview" });
  await expect(
    dialog.getByRole("group", { name: "Image navigation" }),
  ).toContainText("1 / 2");
  await dialog.getByRole("button", { name: "Zoom in" }).click();
  await dialog
    .getByRole("combobox", { name: "Image background" })
    .selectOption("Black");
  await dialog.getByRole("button", { name: "Next image" }).click();
  await expect(dialog.locator("img")).toHaveJSProperty("naturalWidth", 64);
  await expect(dialog.getByRole("button", { name: "Actual size" })).toHaveText(
    "100%",
  );
  await expect(
    dialog.getByRole("combobox", { name: "Image background" }),
  ).toHaveValue("Black");
  const image = dialog.locator("img");
  expect((await fittedImage(image)).image.width).toBe(64);
  await image.dblclick();
  expect((await geometry(image)).image.width).toBe(128);
  await expectInBounds(image);
  await dialog.getByRole("button", { name: "Previous image" }).click();
  const download = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "Download image" }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("first.png");
  expect(await readFile((await saved.path())!)).toEqual(first.buffer);
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(page.getByRole("main")).toBeVisible();
  await opener.click();
  await expect(
    dialog.getByRole("combobox", { name: "Image background" }),
  ).toHaveValue("Checkerboard");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("narrow inspection contains focus, recovers a failed copy, and distinguishes backdrop drag from click", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await pairAndOpen(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.evaluate(() => {
    const write = navigator.clipboard.write.bind(navigator.clipboard);
    let fail = true;
    navigator.clipboard.write = async (items) => {
      if (fail) {
        fail = false;
        throw new DOMException(
          "Clipboard permission denied.",
          "NotAllowedError",
        );
      }
      await write(items);
    };
  });
  const { thumbnail, dialog, image } = await attachImage(page);
  for (const viewport of [
    { width: 740, height: 360 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    const { canvas } = await fittedImage(image);
    expect(canvas.width).toBeGreaterThanOrEqual(viewport.width - 48);
    expect(canvas.height).toBeGreaterThan(viewport.height - 180);
    for (const control of await dialog.locator("button, a, select").all()) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(16);
      expect(box.y).toBeGreaterThanOrEqual(16);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 16);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 16);
    }
  }
  const backgrounds = dialog.getByRole("combobox", {
    name: "Image background",
  });
  const copy = dialog.getByRole("button", { name: "Copy image" });
  await backgrounds.focus();
  await page.keyboard.press("Tab");
  await expect(copy).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(backgrounds).toBeFocused();
  await backgrounds.selectOption("White");
  await copy.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Clipboard permission denied.",
  );
  await expect(
    dialog.getByRole("link", { name: "Download image" }),
  ).toBeVisible();
  await copy.click();
  await expect(
    dialog.getByRole("button", { name: "image copied", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  const copied = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read())[0]!;
    const bitmap = await createImageBitmap(await item.getType("image/png"));
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const alpha = context.getImageData(0, 0, 1, 1).data[3];
    const result = { width: bitmap.width, height: bitmap.height, alpha };
    bitmap.close();
    return result;
  });
  expect(copied).toEqual({ width: 1200, height: 800, alpha: 0 });
  const { canvas } = await geometry(image);
  await page.mouse.move(canvas.x + 5, canvas.y + 5);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 30, canvas.y + 15);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.mouse.click(canvas.x + 5, canvas.y + 5);
  await expect(dialog).toBeHidden();
  await expect(thumbnail).toBeFocused();
});

test("decode errors explain the failure and disable image operations without hiding original download", async ({
  page,
}) => {
  await pairAndOpen(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("not a PNG"),
  });
  await page.getByRole("button", { name: "Preview broken.png" }).click();
  const dialog = page.getByRole("dialog", { name: "Image preview" });
  await expect(dialog.getByRole("status")).toContainText(
    "could not be displayed",
  );
  await expect(dialog.getByRole("button", { name: "Zoom in" })).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Copy image" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("link", { name: "Download image" }),
  ).toHaveAttribute("download", "broken.png");
});

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
  for (const [palette, theme] of [
    ["chimonanthus", "light"],
    ["hydrangea", "dark"],
  ]) {
    await page.evaluate(
      ({ palette, theme }) =>
        Object.assign(document.documentElement.dataset, { palette, theme }),
      { palette, theme },
    );
    for (const name of ["Checkerboard", "White", "Black"]) {
      await backgrounds.selectOption(name);
      const pixels = await imagePixels(page, image);
      if (theme === "light") reference.set(name, pixels);
      else expect(pixels.equals(reference.get(name)!), name).toBe(true);
    }
  }
  expect(reference.get("White")!.equals(reference.get("Black")!)).toBe(false);

  await backgrounds.selectOption("Checkerboard");
  await page.locator(".image-lightbox").evaluate((element) => {
    element.style.backgroundColor = "rgb(0, 255, 0)";
  });
  expect(
    (await imagePixels(page, image)).equals(reference.get("Checkerboard")!),
  ).toBe(true);
  await expect(image).toHaveAttribute("src", source!);
  const audit = await new AxeBuilder({ page })
    .include(".image-lightbox")
    .analyze();
  expect(audit.violations).toEqual([]);
  await dialog.getByRole("button", { name: "Close image preview" }).click();
  const opaque = await attachImage(page, { opaque: true, name: "opaque.png" });
  const original = await imagePixels(page, opaque.image);
  for (const name of ["White", "Black", "Checkerboard"]) {
    await opaque.dialog
      .getByRole("combobox", { name: "Image background" })
      .selectOption(name);
    expect((await imagePixels(page, opaque.image)).equals(original)).toBe(true);
  }
});

test.describe("touch image inspection", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  test("pinch scales the image, not the page; changing finger count and cancellation do not jump or dismiss", async ({
    page,
  }) => {
    await pairAndOpen(page);
    const { dialog, image } = await attachImage(page);
    const before = await geometry(image);
    const cx = before.canvas.x + before.canvas.width / 2;
    const cy = before.canvas.y + before.canvas.height / 2;
    const client = await page.context().newCDPSession(page);
    const point = (id: number, x: number, y: number) => ({
      id,
      x,
      y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    });
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
      touchPoints: ReturnType<typeof point>[],
    ) => client.send("Input.dispatchTouchEvent", { type, touchPoints });
    await touch("touchStart", [point(1, cx - 50, cy), point(2, cx + 50, cy)]);
    await touch("touchMove", [point(1, cx - 90, cy), point(2, cx + 130, cy)]);
    await expect
      .poll(async () => (await geometry(image)).scale)
      .toBeCloseTo(before.scale * 2.2);
    expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1);
    const pinched = await geometry(image);
    expect(pinched.image.x + pinched.image.width / 2).toBeCloseTo(cx + 20, 0);
    await touch("touchEnd", [point(1, cx - 90, cy)]);
    await touch("touchMove", [point(2, cx + 110, cy)]);
    await expect
      .poll(async () => (await geometry(image)).image.x)
      .toBeCloseTo(pinched.image.x - 20, 0);
    expect((await geometry(image)).scale).toBeCloseTo(pinched.scale);
    await touch("touchEnd", []);
    await expect(dialog).toBeVisible();

    await touch("touchStart", [point(3, cx, cy)]);
    await touch("touchMove", [point(3, cx + 35, cy)]);
    await touch("touchCancel", []);
    await page.touchscreen.tap(cx, cy);
    await page.touchscreen.tap(cx, cy);
    await expect
      .poll(async () => (await geometry(image)).scale)
      .toBeCloseTo(before.scale);
    await client.detach();
  });
});
