import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type {
  SessionListResponse,
  SessionRuntimeStatus,
} from "../../shared/contracts";
import { navigationGroupsFixture } from "./fixtures/navigation-groups";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import {
  openCommandPalette,
  openFixtureSession,
  pairedPage,
} from "./support/navigation";

async function preserveCuration(page: Page) {
  const { preferences: before } = await (
    await hostRequest(page).get("/api/preferences")
  ).json();
  return async () => {
    const restored = await hostRequest(page).patch("/api/preferences", {
      data: {
        pinnedSessionIds: before.pinnedSessionIds,
        hiddenSessionIds: before.hiddenSessionIds,
      },
    });
    expect(restored.ok()).toBe(true);
  };
}

test("search loads older sessions and protects active and New drafts through keyboard selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  const source = "Review extension event lifecycle";
  const destination = "Formula rendering and spectral analysis";
  await openFixtureSession(page, new RegExp(source), "fixture-history");
  const composer = page.getByRole("form", { name: "Message composer" });
  const input = composer.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("SESSION_SEARCH_ACTIVE_DRAFT");
  await page.locator('input[type="file"]').setInputFiles({
    name: "search-draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retain draft artifact"),
  });
  await expect(page.locator(".attachment--ready")).toBeVisible();

  const { sessions } = (await (
    await hostRequest(page).get("/api/sessions?offset=0&limit=40")
  ).json()) as SessionListResponse;
  const releaseEmpty = Promise.withResolvers<void>();
  await page.route("**/api/sessions?**", async (route) => {
    const { searchParams } = new URL(route.request().url());
    const offset = Number(searchParams.get("offset") ?? 0);
    switch (searchParams.get("q")) {
      case "empty-fixture-query":
        await releaseEmpty.promise;
        return route.fulfill({
          json: { sessions: [], total: 0, offset: 0, limit: 40 },
        });
      case "failed-fixture-query":
        return route.fulfill({
          status: 503,
          json: { error: "Search is unavailable" },
        });
      case "bodyneedle": {
        const id = offset ? "fixture-active" : "fixture-history";
        const row = sessions.find((session) => session.id === id);
        return route.fulfill({
          json: { sessions: [row], total: 2, offset, limit: 1 },
        });
      }
      default:
        return route.continue();
    }
  });

  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("/resume");
  await palette.getByRole("option", { name: /Find a session/ }).click();
  const search = page.getByRole("searchbox", { name: "Search sessions" });
  await expect(search).toBeFocused();
  const empty = page.locator(".nav__list .empty-state");
  await search.fill("empty-fixture-query");
  try {
    await expect(page.locator(".nav__pagination .pi-loading")).toBeVisible();
    await expect(empty).toBeHidden();
  } finally {
    releaseEmpty.resolve();
  }
  await expect(empty).toContainText("No sessions");
  await search.fill("failed-fixture-query");
  await expect(page.locator(".nav__pagination-status")).toContainText(
    "Search is unavailable",
  );
  await expect(empty).toBeHidden();
  await search.fill("bodyneedle");
  const rows = page.locator(".nav__row-name");
  await expect(rows).toHaveCount(1);
  await search.press("ArrowDown");
  const highlighted = page.locator(".nav__row--highlighted .nav__row-name");
  await expect(highlighted).toHaveText(source);
  const older = page.getByRole("button", {
    name: "Load older sessions",
    exact: true,
  });
  await older.press("Enter");
  await expect(rows).toHaveCount(2);
  await expect(older).toHaveCount(0);
  await search.focus();
  await expect(highlighted).toHaveText(source);
  expect(
    (await new AxeBuilder({ page }).include(".nav").analyze()).violations,
  ).toEqual([]);
  await search.press("ArrowDown");
  await expect(highlighted).toHaveText(destination);
  await search.dispatchEvent("compositionstart");
  await search.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    bubbles: true,
  });
  await search.dispatchEvent("compositionend");
  await expect(search).toHaveValue("bodyneedle");
  await expect(input).toHaveValue("SESSION_SEARCH_ACTIVE_DRAFT");

  const open = Promise.withResolvers<void>();
  await page.route(
    "**/api/sessions/open",
    async (route) => {
      await open.promise;
      await route.continue();
    },
    { times: 1 },
  );
  const destinationRow = page.locator(
    '[data-session-id="fixture-active"] .nav__row-main',
  );
  const title = destinationRow.locator(".nav__row-name");
  const opacity = await destinationRow.evaluate(
    (element) => getComputedStyle(element).opacity,
  );
  const x = (await title.boundingBox())!.x;
  const opening = destinationRow.getByRole("status");
  try {
    await search.press("Enter");
    await expect(composer).toHaveAttribute("aria-busy", "true");
    await expect(input).toBeDisabled();
    await expect(opening).toHaveText("Opening…");
    await expect(destinationRow).toHaveCSS("opacity", opacity);
    await expect(
      destinationRow.getByRole("img", { name: "Working" }),
    ).toBeHidden();
    expect((await title.boundingBox())!.x).toBeCloseTo(x, 1);
  } finally {
    open.resolve();
  }
  const topbar = page.locator(".topbar__title-button");
  await expect(topbar).toHaveText(destination);
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("");
  await expect(opening).toBeHidden();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(search).not.toBeFocused();
  await page
    .getByRole("button", { name: "Collapse navigation", exact: true })
    .click();
  await expect(search).toBeHidden();
  await input.fill("/resume");
  await composer
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(search).toBeFocused();
  await expect(topbar).toHaveText(destination);

  const create = page.getByRole("button", { name: "New session", exact: true });
  await create.click();
  const first = page.getByRole("textbox", { name: "First message" });
  await first.fill("SESSION_SEARCH_START_DRAFT");
  await openFixtureSession(page, new RegExp(source), "fixture-history");
  await expect(input).toHaveValue("SESSION_SEARCH_ACTIVE_DRAFT");
  await expect(page.locator(".attachment")).toContainText("search-draft.txt");
  await create.click();
  await expect(first).toHaveValue("SESSION_SEARCH_START_DRAFT");
});

