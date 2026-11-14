import { basename } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { focusRingClipping } from "./support/focus-bounds";
import { routeSnapshots } from "./support/host-events";
import {
  openFixtureSession,
  openPreviewFixture,
  pairedPage,
} from "./support/navigation";

const width = (pane: Locator) =>
  pane.evaluate((el) => el.getBoundingClientRect().width);
async function drag(handle: Locator, offset: number) {
  const { x, y, width } = (await handle.boundingBox())!;
  const mouse = handle.page().mouse;
  await mouse.move(x + width / 2, y + 24);
  await mouse.down();
  await mouse.move(x + width / 2 + offset, y + 24, { steps: 6 });
  await mouse.up();
}

test("desktop pane gutters remain pointer and keyboard resize targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await expect(page.locator(".ctx")).toBeVisible();

  for (const [label, selector, delta] of [
    ["Resize navigation", ".nav", 48],
    ["Resize files panel", ".ctx", -48],
  ] as const) {
    const handle = page.getByRole("separator", { name: label, exact: true });
    const pane = page.locator(selector);
    const initial = await width(pane);
    await drag(handle, delta);
    await expect.poll(() => width(pane)).toBeCloseTo(initial + 48, 0);

    await handle.press(selector === ".nav" ? "ArrowRight" : "ArrowLeft");
    const reported = Number(await handle.getAttribute("aria-valuenow"));
    expect(reported).toBeGreaterThan(initial + 48);
    await expect.poll(() => width(pane)).toBeCloseTo(reported, 0);
  }

  const widths = () =>
    Promise.all(
      [".nav", ".ctx"].map((selector) => width(page.locator(selector))),
    );
  const saved = await widths();
  await page.reload();
  // Reload restores the open pane as well as both independently saved widths.
  await expect(
    page.getByRole("button", { name: "Toggle resources panel" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".ctx")).toBeVisible();
  for (const [i, selector, label] of [
    [0, ".nav", "Resize navigation"],
    [1, ".ctx", "Resize files panel"],
  ] as const) {
    await expect
      .poll(async () => (await page.locator(selector).boundingBox())!.width)
      .toBeCloseTo(saved[i], 0);
    await page
      .getByRole("separator", { name: label, exact: true })
      .dblclick({ position: { x: 4, y: 24 } });
    await expect
      .poll(async () => (await page.locator(selector).boundingBox())!.width)
      .toBeLessThan(saved[i]);
  }

  const reset = await widths();
  await page.reload();
  await expect.poll(widths).toEqual(reset);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("separator", { name: "Resize files panel" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("separator", { name: "Resize navigation" }),
  ).toHaveCount(0);
});

test("side panes preserve saved widths and leave the reading budget during resize", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("inspire.nav-width", "460");
    localStorage.setItem("inspire.ctx-width", "1200");
  });
  await page.setViewportSize({ width: 901, height: 900 });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await expect(
    page.getByRole("tab", { name: "Files", exact: true }),
  ).toBeVisible();

  const nav = page.locator(".nav");
  const ctx = page.locator(".ctx");
  const center = page.locator(".center");
  await expect.poll(() => width(nav)).toBeGreaterThanOrEqual(220);
  expect(await width(ctx)).toBeGreaterThanOrEqual(320);
  expect(await width(center)).toBeGreaterThanOrEqual(344);

  const left = page.getByRole("separator", {
    name: "Resize navigation",
    exact: true,
  });
  const right = page.getByRole("separator", {
    name: "Resize files panel",
    exact: true,
  });
  await page.setViewportSize({ width: 840, height: 900 });
  await expect(
    page.getByRole("dialog", { name: "Context panel" }),
  ).toBeVisible();
  await expect(right).toHaveCount(0);
  await page.setViewportSize({ width: 2200, height: 900 });
  await expect
    .poll(() => Promise.all([width(nav), width(ctx)]))
    .toEqual([460, 1200]);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => width(center)).toBeGreaterThanOrEqual(400);
  const originalNav = await width(nav);
  const originalContext = await width(ctx);
  await left.press("ArrowLeft");
  await expect.poll(() => width(nav)).toBeLessThan(originalNav);
  const reducedNav = Number(await left.getAttribute("aria-valuenow"));
  await expect.poll(() => width(nav)).toBeCloseTo(reducedNav, 0);
  expect(await width(ctx)).toBeCloseTo(originalContext, 1);
  const limit = Number(await right.getAttribute("aria-valuemax"));
  expect(limit).toBeGreaterThan(originalContext);

  await drag(right, -400);
  expect(await width(nav)).toBeCloseTo(reducedNav, 0);
  expect(await width(center)).toBeGreaterThanOrEqual(400);
  expect(await width(ctx)).toBeCloseTo(limit, 0);
  await left.press("ArrowRight");
  expect(await width(ctx)).toBeCloseTo(limit, 0);
  expect(await width(nav)).toBeCloseTo(reducedNav, 0);
});

