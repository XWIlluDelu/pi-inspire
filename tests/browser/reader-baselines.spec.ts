import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { hostRequest } from "./support/host-request";
import { openMockSession, pairedPage } from "./support/navigation";
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("button", { name: "Display", exact: true }).click();
  await dialog
    .getByRole("group", { name: "Content text size", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
  await dialog.press("Escape");
  await page.evaluate(() => document.fonts.ready);
}

test("notebook execution counts share a bounded gutter without covering source", {
  tag: "@cross-browser",
}, async ({ page }) => {
  const name = "notebook-execution-counts.ipynb";
  const path = join(browserWorkspace, name);
  const counts = [1, 17, 100, 1234, 123456789012345];
  await writeFile(
    path,
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: "python" } },
      cells: counts.map((count) => ({
        cell_type: "code",
        metadata: {},
        execution_count: count,
        source: "measured = 12.5\nmeasured",
        outputs: [
          {
            output_type: "execute_result",
            execution_count: count,
            metadata: {},
            data: { "text/plain": ["12.5"] },
          },
        ],
      })),
    }),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  const host = hostRequest(page);
  const before = await (await host.get("/api/preferences")).json();
  try {
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    const pane = page.locator(".ctx");
    await pane
      .getByRole("searchbox", { name: "Search workspace files" })
      .fill(name);
    await pane
      .getByRole("button", { name: new RegExp(name.replaceAll(".", "\\.")) })
      .click();
    const preview = pane.getByRole("document", {
      name: "Notebook preview",
      exact: true,
    });
    const prompts = preview.locator(".notebook-preview__prompt");
    await expect(prompts).toHaveCount(counts.length * 2);
    expect(await prompts.allTextContents()).toEqual(
      counts.flatMap((n) => [`In [${n}]`, `Out [${n}]`]),
    );
    for (const size of ["Compact", "Comfortable", "Large"]) {
      await readingSize(page, size);
      for (const width of [1280, 820, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() => preview.evaluate((el) => el.scrollWidth - el.clientWidth))
          .toBe(0);
        for (const theme of ["light", "dark"]) {
          await page.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            theme,
          );
          const geometry = await preview.evaluate((root) => {
            const rows = [
              ...root.querySelectorAll<HTMLElement>(
                ".notebook-preview__cell--code, .notebook-preview__output",
              ),
            ];
            return rows.map((row) => {
              const prompt = row.querySelector<HTMLElement>(
                ":scope > .notebook-preview__prompt",
              )!;
              const source = row.querySelector<HTMLElement>(
                ":scope > .notebook-preview__cell-body, :scope > .notebook-preview__output-body",
              )!;
              const range = document.createRange();
              range.selectNodeContents(prompt);
              const box = prompt.getBoundingClientRect(),
                glyphs = range.getBoundingClientRect();
              return {
                source: source.getBoundingClientRect().left,
                left: box.left,
                min: parseFloat(getComputedStyle(prompt).minWidth),
                width: box.width,
                padding: parseFloat(getComputedStyle(prompt).paddingRight),
                rightGap: source.getBoundingClientRect().left - glyphs.right,
                clipped: prompt.scrollWidth - prompt.clientWidth,
                textLeft: glyphs.left,
              };
            });
          });
          expect(
            Math.max(...geometry.map((row) => row.source)) -
              Math.min(...geometry.map((row) => row.source)),
          ).toBeLessThanOrEqual(0.5);
          for (const row of geometry) {
            expect(row.width).toBeGreaterThanOrEqual(row.min);
            expect(row.rightGap).toBeGreaterThanOrEqual(row.padding - 0.5);
            expect(row.textLeft).toBeGreaterThanOrEqual(row.left - 0.5);
            expect(row.clipped).toBe(0);
          }
          const row = preview.locator(".notebook-preview__output").last();
          const baseline = await row
            .locator(".notebook-preview__prompt")
            .evaluate(firstTextBaseline, ".notebook-preview__output");
          if (size === "Compact" && width === 1280 && theme === "light") {
            // The row can move between samples without changing text alignment.
            await preview.evaluate((element) => {
              element.scrollTop += 8;
            });
          }
          const code = await row
            .locator("pre")
            .evaluate(firstTextBaseline, ".notebook-preview__output");
          expect(Math.abs(baseline! - code!)).toBeLessThanOrEqual(
            FIRST_TEXT_BASELINE_TOLERANCE_PX,
          );
        }
      }
    }
  } finally {
    await host.patch("/api/preferences", {
      data: { contentTextSize: before.contentTextSize },
    });
    await rm(path, { force: true });
  }
});

