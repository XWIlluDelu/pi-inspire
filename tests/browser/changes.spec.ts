import { expect, type Locator, test } from "@playwright/test";
import type { GitDiffResponse } from "../../shared/contracts";
import { focusRingClipping } from "./support/focus-bounds";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import { openPreviewFixture, openResourceFixture } from "./support/navigation";

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
    .locator(".files-browser__section")
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

test("@cross-browser keeps compact Changes rows readable through refresh and navigation", async ({
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
  const changes = (["renamed", "copied"] as const).map((kind) => ({
    path: path(`packages/calibration/${kind}/observations/${name}`),
    worktree: {
      kind,
      originalPath: path(`packages/calibration/previous/observations/${name}`),
    },
    untracked: false,
  }));
  const files = [
    ...changes,
    { path: path("new.txt"), worktree: { kind: "added" }, untracked: true },
    { path: path("merge.txt"), conflict: { code: "UU" }, untracked: false },
    ...Array.from({ length: 30 }, (_, index) => ({
      path: path(`updated-${index}.txt`),
      worktree: { kind: "modified" },
      untracked: false,
    })),
  ];
  let unavailable = false;
  await page.route("**/api/git/status**", (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: { error: "Git timed out" } })
      : route.fulfill({
          json: {
            kind: "repository",
            head: {
              kind: "branch",
              name: "review/calibration",
              oid: "b".repeat(40),
            },
            files,
            total: files.length,
            truncated: false,
          },
        }),
  );
  const pane = await openResourceFixture(page);
  const tab = pane.getByRole("tab", { name: "Changes", exact: true });
  await tab.click();
  await page.evaluate(() => document.fonts.ready);
  await expect(
    pane.getByRole("button", { name: /new\.txt, Untracked/ }),
  ).toBeVisible();
  await expect(
    pane.getByRole("button", { name: "merge.txt, conflict UU" }),
  ).toBeVisible();
  for (const change of changes) {
    const { kind, originalPath } = change.worktree;
    const row = pane.getByRole("button", {
      name: `${change.path.display}, ${kind}, ${kind} from ${originalPath.display}`,
      exact: true,
    });
    const destination = row.locator(".res__row-name");
    const origin = row.locator(".changes__source");
    await expect(origin).toBeVisible();
    const destinationBox = (await destination.boundingBox())!;
    expect((await origin.boundingBox())!.y).toBeGreaterThanOrEqual(
      destinationBox.y + destinationBox.height,
    );
    for (const label of await row.locator(".resource-path__visible").all()) {
      expect(
        await label.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          return Array.from(range.getClientRects()).every(
            (rect) => rect.left >= box.left - 1 && rect.right <= box.right + 1,
          );
        }),
      ).toBe(true);
    }
  }
  const refresh = pane.getByRole("button", { name: "Refresh context pane" });
  const stale = pane
    .getByRole("status")
    .filter({ hasText: "Refresh failed; showing the last known status." });
  unavailable = true;
  await refresh.click();
  await expect(stale).toBeVisible();
  await expect(
    pane.getByRole("button", { name: /updated-20\.txt, modified/ }),
  ).toBeEnabled();
  unavailable = false;
  await refresh.click();
  await expect(stale).toBeHidden();

  const list = pane.locator(".res__list");
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
    await page.route("**/api/git/diff", (route) =>
      fail
        ? route.fulfill({
            status: 503,
            json: { error: "Repository temporarily unavailable" },
          })
        : route.continue(),
    );
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
    await expect(pane.locator(".res__state")).toContainText(
      "Source unavailable",
    );
    await checkKeyboardFocus(retry);
    fail = false;
    await retry.press("Enter");
    await expect(source).toBeVisible();
    const copy = pane.getByRole("button", {
      name: /^(Copy path |Path copied$)/,
    });
    await checkKeyboardFocus(copy);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(page.url()).origin,
      });
    await copy.press("Enter");
    await expect(copy).toHaveAccessibleName("Path copied");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toMatch(/page\.html$/);
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
    const frame = page.frameLocator("iframe[title='Preview page.html']");
    const enable = pane.getByRole("button", { name: "Enable interaction" });
    await enable.click();
    await expect(frame.locator("#status")).toHaveText("SCRIPT EXECUTED");
    const grant = (await frame.owner().getAttribute("src"))!;
    await changesView.click();
    await expect(source).toBeVisible();
    await expect
      .poll(async () => (await hostRequest(page).get(grant)).status())
      .toBe(404);
    await pane.getByRole("button", { name: "Source", exact: true }).click();
    const bodySource = pane.getByRole("region", { name: "File source" });
    await expect(bodySource).toBeVisible();
    await changesView.click();
    await expect(source).toBeVisible();
    await changesView.click();
    await expect(bodySource).toBeVisible();
    await selectBody(pane);
    await expect(file).toHaveCount(1);
    await expect(changesView).toHaveAttribute("aria-pressed", "false");
    await pane.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(heading).toHaveText("Quiet systems, legible signals.");
    await expect(frame.owner()).toHaveAttribute("sandbox", "");
  });
});

test("keeps long line numbers aligned and navigation preserves diff colors", {
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
  const geometry = await source
    .locator(".source-diff__line")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        code: row.querySelector("code")!.getBoundingClientRect().left,
        numbersFit: [...row.querySelectorAll(".source-diff__number")].every(
          (el) => {
            if (!el.textContent) return true;
            const range = document.createRange();
            range.selectNodeContents(el);
            const text = range.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            return text.left >= box.left - 0.5 && text.right <= box.right + 0.5;
          },
        ),
      })),
    );
  const starts = geometry.map((row) => row.code);
  expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(0.5);
  expect(geometry.every((row) => row.numbersFit)).toBe(true);
  const gutter = source.locator(".source-diff__gutter").first();
  const scroll = (left: number) =>
    source.evaluate((element, x) => {
      element.scrollLeft = x;
      return element.scrollLeft;
    }, left);
  const offset = await scroll(80);
  expect(offset).toBeGreaterThan(0);
  const gutterInset = () =>
    gutter.evaluate((element) =>
      Math.abs(
        element.getBoundingClientRect().left -
          element.closest(".source-reader")!.getBoundingClientRect().left,
      ),
    );
  await expect.poll(gutterInset).toBeLessThanOrEqual(1);
  expect(await scroll(160)).toBeGreaterThan(offset);
  await expect.poll(gutterInset).toBeLessThanOrEqual(1);
  const lines = source.locator(
    ".source-diff__line--add, .source-diff__line--delete",
  );
  const colors = () =>
    lines.evaluateAll((rows) =>
      rows.map((row) => getComputedStyle(row).backgroundColor),
    );
  const original = await colors();
  expect(original[0]).not.toBe(original[1]);
  const next = pane.getByRole("button", { name: "Next change", exact: true });
  await next.click();
  await expect(pane.getByLabel("Change position")).toHaveText("2/2");
  await expect(next).toBeDisabled();
  expect(await colors()).toEqual(original);
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
    const addition = source.locator(".source-diff__line--add code");
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
        toolCallId: "refresh-fixture",
        toolName: "bash",
        result: "done",
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

    await pane.getByRole("tab", { name: "Changes", exact: true }).click();
    await expect(source).toHaveCount(0);
    await pane.getByRole("button", { name: changeRow }).click();
    await expect(pane.getByRole("tab", fileTab)).toHaveCount(1);
    await expect.poll(position).toEqual(saved);
    await expect(pane).toHaveRole("dialog");
    await page.goBack();
    await expect(pane).toBeHidden();
  });
});
