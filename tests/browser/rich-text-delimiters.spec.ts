import { expect, test } from "@playwright/test";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import {
  escapedCurrencyMath,
  literalReviewText,
  richTextLiteralCases,
  wideInlineMath,
} from "../web/fixtures/rich-text-literals";
import { openMockEventSession } from "./support/mock-host";

test("regex anchors stay prose beside genuine math across message surfaces", async ({
  page,
}, testInfo) => {
  const send = await openMockEventSession(
    page,
    "Markdown boundaries",
    customMessageConfiguration,
    {
      activityFoldVisibility: "expanded",
      thinkingVisibility: "expanded",
    },
  );
  const text =
    "Review the identifier check: /^\\d+$/ accepts non-canonical decimal spellings. Keep the ordinary words and spaces; this is still prose, not a formula. Normalize the directory before assigning its identifier. Replace the pattern with /^(0|[1-9]\\d*)$/ instead. Preserve **this emphasis** and the genuine formula $x+1$.";
  send(
    {
      type: "message_end",
      message: {
        role: "user",
        content: text,
        __inspireMessageId: "regex-user",
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: text },
          { type: "text", text },
        ],
        __inspireMessageId: "regex-assistant",
      },
    },
    {
      type: "message_end",
      message: {
        role: "custom",
        customType: "intercom_message",
        content: text,
        display: true,
        details: {
          from: { id: "regex-review", name: "Regex review" },
          bodyText: text,
        },
        __inspireMessageId: "regex-custom",
      },
    },
  );
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1200 });
    for (const selector of [
      ".turn--user .rich-text",
      ".rich-text--assistant",
      ".rich-text--thinking",
      ".custom-message__body .rich-text",
    ]) {
      const prose = page.locator(selector).first();
      await expect(prose).toContainText(
        "Keep the ordinary words and spaces; this is still prose, not a formula.",
      );
      await expect(prose.locator("strong")).toHaveText("this emphasis");
      await expect(prose.locator(".katex")).toHaveCount(1);
      await expect(prose.locator("annotation")).toHaveText("x+1");
      expect(
        await prose.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
    }
    const article = page.getByRole("article", {
      name: "Regex review",
      exact: true,
    });
    await article.screenshot({
      path: testInfo.outputPath(width + "-regex-review.png"),
    });
  }
});

test("literal syntax and wide formulas remain readable across message surfaces", async ({
  page,
}, testInfo) => {
  const send = await openMockEventSession(
    page,
    "Literal and formula boundaries",
    customMessageConfiguration,
    {
      activityFoldVisibility: "expanded",
      thinkingVisibility: "expanded",
    },
  );
  const text =
    literalReviewText +
    "\n\n$" +
    escapedCurrencyMath +
    "$\n\nInline vector $" +
    wideInlineMath +
    "$.\n\n$$" +
    wideInlineMath +
    "$$";
  const surfaces = [
    {
      selector: ".turn--user .rich-text",
      message: { role: "user", content: text },
    },
    {
      selector: ".rich-text--thinking",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: text }],
      },
    },
    {
      selector: ".rich-text--assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
    {
      selector: ".custom-message__body .rich-text",
      message: {
        role: "custom",
        customType: "intercom_message",
        content: text,
        display: true,
        details: { from: { name: "Boundary review" }, bodyText: text },
      },
    },
  ];
  for (const [index, surface] of surfaces.entries()) {
    send({
      type: "message_end",
      message: { ...surface.message, __inspireMessageId: "boundary-" + index },
    });
    await page
      .locator(".transcript")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    const prose = page.locator(surface.selector).last();
    await expect(prose.locator("annotation")).toHaveCount(3);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      await prose.scrollIntoViewIfNeeded();
      for (const [, literal] of richTextLiteralCases)
        await expect(prose).toContainText(literal);
      await expect(prose.locator(".katex-error")).toHaveCount(0);
      await expect(prose.locator("annotation").first()).toHaveText(
        escapedCurrencyMath,
      );
      expect(
        await prose.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      const vector = prose.locator(".inline-math").last();
      const overflow = await vector.evaluate(
        (el) => el.scrollWidth - el.clientWidth,
      );
      if (width <= 390) {
        expect(overflow).toBeGreaterThan(100);
        await vector.evaluate((el) => (el.scrollLeft = el.scrollWidth));
        expect(await vector.evaluate((el) => el.scrollLeft)).toBeGreaterThan(
          100,
        );
        await vector.evaluate((el) => (el.scrollLeft = 0));
        await vector.focus();
        await expect(vector).toBeFocused();
        await page.keyboard.press("ArrowRight");
        await expect
          .poll(() => vector.evaluate((el) => el.scrollLeft))
          .toBeGreaterThan(0);
        await vector.evaluate((el) => (el.scrollLeft = 0));
      }
    }
    if (index === surfaces.length - 1)
      await page
        .getByRole("article", { name: "Boundary review", exact: true })
        .screenshot({ path: testInfo.outputPath("320-boundary-review.png") });
  }
});

test("large messages use the same literal and escape rules in the parser worker", async ({
  page,
}) => {
  const send = await openMockEventSession(
    page,
    "Worker Markdown boundaries",
    customMessageConfiguration,
    {},
  );
  const text =
    literalReviewText +
    "\n\n$" +
    escapedCurrencyMath +
    "$\n\n" +
    "Detailed findings remain plain text. ".repeat(1000);
  expect(text.length).toBeGreaterThan(32000);
  const worker = page.waitForEvent("worker", {
    predicate: (worker) => worker.url().includes("rich-text-worker"),
  });
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      __inspireMessageId: "worker-boundaries",
    },
  });
  await worker;
  const prose = page.locator(".rich-text--assistant");
  await expect(prose.locator("annotation")).toHaveText(escapedCurrencyMath);
  await expect(prose).not.toHaveAttribute("aria-busy", "true");
  for (const [, literal] of richTextLiteralCases)
    await expect(prose).toContainText(literal);
  await expect(prose.locator(".katex-error")).toHaveCount(0);
});
