import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { PALETTE_PREFERENCES } from "../../shared/contracts";
import { conversationFeedbackMessages } from "../web/fixtures/conversation-feedback";
import {
  customMessageConfiguration,
  incomingIntercom,
} from "../web/fixtures/custom-message-presentation";
import { renderedColors } from "./support/colors";
import { openMockEventSession } from "./support/mock-host";

test.use({ serviceWorkers: "block" });

async function openReview(page: Page) {
  const send = await openMockEventSession(
    page,
    "Custom message review",
    customMessageConfiguration,
    {
      theme: "light",
      palette: "chimonanthus",
      toolVisibility: "hidden",
      thinkingVisibility: "hidden",
      activityFoldVisibility: "collapsed",
    },
  );
  return (message: ReturnType<typeof incomingIntercom>) =>
    send({ type: "message_end", message });
}

test("sender-led custom messages preserve content, keyboard inspection and responsive reading", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const send = await openReview(page);
  const message = incomingIntercom();
  send(message);
  const card = page.getByRole("article", { name: "Inspire: composer editing" });
  await expect(
    card.getByRole("heading", { name: "Composer review ready" }),
  ).toBeVisible();
  await expect(card.locator(".custom-message__source")).toHaveText("Intercom");
  await expect(card.locator(".custom-message__body strong").last()).toHaveText(
    "final paragraph",
  );
  await expect(
    card.locator(
      ".custom-message__raw, .custom-message__type, time, .card__status",
    ),
  ).toHaveCount(0);
  for (const hidden of [
    "intercom_message",
    "To reply",
    "/home/reviewer",
    "seq 42",
    "2030-",
    "broker",
    "injected",
  ])
    await expect(card).not.toContainText(hidden);

  for (const [width, theme] of [
    [1280, "light"],
    [390, "dark"],
    [320, "light"],
  ] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await card.scrollIntoViewIfNeeded();
    expect(
      await card.evaluate(
        (element) =>
          element.scrollWidth <= element.clientWidth + 1 &&
          element.closest(".transcript")!.scrollWidth <=
            element.closest(".transcript")!.clientWidth + 1,
      ),
    ).toBe(true);
  }

  const summary = card.locator("summary");
  await summary.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(summary).toBeFocused();
  await summary.press("Enter");
  await expect(card.locator("details")).toHaveAttribute("open", "");
  const raw = await card.locator(".custom-message__raw").textContent();
  expect(JSON.parse(raw!)).toEqual({
    customType: message.customType,
    content: message.content,
    details: message.details,
  });
  await summary.press("Space");
  await expect(card.locator(".custom-message__raw")).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).include(".custom-message").analyze())
      .violations,
  ).toEqual([]);

  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  const copy = card.getByRole("button", {
    name: "Copy inspire: composer editing block",
  });
  await copy.focus();
  await copy.press("Enter");
  await expect(
    card.getByRole("button", {
      name: "Inspire: composer editing block copied",
    }),
  ).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\r\n/g, "\n")).toContain(
    String(message.content).replace(/\r\n/g, "\n"),
  );
  expect(copied.replace(/\r\n/g, "\n")).toContain(
    JSON.stringify(message.details, null, 2),
  );

  // Unbroken titles reflow rather than colliding with Copy or losing attribution.
  const longMessage = incomingIntercom("The full body is still here.");
  (longMessage.details as { from: { name: string } }).from.name =
    "sender_with_a_very_long_unbroken_name_".repeat(5);
  longMessage.__inspireMessageId = "custom-message-long-sender";
  send(longMessage);
  const longCard = page.getByRole("article", {
    name: "sender_with_a_very_long_unbroken_name_".repeat(5),
  });
  await expect(longCard).toContainText("The full body is still here.");
  const wrappedHeader = await longCard.evaluate((element) => {
    const header = element
      .querySelector(".custom-message__head")!
      .getBoundingClientRect();
    const copy = element
      .querySelector(".custom-message__copy")!
      .getBoundingClientRect();
    return {
      fits: element.scrollWidth <= element.clientWidth + 1,
      headerHeight: header.height,
      copyHeight: copy.height,
    };
  });
  expect(wrappedHeader.fits).toBe(true);
  expect(wrappedHeader.headerHeight).toBeGreaterThan(wrappedHeader.copyHeight);

  expect(errors).toEqual([]);
});

