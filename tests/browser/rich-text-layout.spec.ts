import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { openEventSession } from "./support/host-events";

const checklist = `# Checklist

- [x] Compare $\\displaystyle\\frac{\\sum_{i=1}^{n} w_i x_i}{\\sum_{i=1}^{n} w_i}$ with **reference calibration** and retain the original acquisition settings before comparing the next run.
- Keep the acquisition notes with the result.
- [ ] Confirm the sample temperature and report the measurement uncertainty.

## Details

- [x] Preserve the reference result before continuing with the next acquisition.

  Keep the original instrument settings for comparison.

  - [ ] Check instrument drift and keep the sample temperature stable.
  - [ ] 复核测量结果并保留参考样本的原始采集设置。

- [ ] Report the remaining systematic error and confirm the final result.

3. [x] Check the final reference acquisition.
4. Report the measurement uncertainty.
`.trimEnd();

async function expectTaskColumn(reader: Locator) {
  await expect(reader.locator("ol")).toHaveAttribute("start", "3");
  await expect(reader.locator(".katex")).toHaveCount(1);
  await expect(reader.locator("input[type=checkbox]:disabled")).toHaveCount(7);
  const geometry = await reader.evaluate((element) => {
    const content = ".rich-text__task-content";
    const left = (node: Element) => node.getBoundingClientRect().left;
    const columnDeltas = [
      ...element.querySelectorAll(
        ".contains-task-list > li:not(.task-list-item)",
      ),
    ].map(
      (item) =>
        left(item) -
        left(item.parentElement!.querySelector(`:scope > li > ${content}`)!),
    );
    const nested = element.querySelector(
      ".task-list-item .task-list-item input",
    )!;
    const parentTask = nested.closest("li")!.parentElement!.closest(content)!;
    const mixedListMarkers = [
      ...element.querySelectorAll(
        ".contains-task-list > li:not(.task-list-item)",
      ),
    ].map((item) => getComputedStyle(item).listStyleType);
    return {
      columnDeltas,
      mixedListMarkers,
      nestedIndent: left(nested) - left(parentTask),
      overflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(geometry.mixedListMarkers).toEqual(["disc", "decimal"]);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.nestedIndent).toBeGreaterThan(0);
  for (const delta of geometry.columnDeltas)
    expect(Math.abs(delta)).toBeLessThanOrEqual(0.5);
}

test("task lists keep their reading column across Live and file previews", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const file = join(browserWorkspace, "task-layout.md");
  await writeFile(file, checklist);
  try {
    const send = await openEventSession(
      page,
      "Task layout",
      customMessageConfiguration,
      {
        activityFoldVisibility: "expanded",
        thinkingVisibility: "expanded",
      },
    );
    send(
      {
        type: "message_end",
        message: { role: "user", content: checklist, timestamp: 1 },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 2,
          content: [
            { type: "thinking", thinking: checklist },
            {
              type: "text",
              text: checklist + "\n\nPreview [checklist](task-layout.md).",
            },
          ],
        },
      },
    );
    await page.evaluate(() => document.fonts.ready);
    await expectTaskColumn(page.locator(".rich-text--assistant").last());
    await page.setViewportSize({ width: 320, height: 900 });
    const user = page.locator(".rich-text--user").last();
    await expectTaskColumn(user);
    // The tall math expression and later plain text share the first line;
    // its following prose starts back at the same edge in the narrow bubble.
    const wrappedLines = await user
      .locator(".rich-text__task-content")
      .first()
      .evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        const starts = new Map<number, number>();
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (
            !node.textContent?.trim() ||
            node.parentElement!.closest(".katex")
          )
            continue;
          range.selectNodeContents(node);
          for (const box of range.getClientRects())
            if (box.width > 0 && box.height > 0)
              starts.set(
                box.top,
                Math.min(box.left, starts.get(box.top) ?? Infinity),
              );
        }
        const first = element.getBoundingClientRect().left;
        const sameColumn = [...starts.entries()].filter(
          ([, left]) => Math.abs(left - first) <= 0.5,
        );
        return sameColumn.length;
      });
    expect(wrappedLines).toBeGreaterThan(1);
    await page.getByRole("link", { name: "checklist", exact: true }).click();
    const preview = page.locator(".ctx .rich-text");
    await expect(
      preview.getByRole("heading", { name: "Checklist" }),
    ).toBeVisible();
    await expectTaskColumn(preview);
    await expect(preview.locator("strong")).toHaveText("reference calibration");
    await expect(preview.locator("input[type=checkbox]:checked")).toHaveCount(
      3,
    );
  } finally {
    await rm(file, { force: true });
  }
});
