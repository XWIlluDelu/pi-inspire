import { expect, test } from "@playwright/test";
import { emptyPendingQueues } from "../../shared/contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import {
  openCommandPalette,
  openProjectTerminal,
  pairedPage,
  reloadSession,
} from "./support/navigation";

test.use({ serviceWorkers: "block" });

test("empty session, search and terminal states keep their next actions available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let emptyCatalog = true;
  await routeSnapshots(page, {
    snapshot: (snapshot) => {
      if (emptyCatalog)
        Object.assign(snapshot, {
          active: null,
          runState: "idle",
          sessionStatuses: {},
          pendingQueues: emptyPendingQueues(),
        });
    },
    bootstrap: ({ preferences }) => {
      if (emptyCatalog)
        Object.assign(preferences, {
          pinnedSessionIds: [],
          hiddenSessionIds: [],
          pinnedProjectCwds: [],
          hiddenProjectCwds: [],
        });
    },
    event: (event) => {
      if (emptyCatalog && event.type !== "snapshot" && event.sessionId)
        return false;
    },
  });
  await page.route("**/api/sessions?**", (route) =>
    emptyCatalog
      ? route.fulfill({
          json: { sessions: [], total: 0, offset: 0, limit: 40 },
        })
      : route.continue(),
  );
  await pairedPage(page);
  const toggleNav = page.getByRole("button", { name: "Toggle navigation" });
  await toggleNav.click();

  const navState = page.locator(".nav .empty-state");
  await expect(navState).toContainText("No sessions yet");
  const search = page.getByRole("searchbox", { name: "Search sessions" });
  await search.fill("no-matching-session");
  await expect(navState).toContainText("No sessions found");
  await expect(navState).toContainText("Try a different keyword");
  await page.getByRole("button", { name: "Close navigation" }).click();

  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("no-matching-command");
  const paletteState = palette.locator(".empty-state");
  await expect(paletteState).toContainText("No matching commands");
  await palette.getByLabel("Filter commands").fill("");
  await expect(palette.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await expect(
    page.getByRole("button", { name: "New terminal", exact: true }),
  ).toBeDisabled();
  const terminalState = page.locator(".terminal-empty");
  await page.getByRole("button", { name: "Close context pane" }).click();

  emptyCatalog = false;
  const created = await hostRequest(page).post("/api/sessions/new", {
    data: { cwd: browserWorkspace, name: "Empty-state fixture" },
  });
  expect(created.ok()).toBe(true);
  await reloadSession(page, (await created.json()).active.sessionId);
  await expect(
    page.getByRole("button", { name: /^Session actions:/ }),
  ).toHaveText("Empty-state fixture");
  const conversationState = page.locator(".empty-state--conversation");
  await expect(conversationState).toContainText("Empty session");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/terminals?**", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    await openProjectTerminal(page);
    await expect(terminalState).toContainText("Loading terminals");
    release();
    await expect(terminalState).toContainText("Project terminal");
    await expect(
      terminalState.getByRole("button", { name: "New terminal" }),
    ).toBeEnabled();
  } finally {
    release();
  }
});
