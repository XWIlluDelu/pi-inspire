import { expect, test } from "@playwright/test";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import { openMockEventSession } from "./support/mock-host";

for (const touch of [false, true]) {
  test.describe(
    touch ? "touch activity rhythm" : "desktop activity rhythm",
    () => {
      test.use({
        viewport: { width: touch ? 390 : 1440, height: 1000 },
        hasTouch: touch,
        reducedMotion: "reduce",
      });
      test("collapsed summaries separate from identity while expanded Copy stays adjacent", async ({
        page,
      }) => {
        const send = await openMockEventSession(
          page,
          "Summary spacing",
          customMessageConfiguration,
          {
            activityFoldVisibility: "expanded",
            thinkingVisibility: "collapsed",
            toolVisibility: "collapsed",
          },
        );
        send(
          {
            type: "message_end",
            message: {
              role: "assistant",
              __inspireMessageId: "summary-spacing",
              content: [
                {
                  type: "thinking",
                  thinking: "Verifying font asset licensing",
                },
                {
                  type: "toolCall",
                  id: "summary-read",
                  name: "read",
                  arguments: { path: "src/components/PiLoader.tsx" },
                },
              ],
            },
          },
          {
            type: "message_end",
            message: {
              role: "toolResult",
              toolCallId: "summary-read",
              content: [{ type: "text", text: "Loaded." }],
            },
          },
        );
        const headers = page.locator(".activity-fold .card__header");
        await expect(headers).toHaveCount(2);
        await page.evaluate(() => document.fonts.ready);
        for (const header of await headers.all()) {
          const gap = await header.evaluate((el) => {
            const identity = el
              .querySelector(".card__disclosure")!
              .getBoundingClientRect();
            const summary = el
              .querySelector(".card__summary")!
              .getBoundingClientRect();
            return summary.left - identity.right;
          });
          expect(gap).toBe(10);
          await expect(header.locator(".card__copy")).toHaveCount(0);
        }
        const thinking = page.locator(".card--thinking").first();
        await thinking.locator(".card__disclosure").click();
        await expect(thinking.locator(".card__summary")).toHaveCount(0);
        await expect(thinking.locator(".card__copy")).toHaveCount(1);
        expect(
          await thinking.locator(".card__header").evaluate((el) => {
            return (
              el.querySelector(".card__copy")!.getBoundingClientRect().left -
              el.querySelector(".card__disclosure")!.getBoundingClientRect()
                .right
            );
          }),
        ).toBe(4);
      });
      test("Earlier activity matches the structural label and summarizes only its hidden prefix", async ({
        page,
      }) => {
        const send = await openMockEventSession(
          page,
          "Earlier history",
          customMessageConfiguration,
          {
            activityFoldVisibility: "compact",
            thinkingVisibility: "expanded",
          },
        );
        send(
          ...Array.from({ length: 40 }, (_, i) => ({
            type: "message_end",
            message: {
              role: "assistant",
              __inspireMessageId: `earlier-${i}`,
              content: [
                { type: "thinking", thinking: `History step ${i + 1}` },
              ],
            },
          })),
        );
        const earlier = page.locator(".activity-fold__omission");
        await expect(earlier).toBeVisible();
        await expect(earlier).toHaveCSS("font-family", /Rajdhani/);
        await expect(earlier).toHaveCSS("text-transform", "uppercase");
        const ids = (selector: string) =>
          page
            .locator(selector)
            .evaluateAll((nodes) =>
              nodes.map((n) => n.getAttribute("data-activity-id")),
            );
        const old = await ids(".activity-fold__omission .activity-fold__kind");
        const latest = await ids(
          ".activity-fold__boundary--upper .activity-fold__kind",
        );
        expect(old).toHaveLength(9);
        expect(latest).toHaveLength(9);
        expect(old.some((id) => latest.includes(id))).toBe(false);
        await expect(page.locator(".card--thinking:visible")).toHaveCount(24);
        await earlier.click();
        await expect(earlier).toHaveCount(0);
        await expect(page.locator(".card--thinking:visible")).toHaveCount(40);
      });
      test("short paragraphs keep a clear inner rhythm, adjacent Copy and a separate group boundary", async ({
        page,
      }) => {
        const send = await openMockEventSession(
          page,
          "Activity rhythm",
          customMessageConfiguration,
          {
            activityFoldVisibility: "expanded",
            thinkingVisibility: "expanded",
            toolVisibility: "collapsed",
          },
        );
        send(
          ...[
            "Defining recentKinds semantics\n\nDefining unknown history states",
            "Designing activity matrix",
          ].map((thinking, i) => ({
            type: "message_end",
            message: {
              role: "assistant",
              __inspireMessageId: `rhythm-${i}`,
              content: [{ type: "thinking", thinking }],
            },
          })),
        );
        const cards = page.locator(".card--thinking");
        await expect(cards).toHaveCount(2);
        await expect(cards.first().locator("p")).toHaveCount(2);
        await page.evaluate(() => document.fonts.ready);
        const first = cards.first();
        const geometry = await first.evaluate((el) => {
          const title = el
            .querySelector(".card__label")!
            .getBoundingClientRect();
          const copy = el
            .querySelector(".card__copy svg")!
            .getBoundingClientRect();
          const p = [...el.querySelectorAll("p")].map((el) =>
            el.getBoundingClientRect(),
          );
          return {
            indent: p[0]!.left - title.left,
            copy: copy.left - title.right,
            intro: p[0]!.top - title.bottom,
            paragraphs: p[1]!.top - p[0]!.bottom,
          };
        });
        expect(Math.abs(geometry.indent)).toBeLessThanOrEqual(1);
        expect(geometry.copy).toBeGreaterThan(0);
        expect(geometry.copy).toBeLessThanOrEqual(14);
        expect(geometry.intro).toBeGreaterThanOrEqual(0);
        expect(geometry.intro).toBeLessThanOrEqual(12);
        expect(geometry.paragraphs).toBe(4);
        await expect(first.locator(".card__status")).toHaveCount(0);
        const lower = page.locator(".activity-fold__boundary--lower");
        await expect(lower).toHaveCSS("font-family", /Rajdhani/);
        const before = (await cards.last().locator("p").boundingBox())!;
        expect(
          (await lower.boundingBox())!.y - before.y - before.height,
        ).toBeGreaterThanOrEqual(4);
        const matrix = page.locator(".activity-fold__matrix");
        await expect(matrix.locator(".activity-fold__kind")).toHaveCount(2);
        const calls = Array.from({ length: 7 }, (_, i) => ({
          type: "toolCall",
          id: `rhythm-tool-${i}`,
          name: "read",
          arguments: { path: `file-${i}.txt` },
        }));
        send(
          {
            type: "message_end",
            message: {
              role: "assistant",
              __inspireMessageId: "rhythm-tools",
              content: calls,
            },
          },
          ...calls.map((call) => ({
            type: "message_end",
            message: {
              role: "toolResult",
              toolCallId: call.id,
              content: [{ type: "text", text: "read" }],
            },
          })),
        );
        await expect(matrix.locator(".activity-fold__kind")).toHaveCount(9);
        await expect(matrix).toHaveClass(/matrix--full/);
        await expect(matrix).toHaveCSS("animation-name", "none");
        const box = (await matrix.boundingBox())!;
        expect(box.width).toBe(box.height);
        await expect(
          page.locator(".activity-fold .status-success"),
        ).toHaveCount(7);
        await lower.click();
        await expect(page.locator(".activity-fold__content")).toBeHidden();
      });
    },
  );
}
