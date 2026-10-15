import { expect, test } from "@playwright/test";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { conversationFeedbackMessages } from "../web/fixtures/conversation-feedback";
import { openMockEventSession } from "./support/mock-host";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

for (const touch of [false, true]) {
  test.describe(
    touch ? "touch secondary actions" : "pointer secondary actions",
    () => {
      test.use({
        hasTouch: touch,
        viewport: { width: touch ? 390 : 1440, height: 1100 },
      });
      test("pointer focus does not latch revealed actions; keyboard and touch keep access", async ({
        page,
        context,
      }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        const send = await openMockEventSession(
          page,
          "Secondary action visibility",
          emptyToolPresentationConfiguration(),
          {
            activityFoldVisibility: "expanded",
            toolVisibility: "compact",
            thinkingVisibility: "collapsed",
          },
        );
        send(
          ...conversationFeedbackMessages.map((message) => ({
            type: "message_end",
            message,
          })),
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Read the retained summary." },
              ],
              stopReason: "stop",
              __inspireMessageId: "reveal-thinking",
            },
          },
          {
            type: "message_end",
            message: {
              role: "custom",
              customType: "review-note",
              display: true,
              content: "Keep the original text and independent actions.",
              __inspireMessageId: "reveal-custom",
            },
          },
          {
            type: "extension_ui_request",
            id: "reveal-widget",
            method: "setWidget",
            responseRequired: false,
            extensionDisplays: [
              {
                id: "review-widget",
                kind: "widget",
                label: "Review note",
                source: "Pi extension",
                placement: "aboveEditor",
                lines: ["Check keyboard and pointer feedback."],
              },
            ],
          },
        );
        await page.locator(".context-checkpoint__toggle").click();
        await page.locator(".card--thinking .card__disclosure").click();
        await page.locator(".card--tool .card__disclosure").click();
        const surfaces = [
          {
            scope: ".context-checkpoint",
            copy: ".context-checkpoint__copy",
            paint: ".context-checkpoint__copy",
            toggle: ".context-checkpoint__toggle",
          },
          {
            scope: ".card--thinking",
            copy: ".card__copy",
            paint: ".card__copy",
            toggle: ".card__disclosure",
          },
          {
            scope: ".card--tool",
            copy: ".card__copy",
            paint: ".card__copy",
            toggle: ".card__disclosure",
          },
          {
            scope: ".custom-message",
            copy: ".custom-message__copy",
            paint: ".custom-message__copy",
          },
          {
            scope: ".extension-display",
            copy: ".extension-display__copy",
            paint: ".extension-display__copy",
          },
          {
            scope: ".turn--user",
            copy: ".turn__actions button",
            paint: ".turn__actions",
          },
        ];
        for (const surface of surfaces) {
          const scope = page.locator(surface.scope).first();
          const copy = scope.locator(surface.copy).first();
          const paint = scope.locator(surface.paint);
          if (surface.toggle) {
            const toggle = scope.locator(surface.toggle);
            await toggle.click();
            await toggle.click();
            await expect(toggle).toBeFocused();
            expect(
              await toggle.evaluate((el) => el.matches(":focus-visible")),
            ).toBe(false);
          } else {
            await copy.click();
            // Clipboard loading may briefly disable the control.
            await expect(copy).toBeEnabled();
          }
          await page.mouse.move(0, 0);
          await expect(paint).toHaveCSS("opacity", touch ? "0.75" : "0");
          // Keyboard access remains available even when the control rests at zero opacity.
          await page.keyboard.press("Tab");
          await copy.focus();
          await expect(copy).toBeFocused();
          await expect(paint).toHaveCSS("opacity", "1");
        }
      });
    },
  );
}
