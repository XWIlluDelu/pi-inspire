import { expect, type Locator, test } from "@playwright/test";
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
import { textOverflowsInlineBounds } from "./support/text-bounds";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

async function expectFirstLine(
  row: Locator,
  rowSelector: string,
  source: string,
  labels: string,
  count: number,
) {
  const baseline = await row
    .locator(source)
    .evaluate(firstTextBaseline, rowSelector);
  expect(baseline).not.toBeNull();
  const measured = (
    await Promise.all(
      (
        await row.locator(labels).all()
      ).map((label) => label.evaluate(firstTextBaseline, rowSelector)),
    )
  ).filter((value) => value !== null);
  expect(measured).toHaveLength(count);
  for (const label of measured)
    expect(Math.abs(label - baseline!)).toBeLessThanOrEqual(
      FIRST_TEXT_BASELINE_TOLERANCE_PX,
    );
}

test("Notebook and Changes gutters stay aligned as the shared reading size changes", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const pane = await openResourceFixture(page);
  const host = hostRequest(page);
  const { preferences } = await (await host.get("/api/preferences")).json();
  await openPreviewFixture(pane, "notebook.ipynb");
  const notebook = pane.getByRole("tab", {
    name: "notebook.ipynb",
    exact: true,
  });
  const preview = pane.getByRole("document", {
    name: "Notebook preview",
    exact: true,
  });
  await pane.getByRole("tab", { name: "Changes", exact: true }).click();
  await pane.getByRole("button", { name: /page\.html, modified/ }).click();
  const changedFile = pane.getByRole("tab", { name: "page.html", exact: true });
  try {
    for (const [size, width] of [
      ["Compact", 1280],
      ["Large", 320],
    ] as const) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await openSettings(page);
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await dialog
        .getByRole("button", { name: "Display", exact: true })
        .click();
      await dialog
        .getByRole("combobox", { name: "Content text size", exact: true })
        .selectOption({ label: size });
      await expect(page.locator("html")).toHaveAttribute(
        "data-content-text-size",
        size.toLowerCase(),
      );
      await dialog.press("Escape");
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);

      await changedFile.click();
      for (const kind of ["context", "add", "delete"])
        await expectFirstLine(
          pane
            .locator(`.code-row[data-kind="${kind}"]:has(code:not(:empty))`)
            .first(),
          ".code-row",
          "code",
          ".code-row__number, .code-row__mark",
          2,
        );

      await notebook.click();
      const prompt = ".notebook-preview__prompt";
      const rowSelector =
        ".notebook-preview__cell--code, .notebook-preview__output";
      const rows = preview
        .locator(rowSelector)
        .filter({ has: page.locator("pre") });
      await expect(
        preview.locator(prompt).filter({ hasText: "123456789012345" }),
      ).toHaveText(["In [123456789012345]", "Out [123456789012345]"]);
      const starts: number[] = [];
      for (const row of await rows.all()) {
        const body = row.locator(
          ":scope > :is(.notebook-preview__cell-body, .notebook-preview__output-body)",
        );
        expect(
          await row
            .locator(`:scope > ${prompt}`)
            .evaluate(textOverflowsInlineBounds),
        ).toBe(false);
        starts.push((await body.boundingBox())!.x);
        await expectFirstLine(
          row,
          rowSelector,
          ":scope > div > pre",
          `:scope > ${prompt}`,
          1,
        );
      }
      expect(
        await preview.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(
        0.5,
      );
    }
  } finally {
    await host.patch("/api/preferences", {
      data: { contentTextSize: preferences.contentTextSize },
    });
  }
});
