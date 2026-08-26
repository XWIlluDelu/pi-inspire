import { expect, type Locator, type Page, test } from "@playwright/test";
import { resourcePathCandidates } from "../../src/components/ResourcePathLabel.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resourcePathLabel(path: string): string {
  const candidates = escapeHtml(JSON.stringify(resourcePathCandidates(path)));
  return `<span class="resource-path" data-candidates="${candidates}" aria-hidden="true">
    <span class="resource-path__visible">${escapeHtml(path)}</span>
    <span class="resource-path__measure" aria-hidden="true"></span>
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

async function fitResourcePaths(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Array.from(document.styleSheets).some((sheet) =>
      Array.from(sheet.cssRules).some(
        (rule) =>
          rule instanceof CSSStyleRule &&
          rule.selectorText === ".resource-path__measure",
      ),
    ),
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const root of document.querySelectorAll<HTMLElement>(
      ".resource-path",
    )) {
      const visible = root.querySelector<HTMLElement>(
        ".resource-path__visible",
      )!;
      const measure = root.querySelector<HTMLElement>(
        ".resource-path__measure",
      )!;
      const candidates = JSON.parse(root.dataset.candidates!) as string[];
      let selected = candidates.at(-1)!;
      for (const candidate of candidates) {
        measure.textContent = candidate;
        if (measure.scrollWidth <= root.clientWidth) {
          selected = candidate;
          break;
        }
      }
      measure.textContent = "";
      visible.textContent = selected;
    }
  });
}

async function setCards(page: Page, cards: string): Promise<void> {
  const stylesheet = await currentStylesheet(page);
  await page.setContent(`
    <!doctype html>
    <html>
      <head><link rel="stylesheet" href="${stylesheet}"></head>
      <body><section style="margin: 16px; display: grid; gap: 10px">${cards}</section></body>
    </html>`);
  await fitResourcePaths(page);
}

async function pathMetrics(resource: Locator) {
  return resource.evaluate((button) => {
    const path = button.querySelector<HTMLElement>(".resource-path")!;
    const visible = path.querySelector<HTMLElement>(".resource-path__visible")!;
    const text = document.createRange();
    text.selectNodeContents(visible);
    return {
      text: visible.textContent,
      clientWidth: path.clientWidth,
      textWidth: text.getBoundingClientRect().width,
      lines: Math.round(
        visible.getBoundingClientRect().height /
          Number.parseFloat(getComputedStyle(visible).lineHeight),
      ),
    };
  });
}

function expectFits(metrics: Awaited<ReturnType<typeof pathMetrics>>) {
  expect(metrics.textWidth).toBeLessThanOrEqual(metrics.clientWidth + 0.5);
  expect(metrics.lines).toBe(1);
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
    expectFits(metrics);
  }
});

test("constrained paths preserve informative hierarchy before the filename", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 600 });
  const path = "tests/browser/fixtures/file-previews/notebook.ipynb";
  await setCards(page, summaryCard(path, "L1–40", 300));

  const metrics = await pathMetrics(page.getByRole("button", { name: path }));
  expect(metrics.text).toBe("…/file-previews/notebook.ipynb");
  expectFits(metrics);
});

test("extreme widths elide the filename without losing its extension", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  const path = "src/components/VeryLongResourcePreviewComponent.tsx";
  await setCards(page, summaryCard(path, "L1–40", 90));

  const metrics = await pathMetrics(page.getByRole("button", { name: path }));
  expect(metrics.text).toContain("…");
  expect(metrics.text).toMatch(/\.tsx$/);
  expectFits(metrics);
});
