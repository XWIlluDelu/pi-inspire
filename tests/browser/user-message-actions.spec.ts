import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { conversationFeedbackMessages } from "../web/fixtures/conversation-feedback";
import { openMockEventSession } from "./support/mock-host";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

for (const touch of [false, true]) {
  test.describe(
    touch ? "touch user-message actions" : "pointer user-message actions",
    () => {
      test.use({ hasTouch: touch });
      test("Copy and Fork stay together beside or below text and image bubbles without resizing them", async ({
        page,
      }) => {
        const send = await openMockEventSession(
          page,
          "User message actions",
          emptyToolPresentationConfiguration(),
          {
            theme: "dark",
            palette: "classic-amber",
          },
        );
        send(
          ...conversationFeedbackMessages
            .filter((message) => message.role === "user")
            .map((message) => ({
              type: "message_end",
              message,
            })),
        );
        const image = {
          type: "image",
          mimeType: "image/png",
          data: readFileSync(
            "tests/browser/fixtures/file-previews/training curve.png",
          ).toString("base64"),
        };
        for (const captioned of [true, false]) {
          const id = captioned ? "image-caption" : "image-only";
          send({
            type: "message_end",
            message: {
              role: "user",
              content: captioned
                ? [
                    image,
                    {
                      type: "text",
                      text: "Check the image alongside its caption.",
                    },
                  ]
                : [image],
              __inspireEntryId: `feedback-${id}`,
              __inspireMessageId: `feedback-user-${id}`,
            },
          });
        }

        await expect(page.locator(".turn--user")).toHaveCount(4);
        await page.evaluate(() => document.fonts.ready);
        const viewports = [1440, 820, 520, 480, 440, 390, 320].map((width) => ({
          width,
          height: 1000,
        }));
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          for (const preview of await page
            .locator(".image-preview--message")
            .all()) {
            const box = (await preview.boundingBox())!;
            expect(box.width).toBeGreaterThanOrEqual(104);
            expect(box.width).toBeLessThanOrEqual(160);
            expect(box.width / box.height).toBeCloseTo(4 / 3);
            if (viewport.width <= 390) expect(box.width).toBe(104);
          }
          for (const turn of await page.locator(".turn--user").all()) {
            const copy = turn.getByRole("button", {
              name: "Copy message",
              exact: true,
            });
            await copy.focus();
            await expect(turn.locator(".turn__actions")).toHaveCSS(
              "opacity",
              "1",
            );
            const geometry = await turn.evaluate((el) => {
              const bubble = el
                .querySelector(".user-bubble")!
                .getBoundingClientRect();
              const actions = el
                .querySelector(".turn__actions")!
                .getBoundingClientRect();
              const buttons = [...el.querySelectorAll(".turn__action")].map(
                (b) => b.getBoundingClientRect(),
              );
              const row = el.getBoundingClientRect();
              const actionGroup =
                el.querySelector<HTMLElement>(".turn__actions")!;
              actionGroup.style.display = "none";
              const independentBubble = el
                .querySelector(".user-bubble")!
                .getBoundingClientRect();
              actionGroup.style.removeProperty("display");
              return {
                bubbleWidth: bubble.width,
                rowWidth: row.width,
                fitsBeside:
                  bubble.width +
                    actions.width +
                    parseFloat(getComputedStyle(el).columnGap) <=
                  row.width + 0.5,
                beside: actions.right <= bubble.left,
                sideGap: bubble.left - actions.right,
                bottomInset: bubble.bottom - actions.bottom,
                widthChange: bubble.width - independentBubble.width,
                heightChange: bubble.height - independentBubble.height,
                sameRow: Math.abs(buttons[0]!.top - buttons[1]!.top) < 1,
                buttonGap: buttons[1]!.left - buttons[0]!.right,
                height: actions.height,
                rightAligned: Math.abs(actions.right - bubble.right) < 1,
                bubbleGap: actions.top - bubble.bottom,
                contained: [bubble, actions].every(
                  (box) =>
                    box.top >= row.top &&
                    box.bottom <= row.bottom + 1 &&
                    box.left >= row.left - 1 &&
                    box.right <= row.right + 1,
                ),
                overflow: el.scrollWidth - el.clientWidth,
              };
            });
            expect(geometry.bubbleWidth).toBeLessThanOrEqual(geometry.rowWidth);
            expect(geometry.sameRow).toBe(true);
            expect(geometry.buttonGap).toBeGreaterThanOrEqual(4);
            expect(geometry.height).toBeLessThanOrEqual(32);
            expect(geometry.beside).toBe(geometry.fitsBeside);
            expect(Math.abs(geometry.widthChange)).toBeLessThanOrEqual(1);
            expect(Math.abs(geometry.heightChange)).toBeLessThanOrEqual(1);
            if (geometry.beside) {
              expect(geometry.sideGap).toBe(8);
              expect(Math.abs(geometry.bottomInset)).toBeLessThanOrEqual(1);
            } else {
              expect(geometry.rightAligned).toBe(true);
              expect(geometry.bubbleGap).toBeGreaterThanOrEqual(2);
              expect(geometry.bubbleGap).toBeLessThanOrEqual(8);
            }
            expect(geometry.contained).toBe(true);
            expect(geometry.overflow).toBeLessThanOrEqual(1);
            await copy.press("Tab");
            await expect(
              turn.getByRole("button", {
                name: "Fork session from this input",
              }),
            ).toBeFocused();
          }
        }
      });
    },
  );
}
