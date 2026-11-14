import { expect, test } from "@playwright/test";
import { codemodeCalls } from "../../shared/tool-activity";
import { activityReadingMessages } from "../web/fixtures/activity-reading";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import { openEventSession } from "./support/host-events";

test("interrupted calls stay neutral and nested failures remain keyboard-readable", async ({
  page,
}) => {
  const send = await openEventSession(
    page,
    "Activity states",
    customMessageConfiguration,
    {
      activityFoldVisibility: "expanded",
      toolVisibility: "compact",
    },
  );
  const messages = activityReadingMessages();
  const code = messages.find(
    (message) =>
      message.role === "toolResult" &&
      "toolCallId" in message &&
      message.toolCallId === "reading-code",
  ) as { details: { calls: Record<string, unknown>[] } } | undefined;
  if (!code || !("details" in code) || !code.details?.calls)
    throw new Error("Missing nested activity fixture");
  code.details.calls.push(
    {
      id: "failed-child",
      name: "preview_check",
      args: "{}",
      status: "error",
      error: "Preview check failed",
      durationMs: 30,
    },
    {
      id: "cancelled-child",
      name: "read",
      args: '{"path":"notes.md"}',
      status: "cancelled",
    },
  );
  send(
    ...messages.map((message) => ({
      type: "message_end",
      message:
        message === code
          ? { ...message, __inspireCalls: codemodeCalls(code.details) }
          : message,
    })),
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "not-executed",
            name: "read",
            arguments: { path: "notes.md" },
            __inspireToolCall: {
              phase: "interrupted",
              characters: 20,
              truncated: false,
            },
          },
          {
            type: "toolCall",
            id: "unrecorded",
            name: "read",
            arguments: { path: "notes.md" },
          },
        ],
      },
    },
  );
  for (const label of ["not executed", "no result"]) {
    const mark = page.getByLabel(label, { exact: true });
    await expect(mark).toHaveAttribute("data-status", "neutral");
    await expect(mark).toHaveCSS("animation-name", "none");
  }
  const codeCard = page
    .locator(".card--tool")
    .filter({ hasText: "CodeMode" })
    .first();
  await codeCard.locator(".card__disclosure").click();
  const detail = codeCard
    .locator("details.child-call")
    .filter({ hasText: "preview_check" });
  await page.setViewportSize({ width: 320, height: 1000 });
  const summary = detail.locator("summary");
  await summary.press("Enter");
  await expect(summary).toBeFocused();
  await expect(detail.getByRole("group", { name: "Call error" })).toBeVisible();
  expect(
    await codeCard.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test.describe("touch activity disclosures", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("touch disclosures toggle independently of the assistant response", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const send = await openEventSession(
      page,
      "Touch disclosures",
      customMessageConfiguration,
      {
        thinkingVisibility: "collapsed",
        toolVisibility: "compact",
        activityFoldVisibility: "expanded",
      },
    );
    send(
      ...activityReadingMessages().map((message) => ({
        type: "message_end",
        message,
      })),
    );
    const thinking = page.locator(".card--thinking").first();
    const toggle = thinking.locator(".card__disclosure");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(thinking.locator(".card__copy")).toBeVisible();
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page
      .getByRole("button", { name: "Collapse assistant activity" })
      .first()
      .tap();
    await expect(
      page.getByRole("article", { name: "Inspire: composer editing" }),
    ).toContainText("The keyboard checks are complete.");
  });
});
