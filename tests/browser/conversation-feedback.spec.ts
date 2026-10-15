import { expect, test } from "@playwright/test";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { conversationFeedbackMessages } from "../web/fixtures/conversation-feedback";
import { openMockEventSession } from "./support/mock-host";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

for (const touch of [false, true]) {
  test.describe(touch ? "touch feedback" : "pointer feedback", () => {
    test.use({ hasTouch: touch });
    test("context and error controls remain aligned with independent disclosure, copy and dismissal", async ({
      page,
    }) => {
      const send = await openMockEventSession(
        page,
        "Feedback boundaries",
        emptyToolPresentationConfiguration(),
        {
          theme: "dark",
          palette: "classic-amber",
          toolVisibility: "compact",
          activityFoldVisibility: "expanded",
        },
      );
      send(
        ...conversationFeedbackMessages.map((message) => ({
          type: "message_end",
          message,
        })),
      );
      const checkpoint = page.locator(".context-checkpoint");
      const error = page.getByRole("group", { name: "PI error" });
      await expect(checkpoint).toContainText("History chunk ≈ 42,500 tokens");
      for (const width of [1440, 520, 480, 440, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        const alignment = await checkpoint.evaluate((el) => {
          const chevron = el
            .querySelector(".context-checkpoint__chevron")!
            .getBoundingClientRect();
          const title = el
            .querySelector(".context-checkpoint__title")!
            .getBoundingClientRect();
          const metric = el
            .querySelector(".context-checkpoint__metric")!
            .getBoundingClientRect();
          const fold = document.querySelector(".activity-fold")!;
          const groupLabel = fold
            .querySelector(
              ".activity-fold__boundary--upper > span, .activity-fold__disclosure > span",
            )!
            .getBoundingClientRect();
          const groupChevron = fold
            .querySelector(
              ".activity-fold__boundary--upper > svg, .activity-fold__disclosure > svg",
            )!
            .getBoundingClientRect();
          const children = fold.querySelector(".activity-fold__content")!;
          const first = children
            .querySelector(".card__header")!
            .getBoundingClientRect();
          const titleText = document.createRange();
          titleText.selectNodeContents(
            el.querySelector(".context-checkpoint__title")!,
          );
          return {
            outerInset:
              el.getBoundingClientRect().height -
              el.closest(".turn")!.getBoundingClientRect().height,
            titleLines: new Set(
              [...titleText.getClientRects()].map((rect) =>
                Math.round(rect.top),
              ),
            ).size,
            leadingEdge: chevron.left - groupChevron.left,
            nested: first.left - groupLabel.left,
            guideAxis:
              children.getBoundingClientRect().left +
              0.5 -
              (groupChevron.left + groupChevron.right) / 2,
            metricWraps: metric.top >= title.bottom,
            metricCenter:
              (metric.top + metric.bottom - title.top - title.bottom) / 2,
            metricStart: metric.left - title.left,
            metricGap: metric.left - title.right,
          };
        });
        expect(Math.abs(alignment.outerInset)).toBeLessThanOrEqual(1);
        expect(alignment.titleLines).toBe(1);
        expect(Math.abs(alignment.leadingEdge)).toBeLessThanOrEqual(1);
        expect(Math.abs(alignment.nested)).toBeLessThanOrEqual(1);
        expect(Math.abs(alignment.guideAxis)).toBeLessThanOrEqual(1);
        if (alignment.metricWraps)
          expect(Math.abs(alignment.metricStart)).toBeLessThanOrEqual(1);
        else {
          expect(Math.abs(alignment.metricCenter)).toBeLessThanOrEqual(1);
          expect(alignment.metricGap).toBeGreaterThanOrEqual(4);
          expect(alignment.metricGap).toBeLessThanOrEqual(12);
        }
        const toggle = checkpoint.getByRole("button", {
          name: "Magic Context compacted",
          exact: true,
        });
        await toggle.press("Enter");
        await expect(
          checkpoint.locator(".context-checkpoint__body"),
        ).toBeVisible();
        const title = await checkpoint
          .locator(".context-checkpoint__title")
          .boundingBox();
        const body = await checkpoint
          .locator(".context-checkpoint__body .rich-text")
          .boundingBox();
        expect(Math.abs(title!.x - body!.x)).toBeLessThanOrEqual(1);
        const copy = checkpoint.getByRole("button", {
          name: /compaction summary/i,
        });
        if (touch)
          expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(32);
        await copy.focus();
        await page.keyboard.press("Enter");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await toggle.press("Enter");
        const errorSpacing = await error.evaluate((el) => {
          const head = el
            .querySelector(".assistant-error__head")!
            .getBoundingClientRect();
          const copy = el
            .querySelector(".assistant-error__copy")!
            .getBoundingClientRect();
          const message = el
            .querySelector(".assistant-error__message")!
            .getBoundingClientRect();
          const card = el.getBoundingClientRect();
          return {
            headHeight: head.height,
            bodyGap: message.top - head.bottom,
            copyInside: copy.top >= card.top + 2 && copy.bottom <= message.top,
          };
        });
        expect(errorSpacing.headHeight).toBe(24);
        expect(errorSpacing.bodyGap).toBe(4);
        expect(errorSpacing.copyInside).toBe(true);
        await error.getByRole("button", { name: "Show details" }).click();
        await expect(error).toContainText("Diagnostic line 8");
        await error.getByRole("button", { name: "Hide details" }).click();
        if (touch)
          expect(
            (await error.locator(".assistant-error__copy").boundingBox())!
              .height,
          ).toBeGreaterThanOrEqual(32);
        for (const surface of [checkpoint, error])
          expect(
            await surface.evaluate((el) => el.scrollWidth - el.clientWidth),
          ).toBeLessThanOrEqual(1);
      }
      send({
        type: "extension_error",
        extensionPath: "/workspace/extensions/review-preview.ts",
        error: "Failed to refresh the preview.",
      });
      const notice = page.locator(".notice--error").last();
      await expect(notice).toContainText("Failed to refresh");
      expect(
        await notice.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      if (touch)
        expect(
          (await notice
            .getByRole("button", { name: "Dismiss notification" })
            .boundingBox())!.height,
        ).toBeGreaterThanOrEqual(32);
      const noticeLayout = await notice.evaluate((element) => {
        const head = element
          .querySelector(".notice__head")!
          .getBoundingClientRect();
        const title = element
          .querySelector(".notice__title")!
          .getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return {
          extraHeadHeight: head.height - Math.max(title.height, 24),
          controlsInside: [...element.querySelectorAll("button")].every(
            (button) => {
              const rect = button.getBoundingClientRect();
              return (
                rect.top >= bounds.top &&
                rect.bottom <= bounds.bottom &&
                rect.left >= bounds.left &&
                rect.right <= bounds.right
              );
            },
          ),
        };
      });
      expect(noticeLayout.extraHeadHeight).toBeLessThanOrEqual(1);
      expect(noticeLayout.controlsInside).toBe(true);
      await notice
        .getByRole("button", { name: "Dismiss notification" })
        .click();
      await expect(notice).toHaveCount(0);
      await expect(error).toBeVisible();
      await page.route("**/api/control/native-command", (route) =>
        route.fulfill({
          status: 503,
          json: {
            error:
              "Compaction failed: https://provider.example/requests/" +
              "request-id".repeat(16),
          },
        }),
      );
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("/compact");
      await page.locator(".composer__send").click();
      const receipt = page.locator(".command-activity__item--error");
      await expect(receipt).toContainText("Failed");
      expect(
        await receipt.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      await receipt.getByRole("button", { name: /dismiss/i }).click();
      await expect(receipt).toHaveCount(0);
    });
  });
}