test("catalog retries keep available sessions visible and clear recovered source issues", async ({
  page,
}) => {
  const issues = [
    { path: "/offline/project/sessions", message: "Permission denied" },
  ];
  let retries = 0;
  await page.route("**/api/sessions/refresh", async (route) => {
    retries += 1;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/sessions?**", async (route) => {
    const response = await route.fetch();
    if (!response.ok() || retries >= 2) return route.fulfill({ response });
    const catalog: SessionListResponse = await response.json();
    const sessions =
      retries === 0
        ? []
        : catalog.sessions.filter(({ id }) => id === "fixture-history");
    await route.fulfill({
      response,
      json: { ...catalog, sessions, total: sessions.length, issues },
    });
  });
  await pairedPage(page);
  const nav = page.getByRole("navigation", { name: "Sessions" });
  const diagnostics = nav.getByText("Some sessions may be missing");
  const retry = nav.getByRole("button", { name: "Retry loading sessions" });
  const available = nav.getByText("Review extension event lifecycle", {
    exact: true,
  });
  const recovered = nav.locator(
    '[data-session-id="fixture-errors"] .nav__row-main',
  );
  await diagnostics.click();
  await expect(nav.getByText(issues[0].path)).toBeVisible();
  await expect(nav.getByText("No sessions yet")).toHaveCount(0);

  await retry.click();
  await expect(available).toBeVisible();
  await expect(recovered).toHaveCount(0);
  await expect(diagnostics).toBeVisible();

  await retry.click();
  await expect(recovered).toBeVisible();
  await expect(available).toBeVisible();
  await expect(diagnostics).toHaveCount(0);
});

