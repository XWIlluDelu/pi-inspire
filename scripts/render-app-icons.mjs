// Rasterize the checked-in SVG masters without adding an image-tool dependency.
// Requires the project's Playwright Chromium: npx playwright install chromium.
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [master, output, size] of [
    ["app-icon.svg", "app-icon-192.png", 192],
    ["app-icon.svg", "app-icon-512.png", 512],
    ["app-icon-maskable.svg", "app-icon-maskable-512.png", 512],
    ["app-icon-maskable.svg", "apple-touch-icon.png", 180],
  ]) {
    const svg = await readFile(
      new URL(`../public/${master}`, import.meta.url),
      "utf8",
    );
    const png = await page.evaluate(
      async ({ svg, size }) => {
        const image = new Image();
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, size, size);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      { svg, size },
    );
    await writeFile(
      new URL(`../public/${output}`, import.meta.url),
      Buffer.from(png, "base64"),
    );
    console.log(`${output}: ${size}×${size} from ${master}`);
  }
} finally {
  await browser.close();
}
