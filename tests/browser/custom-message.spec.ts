import { expect, type Page, test } from "@playwright/test";
import {
  customMessageConfiguration,
  incomingRelay,
} from "../web/fixtures/custom-message-presentation";
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

test("sender-led custom messages keep keyboard inspection when an adapter is toggled", async ({
  page,
}) => {
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

  const summary = card.locator("summary");
  await summary.focus();
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
  const fallback = page
    .getByRole("article", { name: "Relay message" })
    .filter({ hasText: "Unverified review paragraph" });
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
