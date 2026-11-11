import { expect, test } from "@playwright/test";
import { routeSnapshots } from "./support/host-events";
import { openFixtureSession, pairedPage } from "./support/navigation";

test("Needs you receives live attention and remembers its mode across reload", async ({
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

  transport.send({
    type: "session_status",
    sessionId: "fixture-calibration-history",
    sessionStatus: { runState: "idle", indicator: "completed" },
  });

  await expect(bell).toHaveAccessibleName("Needs you (1)");
  await bell.click();
  await expect(bell).toHaveAttribute("aria-pressed", "true");
  const list = page.getByRole("region", { name: "Sessions that need you" });
  await expect(list.locator(".nav__row")).toHaveAttribute(
    "data-session-id",
    "fixture-calibration-history",
  );
  // Folders, Pinned and Hidden belong to All.
  await expect(page.locator(".nav__group-toggle")).toHaveCount(0);

  await page.reload();
  await expect(bell).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await expect(page.locator(".nav__pagination")).toHaveCount(0);
  await bell.click();
  await expect(bell).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".nav__group-toggle").first()).toBeVisible();
});
