import { expect, test } from "@playwright/test";
import { conversationFeedbackMessages } from "../web/fixtures/conversation-feedback";
import { checkpointAdapterConfiguration } from "../web/fixtures/extension-adapters";
import { openEventSession } from "./support/host-events";
import { textBaseline } from "./support/text-baseline";

test.use({
  serviceWorkers: "block",
  hasTouch: true,
  viewport: { width: 1440, height: 1000 },
  contextOptions: { reducedMotion: "reduce" },
});

test("conversation feedback shares an axis and keeps narrow touch actions usable", async ({
  page,
}) => {
  const send = await openEventSession(
    page,
    "Feedback boundaries",
    checkpointAdapterConfiguration,
    {
      theme: "dark",
      palette: "classic-amber",
      toolVisibility: "compact",
      activityFoldVisibility: "expanded",
    },
  );
  send(
    ...conversationFeedbackMessages.map((message) => ({
      type: "message_end",
      message,
    })),
  );
  const checkpoint = page.locator(".context-checkpoint");
  const title = checkpoint.locator(".context-checkpoint__title");
  const metric = checkpoint.locator(".context-checkpoint__metric");
  await expect(metric).toHaveText("History chunk ≈ 42,500 tokens");
  await page.evaluate(() => document.fonts.ready);
  const [titleBaseline, metricBaseline] = await Promise.all([
    title.evaluate(textBaseline, ".context-checkpoint"),
    metric.evaluate(textBaseline, ".context-checkpoint"),
  ]);
  expect(Math.abs(titleBaseline - metricBaseline)).toBeLessThan(0.1);
  const disclosureAlignment = await checkpoint.evaluate((element) => {
    const chevron = element.querySelector(".context-checkpoint__chevron")!;
    const foldChevron = document.querySelector(
      ".activity-fold__boundary--upper > svg, .activity-fold__disclosure > svg",
    )!;
    return (
      chevron.getBoundingClientRect().left -
      foldChevron.getBoundingClientRect().left
    );
  });
  expect(Math.abs(disclosureAlignment)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 320, height: 1000 });
  await checkpoint
    .getByRole("button", { name: "Magic Context compacted" })
    .tap();
  const summary = checkpoint.locator(".context-checkpoint__body .rich-text");
  await expect(summary).toBeVisible();
  expect((await summary.boundingBox())!.x).toBeCloseTo(
    (await title.boundingBox())!.x,
    0,
  );
  const error = page.getByRole("group", { name: "Pi error" });
  await error.getByRole("button", { name: "Show details" }).tap();
  await expect(error).toContainText("Diagnostic line 8");
  for (const [surface, copy] of [
    [
      checkpoint,
      checkpoint.getByRole("button", { name: /compaction summary/i }),
    ],
    [error, error.getByRole("button", { name: "Copy error message" })],
  ] as const) {
    expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    expect(
      await surface.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  await error.getByRole("button", { name: "Hide details" }).tap();

  await page.route("**/api/control/native-command", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error:
          "Compaction failed: https://provider.example/requests/" +
          "request-id".repeat(16),
      },
    }),
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("/compact");
  await page.locator(".composer__send").tap();
  const receipt = page.locator(".command-activity__item--error");
  await expect(receipt).toContainText("Failed");
  expect(
    await receipt.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await receipt.getByRole("button", { name: /dismiss/i }).tap();
  await expect(receipt).toHaveCount(0);
  await expect(error).toBeVisible();
});
