import { expect, type Page, test } from "@playwright/test";
import type { ActiveSnapshot } from "../../shared/contracts";
import { HISTORY_FIXTURE_SESSION_ID } from "../fixtures/history-session";
import { routeSnapshots } from "./support/host-events";
import {
  openCommandPalette,
  openFixtureSession,
  pairedPage,
} from "./support/navigation";

test.use({
  serviceWorkers: "block",
  viewport: { width: 1280, height: 844 },
  hasTouch: true,
  contextOptions: { reducedMotion: "reduce" },
});

async function openUsageSession(
  page: Page,
  configure?: (active: NonNullable<ActiveSnapshot["active"]>) => void,
) {
  const sessionId = HISTORY_FIXTURE_SESSION_ID;
  let source!: ActiveSnapshot;
  let envelope!: { type: string; detailSessionId?: string };
  const transport = await routeSnapshots(page, {
    snapshot(snapshot) {
      if (snapshot.active?.sessionId !== sessionId) return;
      configure?.(snapshot.active);
      source = snapshot;
    },
    event(event) {
      if (event.type === "snapshot" && event.detailSessionId === sessionId)
        envelope = event;
    },
  });
  await pairedPage(page);
  await openFixtureSession(page, /Calibration history fixture/, sessionId);
  await expect.poll(() => Boolean(source && envelope)).toBe(true);
  return (update: (snapshot: ActiveSnapshot) => void) => {
    const next = structuredClone(source);
    update(next);
    transport.send({ ...envelope, unchanged: false, data: next });
  };
}

test("refreshes usage in place and keeps distinct query results keyboard-scrollable without losing the draft", async ({
  page,
}) => {
  const project = `/workspace/${"long-project-segment/".repeat(8)}analysis.jsonl`;
  const sessionFile = `${project}/sessions/retained.jsonl`;
  const modelId = "model-with-a-long-deployment-identity";
  const stats = {
    totalMessages: 12,
    tokens: { total: 9_000_000 },
    cost: 1.25,
    contextUsage: { tokens: 123_456, contextWindow: 1_000_000, percent: 12.3 },
  };
  const update = await openUsageSession(page, (active) => {
    active.cwd = project;
    active.sessionFile = sessionFile;
    active.model = { provider: "provider", id: modelId };
    active.stats = stats;
  });
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const meter = page.getByRole("button", { name: /^Session & usage, context/ });
  const receipt = page.getByRole("region", { name: "Command activity" });
  const usage = receipt.getByRole("status");
  const draft = "Keep this draft";
  await input.fill(draft);
  await meter.press("Enter");
  await expect(usage).toContainText("$1.25");
  await expect(input).toHaveValue(draft);
  await expect(receipt).not.toContainText(sessionFile);
  await expect(receipt).not.toContainText(project);
  await expect(receipt).not.toContainText(`provider/${modelId}`);
  await expect(receipt.getByText("/session", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => document.fonts.ready);
  for (const value of ["9,000,000", "$1.25", "123,456 / 1,000,000 (12%)"]) {
    const field = receipt.getByText(value, { exact: true });
    await expect(field).toBeVisible();
    expect(
      await field.evaluate(
        (el) =>
          el.scrollWidth <= el.clientWidth + 1 &&
          getComputedStyle(el).textOverflow !== "ellipsis",
      ),
    ).toBe(true);
  }
  update((snapshot) => {
    snapshot.active!.stats = {
      ...stats,
      cost: 2.5,
      contextUsage: { ...stats.contextUsage, tokens: 250_000, percent: 25 },
    };
  });
  await expect(meter).toHaveAccessibleName(
    "Session & usage, context 25 percent full",
  );
  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("usage");
  await palette.getByRole("option", { name: /Session & usage/ }).click();
  await expect(usage).toContainText("$2.50");
  await expect(usage).toContainText("250,000 / 1,000,000 (25%)");
  await expect(usage).toHaveCount(1);
  await expect(input).toHaveValue(draft);

  // Short windows must keep all results reachable by keyboard and touch.
  await page.setViewportSize({ width: 390, height: 480 });
  await input.fill("/name");
  await page.locator(".composer__send").click();
  await expect(receipt.getByText("/name", { exact: true })).toBeVisible();
  await input.fill(draft);
  await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("/quit");
  await palette.getByRole("option", { name: /Leave Inspire/ }).click();
  const quit = receipt.getByText(
    "Close this tab when you are done. Your sessions keep running.",
    { exact: true },
  );
  await expect(quit).toBeVisible();
  await expect(receipt.getByRole("status")).toHaveCount(3);
  await expect
    .poll(() => receipt.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);
  await receipt.press("End");
  await expect(quit).toBeInViewport();
  await receipt.press("Home");
  await expect.poll(() => receipt.evaluate((el) => el.scrollTop)).toBe(0);
  await receipt.getByRole("button", { name: "Dismiss /quit result" }).click();
  await expect(quit).toHaveCount(0);
  await expect(receipt.getByRole("status")).toHaveCount(2);
  await expect(receipt.getByText("$2.50", { exact: true })).toHaveCount(1);
  await expect(receipt.getByText("/name", { exact: true })).toHaveCount(1);
  await expect(input).toHaveValue(draft);
});
