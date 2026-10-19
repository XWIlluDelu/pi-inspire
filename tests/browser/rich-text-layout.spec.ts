import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { clipboardLines } from "./support/clipboard";
import { openMockEventSession } from "./support/mock-host";
import { firstTextBaseline } from "./support/text-baseline";

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

async function checkTaskColumns(page: Page, reader: Locator) {
  await expect(reader.locator(".task-list-item")).toHaveCount(7);
  await expect(reader.locator(".katex")).toHaveCount(1);
  const plainBullet = reader.locator(
    "ul.contains-task-list > li:not(.task-list-item)",
  );
  const plainNumber = reader.locator(
    "ol.contains-task-list > li:not(.task-list-item)",
  );
  await expect(plainBullet).toHaveCSS("list-style-type", "disc");
  await expect(plainNumber).toHaveCSS("list-style-type", "decimal");
  await expect(reader.locator("ol.contains-task-list")).toHaveAttribute(
    "start",
    "3",
  );
  for (const size of ["compact", "comfortable", "large"]) {
    await page.evaluate((size) => {
      document.documentElement.dataset.contentTextSize = size;
    }, size);
    for (const width of [1280, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 1400 });
      await page.evaluate(() => document.fonts.ready);
      for (const ordinary of [plainBullet, plainNumber]) {
        const columnDelta = await ordinary.evaluate((item) => {
          const task = item.parentElement!.querySelector(
            ":scope > .task-list-item > .rich-text__task-content",
          )!;
          return (
            item.getBoundingClientRect().left -
            task.getBoundingClientRect().left
          );
        });
        expect(Math.abs(columnDelta)).toBeLessThanOrEqual(0.5);
      }
      for (const item of await reader.locator(".task-list-item").all()) {
        const content = item.locator(":scope > .rich-text__task-content");
        const paragraph = content.locator(":scope > p").first();
        const block = (await paragraph.count()) ? paragraph : content;
        const baseline = await block.evaluate(
          firstTextBaseline,
          ".task-list-item",
        );
        expect(baseline).not.toBeNull();
        const geometry = await block.evaluate((block) => {
          const item = block.closest(".task-list-item")!;
          const marker = item.querySelector("input")!;
          const box = marker.getBoundingClientRect();
          const frame = block.getBoundingClientRect();
          const lineHeight = Number.parseFloat(
            getComputedStyle(block).lineHeight,
          );
          const starts = new Map<number, number>();
          const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
          const range = document.createRange();
          let node: Node | null;
          let firstTop: number | undefined;
          while ((node = walker.nextNode())) {
            if (
              node.parentElement!.closest("li") !== item ||
              node.parentElement!.closest(".katex")
            )
              continue;
            const text = node.textContent!;
            for (let offset = 0; offset < text.length; offset++) {
              if (/\s/.test(text[offset]!)) continue;
              range.setStart(node, offset);
              range.setEnd(node, offset + 1);
              const letter = range.getBoundingClientRect();
              firstTop ??= letter.top;
              const line = Math.round((letter.top - firstTop) / lineHeight);
              starts.set(
                line,
                Math.min(starts.get(line) ?? Infinity, letter.left),
              );
            }
          }
          const parentTask = item.parentElement!.closest(".task-list-item");
          const parentContent = parentTask?.querySelector(
            ":scope > .rich-text__task-content",
          );
          return {
            starts: [...starts.values()].map((left) => left - frame.left),
            markerWidth: box.width,
            markerHeight: box.height,
            markerBaseline:
              box.bottom -
              item.getBoundingClientRect().top +
              Number.parseFloat(getComputedStyle(marker).verticalAlign),
            nestedIndent: parentContent
              ? box.left - parentContent.getBoundingClientRect().left
              : null,
            disabled: marker.disabled,
          };
        });
        expect(geometry.starts.length).toBeGreaterThan(0);
        for (const left of geometry.starts)
          expect(Math.abs(left)).toBeLessThanOrEqual(0.5);
        expect(geometry.markerWidth).toBeCloseTo(13, 1);
        expect(geometry.markerHeight).toBeCloseTo(13, 1);
        expect(geometry.disabled).toBe(true);
        expect(
          Math.abs(geometry.markerBaseline - baseline!),
        ).toBeLessThanOrEqual(0.5);
        if (geometry.nestedIndent !== null)
          expect(geometry.nestedIndent).toBeGreaterThan(0);
      }
      expect(
        await reader.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
    }
  }
}

for (const surface of [
  "user",
  "assistant",
  "thinking",
  "extension",
  "document",
] as const) {
  test(`task list text keeps its column, hierarchy and first-line marker in ${surface}`, {
    tag: "@platform-ui",
  }, async ({ page }) => {
    const file = join(browserWorkspace, "task-layout.md");
    if (surface === "document") await writeFile(file, checklist);
    try {
      const send = await openMockEventSession(
        page,
        `Task layout: ${surface}`,
        customMessageConfiguration,
        { activityFoldVisibility: "expanded", thinkingVisibility: "expanded" },
      );
      const message =
        surface === "user"
          ? { role: "user", content: checklist }
          : surface === "extension"
            ? {
                role: "custom",
                customType: "intercom_message",
                display: true,
                content: checklist,
                details: {
                  from: { name: "Checklist review" },
                  bodyText: checklist,
                },
              }
            : {
                role: "assistant",
                content:
                  surface === "thinking"
                    ? [{ type: "thinking", thinking: checklist }]
                    : [
                        {
                          type: "text",
                          text:
                            surface === "document"
                              ? "Preview [checklist](task-layout.md)."
                              : checklist,
                        },
                      ],
              };
      send({
        type: "message_end",
        message: { ...message, __inspireMessageId: `task-layout-${surface}` },
      });
      const selectors = {
        user: ".rich-text--user",
        assistant: ".rich-text--assistant",
        thinking: ".rich-text--thinking",
        extension: ".custom-message__body .rich-text",
        document: ".ctx .rich-text",
      };
      if (surface === "document")
        await page
          .getByRole("link", { name: "checklist", exact: true })
          .click();
      const reader = page.locator(selectors[surface]).last();
      await checkTaskColumns(page, reader);
      if (surface === "user") {
        await page
          .context()
          .grantPermissions(["clipboard-read", "clipboard-write"]);
        const copy = page.locator(".turn--user").last().getByRole("button", {
          name: "Copy message",
          exact: true,
        });
        await copy.focus();
        await copy.press("Enter");
        await expect
          .poll(() => clipboardLines(page))
          .toEqual(checklist.split("\n"));
      }
    } finally {
      if (surface === "document") await rm(file, { force: true });
    }
  });
}
