import { expect, type Locator, type Page, test } from "@playwright/test";
import { navigationGroupsFixture } from "./fixtures/navigation-groups";
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

function folderGaps(folders: Locator) {
  return folders.evaluateAll((elements) => {
    const bounds = elements.map((folder) => folder.getBoundingClientRect());
    return bounds
      .slice(1)
      .map((folder, index) => folder.top - bounds[index]!.bottom);
  });
}

for (const { width, hasTouch } of [
  { width: 1440, hasTouch: false },
  { width: 320, hasTouch: true },
]) {
  test.describe(hasTouch ? "touch Hidden" : "pointer Hidden", () => {
    test.use({ viewport: { width, height: 1000 }, hasTouch });

    test("keeps selection and folder axes through collapse and Hidden", async ({
      page,
    }) => {
      const transport = await navigationGroupsFixture(page);
      await pairedPage(page);
      const openDrawer = page.getByRole("button", {
        name: "Toggle navigation",
        exact: true,
      });
      if (hasTouch) await openDrawer.click();
      const catalog = page.locator(".nav__list > .nav__group");
      const reports = catalog.getByRole("button", {
        name: "reports",
        exact: true,
      });
      const selected = catalog.locator(
        '[data-session-id="fixture-active"] .nav__row-main',
      );
      await expect(catalog).toHaveCount(3);
      const [gap, secondGap] = await folderGaps(catalog);
      expect(gap!).toBeGreaterThan(0);
      expect(secondGap).toBeCloseTo(gap!, 0);
      await reports.click();
      await selected.click();
      await expect(page.locator(".topbar__title-button")).toHaveText(
        "Reports session",
      );
      if (hasTouch) await openDrawer.click();
      await expect(selected).toHaveAttribute("aria-current", "page");
      expect(
        (await selected.locator(".nav__row-name").boundingBox())!.x,
      ).toBeCloseTo(
        (await reports.locator(".nav__group-name").boundingBox())!.x,
        0,
      );
      await reports.click();
      await expect(reports).toHaveAttribute("aria-expanded", "false");
      await expect(selected).toBeHidden();
      const markerClearance = await reports.evaluate((button) => {
        const header = button.parentElement!;
        const marker = getComputedStyle(header, "::before");
        const markerWidth = parseFloat(marker.width);
        const markerRight =
          header.getBoundingClientRect().left +
          parseFloat(marker.left) +
          markerWidth;
        const iconLeft = button
          .querySelector("svg")!
          .getBoundingClientRect().left;
        return Math.min(markerWidth, iconLeft - markerRight);
      });
      expect(markerClearance).toBeGreaterThan(0);
      await reports.press("Enter");
      await expect(selected).toHaveAttribute("aria-current", "page");
      expect(await folderGaps(catalog)).toEqual([gap, secondGap]);

      await page.getByRole("button", { name: "Hidden", exact: true }).click();
      const [hiddenGap] = await folderGaps(
        page.locator(".nav__hidden-content > .nav__group"),
      );
      expect(hiddenGap).toBeCloseTo(gap!, 0);

      const drawer = page.getByRole("region", { name: "Hidden", exact: true });
      const folder = drawer.locator(".nav__group").filter({
        has: page.getByRole("button", { name: "archived-a", exact: true }),
      });
      const toggle = folder.getByRole("button", {
        name: "archived-a",
        exact: true,
      });
      const actions = folder.locator(".nav__group-actions");
      await toggle.click();
      if (!hasTouch) {
        const other = drawer.getByRole("button", {
          name: "archived-b",
          exact: true,
        });
        await other.hover();
        await expect(actions).toHaveCSS("opacity", "0");
        await page.keyboard.press("Tab");
        await expect(
          folder.getByRole("button", { name: "Restore folder archived-a" }),
        ).toBeFocused();
        await expect(actions).toHaveCSS("opacity", "1");
      }

      const child = folder.locator(".nav__row");
      const independent = drawer
        .locator(".nav__row")
        .filter({ hasText: "Independent hidden session" });
      const childTitle = child.locator(".nav__row-name");
      const independentTitle = independent.locator(".nav__row-name");
      const folderLabel = toggle.locator(".nav__group-name");
      const axis = (await folderLabel.boundingBox())!.x;
      expect((await childTitle.boundingBox())!.x).toBeCloseTo(axis, 0);
      expect((await independentTitle.boundingBox())!.x).toBeCloseTo(axis, 0);

      const buttons = [
        actions,
        child.locator(".nav__row-actions"),
        independent.locator(".nav__row-actions"),
      ];
      const centers = [];
      for (const area of buttons) {
        await expect(area.getByRole("button")).toHaveCount(2);
        const bounds = await area.getByRole("button").evaluateAll((items) =>
          items.map((item) => {
            const { x, width } = item.getBoundingClientRect();
            return x + width / 2;
          }),
        );
        centers.push(bounds);
      }
      expect(centers[1]).toEqual(centers[0]);
      expect(centers[2]).toEqual(centers[0]);

      await expect.poll(() => transport.ready("fixture-active")).toBe(true);
      const before = await childTitle.boundingBox();
      transport.send({
        type: "external_session_activity",
        activities: { "fixture-compaction": "blocked" },
      });
      await expect(child.locator(".nav__row-dot")).toBeVisible();
      const after = await childTitle.boundingBox();
      expect(after?.x).toBe(before?.x);
      expect(after?.width).toBe(before?.width);
    });
  });
}
