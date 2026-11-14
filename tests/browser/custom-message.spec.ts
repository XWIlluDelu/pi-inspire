import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { conversationFeedbackMessages } from "../web/fixtures/conversation-feedback";
import {
  customMessageConfiguration,
  incomingRelay,
} from "../web/fixtures/custom-message-presentation";
import { renderedColors } from "./support/colors";
import { openEventSession } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import { openConversationSearch, openSettings } from "./support/navigation";

test.use({ serviceWorkers: "block" });

async function openReview(page: Page, adapter?: boolean) {
  const send = await openEventSession(
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
    adapter
      ? [{ id: "review", name: "Review renderer", enabled: true }]
      : undefined,
  );
  return (message: ReturnType<typeof incomingRelay>) =>
    send({ type: "message_end", message });
}

function headerOffsets(element: Element) {
  const center = (selector: string) => {
    const rect = element.querySelector(selector)!.getBoundingClientRect();
    return rect.top + rect.height / 2;
  };
  const identity = center(".custom-message__identity");
  return [
    center(".custom-message__head > svg") - identity,
    center(".custom-message__copy") - identity,
  ];
}

test("sender-led custom messages preserve content, keyboard inspection and responsive reading", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const send = await openReview(page, true);
  const message = incomingRelay();
  send(message);
  const card = page.getByRole("article", { name: "Inspire: composer editing" });
  await expect(
    card.getByRole("heading", { name: "Composer review ready" }),
  ).toBeVisible();
  await expect(card.locator(".custom-message__source")).toHaveText("Relay");
  await expect(card.locator(".custom-message__body strong").last()).toHaveText(
    "final paragraph",
  );
  await expect(card.locator("details pre")).toHaveCount(0);
  await expect(card).not.toContainText("To reply, use the relay tool");

  await page.setViewportSize({ width: 320, height: 1000 });
  await card.scrollIntoViewIfNeeded();
  for (const offset of await card.evaluate(headerOffsets))
    expect(Math.abs(offset)).toBeLessThan(0.5);
  expect(
    await card.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);

  const summary = card.locator("summary");
  await summary.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(summary).toBeFocused();
  await summary.press("Enter");
  await expect(card.locator("details")).toHaveAttribute("open", "");
  const raw = await card.locator("details pre").textContent();
  expect(JSON.parse(raw!)).toEqual({
    customType: message.customType,
    content: message.content,
    details: message.details,
  });
  await page.route("**/api/presentation-adapters/review", async (route) => {
    const { enabled } = route.request().postDataJSON();
    const publication = await (
      await hostRequest(page).get("/api/preferences")
    ).json();
    await route.fulfill({
      json: {
        configuration: enabled
          ? customMessageConfiguration
          : { version: 1, rules: {}, mappings: {} },
        adapters: [{ id: "review", name: "Review renderer", enabled }],
        preferences: publication.preferences,
        preferenceRevision: publication.revision,
      },
    });
  });
  await openSettings(page);
  await page.getByRole("button", { name: "Adapters", exact: true }).click();
  const adapter = page.getByRole("switch", { name: "Review renderer" });
  await adapter.press("Space");
  await expect(adapter).not.toBeChecked();
  await page.keyboard.press("Escape");
  const unconfigured = page.getByRole("article", { name: "Relay message" });
  await expect(unconfigured.locator("details")).toHaveAttribute("open", "");
  await expect(unconfigured).toContainText("To reply, use the relay tool");
  await openSettings(page);
  await page.getByRole("button", { name: "Adapters", exact: true }).click();
  await adapter.press("Space");
  await expect(adapter).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(card.locator("details")).toHaveAttribute("open", "");
  await expect(card.locator("details pre")).toHaveText(raw!);
  await summary.press("Space");
  await expect(card.locator("details pre")).toHaveCount(0);
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
  const longMessage = incomingRelay("The full body is still here.");
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
  for (const offset of await longCard.evaluate(headerOffsets))
    expect(Math.abs(offset)).toBeLessThan(0.5);

  const external = incomingRelay("Unverified review paragraph");
  external.__inspireMessageId = "external-custom";
  external.content =
    "**From remote@other-host · unverified cross-machine**\n\n" +
    "Unverified review paragraph\n\n<script>globalThis.customMarkupRan = true</script>";
  external.details = {
    ...(external.details as object),
    message: { crossMachine: { trust: "unverified" } },
  };
  send(external);
  send({
    ...external,
    __inspireMessageId: "hidden-context-custom",
    display: false,
    content: "Private model context",
  });
  const mixed = {
    ...external,
    __inspireMessageId: "mixed-custom",
    content: [
      { type: "text", text: "**Original block**" },
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
      },
      { type: "future", data: "Unrecognized payload" },
      "Primitive payload",
      { type: "text", text: "After" },
    ],
  };
  send(mixed);
  const fallback = page
    .getByRole("article", { name: "Relay message" })
    .filter({ hasText: "Unverified review paragraph" });
  const blocks = page
    .getByRole("article", { name: "Relay message" })
    .filter({ hasText: "Original block" });
  await expect(blocks.locator("strong")).toHaveText("Original block");
  for (const preserved of [
    "Unrecognized payload",
    "Primitive payload",
    "After",
  ])
    await expect(
      blocks.getByText(preserved, { exact: preserved === "After" }),
    ).toBeVisible();
  await expect(blocks.locator("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await expect(
    fallback.getByText("From remote@other-host · unverified cross-machine", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(fallback.locator("script")).toHaveCount(0);
  await expect(page.getByText("Private model context")).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  const search = await openConversationSearch(page);
  await search.fill("Unverified review paragraph");
  const matches = page.getByLabel("Transcript search matches");
  await expect(matches).toHaveText("1 match");
  for (const scope of ["user", "model"]) {
    await page
      .getByRole("combobox", { name: "Search scope" })
      .selectOption(scope);
    await expect(matches).toHaveText("0 matches");
  }

  expect(errors).toEqual([]);
});

test("context and extension glyphs follow Tool through live palette changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const send = await openReview(page);
  send(conversationFeedbackMessages[1]!);
  send(incomingRelay("The full message remains independently readable."));
  const checkpoint = page.getByRole("button", {
    name: "Context compacted",
    exact: true,
  });
  const message = page.getByRole("article", {
    name: "Inspire: composer editing",
  });
  await expect(checkpoint).toBeVisible();
  await expect(message).toBeVisible();
  for (const [palette, theme] of [
    ["chimonanthus", "light"],
    ["hydrangea", "dark"],
  ]) {
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
      checkpoint.locator(".card__icon svg"),
      message.locator(".custom-message__head > svg"),
    ]) {
      await expect(glyph).toHaveCSS("color", tool);
      expect((await renderedColors(glyph)).contrast).toBeGreaterThanOrEqual(3);
    }
  }
});

test("Markdown tables preserve word minima and keep long tokens in their own scrollport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const send = await openReview(page);
  const token = "AnUnbrokenTableToken".repeat(20);
  send(
    incomingRelay(
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
  test("keeps touch Copy and Details targets clear of the message body", async ({
    page,
  }) => {
    const send = await openReview(page);
    send(incomingRelay());
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
    await expect(card.locator("details pre")).toContainText("replyCommand");
    await summary.tap();
    await expect(card.locator("details pre")).toHaveCount(0);
    expect(
      await card.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
  });
});