test("context and extension glyphs follow Tool through live palette changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const send = await openReview(page);
  send(conversationFeedbackMessages[1]!);
  send(incomingIntercom("The full message remains independently readable."));
  const checkpoint = page.getByRole("button", {
    name: "Magic Context compacted",
    exact: true,
  });
  const message = page.getByRole("article", {
    name: "Inspire: composer editing",
  });
  await expect(checkpoint).toBeVisible();
  await expect(message).toBeVisible();
  for (const palette of PALETTE_PREFERENCES)
    for (const theme of ["light", "dark"]) {
      const tool = await page.evaluate(
        ({ palette, theme }) => {
          Object.assign(document.documentElement.dataset, { palette, theme });
          const probe = document.createElement("span");
          probe.style.color = "var(--activity-tool)";
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        },
        { palette, theme },
      );
      for (const glyph of [
        checkpoint.locator(".context-checkpoint__icon"),
        message.locator(".custom-message__head > svg"),
      ]) {
        await expect(glyph).toHaveCSS("color", tool);
        expect((await renderedColors(glyph)).contrast).toBeGreaterThanOrEqual(
          3,
        );
      }
    }
  await checkpoint.click();
  await expect(
    page.getByRole("button", { name: "Copy compaction summary", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".context-checkpoint__body")).toContainText(
    "Keep the current design decisions.",
  );
  await expect(message.locator(".custom-message__body")).toHaveText(
    "The full message remains independently readable.",
  );
});

test("Markdown tables preserve word minima and keep long tokens in their own scrollport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const send = await openReview(page);
  const token = "AnUnbrokenTableToken".repeat(20);
  send(
    incomingIntercom(
      `| Surface | Result |\n| --- | --- |\n| Desktop | ${token} |\n\nOutside table: ${token}`,
    ),
  );
  const card = page.getByRole("article", { name: "Inspire: composer editing" });
  const table = card.locator("table");
  await expect(table).toContainText(token);
  const geometry = await table.evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
    wrap: getComputedStyle(element).overflowWrap,
    tokenLines: (() => {
      const range = document.createRange();
      range.selectNodeContents(element.querySelector("tbody td:last-child")!);
      return range.getClientRects().length;
    })(),
  }));
  expect(geometry.scroll).toBeGreaterThan(geometry.width);
  expect(geometry.wrap).toBe("normal");
  expect(geometry.tokenLines).toBe(1);
  const paragraph = card.locator(".rich-text p");
  await expect(paragraph).toContainText(token);
  expect(
    await paragraph.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  expect(
    await card.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
});

test.describe("touch custom messages", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("keeps real Copy and Details targets operable without overlapping content", async ({
    page,
  }) => {
    const send = await openReview(page);
    send(incomingIntercom());
    const card = page.getByRole("article", {
      name: "Inspire: composer editing",
    });
    // Wait for the deferred Markdown body, not its plain-text loading shell:
    // geometry and a rapid second tap must target the stable reading surface.
    await expect(
      card.getByRole("heading", { name: "Composer review ready" }),
    ).toBeVisible();
    const copy = card.getByRole("button", {
      name: "Copy inspire: composer editing block",
    });
    await expect(copy).toBeVisible();
    const copyBox = (await copy.boundingBox())!;
    expect(copyBox.width).toBeGreaterThanOrEqual(32);
    expect(copyBox.height).toBeGreaterThanOrEqual(32);
    const summary = card.locator("summary");
    const summaryBox = (await summary.boundingBox())!;
    expect(summaryBox.height).toBeGreaterThanOrEqual(32);
    const bodyBox = (await card
      .locator(".custom-message__body")
      .boundingBox())!;
    expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(bodyBox.y);
    await summary.tap();
    await expect(card.locator("details")).toHaveAttribute("open", "");
    await expect(card.locator(".custom-message__raw")).toContainText(
      "replyCommand",
    );
    await summary.tap();
    await expect(card.locator(".custom-message__raw")).toHaveCount(0);
    expect(
      await card.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
  });
});