for (const mode of ["notebook", "changes"] as const) {
  test(`${mode} prompts and gutters share the first source baseline at every reading size`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await pairedPage(page);
    await openMockSession(page, /Resource virtualization and sandbox fixture/);
    const host = hostRequest(page);
    const before = await (await host.get("/api/preferences")).json();
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    const pane = page.locator(".ctx");
    if (mode === "notebook") {
      await pane
        .getByRole("searchbox", { name: "Search workspace files" })
        .fill("notebook.ipynb");
      await pane
        .getByRole("button", {
          name: /notebook\.ipynb.*tests\/browser\/fixtures\/file-previews/,
        })
        .click();
      await expect(
        pane.locator(".notebook-preview__cell--code pre").first(),
      ).toBeVisible();
    } else {
      await pane.getByRole("tab", { name: "Changes", exact: true }).click();
      await pane.getByRole("button", { name: /page\.html, modified/ }).click();
      await expect(pane.locator(".source-diff__line--add")).toBeVisible();
    }

    try {
      for (const size of ["Compact", "Comfortable", "Large"]) {
        await readingSize(page, size);
        for (const width of [1280, 820, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          const rows =
            mode === "notebook"
              ? await pane
                  .locator(
                    ".notebook-preview__cell--code, .notebook-preview__output:has(> .notebook-preview__output-body > pre)",
                  )
                  .all()
              : [
                  ...(
                    await pane
                      .locator(
                        ".source-diff__line--context:has(code:not(:empty))",
                      )
                      .all()
                  ).slice(0, 3),
                  pane.locator(".source-diff__line--add").first(),
                  pane.locator(".source-diff__line--delete").first(),
                ];
          const readingRow =
            ".notebook-preview__cell--code, .notebook-preview__output, .source-diff__line";
          const readings: { source: number; label: number; text: string }[] =
            [];
          for (const row of rows) {
            const source = row.locator(
              mode === "notebook"
                ? ":scope > .notebook-preview__cell-body > pre, :scope > .notebook-preview__output-body > pre"
                : "code",
            );
            if (!((await source.textContent()) ?? "").trim()) continue;
            const baseline = await source.evaluate(
              firstTextBaseline,
              readingRow,
            );
            expect(baseline).not.toBeNull();
            const labels = row.locator(
              mode === "notebook"
                ? ":scope > .notebook-preview__prompt"
                : ".source-diff__number, .source-diff__mark",
            );
            for (const label of await labels.all()) {
              const text = (await label.textContent()) ?? "";
              if (!text.trim()) continue;
              readings.push({
                source: baseline!,
                label: (await label.evaluate(firstTextBaseline, readingRow))!,
                text,
              });
            }
          }
          expect(readings.length).toBeGreaterThan(mode === "notebook" ? 3 : 6);
          for (const row of readings)
            expect(
              Math.abs(row.source - row.label),
              `${mode} ${size} ${width}: ${row.text}`,
            ).toBeLessThanOrEqual(FIRST_TEXT_BASELINE_TOLERANCE_PX);
        }
      }
    } finally {
      await host.patch("/api/preferences", {
        data: { contentTextSize: before.contentTextSize },
      });
    }
  });
}
