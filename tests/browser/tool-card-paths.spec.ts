import { expect, type Locator, type Page, test } from "@playwright/test";
import { projectResourcePath } from "../../src/components/ResourcePathLabel.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resourcePathLabel(path: string): string {
  const projection = projectResourcePath(path);
  return `<span class="resource-path" aria-hidden="true">${
    projection.leading
      ? `<span class="resource-path__leading">${escapeHtml(projection.leading)}</span>`
      : ""
  }${
    projection.tail
      ? `<span class="resource-path__tail"><span>${escapeHtml(projection.tail)}</span></span>`
      : ""
  }</span>`;
}

function resourceButton(path: string): string {
  return `<button type="button" class="tool-summary__resource" aria-label="${escapeHtml(path)}">${resourcePathLabel(path)}</button>`;
}

function summaryCard(path: string, range: string): string {
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
            ${resourceButton(path)}
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

async function waitForResourcePathStyles(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Array.from(document.styleSheets).some((sheet) =>
      Array.from(sheet.cssRules).some(
        (rule) =>
          rule instanceof CSSStyleRule &&
          rule.selectorText === ".resource-path__leading",
      ),
    ),
  );
}

async function setCards(page: Page, cards: string): Promise<void> {
  const stylesheet = await currentStylesheet(page);
  await page.setContent(`
    <!doctype html>
    <html>
      <head><link rel="stylesheet" href="${stylesheet}"></head>
      <body><section style="margin: 16px; display: grid; gap: 10px">${cards}</section></body>
    </html>`);
  await waitForResourcePathStyles(page);
}

async function pathMetrics(resource: Locator) {
  return resource.evaluate((button) => {
    const path = button.querySelector<HTMLElement>(".resource-path")!;
    const leading = path.querySelector<HTMLElement>(".resource-path__leading")!;
    const tail = path.querySelector<HTMLElement>(".resource-path__tail")!;
    const leadingText = document.createRange();
    leadingText.selectNodeContents(leading);
    const tailText = document.createRange();
    tailText.selectNodeContents(tail);
    const pathBox = path.getBoundingClientRect();
    const leadingBox = leading.getBoundingClientRect();
    const tailBox = tail.getBoundingClientRect();
    return {
      text: path.textContent,
      leadingClientWidth: leading.clientWidth,
      leadingScrollWidth: leading.scrollWidth,
      leadingTextWidth: leadingText.getBoundingClientRect().width,
      tailClientWidth: tail.clientWidth,
      tailScrollWidth: tail.scrollWidth,
      tailTextWidth: tailText.getBoundingClientRect().width,
      tailText: tail.textContent,
      segmentGap: tailBox.left - leadingBox.right,
      trailingGap: pathBox.right - tailBox.right,
    };
  });
}

function expectContiguous(metrics: Awaited<ReturnType<typeof pathMetrics>>) {
  expect(Math.abs(metrics.segmentGap)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(metrics.trailingGap)).toBeLessThanOrEqual(0.5);
  expect(metrics.tailScrollWidth).toBe(metrics.tailClientWidth);
  expect(metrics.tailTextWidth).toBeLessThanOrEqual(
    metrics.tailClientWidth + 0.5,
  );
}

test("fitting mobile resource paths remain complete and contiguous", async ({
  page,
}) => {
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
    expect(metrics.leadingScrollWidth).toBe(metrics.leadingClientWidth);
    expect(metrics.leadingTextWidth).toBeLessThanOrEqual(
      metrics.leadingClientWidth + 0.5,
    );
    expectContiguous(metrics);
  }
});

test("constrained mobile resource paths preserve one adjacent filename tail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  const paths = [
    {
      path: "src/components/Nav.tsx",
      range: "L130–319",
      tail: "Nav.tsx",
    },
    {
      path: "tests/server/project-files.test.ts",
      range: "L1–92",
      tail: "-files.test.ts",
    },
  ];
  await setCards(
    page,
    paths.map(({ path, range }) => summaryCard(path, range)).join(""),
  );

  for (const { path, tail } of paths) {
    const metrics = await pathMetrics(page.getByRole("button", { name: path }));
    expect(metrics.text).toBe(path);
    expect(metrics.leadingScrollWidth).toBeGreaterThan(
      metrics.leadingClientWidth,
    );
    expect(metrics.tailText).toBe(tail);
    expectContiguous(metrics);
  }
});

test("expanded resource paths keep the filename tail at intermediate widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 500 });
  const path =
    "/home/wangzixiong/others/pi/packages/coding-agent/test/rpc-presentation-retrieval.test.ts";
  const stylesheet = await currentStylesheet(page);
  await page.setContent(`
    <!doctype html>
    <html>
      <head><link rel="stylesheet" href="${stylesheet}"></head>
      <body>
        <article class="card card--tool" style="margin: 16px">
          <div class="card__body card__body--tool">
            <div class="tool-presentation">
              <section class="tool-block">
                <h4 class="tool-block__heading">
                  <span>Requested file</span>
                  <button type="button" class="tool-block__path" aria-label="${path}">
                    ${resourcePathLabel(path)}
                  </button>
                </h4>
              </section>
            </div>
          </div>
        </article>
      </body>
    </html>`);
  await waitForResourcePathStyles(page);

  const metrics = await pathMetrics(page.getByRole("button", { name: path }));
  expect(metrics.text).toBe(path);
  expect(metrics.leadingScrollWidth).toBeGreaterThan(
    metrics.leadingClientWidth,
  );
  expect(metrics.tailText).toBe("rieval.test.ts");
  expectContiguous(metrics);
});
