import { expect, type Locator, type Page, test } from "@playwright/test";
import { hostRequest } from "./support/host-request";
import {
  openPreviewFixture,
  openResourceFixture,
  openSettings,
} from "./support/navigation";
import {
  FIRST_TEXT_BASELINE_TOLERANCE_PX,
  firstTextBaseline,
} from "./support/text-baseline";

test.use({
  serviceWorkers: "block",
  contextOptions: { reducedMotion: "reduce" },
});

async function readingSize(page: Page, name: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("button", { name: "Display", exact: true }).click();
  await dialog
    .getByRole("group", { name: "Content text size", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
  await dialog.press("Escape");
  await page.evaluate(() => document.fonts.ready);
}

async function expectNotebookGutter(preview: Locator) {
  await expect
    .poll(() => preview.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBe(0);
  const rows = preview
    .locator(".notebook-preview__cell--code, .notebook-preview__output")
    .filter({ has: preview.page().locator("pre") });
  const positions: number[] = [];
  for (const row of await rows.all()) {
    const prompt = row.locator(":scope > .notebook-preview__prompt");
    const body = row.locator(
      ":scope > .notebook-preview__cell-body, :scope > .notebook-preview__output-body",
    );
    const { left, right, clipped } = await prompt.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return {
        left: text.left - box.left,
        right: box.right - text.right,
        clipped: element.scrollWidth - element.clientWidth,
      };
    });
    expect(left).toBeGreaterThanOrEqual(-0.5);
    expect(right).toBeGreaterThanOrEqual(-0.5);
    expect(clipped).toBe(0);
    positions.push((await body.boundingBox())!.x);
    const relativeTo =
      ".notebook-preview__cell--code, .notebook-preview__output";
    const promptBaseline = await prompt.evaluate(firstTextBaseline, relativeTo);
    const sourceBaseline = await body
      .locator(":scope > pre")
      .evaluate(firstTextBaseline, relativeTo);
    expect(promptBaseline).not.toBeNull();
    expect(sourceBaseline).not.toBeNull();
    expect(Math.abs(promptBaseline! - sourceBaseline!)).toBeLessThanOrEqual(
      FIRST_TEXT_BASELINE_TOLERANCE_PX,
    );
  }
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(
    0.5,
  );
}

async function expectChangeGutter(pane: Locator) {
  const rows = [
    pane.locator(".source-diff__line--context:has(code:not(:empty))").first(),
    pane.locator(".source-diff__line--add").first(),
    pane.locator(".source-diff__line--delete").first(),
  ];
  for (const row of rows) {
    const relativeTo = ".source-diff__line";
    const source = await row
      .locator("code")
      .evaluate(firstTextBaseline, relativeTo);
    expect(source).not.toBeNull();
    const baselines: number[] = [];
    for (const label of await row
      .locator(".source-diff__number, .source-diff__mark")
      .all()) {
      const baseline = await label.evaluate(firstTextBaseline, relativeTo);
      if (baseline !== null) baselines.push(baseline);
    }
    expect(baselines).toHaveLength(2);
    for (const baseline of baselines)
      expect(Math.abs(source! - baseline)).toBeLessThanOrEqual(
        FIRST_TEXT_BASELINE_TOLERANCE_PX,
      );
  }
}

test("Notebook and Changes gutters stay aligned as the shared reading size changes", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const pane = await openResourceFixture(page);
  const host = hostRequest(page);
  const before = await (await host.get("/api/preferences")).json();
  const changes = pane.getByRole("tab", { name: "Changes", exact: true });
  const preview = pane.getByRole("document", {
    name: "Notebook preview",
    exact: true,
  });
  try {
    await openPreviewFixture(pane, "notebook.ipynb");
    await expect(
      preview
        .locator(".notebook-preview__prompt")
        .filter({ hasText: "123456789012345" }),
    ).toHaveText(["In [123456789012345]", "Out [123456789012345]"]);
    await changes.click();
    await pane.getByRole("button", { name: /page\.html, modified/ }).click();
    async function showFile(name: string) {
      const tab = pane.getByRole("tab", { name, exact: true });
      if (await tab.isVisible()) await tab.click();
      else {
        await pane
          .getByRole("combobox", { name: "More tabs", exact: true })
          .click();
        await page.getByRole("option", { name }).click();
      }
    }
    for (const size of ["Compact", "Comfortable", "Large"]) {
      await readingSize(page, size);
      if (size === "Large")
        await page.setViewportSize({ width: 320, height: 900 });
      await expectChangeGutter(pane);
      await showFile("notebook.ipynb");
      await expectNotebookGutter(preview);
      if (size !== "Large") await showFile("page.html");
    }
  } finally {
    await host.patch("/api/preferences", {
      data: { contentTextSize: before.contentTextSize },
    });
  }
});