test.describe("touch session drawer", () => {
  test.use({ viewport: { width: 320, height: 740 }, hasTouch: true });
  test("direct curation does not select a session; selection dismisses the drawer and restores its draft", async ({
    page,
  }) => {
    const sessionId = "fixture-history";
    await pairedPage(page);
    const restoreCuration = await preserveCuration(page);
    try {
      await openFixtureSession(
        page,
        /Review extension event lifecycle/,
        sessionId,
      );
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      await input.fill("Keep this touch draft");
      await page
        .getByRole("button", { name: "Toggle navigation", exact: true })
        .tap();
      const drawer = page.getByRole("dialog", {
        name: "Sessions",
        exact: true,
      });
      const title = "Review extension event lifecycle";
      const row = drawer.locator(`[data-session-id="${sessionId}"]`);
      const action = (name: string) =>
        row.getByRole("button", {
          name: name + ' "' + title + '"',
          exact: true,
        });
      await action("Pin").tap();
      await expect(drawer.locator(".nav__group--pinned")).toContainText(title);
      await action("Hide").tap();
      await drawer.getByRole("button", { name: "Hidden", exact: true }).tap();
      const hidden = drawer.getByRole("region", {
        name: "Hidden",
        exact: true,
      });
      const hiddenRow = hidden.locator(`[data-session-id="${sessionId}"]`);
      await expect(hiddenRow).toBeVisible();
      await expect(hiddenRow.locator('[aria-current="page"]')).toBeVisible();
      await action("Restore").tap();
      await expect(hiddenRow).toHaveCount(0);
      await drawer.getByRole("button", { name: "All", exact: true }).tap();
      await expect(action("Pin")).toBeVisible();
      await expect(input).toHaveValue("Keep this touch draft");
      await row.locator(".nav__row-main").tap();
      await expect(drawer).toHaveCount(0);
      await expect(input).toHaveValue("Keep this touch draft");
    } finally {
      await restoreCuration();
    }
  });
});