test("sidebar owns desktop toggles and creation while phones keep a full drawer", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  await expect(page.getByRole("log")).toContainText("A compact result");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .disableRules(["color-contrast"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const project = page.getByRole("button", { name: "Copy project path" });
  await expect(project).toHaveText(basename(browserWorkspace));
  await expect
    .poll(() => project.getAttribute("title"))
    .toContain(browserWorkspace);
  await project.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(browserWorkspace);
  const collapse = page.getByRole("button", { name: "Collapse navigation" });
  const expand = page.getByRole("button", { name: "Expand navigation" });
  await collapse.focus();
  await collapse.press("Enter");
  await expect(page.locator(".nav--rail")).toBeVisible();
  await expect(expand).toBeFocused();
  await expand.press("Enter");
  await expect(collapse).toBeFocused();
  await expect(page.locator(".nav--rail")).toHaveCount(0);

  // Global shortcuts must not move editor focus into the sidebar.
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.focus();
  await editor.press("Control+b");
  await expect(expand).toBeVisible();
  await expect(editor).toBeFocused();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "First message", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".nav--rail")).toBeVisible();

  // Desktop rail preference must never turn the phone drawer into a rail.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".nav")).toHaveCount(0);
  const phoneToggle = page.getByRole("button", { name: "Toggle navigation" });
  await phoneToggle.click();
  const drawer = page.getByRole("dialog", { name: "Sessions", exact: true });
  await expect(drawer).toBeVisible();
  await expect(page.locator(".nav--rail")).toHaveCount(0);
  const create = drawer.getByRole("button", {
    name: "New session",
    exact: true,
  });
  const search = drawer.getByRole("searchbox", {
    name: "Search sessions",
    exact: true,
  });
  await expect(create).toBeVisible();
  await search.fill("Formula rendering");
  await expect(search).toHaveValue("Formula rendering");
  await drawer.getByRole("button", { name: "Close navigation" }).click();
  await expect(phoneToggle).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(expand).toBeVisible();
  await expect(phoneToggle).toHaveCount(0);
});

test("workbench headers keep labels, controls and the live Git count readable", async ({
  page,
}) => {
  let total = 1;
  await page.route("**/api/git/status?**", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    if (status.kind === "repository") status.total = total;
    await route.fulfill({ response, json: status });
  });
  await routeSnapshots(page, {
    snapshot(snapshot) {
      snapshot.extensionStatuses = { context: "mc: 93.7K (46%) · idle" };
      if (snapshot.active?.model) snapshot.active.model.reasoning = false;
      for (const model of snapshot.active?.availableModels ?? [])
        model.reasoning = false;
    },
    bootstrap(body) {
      for (const model of body.availableModels ?? []) model.reasoning = false;
    },
  });
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  await expect(
    page.getByRole("combobox", { name: "Thinking level" }),
  ).toBeDisabled();
  await expect(page.locator(".topbar__extension-text")).toHaveText(
    "mc: 93.7K (46%) · idle",
  );
  await expect(page.locator(".topbar__git")).toHaveAccessibleName(
    /fixture\/analysis, 1 change/,
  );
  const branch = page.locator(".topbar__git-branch");
  await expect(branch).toBeVisible();
  expect(
    await branch.evaluate((label) => label.scrollWidth - label.clientWidth),
  ).toBeLessThanOrEqual(1);

  await page.evaluate(() => document.fonts.ready);
  for (const [width, height, name] of [
    [901, 390, "Toggle resources panel"],
    [320, 640, "Toggle navigation"],
  ] as const) {
    await page.setViewportSize({ width, height });
    const button = page.getByRole("button", { name, exact: true });
    await button.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS("outline-style", "solid");
    await expect
      .poll(() => button.evaluate(focusRingClipping))
      .toBeLessThanOrEqual(0.5);
  }
  const topbar = page.locator(".topbar");
  for (const control of [
    topbar.getByRole("button", { name: "Copy project path" }),
    topbar.getByRole("button", { name: /Open Git changes.*1 change/ }),
  ]) {
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  const model = page.getByRole("button", { name: "Model", exact: true });
  await expect(model).toBeVisible();
  expect(
    await model
      .locator(".model-picker__value")
      .evaluate((label) => label.scrollWidth - label.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const pane = page.getByRole("dialog", { name: "Context panel" });
  const tools = pane.locator(".ctx__tools");
  const changes = pane.getByRole("tab", { name: "Changes", exact: true });
  const count = changes.locator(".ctx__mode-count");
  await expect(count).toHaveText("1");
  const refresh = pane.getByRole("button", {
    name: "Refresh context pane",
    exact: true,
  });
  await expect(refresh).toBeVisible();
  await changes.click();
  total = 1234;
  await refresh.click();
  await expect(changes).toHaveAttribute("title", "Changes (1234 changes)");
  await expect(count).toHaveText("99+");
  await openPreviewFixture(pane, "document.md");

  expect(
    await tools.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  const icon = (await changes.locator("svg").boundingBox())!;
  const target = (await changes.boundingBox())!;
  const box = (await count.boundingBox())!;
  expect(box.x).toBeGreaterThan(icon.x + icon.width);
  expect(box.x + box.width).toBeLessThan(target.x + target.width);
  await page.unrouteAll({ behavior: "wait" });
});
