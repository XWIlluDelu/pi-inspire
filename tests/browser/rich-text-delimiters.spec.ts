import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import {
  escapedCurrencyMath,
  literalReviewText,
  richTextLiteralCases,
  wideInlineMath,
} from "../web/fixtures/rich-text-literals";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { openMockEventSession } from "./support/mock-host";

test("regex anchors stay prose beside genuine math across message surfaces", async ({
  page,
}) => {
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
  }
});

test("literal syntax and wide formulas remain readable across message surfaces", async ({
  page,
}) => {
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
    "$\n\nInline comparison $G_{\\mathrm{mean}}B_*$.\n\n" +
    "| Name | Meaning |\n| --- | --- |\n| $G_{\\mathrm{mean}}$ | Average gain |\n\n" +
    "- Compare $G_{\\mathrm{center}}$ with the measured gain.\n\n$$" +
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
    await expect(prose.locator("annotation")).toHaveCount(5);
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
      for (const inline of await prose.locator(".inline-math").all()) {
        await expect(inline).toHaveCSS("display", "inline");
        await expect(inline).toHaveCSS("overflow-x", "visible");
        await expect(inline).toHaveCSS("overflow-y", "visible");
      }
      const vector = prose.locator(".katex-display").last();
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
  }
});

test("inline formulas remain natural in chat and Markdown file previews", async ({
  page,
}) => {
  const file = join(browserWorkspace, "inline-math-layout.md");
  const text =
    String.raw`Short $G_{\mathrm{mean}}B_*$ comparison.

| Name | Meaning |
| --- | --- |
| $G_{\mathrm{mean}}$ | Average gain |

- Compare $G_{\mathrm{center}}$ with the measured gain.
- Preserve $\displaystyle\frac{\sum_{i=1}^{n}w_ix_i}{\sum_{i=1}^{n}w_i}$ completely.

$$x+1$$

$$` +
    wideInlineMath +
    "$$";
  await writeFile(file, text);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const send = await openMockEventSession(
      page,
      "Inline math reading",
      customMessageConfiguration,
      {},
    );
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: text + "\n\n[Read formulas](inline-math-layout.md)",
          },
        ],
        __inspireMessageId: "inline-math-reading",
      },
    });
    await page
      .getByRole("link", { name: "Read formulas", exact: true })
      .click();
    const resize = page.getByRole("separator", {
      name: "Resize files panel",
      exact: true,
    });
    const handle = (await resize.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 24);
    await page.mouse.down();
    await page.mouse.move(0, handle.y + 24, { steps: 8 });
    await page.mouse.up();
    expect((await page.locator(".center").boundingBox())!.width).toBeCloseTo(
      400,
      0,
    );
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const selector of width === 1440
        ? [".center .rich-text--assistant", ".ctx .rich-text"]
        : [".ctx .rich-text"]) {
        const reader = page.locator(selector).last();
        await expect(reader.locator(".inline-math")).toHaveCount(4);
        for (const formula of await reader.locator(".inline-math").all()) {
          await expect(formula).toHaveCSS("display", "inline");
          await expect(formula).toHaveCSS("overflow-x", "visible");
          await expect(formula).toHaveCSS("overflow-y", "visible");
        }
        const displays = reader.locator(".katex-display");
        await expect(displays).toHaveCount(2);
        expect(
          await displays
            .first()
            .evaluate((el) => el.scrollWidth - el.clientWidth),
        ).toBeLessThanOrEqual(1);
        if (width <= 390 || selector === ".center .rich-text--assistant")
          expect(
            await displays
              .last()
              .evaluate((el) => el.scrollWidth - el.clientWidth),
          ).toBeGreaterThan(100);
        expect(
          await reader.evaluate((el) => el.scrollWidth - el.clientWidth),
        ).toBeLessThanOrEqual(1);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBeLessThanOrEqual(1);
    }
  } finally {
    await rm(file, { force: true });
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
