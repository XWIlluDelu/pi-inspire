import { expect, test } from "@playwright/test";
import { routeSnapshots } from "./support/host-events";
import { openFixtureSession, pairedPage } from "./support/navigation";

test("the bell switches the column to Needs you, ordered by urgency and remembered", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let connected = false;
  const transport = await routeSnapshots(page, {
    bootstrap: (body) =>
      Object.assign(body.preferences, {
        pinnedSessionIds: [],
        hiddenSessionIds: [],
        hiddenProjectCwds: [],
        navCollapsedGroups: [],
      }),
    // Other tests share this Host; start from no session statuses.
    snapshot: (snapshot) => {
      Object.assign(snapshot, { sessionStatuses: {} });
    },
    event: (event) => {
      if (event.type === "snapshot") connected = true;
      if (event.type === "session_status") return false;
    },
  });
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Review extension event lifecycle/,
    "fixture-history",
  );
  await expect.poll(() => connected).toBe(true);
  // One bell in the column header: lit is Needs you, unlit is All.
  const bell = page.locator(".nav").getByRole("button", { name: /^Needs you/ });
  await expect(bell).toHaveAttribute("aria-pressed", "false");
  await expect(bell).toHaveAccessibleName("Needs you");

  const send = (sessionId: string, sessionStatus: Record<string, unknown>) =>
    transport.send({ type: "session_status", sessionId, sessionStatus });
  send("fixture-calibration-history", {
    runState: "idle",
    indicator: "completed",
  });
  send("fixture-errors", { runState: "failed", indicator: "failed" });
  send("fixture-prompt-map", { runState: "running", needsInput: true });
  send("fixture-active", { runState: "running", indicator: "running" });

  await expect(bell).toHaveAccessibleName("Needs you (3)");
  await expect(bell.locator(".navigation-toggle__attention")).toHaveClass(
    /urgent/,
  );
  await bell.click();
  await expect(bell).toHaveAttribute("aria-pressed", "true");
  const list = page.getByRole("region", { name: "Sessions that need you" });
  // Waiting first, then failed, then finished; running work is absent.
  await expect(list.locator(".nav__row")).toHaveCount(3);
  expect(
    await list
      .locator(".nav__row")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-session-id")),
      ),
  ).toEqual([
    "fixture-prompt-map",
    "fixture-errors",
    "fixture-calibration-history",
  ]);
  // Folders, Pinned and Hidden belong to All.
  await expect(page.locator(".nav__group-toggle")).toHaveCount(0);

  // The mode survives a reload of the page.
  await page.reload();
  await expect(bell).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("region", { name: "Sessions that need you" })
      .or(page.getByText("Nothing needs you")),
  ).toBeVisible();
  await bell.click();
  await expect(bell).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".nav__group-toggle").first()).toBeVisible();
});

test("an empty Needs you list says so", async ({ page }) => {
  await routeSnapshots(page, {
    snapshot: (snapshot) => {
      Object.assign(snapshot, { sessionStatuses: {} });
    },
    event: (event) => (event.type === "session_status" ? false : undefined),
  });
  await pairedPage(page);
  await page
    .locator(".nav")
    .getByRole("button", { name: /^Needs you/ })
    .click();
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await expect(page.locator(".nav__pagination")).toHaveCount(0);
});
