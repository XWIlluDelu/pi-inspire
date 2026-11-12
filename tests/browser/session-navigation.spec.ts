import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type {
  SessionListResponse,
  SessionRuntimeStatus,
} from "../../shared/contracts";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import {
  openCommandPalette,
  openFixtureSession,
  pairedPage,
} from "./support/navigation";

async function preserveCuration(page: Page) {
  const before = await (await hostRequest(page).get("/api/preferences")).json();
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

test("session search paginates unloaded results and keyboard selection preserves drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("SESSION_SEARCH_ACTIVE_DRAFT");
  await page.locator('input[type="file"]').setInputFiles({
    name: "search-draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retain draft artifact"),
  });
  await expect(page.locator(".attachment--ready")).toBeVisible();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const first = page.getByRole("textbox", { name: "First message" });
  await first.fill("SESSION_SEARCH_START_DRAFT");
  const response = await hostRequest(page).get(
    "/api/sessions?q=&offset=0&limit=40",
  );
  const catalog = (await response.json()).sessions as Array<{ id: string }>;
  const find = (id: string) => catalog.find((session) => session.id === id)!;
  let releaseEmpty!: () => void;
  const empty = new Promise<void>((resolve) => {
    releaseEmpty = resolve;
  });
  // Keep real selectable sessions behind the controlled catalog responses.
  await page.route("**/api/sessions?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("q") === "empty-fixture-query") {
      await empty;
      return route.fulfill({
        json: { sessions: [], total: 0, offset: 0, limit: 40 },
      });
    }
    if (params.get("q") === "failed-fixture-query") {
      return route.fulfill({
        status: 503,
        json: { error: "Search is unavailable" },
      });
    }
    if (params.get("q") !== "bodyneedle") return route.continue();
    const offset = Number(params.get("offset") ?? 0);
    await route.fulfill({
      json: {
        sessions: [
          {
            ...find(offset === 0 ? "fixture-history" : "fixture-active"),
            modified:
              offset === 0 ? "2026-07-22T00:01:00Z" : "2026-07-22T00:00:00Z",
          },
        ],
        total: 2,
        offset,
        limit: 1,
      },
    });
  });
  const findSession = async () => {
    const palette = await openCommandPalette(page);
    await palette.getByLabel("Filter commands").fill("/resume");
    await palette.getByRole("option", { name: /Find a session/ }).click();
    const search = page.getByRole("searchbox", { name: "Search sessions" });
    await expect(search).toBeFocused();
    return search;
  };
  const search = await findSession();
  const emptyState = page.locator(".nav__list .empty-state");
  await search.fill("empty-fixture-query");
  try {
    await expect(page.locator(".nav__pagination .pi-loading")).toBeVisible();
    await expect(emptyState).toBeHidden();
  } finally {
    releaseEmpty();
  }
  await expect(emptyState).toContainText("No sessions");
  await search.fill("failed-fixture-query");
  await expect(page.locator(".nav__pagination-status")).toContainText(
    "Search is unavailable",
  );
  await expect(emptyState).toBeHidden();
  await search.fill("bodyneedle");
  const rows = page.locator(".nav__row-name");
  await expect(rows).toHaveCount(1);
  await search.press("ArrowDown");
  const highlighted = page.locator(".nav__row--highlighted .nav__row-name");
  await expect(highlighted).toHaveText("Review extension event lifecycle");
  const older = page.getByRole("button", {
    name: "Load older sessions",
    exact: true,
  });
  await older.press("Enter");
  await expect(rows).toHaveCount(2);
  await expect(older).toHaveCount(0);
  await search.focus();
  await expect(highlighted).toHaveText("Review extension event lifecycle");
  expect(
    (await new AxeBuilder({ page }).include(".nav").analyze()).violations,
  ).toEqual([]);
  await search.press("ArrowDown");
  await expect(highlighted).toHaveText(
    "Formula rendering and spectral analysis",
  );
  await search.dispatchEvent("compositionstart");
  await search.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    bubbles: true,
  });
  await search.dispatchEvent("compositionend");
  await expect(search).toHaveValue("bodyneedle");
  await expect(first).toHaveValue("SESSION_SEARCH_START_DRAFT");
  await search.press("Enter");
  await expect(page.locator(".topbar__title-button")).toHaveText(
    "Formula rendering and spectral analysis",
  );
  await expect(input).toHaveValue("");
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
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(search).toBeFocused();
  await expect(page.locator(".topbar__title-button")).toHaveText(
    "Formula rendering and spectral analysis",
  );
  await openFixtureSession(page, /Review extension event lifecycle/);
  await expect(input).toHaveValue("SESSION_SEARCH_ACTIVE_DRAFT");
  await expect(page.locator(".attachment")).toContainText("search-draft.txt");
  await page.getByRole("button", { name: "New session", exact: true }).click();
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