test("catalog search follows curation and reviews the exact Hidden selection", async ({
  page,
}) => {
  await navigationGroupsFixture(page);
  await pairedPage(page);
  const nav = page.getByRole("navigation", { name: "Sessions" });
  const search = nav.getByRole("searchbox", { name: "Search sessions" });
  const reports = nav.getByRole("button", { name: "reports", exact: true });
  const row = nav.locator('[data-session-id="fixture-active"]');
  const action = (label: string) =>
    row.getByRole("button", { name: `${label} "Reports session"` });
  const selected = nav.locator(".nav__row--highlighted .nav__row-name");
  await expect(reports).toHaveAttribute("aria-expanded", "false");
  await search.fill("reports");
  await expect(reports).toBeDisabled();
  await expect(selected).toHaveText("Reports session");
  await search.press("ArrowDown");
  await expect(selected).toHaveText("Independent hidden session");
  await search.press("ArrowUp");
  await action("Pin").click();
  await expect(action("Unpin")).toBeVisible();
  await search.focus();
  await expect(selected).toHaveText("Reports session");
  await action("Hide").click();
  await expect(action("Restore")).toBeVisible();
  await search.focus();
  await expect(selected).toHaveText("Reports session");
  await search.press("ArrowDown");
  await expect(selected).toHaveText("Independent hidden session");
  await search.press("ArrowUp");
  await search.fill("session");
  await search.press("Enter");
  await expect(
    page.getByRole("form", { name: "Start a session" }),
  ).toBeVisible();
  await expect(selected).toHaveText("Geometry session");

  const palette = await openCommandPalette(page);
  for (const query of ["", "session"]) {
    await palette.getByLabel("Filter commands").fill(query);
    await expect(
      palette.getByRole("option", { name: /^Geometry session/ }),
    ).toBeVisible();
    await expect(
      palette.getByRole("option", {
        name: /^Reports session|^Archived measurement/,
      }),
    ).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await search.fill("");
  await expect(
    nav.getByRole("button", { name: "calibration", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(row).toHaveCount(0);
  const hidden = nav.getByRole("button", { name: "Hidden", exact: true });
  await hidden.click();
  await page.reload();
  await expect(hidden).toHaveAttribute("aria-pressed", "true");
  await expect(row).toBeVisible();

  const requests: Array<{
    scope: string;
    projectCwd?: string;
    sessionIds: string[];
  }> = [];
  await page.route("**/api/sessions/delete", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 503,
      json: { error: "Deletion unavailable" },
    });
  });
  const all = nav.getByRole("button", { name: "Clear Hidden" });
  await search.fill("reports");
  await expect(all).toBeDisabled();
  await search.fill("");
  const folder = nav.getByRole("button", {
    name: "Delete all sessions in folder archived-a",
  });
  await folder.click();
  const dialog = page.getByRole("alertdialog", {
    name: "Clear hidden folder?",
  });
  await expect(dialog).toHaveAccessibleDescription(/\/projects\/archived-a/);
  const deleteOne = dialog.getByRole("button", { name: "Delete 1 session" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(requests).toEqual([]);
  await folder.click();
  await deleteOne.click();
  await expect
    .poll(() => requests[0])
    .toMatchObject({
      scope: "hidden",
      projectCwd: "/projects/archived-a",
      sessionIds: ["fixture-compaction"],
    });
  await expect(dialog.getByText("Deletion unavailable")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await all.click();
  await page
    .getByRole("alertdialog", { name: "Clear Hidden?" })
    .getByRole("button", { name: "Delete 4 sessions" })
    .click();
  await expect
    .poll(() => requests[1])
    .toMatchObject({
      scope: "hidden",
      sessionIds: expect.arrayContaining([
        "fixture-active",
        "fixture-compaction",
        "fixture-errors",
        "hidden-independent",
      ]),
    });
  expect(requests[1]?.sessionIds).toHaveLength(4);
});

test("live attention filters and counts the relevant sessions through rail, drawer and reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const older = "fixture-calibration-history";
  const newer = "fixture-errors";
  const hidden = "fixture-active";
  await page.route("**/api/sessions?**", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as SessionListResponse;
    for (const row of body.sessions) {
      if (row.id === older) row.modified = "2026-07-20T10:00:00Z";
      if (row.id === newer) row.modified = "2026-07-24T10:00:00Z";
    }
    await route.fulfill({ response, json: body });
  });
  const statuses: Record<string, SessionRuntimeStatus> = {};
  const transport = await routeSnapshots(page, {
    bootstrap: (body) =>
      Object.assign(body.preferences, {
        pinnedSessionIds: [older],
        hiddenSessionIds: [hidden],
        hiddenProjectCwds: [],
        navCollapsedGroups: [],
      }),
    snapshot(snapshot) {
      const active = snapshot.active?.sessionId;
      snapshot.sessionStatuses = active
        ? { ...statuses, [active]: statuses[active] ?? { runState: "idle" } }
        : { ...statuses };
    },
    event(event) {
      if (event.type === "session_status") return false;
    },
  });
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Review extension event lifecycle/,
    "fixture-history",
  );
  await expect.poll(() => transport.ready("fixture-history")).toBe(true);
  let attention = 0;
  const report = (id: string, completed: boolean) => {
    statuses[id] = completed
      ? { runState: "idle", indicator: "completed", attentionId: ++attention }
      : { runState: "idle" };
    transport.send({
      type: "session_status",
      sessionId: id,
      sessionStatus: statuses[id],
    });
  };
  const bell = page.locator(".nav").getByRole("button", { name: /^Needs you/ });
  const pinned = page.getByRole("region", { name: "Pinned", exact: true });
  await expect(bell).toHaveAccessibleName("Needs you");
  await expect(pinned.locator(".nav__row")).toHaveAttribute(
    "data-session-id",
    older,
  );
  for (const id of [newer, older, hidden]) report(id, true);
  await expect(bell).toHaveAccessibleName("Needs you (2)");
  await bell.click();
  await expect(bell).toHaveAttribute("aria-pressed", "true");
  const rows = page
    .getByRole("region", { name: "Sessions that need you" })
    .locator(".nav__row");
  const all = page
    .locator(".nav")
    .getByRole("button", { name: "All", exact: true });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-session-id", newer);
  await expect(rows.nth(1)).toHaveAttribute("data-session-id", older);
  await expect(pinned).toHaveCount(0);
  for (const id of Object.keys(statuses)) delete statuses[id];
  await page.reload();
  await expect(bell).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await all.click();
  await expect(bell).toHaveAttribute("aria-pressed", "false");
  await expect(pinned).toBeVisible();

  await expect.poll(() => transport.ready("fixture-history")).toBe(true);
  report(newer, true);
  const collapse = page.getByRole("button", {
    name: "Collapse navigation",
    exact: true,
  });
  const rail = page.getByRole("button", {
    name: "Expand navigation",
    exact: true,
  });
  await collapse.click();
  const check = async (toggle: Locator, count: string) => {
    const badge = toggle.locator(
      ".navigation-toggle__attention > [aria-hidden]",
    );
    await expect(badge).toHaveText(count);
    await expect(badge).toBeInViewport({ ratio: 1 });
  };
  await check(rail, "1");
  await expect(rail).toHaveAccessibleDescription(
    "1 other session needs attention",
  );
  const more = Array.from({ length: 10 }, (_, index) => `unseen-${index}`);
  for (const id of more) report(id, true);
  await check(rail, "9+");
  await expect(rail).toHaveAccessibleDescription(
    "11 other sessions need attention",
  );
  await page.setViewportSize({ width: 390, height: 780 });
  const drawer = page.getByRole("button", {
    name: "Toggle navigation",
    exact: true,
  });
  await check(drawer, "9+");
  for (const id of more) report(id, false);
  await check(drawer, "1");

  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixtureSession(page, /Pi error display fixture/, newer);
  await expect(
    page.locator(".nav__row--active").getByRole("img", { name: "Completed" }),
  ).toBeHidden();
  await collapse.click();
  await expect(rail).not.toHaveAccessibleDescription(/need[s]? attention/);
  await page.unrouteAll({ behavior: "wait" });
});

test.describe("phone status alignment", () => {
  test.use({ viewport: { width: 320, height: 1000 }, hasTouch: true });

  test("running, failed and waiting rows leave room for titles and curation", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const transport = await navigationGroupsFixture(page);
    await pairedPage(page);
    await openFixtureSession(page, /Geometry session/, "fixture-history");
    await expect.poll(() => transport.ready("fixture-history")).toBe(true);
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .tap();
    const search = page.getByRole("searchbox", { name: "Search sessions" });
    const row = page.locator('[data-session-id="fixture-active"]');
    const title = row.locator(".nav__row-name");
    await search.fill("reports");
    await expect(title.locator(".search-match")).toHaveText("Reports");
    await page.evaluate(() => document.fonts.ready);
    const before = await title.boundingBox();
    const states = [
      { runState: "running", indicator: "running", label: "Working" },
      { runState: "idle", indicator: "completed", label: "Completed" },
      { runState: "idle", indicator: "failed", label: "Failed" },
      { runState: "running", needsInput: true, label: "Waiting for input" },
    ] as const;
    for (const { label, ...sessionStatus } of states) {
      transport.send({
        type: "session_status",
        sessionId: "fixture-active",
        sessionStatus,
      });
      const status = row.getByRole("img", { name: label, exact: true });
      await expect(status).toBeVisible();
      expect(await title.boundingBox()).toEqual(before);
      const mark = (await status.boundingBox())!;
      expect(mark.x + mark.width).toBeLessThanOrEqual(before!.x);
      await expect(
        row.getByRole("button", { name: 'Hide "Reports session"' }),
      ).toBeInViewport();
    }
    transport.send({
      type: "session_status",
      sessionId: "fixture-active",
      sessionStatus: { runState: "idle" },
    });
    await expect(
      row.getByRole("img", { name: "Waiting for input" }),
    ).toBeHidden();
  });
});
