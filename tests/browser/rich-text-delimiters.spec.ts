import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import {
  escapedCurrencyMath,
  literalReviewText,
  richTextLiteralCases,
  wideInlineMath,
} from "../web/fixtures/rich-text-literals";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { openEventSession } from "./support/host-events";

test("keeps inline math and display scrolling local to narrow readers", async ({
  page,
}) => {
  const file = join(browserWorkspace, "inline-math-layout.md");
  const formulas =
    String.raw`Short $G_{\mathrm{mean}}B_*$ comparison.` +
    "\n\n$$x+1$$\n\n$$" +
    wideInlineMath +
    "$$";
  await writeFile(file, formulas);
  try {
    await page.setViewportSize({ width: 320, height: 844 });
    const send = await openEventSession(
      page,
      "Inline math reading",
      customMessageConfiguration,
      {},
    );
    send(
      {
        type: "message_end",
        message: {
          role: "user",
          content: formulas,
          __inspireMessageId: "user-math",
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "[Read formulas](inline-math-layout.md)\n\n" + formulas,
            },
          ],
          __inspireMessageId: "assistant-math",
        },
      },
    );
    const overflow = (el: Element) => el.scrollWidth - el.clientWidth;
    const assistant = page.locator(".rich-text--assistant");
    const user = page.locator(".turn--user .rich-text");
    const checkLayout = async (reader: Locator) => {
      const inline = reader.locator(".inline-math");
      await expect(inline).toHaveCSS("display", "inline");
      await expect(inline).toHaveCSS("overflow-x", "visible");
      const displays = reader.locator(".katex-display");
      expect(await displays.first().evaluate(overflow)).toBeLessThanOrEqual(1);
      expect(await displays.last().evaluate(overflow)).toBeGreaterThan(100);
      expect(await reader.evaluate(overflow)).toBeLessThanOrEqual(1);
    };
    await checkLayout(assistant);
    await checkLayout(user);
    const display = assistant.locator(".katex-display").last();
    await display.focus();
    await display.press("ArrowRight");
    await expect
      .poll(() => display.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
    expect(await page.getByRole("log").evaluate(overflow)).toBeLessThanOrEqual(
      1,
    );

    await page.getByRole("link", { name: "Read formulas" }).click();
    await checkLayout(page.locator(".ctx .rich-text"));
  } finally {
    await rm(file, { force: true });
  }
});

test("large streaming Markdown resolves late references without losing the composer draft", async ({
  page,
}) => {
  const send = await openEventSession(
    page,
    "Streaming Markdown boundaries",
    customMessageConfiguration,
    {},
  );
  let text =
    literalReviewText +
    "\n\n$" +
    escapedCurrencyMath +
    "$\n\n[Forward][later]\n\n" +
    "Detailed findings remain plain text. ".repeat(1500);
  const message = () => ({
    role: "assistant",
    content: [{ type: "text", text }],
    __inspireMessageId: "large-rich-text",
  });
  send({ type: "agent_start" }, { type: "message_start", message: message() });
  const prose = page.locator(".rich-text--assistant").last();
  await expect(prose.locator("annotation")).toHaveText(escapedCurrencyMath);
  for (const [, literal] of richTextLiteralCases)
    await expect(prose).toContainText(literal);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.focus();
  await Promise.all([
    input.pressSequentially("Keep this draft", { delay: 20 }),
    (async () => {
      for (let index = 0; index < 10; index++) {
        text += `\n\nStreaming token ${index}.`;
        send({ type: "message_update", message: message() });
        await page.waitForTimeout(20);
      }
      text += "\n\n[later]: ./docs/reference.md\n\n**Latest rich text**";
      send({ type: "message_update", message: message() });
    })(),
  ]);
  await expect(input).toHaveValue("Keep this draft");
  await expect(prose.getByText("Forward", { exact: true })).toHaveAttribute(
    "data-file-path",
    "./docs/reference.md",
  );
  await expect(prose.locator("strong").last()).toHaveText("Latest rich text");
});
