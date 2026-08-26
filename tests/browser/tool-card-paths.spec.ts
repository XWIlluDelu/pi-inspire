import { expect, type Locator, type Page, test } from "@playwright/test";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resourcePathLabel(path: string): string {
  const escaped = escapeHtml(path);
  return `<span class="resource-path" title="${escaped}">
    <span class="resource-path__visible" aria-hidden="true">${escaped}</span>
    <span class="visually-hidden">${escaped}</span>
  </span>`;
}

function resourceButton(path: string, width?: number): string {
  const style = width ? ` style="width: ${width}px; flex: 0 0 auto"` : "";
  return `<button type="button" class="tool-summary__resource" aria-label="${escapeHtml(path)}"${style}>${resourcePathLabel(path)}</button>`;
}

function summaryCard(path: string, range: string, width?: number): string {
  return `
    <article class="card card--tool">
      <header class="card__header">
        <button type="button" class="card__disclosure">
          <span class="card__chevron">›</span>
          <span class="card__icon">▧</span>
          <span class="card__label card__tool-name">read</span>
          <span class="status-success">✓</span>
        </button>
        <span class="card__summary card__summary--tool">
          <span class="tool-summary__part tool-summary__part--resource">
            ${resourceButton(path, width)}
          </span>
          <span class="tool-summary__part tool-summary__part--subdued">
            <span class="tool-summary__separator"> · </span>
            <span class="tool-summary__subdued">${range}</span>
          </span>
        </span>
        <span class="card__header-spacer"></span>
        <button type="button" class="card__copy icon-button">□</button>
      </header>
    </article>`;
}

async function currentStylesheet(page: Page): Promise<string> {
  await page.goto("/");
  const href = await page
    .locator('link[rel="stylesheet"]')
    .first()
    .getAttribute("href");
  if (!href) throw new Error("The built page has no stylesheet");
  return href;
}

async function setCards(page: Page, cards: string): Promise<void> {
  const stylesheet = await currentStylesheet(page);
  await page.setContent(`
    <!doctype html>
    <html>
      <head><link rel="stylesheet" href="${stylesheet}"></head>
      <body><section style="margin: 16px; display: grid; gap: 10px">${cards}</section></body>
    </html>`);
  await page.evaluate(() => document.fonts.ready);
}

async function pathMetrics(resource: Locator) {
  return resource.evaluate((button) => {
    const path = button.querySelector<HTMLElement>(".resource-path")!;
    const visible = path.querySelector<HTMLElement>(".resource-path__visible")!;
    const style = getComputedStyle(visible);
    return {
      text: visible.textContent,
      title: path.title,
      clientWidth: visible.clientWidth,
      scrollWidth: visible.scrollWidth,
      lines: Math.round(
        visible.getBoundingClientRect().height /
          Number.parseFloat(style.lineHeight),
      ),
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });
}

function expectNativeEllipsis(
  metrics: Awaited<ReturnType<typeof pathMetrics>>,
) {
  expect(metrics.lines).toBe(1);
  expect(metrics.overflow).toBe("hidden");
  expect(metrics.textOverflow).toBe("ellipsis");
  expect(metrics.whiteSpace).toBe("nowrap");
}

test("fitting mobile resource paths remain complete", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 600 });
  const paths = [
    { path: "server/app.ts", range: "L1–40" },
    { path: "src/components/Nav.tsx", range: "L130–319" },
  ];
  await setCards(
    page,
    paths.map(({ path, range }) => summaryCard(path, range)).join(""),
  );

  for (const { path } of paths) {
    const metrics = await pathMetrics(page.getByRole("button", { name: path }));
    expect(metrics.text).toBe(path);
    expect(metrics.title).toBe(path);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    expectNativeEllipsis(metrics);
  }
});

test("constrained paths keep their exact value behind native ellipsis", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 600 });
  const path = "tests/browser/fixtures/file-previews/notebook.ipynb";
  await setCards(page, summaryCard(path, "L1–40", 300));

  const metrics = await pathMetrics(page.getByRole("button", { name: path }));
  expect(metrics.text).toBe(path);
  expect(metrics.title).toBe(path);
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  expectNativeEllipsis(metrics);
});

test("extreme widths still clip one exact path with native ellipsis", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  const path = "src/components/VeryLongResourcePreviewComponent.tsx";
  await setCards(page, summaryCard(path, "L1–40", 90));

  const metrics = await pathMetrics(page.getByRole("button", { name: path }));
  expect(metrics.text).toBe(path);
  expect(metrics.title).toBe(path);
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  expectNativeEllipsis(metrics);
});
