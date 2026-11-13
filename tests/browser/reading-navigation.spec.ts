import { expect, test } from "@playwright/test";
import type { NativeTurnPage } from "../../shared/contracts";
import { routeSnapshots } from "./support/host-events";
import { openFixtureSession, pairedPage } from "./support/navigation";

test.use({ serviceWorkers: "block" });

test("searches a real saved branch and reads an old response in bounded sections", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Calibration history fixture/,
    "fixture-calibration-history",
  );
  await page.getByRole("button", { name: "Turn history" }).click();
  const history = page.getByRole("region", { name: "Turn history" });
  await expect(history.getByText(/of 600/)).toBeVisible();
  await history
    .getByRole("textbox", { name: "Search this branch" })
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
  await page.getByRole("button", { name: "Turn history" }).click();
  await expect(oldAnswer.locator("pre")).toContainText("完整测量记录。");
});

test("@cross-browser history reads one page, retries it, and stays still as Live updates", async ({
  page,
}) => {
  const transport = await routeSnapshots(page, {});
  let fail = true;
  let hits = 0;
  await page.route("**/api/history?kind=page&**", async (route) => {
    const { searchParams } = new URL(route.request().url());
    const cursor = searchParams.get("cursor");
    if (hits > 0) expect(searchParams.get("leafId")).toBe("current-entry");
    if (cursor === "older" && fail) {
      fail = false;
      return route.fulfill({
        status: 503,
        json: { error: "History unavailable" },
      });
    }
    hits++;
    const older =
      cursor === "older" || searchParams.get("entryId") === "older-entry";
    return route.fulfill({
      json: {
        sessionId: searchParams.get("sessionId")!,
        viewId: searchParams.get("viewId")!,
        incarnation: "source",
        revision: 1,
        leafId: "current-entry",
        firstTurn: older ? 1 : 2,
        lastTurn: older ? 1 : 2,
        totalTurns: 2,
        messages: [
          {
            role: "user",
            __inspireEntryId: older ? "older-entry" : "current-entry",
            content: older ? "Earlier saved prompt" : "Current saved prompt",
          },
        ],
        earlier: older ? null : "older",
        later: older ? "newer" : null,
      } satisfies NativeTurnPage,
    });
  });
  await page.route("**/api/history?kind=search&**", (route) => {
    expect(new URL(route.request().url()).searchParams.get("leafId")).toBe(
      "current-entry",
    );
    return route.fulfill({
      json: {
        matches: [
          { entryId: "older-entry", turn: 1, snippet: "Earlier saved prompt" },
        ],
        more: false,
      },
    });
  });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  await expect.poll(() => transport.ready("fixture-history")).toBe(true);
  await page.getByRole("button", { name: "Turn history" }).click();
  const history = page.getByRole("region", { name: "Turn history" });
  await expect(history.getByText("Current saved prompt")).toBeVisible();
  await history.getByRole("button", { name: "Earlier" }).click();
  await expect(history.getByRole("alert")).toContainText("History unavailable");
  await expect(history.getByText("Current saved prompt")).toBeVisible();
  await history.getByRole("button", { name: "Retry" }).click();
  await expect(history.getByText("Earlier saved prompt")).toBeVisible();
  await expect(history.getByText("Current saved prompt")).toHaveCount(0);
  transport.send({
    sessionId: "fixture-history",
    type: "message_end",
    message: { role: "assistant", content: "New live output", timestamp: 888 },
  });
  await expect(history.getByText("Earlier saved prompt")).toBeVisible();
  await expect(history.getByText("New live output")).toHaveCount(0);
  await history.getByRole("button", { name: "Later" }).click();
  await expect(history.getByText("Current saved prompt")).toBeVisible();
  await history
    .getByRole("textbox", { name: "Search this branch" })
    .fill("Earlier saved");
  await history.getByRole("button", { name: "Search", exact: true }).click();
  await history
    .getByRole("button", { name: "Turn 1: Earlier saved prompt" })
    .click();
  await expect(history.getByText("Earlier saved prompt")).toBeVisible();
  expect(hits).toBe(4);
  transport.send({
    type: "queue_update",
    sessionId: "fixture-history",
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
  await page.getByRole("button", { name: "Jump to 1 pending item" }).click();
  await expect(
    page.getByRole("region", { name: "Pending input", exact: true }),
  ).toBeFocused();
  await expect(history).toHaveCount(0);
  await expect(
    page.getByRole("log").getByText("New live output"),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Turn history" }).click();
  await expect(history.getByText("Earlier saved prompt")).toBeVisible();
});
