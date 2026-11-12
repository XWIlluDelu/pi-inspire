import { basename } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { focusRingClipping } from "./support/focus-bounds";
import { routeSnapshots } from "./support/host-events";
import {
  openFixtureSession,
  openPreviewFixture,
  pairedPage,
} from "./support/navigation";
import { textBaseline } from "./support/text-baseline";

test("header controls keep visible keyboard focus across desktop and phone layouts", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
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
});

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
    const initial = (await pane.boundingBox())!.width;
    const bounds = (await handle.boundingBox())!;
    // A scroll thumb may own lower parts of the shared hit band.
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + 24;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => (await pane.boundingBox())!.width)
      .toBeCloseTo(initial + 48, 0);

    const dragged = (await pane.boundingBox())!.width;
    await handle.focus();
    await handle.press(selector === ".nav" ? "ArrowRight" : "ArrowLeft");
    await expect
      .poll(async () => (await pane.boundingBox())!.width)
      .toBeGreaterThan(dragged);
    // Save the settled size, rather than an intermediate frame of the resize.
    await expect
      .poll(async () => (await pane.boundingBox())!.width)
      .toBeCloseTo(Number(await handle.getAttribute("aria-valuenow")), 0);
  }

  const widths = () =>
    Promise.all(
      [".nav", ".ctx"].map((selector) =>
        page
          .locator(selector)
          .evaluate((el) => el.getBoundingClientRect().width),
      ),
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
  await expect(page.locator(".ctx__modes")).toBeVisible();

  const nav = page.locator(".nav");
  const ctx = page.locator(".ctx");
  const center = page.locator(".center");
  const width = (pane: typeof nav) =>
    pane.evaluate((el) => el.getBoundingClientRect().width);
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

  const handle = (await right.boundingBox())!;
  const x = handle.x + handle.width / 2;
  const y = handle.y + 24;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 400, y, { steps: 8 });
  await page.mouse.up();
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
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const title = page.locator(".topbar__title-button > span");
    await expect(title).toBeVisible();
    const titleBaseline = await title.evaluate(textBaseline);
    for (const selector of [
      ".topbar__project-label",
      ".topbar__git-branch",
      ".topbar__git-count",
      ".topbar__extension-text",
    ]) {
      const label = page.locator(selector);
      if (await label.isVisible()) {
        expect(
          Math.abs((await label.evaluate(textBaseline)) - titleBaseline),
          `${width}: ${selector}`,
        ).toBeLessThanOrEqual(0.5);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const branch = page.locator(".topbar__git-branch");
  await expect(branch).toBeVisible();
  expect(
    await branch.evaluate((label) => label.scrollWidth - label.clientWidth),
  ).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  const metadata = page.locator(".topbar__workspace-meta");
  expect(
    await metadata.evaluate((element) => {
      const meta = element.getBoundingClientRect();
      const git = element
        .querySelector(".topbar__git")!
        .getBoundingClientRect();
      return git.right - meta.right;
    }),
  ).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 320, height: 844 });
  await expect(metadata).toBeHidden();
  const model = page.getByRole("button", { name: "Model", exact: true });
  await expect(model).toBeVisible();
  expect(
    await model
      .locator(".dropdown__value")
      .evaluate((label) => label.scrollWidth - label.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const pane = page.getByRole("dialog", { name: "Context panel" });
  const modes = pane.locator(".ctx__modes");
  const changes = pane.getByRole("tab", { name: "Changes", exact: true });
  const count = modes.locator(".ctx__mode-count");
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

  const tiles = await modes.locator("button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      const count = button
        .querySelector(".ctx__mode-count")
        ?.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        icon: [icon.width, icon.height],
        iconCenterOffset: Math.abs(
          icon.y + icon.height / 2 - box.y - box.height / 2,
        ),
        gutter: Math.min(
          icon.left - box.left,
          box.right - (count ?? icon).right,
        ),
        counted: count !== undefined,
      };
    }),
  );
  const regularWidths = tiles
    .filter((tile) => !tile.counted)
    .map((tile) => tile.width);
  expect(Math.max(...regularWidths) - Math.min(...regularWidths)).toBeLessThan(
    0.1,
  );
  for (const tile of tiles) {
    expect(tile.icon).toEqual([16, 16]);
    expect(tile.height).toBeGreaterThanOrEqual(32);
    expect(tile.iconCenterOffset).toBeLessThanOrEqual(1);
    expect(tile.gutter).toBeGreaterThanOrEqual(2);
  }
  const tools = (await modes.boundingBox())!;
  const actions = (await pane.locator(".ctx__header-actions").boundingBox())!;
  expect(actions.x - tools.x - tools.width).toBeGreaterThanOrEqual(2);

  for (const mode of ["Files", "Changes"]) {
    await modes.getByRole("tab", { name: mode, exact: true }).click();
    const icon = (await changes.locator("svg").boundingBox())!;
    const target = (await changes.boundingBox())!;
    const box = (await count.boundingBox())!;
    expect(box.x - icon.x - icon.width).toBeGreaterThanOrEqual(2);
    expect(box.x + box.width).toBeLessThan(target.x + target.width);
    expect(
      Math.abs(box.y + box.height / 2 - icon.y - icon.height / 2),
    ).toBeLessThanOrEqual(1);
  }
  await page.unrouteAll({ behavior: "wait" });
});
