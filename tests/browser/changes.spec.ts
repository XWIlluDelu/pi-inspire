import { expect, type Locator, test } from "@playwright/test";
import type { GitDiffResponse } from "../../shared/contracts";
import { focusRingClipping } from "./support/focus-bounds";
import { routeSnapshots } from "./support/host-events";
import {
  openPreviewFixture,
  openResourceFixture,
} from "./support/navigation";

test.use({ serviceWorkers: "block" });

const changeRow = /page\.html, modified/;
const fileTab = { name: "page.html", exact: true };
const gitToggle = { name: "Git changes", exact: true };

async function selectChange(pane: Locator) {
  await pane.getByRole("tab", { name: "Changes", exact: true }).click();
  await pane.getByRole("button", { name: changeRow }).click();
  return pane.getByRole("region", { name: /Source changes for .*page\.html/ });
}

async function selectBody(pane: Locator) {
  await pane.getByRole("tab", { name: "Files", exact: true }).click();
  const clear = pane.getByRole("button", { name: "Clear workspace search" });
  if (await clear.isVisible()) await clear.click();
  await pane
    .locator(".res__index-section")
    .filter({ hasText: "Recent" })
    .getByRole("button", { name: /page\.html/ })
    .click();
}

async function checkKeyboardFocus(control: Locator) {
  await control.page().keyboard.press("Tab");
  await control.focus();
  await expect(control).toBeFocused();
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() => control.evaluate(focusRingClipping))
    .toBeLessThanOrEqual(0.5);
}

test("@cross-browser keeps renamed, conflicting and opaque paths readable in narrow Changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  const name = "calibration-observation-summary.json";
  const path = (display: string) => ({
    id: Buffer.from(display).toString("base64url"),
    display,
    utf8Path: display,
    workspacePath: display,
  });
  const destination = path(`packages/calibration/observations/${name}`);
  const originalPath = path(`packages/calibration/previous/${name}`);
  const opaque = { id: "_w", display: "raw-�.txt" };
  const files = [
    {
      path: destination,
      worktree: { kind: "renamed", originalPath },
      untracked: false,
    },
    { path: path("new.txt"), worktree: { kind: "added" }, untracked: true },
    { path: path("merge.txt"), conflict: { code: "UU" }, untracked: false },
    { path: opaque, worktree: { kind: "modified" }, untracked: false },
    ...Array.from({ length: 30 }, (_, index) => ({
      path: path(`updated-${index}.txt`),
      worktree: { kind: "modified" },
      untracked: false,
    })),
  ];
  await page.route("**/api/git/status**", (route) =>
    route.fulfill({ json: {
      kind: "repository",
      head: { kind: "branch", name: "review/calibration", oid: "b".repeat(40) },
      files, total: files.length, truncated: false,
    } }),
  );
  const pane = await openResourceFixture(page);
  const tab = pane.getByRole("tab", { name: "Changes", exact: true });
  await tab.click();
  const row = pane.getByRole("button", {
    name: `${destination.display}, renamed, renamed from ${originalPath.display}`,
  });
  await expect(row).toBeInViewport();
  await expect(row.locator(".changes__source")).toBeInViewport();
  await expect(
    pane.getByRole("button", { name: /new\.txt, Untracked/ }),
  ).toBeVisible();
  const list = pane.locator(".res__index-list");
  const offset = await list.evaluate((element) => {
    element.scrollTop = 380;
    return element.scrollTop;
  });
  expect(offset).toBeGreaterThan(0);
  await pane.getByRole("tab", { name: "Files", exact: true }).click();
  await tab.click();
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBe(offset);

  await page.route("**/api/git/diff", (route) => {
    const { pathId } = route.request().postDataJSON();
    if (pathId !== opaque.id) return route.continue();
    return route.fulfill({
      json: { kind: "unsupported", reason: "path-encoding", path: opaque },
    });
  });
  await pane.locator(`[data-git-path=${JSON.stringify(opaque.id)}]`).click();
  await expect(
    pane.getByText("This Git path cannot be represented as UTF-8."),
  ).toBeVisible();
  await pane.getByRole("button", gitToggle).click();
  await expect(
    pane.getByText("This Git path has no readable workspace file."),
  ).toBeVisible();

});

