import { expect, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

test("PDF paints selectable pages, preserves zoom across resize and never runs document actions", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
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
  const pdfPage = pdf.locator(".pdf-preview__page");
  const textLayer = pdf.locator(".pdf-preview__text-layer");
  await expect(textLayer).toContainText("Experiment summary");
  await expect(pdfPage).toHaveAttribute("aria-busy", "false");
  const ink = await pdf
    .locator("canvas")
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
  await pdf.getByRole("button", { name: "Next PDF page" }).click();
  await expect(textLayer).toContainText("Measurement details");
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
  await page.setViewportSize({ width: 390, height: 620 });
  const scroll = pdf.getByRole("region", { name: "PDF page 2" });
  await expect
    .poll(() =>
      pdf.evaluate((root) => {
        const sheet = root.querySelector<HTMLElement>(".pdf-preview__sheet");
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
  const position = await scroll.evaluate((element) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
    return element.scrollTop;
  });
  expect(position).toBeGreaterThan(0);
  await pdf.getByRole("button", { name: "Zoom in PDF" }).click();
  await expect
    .poll(async () =>
      Math.abs(
        (await scroll.evaluate((element) => element.scrollTop)) -
          position * 1.25,
      ),
    )
    .toBeLessThanOrEqual(1);
  await pdf.getByRole("button", { name: "Fit PDF to width" }).click();
  await expect
    .poll(async () =>
      Math.abs(
        (await scroll.evaluate((element) => element.scrollTop)) - position,
      ),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await scroll.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.setViewportSize(viewport);

  await resources
    .getByRole("button", { name: "unsafe.pdf", exact: true })
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
  await resources.getByRole("button", { name: "Back to file browser" }).click();
  await expect.poll(() => page.workers().length).toBe(0);
});
