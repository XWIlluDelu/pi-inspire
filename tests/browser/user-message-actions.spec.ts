import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { openEventSession } from "./support/host-events";

test.use({
  serviceWorkers: "block",
  contextOptions: { reducedMotion: "reduce" },
});

for (const [mode, width, touch] of [
  ["desktop", 1440, false],
  ["narrow touch", 320, true],
] as const) {
  test.describe(mode, () => {
    test.use({ hasTouch: touch, viewport: { width, height: 1000 } });
    test("keeps Copy and Fork together without covering the user bubble", async ({
      page,
    }) => {
      const send = await openEventSession(
        page,
        "User message actions",
        emptyToolPresentationConfiguration(),
        {},
      );
      const image = {
        type: "image",
        mimeType: "image/png",
        data: readFileSync(
          "tests/browser/fixtures/file-previews/training curve.png",
        ).toString("base64"),
      };
      const messages = [
        "Short user input",
        [
          {
            type: "text",
            text: "Review this calibration result alongside the reference. ".repeat(
              4,
            ),
          },
          image,
        ],
      ];
      for (const [index, content] of messages.entries())
        send({
          type: "message_end",
          message: {
            role: "user",
            content,
            __inspireEntryId: `user-actions-${index}`,
            __inspireMessageId: `user-actions-${index}`,
          },
        });

      send({
        type: "message_end",
        message: { role: "assistant", content: "Calibration answer" },
      });
      const turns = page.locator(".turn--user");
      await expect(turns).toHaveCount(2);
      await page.evaluate(() => document.fonts.ready);
      for (const turn of await turns.all()) {
        const copy = turn.getByRole("button", {
          name: "Copy message",
          exact: true,
        });
        const fork = turn.getByRole("button", {
          name: "Fork session from this input",
        });
        await copy.press("Tab");
        await expect(fork).toBeFocused();
        await expect(turn.locator(".turn__actions")).toHaveCSS("opacity", "1");
        await expect(copy).toBeInViewport({ ratio: 1 });
        await expect(fork).toBeInViewport({ ratio: 1 });
        const [copyBox, forkBox, bubble] = await Promise.all([
          copy.boundingBox(),
          fork.boundingBox(),
          turn.locator(".user-bubble").boundingBox(),
        ]);
        expect(forkBox!.x).toBeGreaterThanOrEqual(copyBox!.x + copyBox!.width);
        // The actions can sit beside or below the bubble, but must not cover it.
        expect(
          forkBox!.x + forkBox!.width <= bubble!.x ||
            forkBox!.y >= bubble!.y + bubble!.height,
        ).toBe(true);
        expect(
          await turn.evaluate((el) => el.scrollWidth - el.clientWidth),
        ).toBeLessThanOrEqual(1);
      }

      if (touch) return;
      const log = page.getByRole("log");
      const fork = { name: "Fork session from this input" };
      await expect(log.getByRole("button", fork)).toHaveCount(2);
      await page.route("**/api/branches/fork", (route) =>
        route.fulfill({
          status: 404,
          json: { error: "Fixture entry has no persisted counterpart" },
        }),
      );
      const request = page.waitForRequest("**/api/branches/fork");
      await turns.last().getByRole("button", fork).click();
      expect((await request).postDataJSON()).toMatchObject({
        targetId: "user-actions-1",
      });
    });
  });
}