test.describe("narrow Changes controls", () => {
  test.use({
    viewport: { width: 320, height: 640 },
    hasTouch: true,
    contextOptions: { reducedMotion: "reduce" },
  });

  test("keeps a shared Files and Changes tab readable through navigation and reload", async ({
    page,
  }) => {
    let fail = true;
    await page.route("**/api/git/diff", async (route) => {
      if (fail)
        return route.fulfill({
          status: 503,
          json: { error: "Repository temporarily unavailable" },
        });
      const response = await route.fetch();
      const diff = (await response.json()) as GitDiffResponse;
      if (diff.kind === "text") {
        diff.contextLimited = true;
      }
      await route.fulfill({ response, json: diff });
    });
    const pane = await openResourceFixture(page);
    await openPreviewFixture(pane, "vector.svg");
    await selectBody(pane);
    const changes = pane.getByRole("tab", { name: "Changes", exact: true });
    await changes.click();
    await expect(
      pane.getByText("fixture/analysis", { exact: true }),
    ).toBeVisible();
    await expect(pane.getByText("1 change", { exact: true })).toBeVisible();
    await pane.getByRole("button", { name: changeRow }).click();
    const file = pane.getByRole("tab", fileTab);
    const changesView = pane.getByRole("button", gitToggle);
    const source = pane.getByRole("region", {
      name: /Source changes for .*page\.html/,
    });
    const retry = pane.getByRole("button", { name: "Retry", exact: true });
    await expect(
      pane.getByText("Source unavailable", { exact: true }),
    ).toBeVisible();
    await checkKeyboardFocus(retry);
    fail = false;
    await retry.press("Enter");
    await expect(source.getByRole("status")).toContainText(
      "source context limited",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    const comparison = page.waitForResponse(
      (response) => response.url().endsWith("/api/git/diff") && response.ok(),
    );
    await page.reload();
    await comparison;
    await expect(pane.getByRole("tab", { name: "vector.svg" })).toBeVisible();
    await expect(file).toHaveAttribute("aria-selected", "true");
    await expect(changesView).toHaveAttribute("aria-pressed", "true");
    await expect(source).toBeVisible();

    const heading = page
      .frameLocator("iframe[title='Preview page.html']")
      .locator("h1");
    await changesView.click();
    await expect(heading).toHaveText("Quiet systems, legible signals.");
    await selectBody(pane);
    await expect(file).toHaveCount(1);
    await expect(changesView).toHaveAttribute("aria-pressed", "false");
  });
});

test("keeps long line numbers aligned during horizontal scroll", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/git/diff", async (route) => {
    const response = await route.fetch();
    const diff = (await response.json()) as GitDiffResponse;
    if (diff.kind === "text") {
      diff.lines = [
        { kind: "delete", text: "-old first", oldLine: 998, newLine: null },
        { kind: "add", text: "+new first", oldLine: null, newLine: 998 },
        {
          kind: "context",
          text: " " + "long source ".repeat(45),
          oldLine: 999,
          newLine: 999,
        },
        { kind: "delete", text: "-old second", oldLine: 1000, newLine: null },
        { kind: "add", text: "+new second", oldLine: null, newLine: 1000 },
      ];
      diff.additions = 2;
      diff.deletions = 2;
      delete diff.source;
    }
    await route.fulfill({ response, json: diff });
  });
  const pane = await openResourceFixture(page);
  const source = await selectChange(pane);
  await expect(source).toContainText("1000");
  await page.evaluate(() => document.fonts.ready);
  for (const left of [80, 160]) {
    expect(await source.evaluate((element, left) => {
      element.scrollLeft = left;
      return element.scrollLeft;
    }, left)).toBe(left);
    await expect.poll(() => source.evaluate((element) => {
      const gutter = element.querySelector(".code-row__gutter")!;
      return gutter.getBoundingClientRect().left - element.getBoundingClientRect().left;
    })).toBeCloseTo(0, 0);
  }
});

test.describe("touch source navigation", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("refreshes on polls and tool completion without moving the reader", async ({
    page,
  }) => {
    await page.clock.install();
    const transport = await routeSnapshots(page, {});
    let release: (() => void) | undefined;
    let gate: Promise<void> | undefined;
    let failRefresh = false;
    let pending = false;
    await page.route("**/api/git/diff", async (route) => {
      if (failRefresh) {
        failRefresh = false;
        return route.fulfill({
          status: 503,
          json: { error: "Repository temporarily unavailable" },
        });
      }
      const refresh = gate;
      const response = await route.fetch();
      const diff = (await response.json()) as GitDiffResponse;
      if (refresh && diff.kind === "text") {
        pending = true;
        await refresh;
        diff.lines = diff.lines.map((line) =>
          line.kind === "add"
            ? { ...line, text: "+LATEST_VISIBLE_SOURCE" }
            : line,
        );
        delete diff.source;
      }
      await route.fulfill({ response, json: diff });
    });
    const pane = await openResourceFixture(page);
    await expect.poll(() => transport.ready("fixture-resources")).toBe(true);
    const source = await selectChange(pane);
    await expect(source.locator('[data-change-index="0"]')).toBeInViewport();
    expect(await source.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await source.evaluate((node) => {
      node.scrollTop = 800;
      node.scrollLeft = 50;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const position = () =>
      source.evaluate((node) => [node.scrollTop, node.scrollLeft]);
    const saved = await position();
    const addition = source.locator('.code-row[data-kind="add"] code');
    const old = await addition.innerText();
    failRefresh = true;
    await page.clock.fastForward(4_001);
    const stale = pane.getByText(/Source refresh failed/);
    await expect(stale).toBeVisible();
    await expect(addition).toHaveText(old);
    expect(await position()).toEqual(saved);

    gate = new Promise((resolve) => {
      release = resolve;
    });
    try {
      // Pause the clock so a scheduled poll cannot satisfy the tool refresh.
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
      transport.send({
        type: "tool_execution_end",
        sessionId: "fixture-resources",
      });
      await expect.poll(() => pending).toBe(true);
      await page.clock.resume();
      await expect(addition).toHaveText(old);
      expect(await position()).toEqual(saved);
    } finally {
      release?.();
    }
    await expect(addition).toHaveText("LATEST_VISIBLE_SOURCE");
    await expect(stale).toBeHidden();
    await expect.poll(position).toEqual(saved);

  });
});
