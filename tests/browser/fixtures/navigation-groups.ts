import type { Page } from "@playwright/test";
import type { SessionSummary } from "../../../shared/contracts";
import { routeMockSnapshots } from "../support/mock-host";

/** Isolated curation model: grouped projects, including a Hidden former pin.
 * MockRuntime.newSession is transient, not a file-backed catalog entry. Seeded
 * native IDs retain their real open/history envelopes; only the catalog
 * summaries and matching selected identity are fixture-owned. No Host preference
 * or canonical session file is changed. */
export async function navigationGroupsFixture(page: Page) {
  const records: SessionSummary[] = [
    ["mock-history", "/projects/calibration", "Geometry session", "05"],
    [
      "mock-calibration-history",
      "/projects/acquisition",
      "Residual session",
      "04",
    ],
    ["mock-active", "/projects/reports", "Reports session", "03"],
    [
      "mock-compaction",
      "/projects/archived-a",
      "Archived measurement session",
      "02",
    ],
    [
      "mock-errors",
      "/projects/archived-b",
      "Archived validation session",
      "01",
    ],
  ].map(([id, cwd, title, day]) => ({
    id: id!,
    cwd: cwd!,
    title: title!,
    project: cwd!.split("/").at(-1)!,
    created: "2026-08-01T12:00:00Z",
    modified: "2026-08-" + day + "T12:00:00Z",
    messageCount: 1,
  }));
  let preferences: Record<string, unknown>;
  const transport = await routeMockSnapshots(page, {
    bootstrap: (body) => {
      if (!preferences)
        preferences = {
          ...body.preferences,
          pinnedSessionIds: [],
          hiddenSessionIds: [],
          pinnedProjectCwds: [
            "/projects/calibration",
            "/projects/acquisition",
            "/projects/archived-a",
          ],
          hiddenProjectCwds: ["/projects/archived-a", "/projects/archived-b"],
          navCollapsedGroups: records.map((record) => record.cwd),
        };
      Object.assign(body.preferences, preferences);
    },
    snapshot: (snapshot) => {
      const record = records.find(
        (record) => record.id === snapshot.active?.sessionId,
      );
      if (snapshot.active && record) {
        snapshot.active.cwd = record.cwd;
        snapshot.active.sessionName = record.title;
      }
    },
  });
  await page.route("**/api/preferences", async (route) => {
    Object.assign(preferences, route.request().postDataJSON());
    await route.fulfill({
      headers: { "X-Inspire-Authority": transport.authority() },
      json: preferences,
    });
  });
  await page.route(/\/api\/sessions(?:\?|$)/, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const q = (params.get("q") ?? "").toLowerCase();
    const sessions = records.filter((record) =>
      (record.title + " " + record.cwd).toLowerCase().includes(q),
    );
    const offset = Number(params.get("offset") ?? 0),
      limit = Number(params.get("limit") ?? 40);
    await route.fulfill({
      json: {
        sessions: sessions.slice(offset, offset + limit),
        total: sessions.length,
        offset,
        limit,
      },
    });
  });
  for (const kind of ["id", "cwd"] as const)
    await page.route("**/api/sessions/by-" + kind, async (route) => {
      const body = route.request().postDataJSON();
      const requested = body[kind === "id" ? "ids" : "cwds"];
      await route.fulfill({
        json: {
          sessions: records.filter((record) =>
            requested.includes(record[kind]),
          ),
        },
      });
    });
}
