import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const stylesheet = new URL("../../src/styles.css", import.meta.url);

test("a constrained tool path preserves its filename tail above the compact breakpoint", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 300 });
  const css = await readFile(stylesheet, "utf8");
  const path =
    "/home/wangzixiong/others/pi/packages/coding-agent/test/runtime/deferred/tool-card-path-projection/rpc-presentation-retrieval.test.ts";
  const tail = Array.from(path).slice(-14).join("");
  const start = path.slice(0, -tail.length);

  await page.setContent(`
    <style>${css}</style>
    <section class="card card--tool" style="margin: 16px">
      <div class="card__body">
        <div class="tool-block">
          <div class="card__section-label tool-block__heading">
            <span>Applied changes</span>
            <button class="tool-block__path" aria-label="${path}">
              <span class="resource-path">
                <span class="resource-path__full" aria-hidden="true">
                  <span class="resource-path__full-start">${start}</span>
                  <span class="resource-path__full-end"><span>${tail}</span></span>
                </span>
                <span class="resource-path__compact" aria-hidden="true">
                  <span class="resource-path__context">/…/coding-agent/test/</span>
                  <span class="resource-path__name-start">rpc-presentation-re</span>
                  <span class="resource-path__name-end"><span>trieval.test.ts</span></span>
                </span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </section>
  `);

  const metrics = await page.evaluate(() => {
    const path = document.querySelector<HTMLElement>(".tool-block__path")!;
    const full = document.querySelector<HTMLElement>(".resource-path__full")!;
    const compact = document.querySelector<HTMLElement>(
      ".resource-path__compact",
    )!;
    const start = document.querySelector<HTMLElement>(
      ".resource-path__full-start",
    )!;
    const end = document.querySelector<HTMLElement>(
      ".resource-path__full-end",
    )!;
    return {
      fullDisplay: getComputedStyle(full).display,
      compactDisplay: getComputedStyle(compact).display,
      startClientWidth: start.clientWidth,
      startScrollWidth: start.scrollWidth,
      endClientWidth: end.clientWidth,
      endScrollWidth: end.scrollWidth,
      endRight: end.getBoundingClientRect().right,
      pathRight: path.getBoundingClientRect().right,
      endText: end.textContent,
    };
  });

  expect(metrics.fullDisplay).toBe("flex");
  expect(metrics.compactDisplay).toBe("none");
  expect(metrics.startScrollWidth).toBeGreaterThan(metrics.startClientWidth);
  expect(metrics.endText).toBe(tail);
  expect(metrics.endScrollWidth).toBe(metrics.endClientWidth);
  expect(metrics.endRight).toBeLessThanOrEqual(metrics.pathRight + 0.5);
});

test("a short summary path keeps its complete filename without a middle gap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 974, height: 300 });
  const css = await readFile(stylesheet, "utf8");

  await page.setContent(`
    <style>${css}</style>
    <section class="card card--tool" style="margin: 16px">
      <div class="card__header">
        <button class="card__disclosure">
          <span class="card__label"><code class="card__tool-name">read</code></span>
        </button>
        <span class="card__summary card__summary--tool">
          <span class="tool-summary__part tool-summary__part--resource">
            <button class="tool-summary__resource" aria-label="src/styles.css">
              <span class="resource-path">
                <span class="resource-path__full" aria-hidden="true">
                  <span class="resource-path__full-start">src/</span>
                  <span class="resource-path__full-end"><span>styles.css</span></span>
                </span>
                <span class="resource-path__compact" aria-hidden="true">
                  <span class="resource-path__context">src/</span>
                  <span class="resource-path__name-start"></span>
                  <span class="resource-path__name-end"><span>styles.css</span></span>
                </span>
              </span>
            </button>
          </span>
          <span class="tool-summary__part tool-summary__part--subdued">
            <span class="tool-summary__separator"> · </span>
            <span class="tool-summary__subdued">L60–289</span>
          </span>
        </span>
        <span class="card__header-spacer"></span>
      </div>
    </section>
  `);

  const metrics = await page.evaluate(() => {
    const start = document.querySelector<HTMLElement>(
      ".resource-path__full-start",
    )!;
    const end = document.querySelector<HTMLElement>(
      ".resource-path__full-end",
    )!;
    const startText = document.createRange();
    startText.selectNodeContents(start);
    return {
      startClientWidth: start.clientWidth,
      startScrollWidth: start.scrollWidth,
      startTextWidth: startText.getBoundingClientRect().width,
      endClientWidth: end.clientWidth,
      endScrollWidth: end.scrollWidth,
      segmentGap:
        end.getBoundingClientRect().left - start.getBoundingClientRect().right,
    };
  });

  expect(metrics.startScrollWidth).toBe(metrics.startClientWidth);
  expect(
    Math.abs(metrics.startClientWidth - metrics.startTextWidth),
  ).toBeLessThanOrEqual(0.5);
  expect(metrics.endScrollWidth).toBe(metrics.endClientWidth);
  expect(Math.abs(metrics.segmentGap)).toBeLessThanOrEqual(0.5);

  await page.setViewportSize({ width: 390, height: 300 });
  const compactMetrics = await page.evaluate(() => {
    const full = document.querySelector<HTMLElement>(".resource-path__full")!;
    const compact = document.querySelector<HTMLElement>(
      ".resource-path__compact",
    )!;
    const context = compact.querySelector<HTMLElement>(
      ".resource-path__context",
    )!;
    const end = compact.querySelector<HTMLElement>(".resource-path__name-end")!;
    const contextText = document.createRange();
    contextText.selectNodeContents(context);
    return {
      fullDisplay: getComputedStyle(full).display,
      compactDisplay: getComputedStyle(compact).display,
      contextClientWidth: context.clientWidth,
      contextScrollWidth: context.scrollWidth,
      contextTextWidth: contextText.getBoundingClientRect().width,
      endClientWidth: end.clientWidth,
      endScrollWidth: end.scrollWidth,
      segmentGap:
        end.getBoundingClientRect().left -
        context.getBoundingClientRect().right,
    };
  });

  expect(compactMetrics.fullDisplay).toBe("none");
  expect(compactMetrics.compactDisplay).toBe("flex");
  expect(compactMetrics.contextScrollWidth).toBe(
    compactMetrics.contextClientWidth,
  );
  expect(
    Math.abs(
      compactMetrics.contextClientWidth - compactMetrics.contextTextWidth,
    ),
  ).toBeLessThanOrEqual(0.5);
  expect(compactMetrics.endScrollWidth).toBe(compactMetrics.endClientWidth);
  expect(Math.abs(compactMetrics.segmentGap)).toBeLessThanOrEqual(0.5);
});
