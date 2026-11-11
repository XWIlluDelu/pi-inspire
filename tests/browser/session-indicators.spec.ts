import { expect, type Locator, test } from "@playwright/test";
import { routeSnapshots } from "./support/host-events";
import { openFixtureSession, pairedPage } from "./support/navigation";

test("navigation attention counts clear the glyph in the rail and drawer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let detailSessionId: string | undefined;
  const transport = await routeSnapshots(page, {
    snapshot(snapshot) {
      snapshot.sessionStatuses = {};
    },
    event(event) {
      if (event.type === "snapshot") detailSessionId = event.detailSessionId;
    },
  });
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Review extension event lifecycle/,
    "fixture-history",
  );
  await expect.poll(() => detailSessionId).toBe("fixture-history");

  const report = (id: string, completed: boolean) =>
    transport.send({
      type: "session_status",
      sessionId: id,
      sessionStatus: completed
        ? { runState: "idle", indicator: "completed" }
        : { runState: "idle" },
    });
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
  const additional = Array.from(
    { length: 10 },
    (_, index) => `unseen-${index}`,
  );
  for (const id of additional) report(id, true);
  await check(rail, "9+");

  await page.setViewportSize({ width: 390, height: 780 });
  const narrow = page.getByRole("button", {
    name: "Toggle navigation",
    exact: true,
  });
  await check(narrow, "9+");
  for (const id of additional) report(id, false);
  await check(narrow, "1");
  await page.unrouteAll({ behavior: "wait" });
});

test("sidebar work and unread outcomes share glyph geometry without animating attention", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let detailSessionId: string | undefined;
  const transport = await routeSnapshots(page, {
    event(event) {
      if (event.type === "snapshot") detailSessionId = event.detailSessionId;
    },
  });
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Review extension event lifecycle/,
    "fixture-history",
  );
  await expect.poll(() => detailSessionId).toBe("fixture-history");
  const fixtures = [
    {
      id: "fixture-calibration-history",
      name: "Calibration history fixture",
      label: "Working",
      runState: "running",
      indicator: "running",
    },
    {
      id: "fixture-prompt-map",
      name: "Prompt map long-session fixture",
      label: "Completed",
      runState: "idle",
      indicator: "completed",
    },
    {
      id: "fixture-branch",
      name: "Earlier branch recovery fixture",
      label: "Failed",
      runState: "idle",
      indicator: "failed",
    },
  ];
  for (const fixture of fixtures) {
    transport.send({
      type: "session_status",
      sessionId: fixture.id,
      sessionStatus: {
        runState: fixture.runState,
        indicator: fixture.indicator,
      },
    });
  }
  for (const [index, fixture] of fixtures.entries()) {
    const row = page.locator(`.nav__row[data-session-id="${fixture.id}"]`);
    const status = row.getByRole("img", { name: fixture.label, exact: true });
    await expect(status).toBeVisible();
    const glyph = status.locator(index === 0 ? ".pi-loading" : ".pi-status");
    await expect(glyph).toBeVisible();
    const box = await glyph.boundingBox();
    expect(box!.width).toBeCloseTo(10, 2);
    expect(box!.height).toBeCloseTo(10, 2);
    expect(
      await status.evaluate((el) => {
        const icon = el.getBoundingClientRect();
        const title = el
          .closest(".nav__row")!
          .querySelector(".nav__row-name")!
          .getBoundingClientRect();
        return Math.abs(icon.y + icon.height / 2 - title.y - title.height / 2);
      }),
    ).toBeLessThanOrEqual(0.5);
  }
  const working = page.locator(
    `.nav__row[data-session-id="${fixtures[0]!.id}"]`,
  );
  transport.send({
    type: "session_status",
    sessionId: fixtures[0]!.id,
    sessionStatus: {
      runState: "running",
      indicator: "attention",
      needsInput: true,
    },
  });
  await expect(
    working.getByRole("img", { name: "Waiting for input", exact: true }),
  ).toBeVisible();
  await expect(working.locator(".pi-loading")).toHaveCount(0);
  await openFixtureSession(page, /Prompt map long-session fixture/);
  await expect(page.locator(".nav__row--active .pi-status")).toHaveCount(0);

  // Fast selection stays quiet; a slow open uses text, not the working glyph.
  const nextRow = page
    .locator(".nav__row")
    .filter({ hasText: "Formula rendering and spectral analysis" });
  const idleInset = () =>
    nextRow
      .locator(".nav__row-name")
      .evaluate(
        (element) =>
          element.getBoundingClientRect().left -
          element
            .closest(".nav__group")!
            .querySelector(".nav__group-name")!
            .getBoundingClientRect().left,
      );
  expect(await idleInset()).toBe(0);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/open", async (route) => {
    await gate;
    await route.continue();
  });
  await nextRow.locator(".nav__row-main").click();
  await expect(nextRow.locator(".nav__row-main")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(nextRow.locator(".nav__row-main")).toHaveCSS("opacity", "1");
  await expect(nextRow.locator(".pi-loading")).toHaveCount(0);
  const opening = nextRow.getByRole("status");
  await expect(opening).toHaveCount(0);
  await expect(opening).toHaveText("Opening…");
  expect(await idleInset()).toBe(0);
  release();
  await expect(opening).toHaveCount(0);
  expect(await idleInset()).toBe(0);
});

for (const touch of [false, true]) {
  test.describe(touch ? "touch status axes" : "pointer status axes", () => {
    test.use({ hasTouch: touch });
    test("grouped, pinned and searched titles keep their position and width across status changes", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      let connected = false;
      const transport = await routeSnapshots(page, {
        bootstrap: (body) =>
          Object.assign(body.preferences, {
            pinnedSessionIds: ["fixture-prompt-map"],
            hiddenSessionIds: [],
            hiddenProjectCwds: [],
            navCollapsedGroups: [],
          }),
        event: (event) => {
          if (event.type === "snapshot") connected = true;
        },
      });
      await pairedPage(page);
      await openFixtureSession(
        page,
        /Review extension event lifecycle/,
        "fixture-history",
      );
      await expect.poll(() => connected).toBe(true);
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
          markInset: mark ? mark.left - main.left : null,
          markGap: mark ? title.left - mark.right : null,
        };
      };
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        if (width <= 900)
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
            await expect(rows[0]!.locator(".search-match")).toHaveText(
              "fixture",
            );
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
              row.locator(".nav__row-state, .nav__row-dot"),
            ).toHaveCount(0);
        }
        await search.clear();
        if (width <= 900)
          await page
            .getByRole("button", { name: "Close navigation", exact: true })
            .click();
      }
    });
  });
}
