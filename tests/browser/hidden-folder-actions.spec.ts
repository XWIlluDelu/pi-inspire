import { expect, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { hostRequest } from "./support/host-request";
import { routeMockSnapshots } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";

test.use({ reducedMotion: "reduce", serviceWorkers: "block" });

test("deletes the visible idle session through one confirmation and returns to New session", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Calibration history fixture/);
  // Destructive tests own their persisted session; the shared History fixture
  // must remain available to subsequent browser tests and retries.
  const source = (await (await hostRequest(page).get("/api/snapshot")).json())
    .active;
  const created = await hostRequest(page).post("/api/branches/clone", {
    data: {
      sessionId: source.sessionId,
      revision: source.transcriptPage.revision,
    },
  });
  expect(created.ok()).toBe(true);
  const clone = await created.json();
  const id = clone.sessionId;
  const name = clone.snapshot.active.sessionName;
  expect(
    (
      await hostRequest(page).patch("/api/preferences", {
        data: { hiddenSessionIds: [id], hiddenProjectCwds: [] },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^Session actions:/ }),
  ).toHaveText(name);
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
  const remove = page.locator(".nav__group--hidden").getByRole("button", {
    name: `Delete "${name}"`,
    exact: true,
  });
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

for (const touch of [false, true]) {
  test.describe(
    touch ? "touch Hidden hierarchy" : "pointer Hidden hierarchy",
    () => {
      test.use({ hasTouch: touch });
      test("independent rows stay distinct and folder deletion is scoped", async ({
        page,
      }, testInfo) => {
        await pairedPage(page);
        await openMockSession(page, /Formula rendering and spectral analysis/);
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
        let rows = [
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
        let preferences: Record<string, unknown> = {};
        // Browser projection owns hierarchy and the submitted scope. Real catalog
        // completeness, reservations and filesystem deletion are server regressions.
        let connected = false;
        const transport = await routeMockSnapshots(page, {
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
          if (url.pathname === "/api/sessions/clear-hidden") {
            rows = rows.filter((row) => row.cwd !== targetCwd);
            curation.hiddenProjectCwds = [otherCwd];
            return route.fulfill({
              json: {
                deleted: [first, second].map((sessionId) => ({
                  sessionId,
                  disposition: "trashed",
                })),
                preferences: { ...preferences, ...curation },
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
          await drawer.screenshot({
            path: testInfo.outputPath("pointer-actions.png"),
          });
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
        for (const width of [1440, 390, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          if (width < 768)
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
          expect(
            geometry.childName - geometry.independentName,
          ).toBeGreaterThanOrEqual(24);
          expect(geometry.clearance).toBeGreaterThanOrEqual(3);
          expect(geometry.overflow).toBe(false);
          expect(geometry.folderActions).toHaveLength(2);
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
          if (width === 390) {
            await page.mouse.move(0, 0);
            await drawer.screenshot({
              path: testInfo.outputPath("hidden-light.png"),
            });
            await page.evaluate(
              () => (document.documentElement.dataset.theme = "dark"),
            );
            await drawer.screenshot({
              path: testInfo.outputPath("hidden-dark.png"),
            });
            await page.evaluate(
              () => (document.documentElement.dataset.theme = "light"),
            );
          }
          if (width < 768)
            await page
              .getByRole("button", { name: "Close navigation", exact: true })
              .click();
        }
        await page.setViewportSize({ width: 390, height: 1000 });
        await page
          .getByRole("button", { name: "Toggle navigation", exact: true })
          .click();
        await revealRows();
        // A filtered view must not become a destructive subset of a folder.
        const search = page.getByRole("searchbox", { name: "Search sessions" });
        await search.fill("Target one");
        await expect(trash).toBeDisabled();
        await search.clear();
        transport.send({
          type: "external_session_activity",
          activities: { [first]: "working", [second]: "idle" },
        });
        await expect(target.getByRole("img", { name: /Pi/ })).toBeVisible();
        await expect(trash).toBeEnabled();
        await trash.focus();
        await trash.press("Enter");
        const dialog = page.getByRole("alertdialog", {
          name: "Clear hidden folder?",
        });
        await expect(dialog).toContainText("target · 2 sessions");
        await expect(dialog).toContainText(targetCwd);
        await expect(dialog).toContainText(
          "Open Pi terminals may write these sessions again.",
        );
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect(
          target.getByText("Target one", { exact: true }),
        ).toBeVisible();
        await trash.click();
        const response = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/sessions/clear-hidden") &&
            response.request().method() === "POST",
        );
        await dialog
          .getByRole("button", { name: "Delete 2 sessions", exact: true })
          .click();
        const receipt = await response;
        expect(receipt.ok()).toBe(true);
        expect(receipt.request().postDataJSON()).toEqual({
          sessionIds: expect.arrayContaining([first, second]),
          projectCwd: targetCwd,
        });
        expect(
          (await receipt.json()).deleted
            .map((result: { sessionId: string }) => result.sessionId)
            .sort(),
        ).toEqual([first, second].sort());
        await expect(dialog).toBeHidden();
        await expect(target).toHaveCount(0);
        await expect(standalone).toBeVisible();

        expect(curation.hiddenProjectCwds).toEqual([otherCwd]);
        expect(rows.map((row) => row.id).sort()).toEqual(
          [independent, other].sort(),
        );
      });
    },
  );
}
