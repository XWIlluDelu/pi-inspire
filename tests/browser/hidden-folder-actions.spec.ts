import { expect, type Page, test } from "@playwright/test";
import type { InspirePreferences } from "../../shared/contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import { openFixtureSession, pairedPage } from "./support/navigation";

test.use({
  contextOptions: { reducedMotion: "reduce" },
  serviceWorkers: "block",
});

/** A disposable Hidden session cloned from a fixture, with the navigation
 * drawer and Hidden open. Destructive tests own their persisted session; the
 * shared fixtures must remain available to later tests and retries. */
async function hiddenClone(
  page: Page,
  fixture: RegExp,
  fixtureId?: string,
): Promise<{ id: string; name: string }> {
  await pairedPage(page);
  await openFixtureSession(page, fixture, fixtureId);
  const source = (await (await hostRequest(page).get("/api/snapshot")).json())
    .active;
  const created = await hostRequest(page).post("/api/branches/clone", {
    data: {
      sessionId: source.sessionId,
      viewId: source.transcriptPage.viewId,
      targetId: source.transcriptPage.effectiveLeafId,
    },
  });
  expect(created.ok()).toBe(true);
  const clone = await created.json();
  const id: string = clone.sessionId;
  expect(
    (
      await hostRequest(page).patch("/api/preferences", {
        data: { hiddenSessionIds: [id], hiddenProjectCwds: [] },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  const navigation = page.getByRole("button", {
    name: /^(Toggle|Expand|Collapse) navigation$/,
    exact: true,
  });
  if (
    (await navigation.getAttribute("aria-expanded")) === "false" ||
    (await page.locator(".nav--rail").count())
  )
    await navigation.click();
  const hidden = page.getByRole("button", { name: "Hidden", exact: true });
  if ((await hidden.getAttribute("aria-expanded")) !== "true")
    await hidden.click();
  return { id, name: clone.snapshot.active.sessionName };
}

test("deletes the visible idle session through one confirmation and returns to New session", async ({
  page,
}) => {
  const { name } = await hiddenClone(
    page,
    /Calibration history fixture/,
    "fixture-calibration-history",
  );
  // API cloning does not replace this browser's selected session.
  await page
    .locator(".nav__group--hidden .nav__row-main")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();
  await expect(
    page.getByRole("button", { name: /^Session actions:/ }),
  ).toHaveText(name);
  const remove = page.locator(".nav__group--hidden").getByRole("button", {
    name: `Delete "${name}"`,
    exact: true,
  });
  await page
    .locator(".nav__group--hidden .nav__row")
    .filter({
      has: page.getByRole("button", { name: `Delete "${name}"`, exact: true }),
    })
    .hover();
  await expect(remove).toBeEnabled();
  await remove.click();
  const dialog = page.getByRole("alertdialog", { name: "Delete session?" });
  await expect(dialog.locator(".session-delete__warning")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Delete session", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("form", { name: "Start a session" }),
  ).toBeVisible();
  await expect(remove).toHaveCount(0);
  const snapshot = await hostRequest(page).get("/api/snapshot");
  expect((await snapshot.json()).active).toBeNull();
});

test("failed deletion wraps a literal path inside the confirmation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const { id, name } = await hiddenClone(
    page,
    /Review extension event lifecycle/,
  );
  const diagnostic =
    "Cannot delete /workspace/calibration/reference_measurement_comparison_for_multichannel_calibration_and_residual_validation_2026_10_17_results.json because the project is locked.";
  let attempted = 0;
  await page.route(
    `**/api/sessions/${encodeURIComponent(id)}`,
    async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      attempted++;
      await route.fulfill({ status: 409, json: { error: diagnostic } });
    },
  );
  await page
    .locator(".nav__group--hidden")
    .getByRole("button", {
      name: `Delete "${name}"`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("alertdialog", {
    name: "Delete session?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Delete session", exact: true })
    .click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText(diagnostic);
  const geometry = await alert.evaluate((node) => {
    const b = node.getBoundingClientRect(),
      style = getComputedStyle(node),
      range = document.createRange();
    range.selectNodeContents(node);
    const left =
      b.left +
      Number.parseFloat(style.borderLeftWidth) +
      Number.parseFloat(style.paddingLeft);
    const right =
      b.right -
      Number.parseFloat(style.borderRightWidth) -
      Number.parseFloat(style.paddingRight);
    return {
      textFits: [...range.getClientRects()].every(
        (rect) => rect.left >= left - 0.5 && rect.right <= right + 0.5,
      ),
      client: node.closest(".dialog")!.clientWidth,
      scroll: node.closest(".dialog")!.scrollWidth,
    };
  });
  expect(geometry.textFits).toBe(true);
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.client);
  expect(attempted).toBe(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Even a deliberately failed delete must not hide or consume shared data.
  expect(
    (
      await hostRequest(page).delete(`/api/sessions/${encodeURIComponent(id)}`)
    ).ok(),
  ).toBe(true);
});

for (const touch of [false, true]) {
  test.describe(
    touch ? "touch Hidden hierarchy" : "pointer Hidden hierarchy",
    () => {
      test.use({ hasTouch: touch });
      test("folder, child and independent rows share one alignment and reveal actions per row", async ({
        page,
      }) => {
        await pairedPage(page);
        await openFixtureSession(
          page,
          /Formula rendering and spectral analysis/,
        );
        const initial = await (
          await hostRequest(page).get("/api/bootstrap")
        ).json();
        const catalogResponse = await hostRequest(page).get(
          "/api/sessions?offset=0&limit=40",
        );
        const template = (await catalogResponse.json()).sessions[0];
        const targetCwd = `${browserWorkspace}/target`;
        const otherCwd = `${browserWorkspace}/other`;
        const first = "hidden-target-one",
          second = "hidden-target-two",
          independent = "hidden-independent";
        const other = initial.snapshot.active.sessionId as string;
        const rows = [
          { ...template, id: first, title: "Target one", cwd: targetCwd },
          { ...template, id: second, title: "Target two", cwd: targetCwd },
          {
            ...template,
            id: independent,
            title: "Independent hidden session",
            cwd: browserWorkspace,
          },
          {
            ...template,
            id: other,
            title: "Other hidden session",
            cwd: otherCwd,
          },
        ];
        const curation = {
          theme: "light",
          palette: "classic-amber",
          hiddenProjectCwds: [targetCwd, otherCwd],
          hiddenSessionIds: [independent],
          pinnedSessionIds: [],
          pinnedProjectCwds: [],
          navCollapsedGroups: [otherCwd],
        };
        let preferences: Partial<InspirePreferences> = {};
        // Layout and per-row action reveal only; deletion scope and eligibility
        // are covered by the Nav component and nav-model rules.
        let connected = false;
        const transport = await routeSnapshots(page, {
          event: (event) => {
            if (event.type === "snapshot") connected = true;
          },
          snapshot: (snapshot) => {
            if (snapshot.active)
              Object.assign(snapshot.active, {
                sessionId: other,
                cwd: otherCwd,
                sessionName: "Other hidden session",
              });
          },
          bootstrap: (body) => {
            Object.assign(body.preferences, curation);
            preferences = body.preferences;
          },
        });
        await page.route("**/api/sessions**", async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === "/api/sessions/by-cwd") {
            const { cwds } = route.request().postDataJSON();
            return route.fulfill({
              json: { sessions: rows.filter((row) => cwds.includes(row.cwd)) },
            });
          }
          if (url.pathname === "/api/sessions/by-id") {
            const { ids } = route.request().postDataJSON();
            return route.fulfill({
              json: { sessions: rows.filter((row) => ids.includes(row.id)) },
            });
          }
          if (url.pathname === "/api/sessions") {
            const query = (url.searchParams.get("q") ?? "").toLowerCase();
            const matches = rows.filter((row) =>
              row.title.toLowerCase().includes(query),
            );
            return route.fulfill({
              json: {
                sessions: matches,
                total: matches.length,
                offset: 0,
                limit: 40,
              },
            });
          }
          return route.fallback();
        });
        await page.route("**/api/preferences", async (route) => {
          Object.assign(preferences, route.request().postDataJSON());
          await route.fulfill({ json: preferences });
        });
        await page.reload();
        await expect.poll(() => connected).toBe(true);
        await page.getByRole("button", { name: "Hidden", exact: true }).click();
        const drawer = page.locator(".nav__group--hidden");
        const target = drawer.locator(".nav__group").filter({
          has: page.getByRole("button", {
            name: "Delete all sessions in folder target",
            exact: true,
          }),
        });
        const standalone = drawer
          .locator(".nav__hidden-content > .nav__row")
          .filter({
            hasText: "Independent hidden session",
          });
        const trash = target.getByRole("button", {
          name: "Delete all sessions in folder target",
        });
        await expect(trash).toBeEnabled();
        await expect(
          page.getByRole("button", { name: "Clear Hidden", exact: true }),
        ).toBeEnabled();
        // A pointer click must not keep one folder's actions revealed while
        // another is hovered. Keyboard focus still owns a visible action row.
        if (!touch) {
          await page.setViewportSize({ width: 1440, height: 1000 });
          const otherFolder = drawer.locator(".nav__group").filter({
            has: page.getByRole("button", {
              name: "Restore folder other",
              exact: true,
            }),
          });
          const toggle = target.locator(".nav__group-toggle");
          await toggle.click();
          await otherFolder.locator(".nav__group-title").hover();
          await expect(toggle).toBeFocused();
          expect(
            await toggle.evaluate((el) => el.matches(":focus-visible")),
          ).toBe(false);
          await expect(target.locator(".nav__group-actions")).toHaveCSS(
            "opacity",
            "0",
          );
          await expect(target.locator(".nav__group-count")).toHaveCSS(
            "opacity",
            "1",
          );
          await expect(otherFolder.locator(".nav__group-actions")).toHaveCSS(
            "opacity",
            "1",
          );
          await page.keyboard.press("Tab");
          await expect(
            target.getByRole("button", {
              name: "Restore folder target",
              exact: true,
            }),
          ).toBeFocused();
          await expect(target.locator(".nav__group-actions")).toHaveCSS(
            "opacity",
            "1",
          );
          await expect(target.locator(".nav__group-count")).toHaveCSS(
            "opacity",
            "0",
          );
        }
        const revealRows = async () => {
          const hiddenToggle = page.getByRole("button", {
            name: "Hidden",
            exact: true,
          });
          if ((await hiddenToggle.getAttribute("aria-expanded")) !== "true")
            await hiddenToggle.click();
          const folderToggle = target.locator(".nav__group-toggle");
          if ((await folderToggle.getAttribute("aria-expanded")) !== "true")
            await folderToggle.click();
        };
        for (const width of [1440, 768, 390, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          if (width <= 900)
            await page
              .getByRole("button", { name: "Toggle navigation", exact: true })
              .click();
          await revealRows();
          await expect(
            target.getByText("Target one", { exact: true }),
          ).toBeVisible();
          const geometry = await drawer.evaluate((element) => {
            const group = [...element.querySelectorAll(".nav__group")].find(
              (group) =>
                group.querySelector(".nav__group-name")?.textContent ===
                "target",
            )!;
            const row = group.querySelector(".nav__row")!;
            const loose = element.querySelector(
              ".nav__hidden-content > .nav__row",
            )!;
            const centers = (element: Element, selector: string) =>
              [...element.querySelectorAll(selector)].map((button) => {
                const box = button.getBoundingClientRect();
                return (box.left + box.right) / 2;
              });
            const active = element.querySelector(".nav__group-title--active")!;
            const marker = getComputedStyle(active, "::before");
            const markerRight =
              active.getBoundingClientRect().left +
              parseFloat(marker.left) +
              parseFloat(marker.width);
            return {
              navLeft: element.closest(".nav")!.getBoundingClientRect().left,
              folderName: group
                .querySelector(".nav__group-name")!
                .getBoundingClientRect().left,
              childName: row
                .querySelector(".nav__row-name")!
                .getBoundingClientRect().left,
              independentName: loose
                .querySelector(".nav__row-name")!
                .getBoundingClientRect().left,
              folderActions: centers(group, ".nav__group-actions > button"),
              childActions: centers(row, ".nav__row-actions > button"),
              independentActions: centers(loose, ".nav__row-actions > button"),
              clearance:
                active
                  .querySelector(".nav__group-toggle > svg")!
                  .getBoundingClientRect().left - markerRight,
              overflow: element.scrollWidth > element.clientWidth,
            };
          });
          expect(
            Math.abs(geometry.folderName - geometry.childName),
          ).toBeLessThanOrEqual(1);
          expect(geometry.folderName - geometry.navLeft).toBeCloseTo(40, 1);
          expect(geometry.independentName).toBeCloseTo(geometry.childName, 1);
          await expect(standalone.locator("..")).toHaveClass(
            "nav__hidden-content",
          );
          expect(geometry.clearance).toBeGreaterThanOrEqual(1);
          expect(geometry.overflow).toBe(false);
          expect(geometry.folderActions).toHaveLength(2);
          const trashBounds = (await trash.boundingBox())!;
          const minimumTarget = touch || width <= 600 ? 36 : 24;
          expect(trashBounds.width).toBeGreaterThanOrEqual(minimumTarget);
          expect(trashBounds.height).toBeGreaterThanOrEqual(minimumTarget);
          for (let slot = 0; slot < 2; slot++) {
            expect(
              Math.abs(
                geometry.folderActions[slot]! - geometry.childActions[slot]!,
              ),
            ).toBeLessThanOrEqual(1);
            expect(
              Math.abs(
                geometry.folderActions[slot]! -
                  geometry.independentActions[slot]!,
              ),
            ).toBeLessThanOrEqual(1);
          }
          const statusRows = [
            target.locator(".nav__row").filter({ hasText: "Target one" }),
            standalone,
          ];
          const measureTitle = (row: Element) => {
            const main = row
              .querySelector(".nav__row-main")!
              .getBoundingClientRect();
            const title = row
              .querySelector(".nav__row-name")!
              .getBoundingClientRect();
            return { inset: title.left - main.left, width: title.width };
          };
          const idleTitles = await Promise.all(
            statusRows.map((row) => row.evaluate(measureTitle)),
          );
          for (const activity of ["working", "blocked", "idle"] as const) {
            transport.send({
              type: "external_session_activity",
              activities: { [first]: activity, [independent]: activity },
            });
            for (const [index, row] of statusRows.entries()) {
              const mark = row.locator(
                activity === "idle"
                  ? ".nav__row-state, .nav__row-dot"
                  : activity === "blocked"
                    ? ".nav__row-dot"
                    : ".nav__row-state",
              );
              if (activity === "idle") await expect(mark).toHaveCount(0);
              else await expect(mark).toBeVisible();
              const title = await row.evaluate(measureTitle);
              expect(title.inset).toBeCloseTo(idleTitles[index]!.inset, 1);
              expect(title.width).toBeCloseTo(idleTitles[index]!.width, 1);
            }
          }
          if (width <= 900)
            await page
              .getByRole("button", { name: "Close navigation", exact: true })
              .click();
        }
      });
    },
  );
}