test("session transitions cannot accept input for the previous session", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);

  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  let confirmOpenStarted!: () => void;
  const openStarted = new Promise<void>((resolve) => {
    confirmOpenStarted = resolve;
  });
  await page.route(/\/api\/sessions\/open(?:\?|$)/, async (route) => {
    confirmOpenStarted();
    await openGate;
    await route.continue();
  });

  const composer = page.getByRole("form", { name: "Message composer" });
  const message = page.getByRole("textbox", { name: "Message" });
  const target = page
    .locator(".nav__row-main")
    .filter({ hasText: /Review extension event lifecycle/ });
  const opening = target.getByRole("status");
  const titleInset = async () =>
    (await target.locator(".nav__row-name").boundingBox())!.x;
  const initialInset = await titleInset();
  const initialOpacity = await target.evaluate(
    (element) => getComputedStyle(element).opacity,
  );
  const switchSession = target.click();
  try {
    await openStarted;
    await expect(composer).toHaveAttribute("aria-busy", "true");
    await expect(message).toBeDisabled();
    await expect(opening).toHaveText("Opening…");
    await expect(target).toHaveCSS("opacity", initialOpacity);
    await expect(target.getByRole("img", { name: "Working" })).toBeHidden();
    expect(await titleInset()).toBeCloseTo(initialInset, 1);
  } finally {
    releaseOpen();
    await switchSession;
  }

  await expect(page.locator(".topbar__title-button")).toHaveText(
    /Review extension event lifecycle/,
  );
  await expect(message).toBeEnabled();
  await expect(opening).toBeHidden();
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
      const hidden = drawer.locator(".nav__group--hidden");
      const hiddenToggle = hidden.getByRole("button", {
        name: "Hidden",
        exact: true,
      });
      if ((await hiddenToggle.getAttribute("aria-expanded")) === "false")
        await hiddenToggle.tap();
      const hiddenRow = hidden.locator(`[data-session-id="${sessionId}"]`);
      await expect(hiddenRow).toBeVisible();
      await expect(hiddenRow.locator('[aria-current="page"]')).toBeVisible();
      await action("Restore").tap();
      await expect(hiddenRow).toHaveCount(0);
      // Hiding clears the pin; restoring returns a regular session row.
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

