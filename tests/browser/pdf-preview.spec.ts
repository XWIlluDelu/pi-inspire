import { expect, test } from "@playwright/test";
import { openPreviewFixture, openResourceFixture } from "./support/navigation";

test("PDF scrolls continuously through selectable pages, preserves its reading point and never runs actions", async ({
  page,
}) => {
  const resources = await openResourceFixture(page);
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
  await openPreviewFixture(resources, "report.pdf");
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
  const actions = page.getByRole("toolbar", { name: "File actions" });
  const showActions = actions.getByRole("button", {
    name: "Show file actions",
  });
  if (await showActions.isVisible()) await showActions.click();
  const hideActions = actions.getByRole("button", {
    name: "Hide file actions",
  });
  await expect(hideActions).toBeVisible();
  const zoom = pdf.getByRole("button", { name: "Zoom in PDF" });
  const top = (await zoom.boundingBox())!.y;
  await zoom.click();
  await expect(
    pdf.getByRole("button", { name: "Fit PDF to width" }),
  ).toHaveText("125%");
  expect((await zoom.boundingBox())!.y).toBeCloseTo(top, 1);
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

  await pdf.getByRole("button", { name: "Find in PDF" }).click();
  const find = pdf.getByRole("search", { name: "Find in PDF" });
  const query = find.getByRole("searchbox", { name: "Find in PDF" });
  await query.fill(" sAmPlE ");
  await expect(find.getByText("1 / 4", { exact: true })).toBeVisible();
  await expect(first.locator(".pdf-preview__hit")).toContainText("Sample A");
  await query.press("Shift+Enter");
  await expect(find.getByText("4 / 4", { exact: true })).toBeVisible();
  await expect(pdfPage.locator(".pdf-preview__hit")).toContainText(
    "per sample",
  );
  await query.press("Escape");
  await expect(find).toHaveCount(0);
  await expect(pdf.locator(".pdf-preview__hit")).toHaveCount(0);

  await openPreviewFixture(resources, "unsafe.pdf");
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
