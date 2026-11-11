import { expect, test } from "@playwright/test";
import { openFixtureSession, pairedPage } from "./support/navigation";

test("PDF scrolls continuously through selectable pages, preserves its reading point and never runs actions", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(page, /Resource virtualization and sandbox fixture/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const resources = page.getByRole("complementary", { name: "Context panel" });
  const localOrigin = new URL(page.url()).origin;
  const externalRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const external =
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin !== localOrigin;
    if (external) {
      externalRequests.push(url.href);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const activePdfContent: string[] = [];
  page.on("dialog", async (dialog) => {
    activePdfContent.push(dialog.message());
    await dialog.dismiss();
  });
  page.on("popup", async (popup) => {
    activePdfContent.push(popup.url());
    await popup.close();
  });
  await resources
    .getByRole("searchbox", { name: "Search workspace files" })
    .fill("file-previews/report.pdf");
  await resources
    .locator(
      '[data-workspace-path="tests/browser/fixtures/file-previews/report.pdf"]',
    )
    .click();
  const pdf = page.getByRole("document", { name: "Preview report.pdf" });
  const first = pdf.getByRole("region", { name: "PDF page 1", exact: true });
  const pdfPage = pdf.getByRole("region", { name: "PDF page 2", exact: true });
  const textLayer = pdfPage.locator(".pdf-preview__text-layer");
  const scroll = pdf.getByRole("region", { name: "PDF pages", exact: true });
  await expect(first).toContainText("Experiment summary");
  await expect(first).toHaveAttribute("aria-busy", "false");
  await expect(
    resources.getByRole("button", { name: "Download report.pdf" }),
  ).toBeEnabled();
  const ink = await pdf
    .locator("canvas")
    .first()
    .evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          pixels[i + 3]! > 0 &&
          Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) < 200
        )
          count++;
      return count;
    });
  expect(ink).toBeGreaterThan(150);
  // Crossing a page boundary uses the same vertical reader, without a toolbar click.
  await scroll.hover();
  await page.mouse.wheel(0, 700);
  await expect(pdf.locator(".pdf-preview__page-number")).toHaveText("2 / 2");
  await expect(textLayer).toContainText("Measurement details");
  await pdf.getByRole("button", { name: "Previous PDF page" }).click();
  await expect(pdf.locator(".pdf-preview__page-number")).toHaveText("1 / 2");
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBeLessThanOrEqual(13);
  await pdf.getByRole("button", { name: "Next PDF page" }).click();
  await expect(pdf.locator(".pdf-preview__page-number")).toHaveText("2 / 2");
  await expect
    .poll(() =>
      pdfPage.evaluate((element) => {
        const viewport = element
          .closest(".pdf-preview__scroll")!
          .getBoundingClientRect();
        const page = element.getBoundingClientRect();
        return page.height > viewport.height
          ? Math.abs(page.top - viewport.top) < 1
          : page.top >= viewport.top - 1 && page.bottom <= viewport.bottom + 1;
      }),
    )
    .toBe(true);
  await expect(pdfPage).toHaveAttribute("aria-busy", "false");
  await expect(
    pdf.getByRole("button", { name: "Next PDF page" }),
  ).toBeDisabled();
  const selection = await textLayer.evaluate((layer) => {
    const range = document.createRange();
    range.selectNodeContents(layer);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(selection).toContain("Report page 2 - selectable text");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 480 });
  await expect
    .poll(() =>
      pdf.evaluate((root) => {
        const sheet = root.querySelector<HTMLElement>(
          '[aria-label="PDF page 2"] .pdf-preview__sheet',
        );
        const scroll = root.querySelector<HTMLElement>(".pdf-preview__scroll");
        return (
          sheet &&
          !sheet.hidden &&
          scroll &&
          Math.abs(
            sheet.getBoundingClientRect().width - (scroll.clientWidth - 24),
          ) < 1
        );
      }),
    )
    .toBe(true);
  const readingPoint = () =>
    pdfPage.evaluate((element) => {
      const scroll = element.closest(".pdf-preview__scroll")!;
      const page = element.getBoundingClientRect();
      return (scroll.getBoundingClientRect().top - page.top) / page.height;
    });
  await scroll.evaluate((element) => {
    element.scrollTop += 50;
  });
  await expect.poll(readingPoint).toBeGreaterThan(0.05);
  const position = await readingPoint();
  await pdf.getByRole("button", { name: "Zoom in PDF" }).click();
  await expect
    .poll(async () => Math.abs((await readingPoint()) - position))
    .toBeLessThanOrEqual(0.005);
  await pdf.getByRole("button", { name: "Fit PDF to width" }).click();
  await expect
    .poll(async () => Math.abs((await readingPoint()) - position))
    .toBeLessThanOrEqual(0.005);
  expect(
    await scroll.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.setViewportSize(viewport);

  await resources.getByRole("tab", { name: "Files", exact: true }).click();
  await resources
    .getByRole("searchbox", { name: "Search workspace files" })
    .fill("file-previews/unsafe.pdf");
  await resources
    .locator(
      '[data-workspace-path="tests/browser/fixtures/file-previews/unsafe.pdf"]',
    )
    .click();
  const staticPdf = page.getByRole("document", { name: "Preview unsafe.pdf" });
  await expect(staticPdf.locator(".pdf-preview__page")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(staticPdf).toContainText("Static safety fixture");
  await expect(staticPdf.locator("a, form, iframe, object, embed")).toHaveCount(
    0,
  );
  expect(activePdfContent).toEqual([]);
  expect(externalRequests).toEqual([]);
  await resources.getByRole("tab", { name: "Files", exact: true }).click();
  await expect.poll(() => page.workers().length).toBe(0);
});