test("Needs you receives live attention and remembers its mode across reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const older = "fixture-calibration-history";
  const newer = "fixture-errors";
  const hidden = "fixture-active";
  await page.route("**/api/sessions?**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const row of body.sessions) {
      if (row.id === older) row.modified = "2026-07-20T10:00:00Z";
      if (row.id === newer) row.modified = "2026-07-24T10:00:00Z";
    }
    await route.fulfill({ response, json: body });
  });
  const transport = await routeSnapshots(page, {
    bootstrap: (body) =>
      Object.assign(body.preferences, {
        pinnedSessionIds: [older],
        hiddenSessionIds: [hidden],
        hiddenProjectCwds: [],
        navCollapsedGroups: [],
      }),
    // Other tests share this Host; start from no session statuses.
    snapshot: (snapshot) => {
      Object.assign(snapshot, { sessionStatuses: {} });
    },
    event: (event) => {
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
  const bell = page.locator(".nav").getByRole("button", { name: /^Needs you/ });
  await expect(bell).toHaveAttribute("aria-pressed", "false");
  await expect(bell).toHaveAccessibleName("Needs you");

  const pinned = page.getByRole("region", { name: "Pinned", exact: true });
  await expect(pinned.locator(".nav__row")).toHaveAttribute(
    "data-session-id",
    older,
  );
  for (const sessionId of [newer, older, hidden]) {
    transport.send({
      type: "session_status",
      sessionId,
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
  }

  await expect(bell).toHaveAccessibleName("Needs you (2)");
  await bell.click();
  await expect(bell).toHaveAttribute("aria-pressed", "true");
  const list = page.getByRole("region", { name: "Sessions that need you" });
  const rows = list.locator(".nav__row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-session-id", newer);
  await expect(rows.nth(1)).toHaveAttribute("data-session-id", older);
  await expect(pinned).toHaveCount(0);

  await page.reload();
  await expect(bell).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await bell.click();
  await expect(bell).toHaveAttribute("aria-pressed", "false");
  await expect(pinned).toBeVisible();
});

test("navigation attention counts clear the glyph in the rail and drawer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const statuses: Record<string, SessionRuntimeStatus> = {};
  const transport = await routeSnapshots(page, {
    snapshot(snapshot) {
      snapshot.sessionStatuses = { ...statuses };
    },
  });
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Review extension event lifecycle/,
    "fixture-history",
  );
  await expect.poll(() => transport.ready("fixture-history")).toBe(true);

  const report = (id: string, completed: boolean) => {
    statuses[id] = completed
      ? { runState: "idle", indicator: "completed" }
      : { runState: "idle" };
    transport.send({
      type: "session_status",
      sessionId: id,
      sessionStatus: statuses[id],
    });
  };
  const check = async (toggle: Locator, count: string) => {
    await expect(
      toggle.locator(".navigation-toggle__attention > [aria-hidden]"),
    ).toHaveText(count);
    expect(
      await toggle.evaluate((button) => {
        const badge = button
          .querySelector(".navigation-toggle__attention")!
          .getBoundingClientRect();
        const header = button
          .closest("header, .nav__header")!
          .getBoundingClientRect();
        if (badge.top < header.top || badge.right > header.right)
          return "clipped";

        // The reticle has transparent space within its SVG viewBox. Check its
        // painted geometry so placing a badge in that space is permitted.
        const svg = [...button.querySelectorAll("svg")].find(
          (icon) => icon.getBoundingClientRect().width > 0,
        )!;
        for (const shape of svg.querySelectorAll<SVGGeometryElement>(
          "path, rect",
        )) {
          const matrix = shape.getScreenCTM()!.inverse();
          const { stroke, fill } = getComputedStyle(shape);
          for (let y = badge.top + 0.25; y < badge.bottom; y += 0.5) {
            for (let x = badge.left + 0.25; x < badge.right; x += 0.5) {
              const point = new DOMPoint(x, y).matrixTransform(matrix);
              if (
                (stroke !== "none" && shape.isPointInStroke(point)) ||
                (fill !== "none" && shape.isPointInFill(point))
              )
                return "overlap";
            }
          }
        }
        return "clear";
      }),
    ).toBe("clear");
  };

  report("fixture-prompt-map", true);
  await page
    .getByRole("button", { name: "Collapse navigation", exact: true })
    .click();
  const rail = page.getByRole("button", {
    name: "Expand navigation",
    exact: true,
  });
  await check(rail, "1");
  await expect(rail).toHaveAccessibleDescription(
    "1 other session needs attention",
  );
  const additional = Array.from(
    { length: 10 },
    (_, index) => `unseen-${index}`,
  );
  for (const id of additional) report(id, true);
  await check(rail, "9+");
  await expect(rail).toHaveAccessibleDescription(
    "11 other sessions need attention",
  );

  await page.setViewportSize({ width: 390, height: 780 });
  const narrow = page.getByRole("button", {
    name: "Toggle navigation",
    exact: true,
  });
  await check(narrow, "9+");
  for (const id of additional) report(id, false);
  await check(narrow, "1");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixtureSession(page, /Prompt map long-session fixture/);
  await expect(
    page.locator(".nav__row--active").getByRole("img", { name: "Completed" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(rail).not.toHaveAccessibleDescription(/need[s]? attention/);
  await page.unrouteAll({ behavior: "wait" });
});

for (const touch of [false, true]) {
  test.describe(touch ? "touch status axes" : "pointer status axes", () => {
    test.use({
      hasTouch: touch,
      viewport: { width: touch ? 320 : 1440, height: 1000 },
    });
    test("grouped, pinned and searched titles keep their position and width across status changes", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const transport = await routeSnapshots(page, {
        bootstrap: (body) =>
          Object.assign(body.preferences, {
            pinnedSessionIds: ["fixture-prompt-map"],
            hiddenSessionIds: [],
            hiddenProjectCwds: [],
            navCollapsedGroups: [],
          }),
      });
      await pairedPage(page);
      await openFixtureSession(
        page,
        /Review extension event lifecycle/,
        "fixture-history",
      );
      await expect.poll(() => transport.ready("fixture-history")).toBe(true);
      const fixtures = [
        {
          id: "fixture-calibration-history",
          name: "Calibration history fixture",
        },
        { id: "fixture-prompt-map", name: "Prompt map long-session fixture" },
      ];
      const states = [
        { runState: "running", indicator: "running", label: "Working" },
        { runState: "idle", indicator: "completed", label: "Completed" },
        { runState: "idle", indicator: "failed", label: "Failed" },
        { runState: "running", needsInput: true, label: "Waiting for input" },
      ];
      const measureTitle = (row: Element) => {
        const main = row
          .querySelector(".nav__row-main")!
          .getBoundingClientRect();
        const title = row
          .querySelector(".nav__row-name")!
          .getBoundingClientRect();
        const mark = row
          .querySelector(".nav__row-state, .nav__row-dot")
          ?.getBoundingClientRect();
        return {
          inset: title.left - main.left,
          width: title.width,
          center: title.top + title.height / 2,
          markInset: mark ? mark.left - main.left : null,
          markGap: mark ? title.left - mark.right : null,
        };
      };
      if (touch)
        await page
          .getByRole("button", { name: "Toggle navigation", exact: true })
          .click();
      const search = page.getByRole("searchbox", { name: "Search sessions" });
      for (const query of ["", "fixture"]) {
        await search.fill(query);
        const rows = fixtures.map(({ id }) =>
          page.locator(`.nav__row[data-session-id="${id}"]`),
        );
        for (const row of rows) await expect(row).toBeVisible();
        if (query)
          await expect(rows[0]!.locator(".search-match")).toHaveText("fixture");
        else
          await expect(
            page.locator(
              `.nav__group--pinned .nav__row[data-session-id="${fixtures[1]!.id}"]`,
            ),
          ).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const idle = await Promise.all(
          rows.map((row) => row.evaluate(measureTitle)),
        );
        for (const { label, ...sessionStatus } of states) {
          for (const { id } of fixtures)
            transport.send({
              type: "session_status",
              sessionId: id,
              sessionStatus,
            });
          for (const [index, row] of rows.entries()) {
            const status = row.getByRole("img", { name: label, exact: true });
            await expect(status).toBeVisible();
            const title = await row.evaluate(measureTitle);
            expect(title.inset).toBeCloseTo(idle[index]!.inset, 1);
            expect(title.width).toBeCloseTo(idle[index]!.width, 1);
            expect(title.markGap).toBeGreaterThanOrEqual(7);
            expect(title.markInset).toBeGreaterThanOrEqual(0);
            if (label !== "Waiting for input") {
              const glyph = (await status.locator("svg").boundingBox())!;
              expect(glyph.width).toBeCloseTo(10, 2);
              expect(glyph.height).toBeCloseTo(10, 2);
              expect(
                Math.abs(glyph.y + glyph.height / 2 - title.center),
              ).toBeLessThanOrEqual(0.5);
            }
          }
        }
        for (const { id } of fixtures)
          transport.send({
            type: "session_status",
            sessionId: id,
            sessionStatus: { runState: "idle" },
          });
        for (const row of rows)
          await expect(
            row.getByRole("img", { name: "Waiting for input", exact: true }),
          ).toBeHidden();
      }
    });
  });
}
