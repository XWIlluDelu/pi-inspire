import { expect, test } from "@playwright/test";
import type { NativeTurnPage } from "../../shared/contracts";
import { HISTORY_FIXTURE_SESSION_ID } from "../fixtures/history-session";
import { routeSnapshots } from "./support/host-events";
import {
  openFixtureSession,
  openHistoryPane,
  pairedPage,
} from "./support/navigation";

test.use({ serviceWorkers: "block" });

test("@cross-browser retries a native page, keeps it apart from Live, and restores the old entry section", async ({
  page,
}) => {
  const transport = await routeSnapshots(page, {});
  let pinnedLeaf: string | null | undefined;
  let failed = false;
  await page.route("**/api/history?kind=page&**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has("cursor")) expect(query.get("leafId")).toBe(pinnedLeaf);
    if (!failed && query.has("cursor")) {
      failed = true;
      return route.fulfill({
        status: 503,
        json: { error: "History unavailable" },
      });
    }
    const response = await route.fetch();
    if (response.ok())
      pinnedLeaf ??= ((await response.json()) as NativeTurnPage).leafId;
    await route.fulfill({ response });
  });
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Calibration history fixture/,
    HISTORY_FIXTURE_SESSION_ID,
  );
  await expect
    .poll(() => transport.ready(HISTORY_FIXTURE_SESSION_ID))
    .toBe(true);
  const history = await openHistoryPane(page);
  const latest = history.locator('[data-history-entry="history-latest"]');
  await expect(history.getByText(/of 600/)).toBeVisible();
  await history
    .getByRole("button", { name: "Earlier", exact: true })
    .press("Enter");
  await expect(history.getByRole("alert")).toContainText("History unavailable");
  await expect(latest).toBeAttached();
  await history.getByRole("button", { name: "Retry" }).click();
  await expect(latest).toHaveCount(0);
  transport.send({
    sessionId: HISTORY_FIXTURE_SESSION_ID,
    type: "message_end",
    message: { role: "assistant", content: "New live output", timestamp: 888 },
  });
  transport.send({
    type: "queue_update",
    sessionId: HISTORY_FIXTURE_SESSION_ID,
    pendingQueues: {
      revision: 1,
      totalCount: 1,
      steering: [],
      followUp: [
        {
          id: "pending-one",
          textPreview: "Queued input",
          textLength: 12,
          textTruncated: false,
        },
      ],
    },
  });
  const jump = page.getByRole("button", { name: "Jump to 1 pending item" });
  await expect(jump).toBeVisible();
  await expect(latest).toHaveCount(0);
  await history.getByRole("button", { name: "Later", exact: true }).click();
  await expect(latest).toBeAttached();
  await page.setViewportSize({ width: 390, height: 844 });
  await jump.click();
  const pending = page.getByRole("region", {
    name: "Pending input",
    exact: true,
  });
  const live = page.getByRole("log");
  const jumpToLatest = page.getByRole("button", { name: "Jump to latest" });
  const distanceFromEnd = () =>
    live.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect(pending).toBeFocused();
  await expect(pending).toBeInViewport();
  await expect(history).toHaveCount(0);
  await expect(live.getByText("New live output")).toBeVisible();
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1);
  await expect(jumpToLatest).toBeHidden();

  await openHistoryPane(page);
  await history
    .getByRole("searchbox", { name: "Search this branch" })
    .fill("cobalt baseline");
  await history.getByRole("button", { name: "Search", exact: true }).click();
  await history
    .getByRole("button", { name: /Turn 1:.*cobalt baseline/ })
    .click();
  const oldAnswer = history.locator('[data-history-entry="history-a-0"]');
  await oldAnswer.getByRole("button", { name: "Read full entry" }).click();
  const next = oldAnswer.getByRole("button", { name: "Next section" });
  await next.click();
  await next.click();
  await expect(oldAnswer.locator("pre")).toContainText("完整测量记录。");
  await expect(next).toBeDisabled();
  await page.reload();
  await openHistoryPane(page);
  await expect(oldAnswer.locator("pre")).toContainText("完整测量记录。");
});
