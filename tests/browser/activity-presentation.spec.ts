import { expect, test } from "@playwright/test";
import { codemodeCalls } from "../../shared/tool-activity";
import { activityReadingMessages } from "../web/fixtures/activity-reading";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import { openEventSession } from "./support/host-events";
import { openFixtureSession, pairedPage } from "./support/navigation";

test("saved activity opens from the keyboard and keeps its disclosure and Copy independently reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  const fold = page.locator(".activity-fold").first();
  const disclosure = fold.getByRole("button", { name: /assistant activity/i });
  const content = fold.locator(".activity-fold__content");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(fold.locator(".activity-fold__summary")).toContainText(/step/);
  await disclosure.press("Enter");
  await expect(disclosure).toBeFocused();
  await expect(content).toBeVisible();
  expect(
    await fold.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  const card = fold.locator(".card--tool").first();
  const toggle = card.locator(".card__disclosure");
  const header = card.locator(".card__header");
  if ((await toggle.getAttribute("aria-expanded")) === "true")
    await toggle.click();

  await header.click({
    position: { x: (await header.boundingBox())!.width - 24, y: 12 },
  });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const copy = header.locator(".card__copy");
  await copy.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(toggle).toBeFocused();
  expect(
    await toggle.evaluate(
      (button) => getComputedStyle(button, "::after").outlineStyle,
    ),
  ).toBe("solid");
  await copy.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await disclosure.press("Enter");
  await expect(disclosure).toBeFocused();
  await expect(content).toBeHidden();
});

test("success and failure cues retain semantic color in tools and nested calls", async ({
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
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const [selector, token] of [
      [".card--thinking .card__icon", "--activity-think"],
      [".card--tool .card__icon", "--activity-tool"],
      ['.card__status [data-status="success"]', "--success"],
      ['.card__status [data-status="error"]', "--error"],
      ['.child-call__status [data-status="success"]', "--success"],
      ['.child-call__status [data-status="error"]', "--error"],
      ['.card__status .pi-status[data-status="neutral"]', "--muted"],
      ['.child-call__status[data-status="cancelled"] .pi-status', "--muted"],
    ]) {
      const cue = page.locator(selector!).first();
      await expect(cue).toBeVisible();
      const colors = await cue.evaluate((element, token) => {
        const sample = document.createElement("span");
        sample.style.color = `var(${token})`;
        element.append(sample);
        const colors = {
          actual: getComputedStyle(element).color,
          semantic: getComputedStyle(sample).color,
        };
        sample.remove();
        return colors;
      }, token!);
      expect(colors.actual).toBe(colors.semantic);
    }
  }
});

test.describe("touch activity disclosures", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("tap feedback clears without a selected row and keyboard focus remains visible", async ({
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
      {
        type: "message_end",
        message: {
          role: "compactionSummary",
          summary: "Magic Context compacted: Keep the interaction decisions.",
          __inspireCompactionSource: "magic-context",
          __inspireMessageId: "touch-checkpoint",
          tokensBefore: 1842,
        },
      },
    );
    const thinking = page.locator(".card--thinking").first();
    const tool = page.locator(".card--tool").first();
    const checkpoint = page.locator(".context-checkpoint");
    for (const surface of [thinking, tool, checkpoint]) {
      const toggle = surface.locator(".card__disclosure");
      const copy = surface.locator(".card__copy");
      await expect(copy).toHaveCount(0);
      const restingBackground = await toggle.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      const row = surface.locator(".card__header");
      await row.tap({
        position: { x: (await row.boundingBox())!.width - 24, y: 12 },
      });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(copy).toBeVisible();
      const { width, height } = (await copy.boundingBox())!;
      expect(Math.min(width, height)).toBeGreaterThanOrEqual(32);
      expect(
        await surface.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
      await copy.tap();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await toggle.tap();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(copy).toHaveCount(0);
      await expect(toggle).toHaveCSS("background-color", restingBackground);
      await toggle.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(toggle).toBeFocused();
      expect(
        await toggle.evaluate(
          (el) => getComputedStyle(el, "::after").outlineStyle,
        ),
      ).not.toBe("none");
    }
    await page
      .getByRole("button", { name: "Collapse assistant activity" })
      .first()
      .tap();
    await expect(
      page.getByRole("article", { name: "Inspire: composer editing" }),
    ).toContainText("The keyboard checks are complete.");
  });
});
