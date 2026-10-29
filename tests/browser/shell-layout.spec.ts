import { expect, test } from "@playwright/test";
import { focusRingClipping } from "./support/focus-bounds";
import { openMockSession, pairedPage } from "./support/navigation";
import { textBaseline } from "./support/text-baseline";

for (const touch of [false, true]) {
  test.describe(`header keyboard focus · ${touch ? "coarse" : "fine"} pointer`, () => {
    test.use({
      viewport: { width: 1366, height: 768 },
      hasTouch: touch,
      deviceScaleFactor: touch ? 2 : 1,
      reducedMotion: "reduce",
    });
    test("keeps focus rings and workspace buttons inside clipped header regions", async ({
      page,
    }) => {
      await pairedPage(page);
      await openMockSession(page, /Review extension event lifecycle/);
      await page.evaluate(() => document.fonts.ready);
      for (const [width, height] of [
        [1366, 768],
        [901, 390],
        [390, 844],
        [320, 640],
        [568, 320],
      ]) {
        await page.setViewportSize({ width, height });
        for (const button of await page.locator(".topbar button").all()) {
          if (!(await button.isVisible()) || !(await button.isEnabled()))
            continue;
          await button.focus();
          // A real keyboard round trip also clears restored-focus suppression.
          await page.keyboard.press("Tab");
          await page.keyboard.press("Shift+Tab");
          await expect(button).toBeFocused();
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
          await expect(button).toHaveCSS("outline-style", "solid");
          const clipping = await button.evaluate(focusRingClipping);
          expect(
            clipping,
            `${width}×${height}: ${await button.getAttribute("aria-label")}`,
          ).toBeLessThanOrEqual(0.5);
        }
        expect(
          await page.locator(".topbar__ident").evaluate((el) => el.scrollLeft),
        ).toBe(0);
      }
    });
  });
}

test("desktop pane gutters remain pointer and keyboard resize targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
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
    expect(bounds.width).toBeGreaterThanOrEqual(8);
    await page.mouse.move(800, 60);
    await expect
      .poll(() =>
        handle.evaluate((el) => getComputedStyle(el, "::after").opacity),
      )
      .toBe("0");
    // Start near the header: a scroll thumb may correctly own lower parts
    // of the shared hit band. Exercise a real pointer, not dispatched events.
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + 24;
    await page.mouse.move(x, y);
    await expect(handle).toHaveCSS("cursor", "col-resize");
    await expect
      .poll(() =>
        handle.evaluate((el) => getComputedStyle(el, "::after").opacity),
      )
      .toBe("1");
    const restingStroke = await handle.evaluate(
      (el) => getComputedStyle(el, "::after").backgroundColor,
    );
    await page.mouse.down();
    await expect
      .poll(() =>
        handle.evaluate(
          (el) => getComputedStyle(el, "::after").backgroundColor,
        ),
      )
      .not.toBe(restingStroke);
    await page.mouse.move(x + delta, y, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => (await pane.boundingBox())!.width)
      .toBeCloseTo(initial + 48, 0);

    await page.mouse.move(800, 60);
    await handle.focus();
    await handle.press(selector === ".nav" ? "ArrowRight" : "ArrowLeft");
    await expect
      .poll(() =>
        handle.evaluate((el) => getComputedStyle(el, "::after").opacity),
      )
      .toBe("1");
    await expect
      .poll(async () => (await pane.boundingBox())!.width)
      .toBeCloseTo(initial + 72, 0);
    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        handle.evaluate((el) => getComputedStyle(el, "::after").opacity),
      )
      .toBe("0");
  }

  const saved = await Promise.all(
    [".nav", ".ctx"].map((selector) =>
      page.locator(selector).evaluate((el) => el.getBoundingClientRect().width),
    ),
  );
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

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("separator", { name: "Resize files panel" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("separator", { name: "Resize navigation" }),
  ).toHaveCount(0);
});

test("saved side widths share a reading budget without changing preferences on resize", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("inspire.nav-width", "460");
    localStorage.setItem("inspire.ctx-width", "1200");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await expect(page.locator(".ctx__modes")).toBeVisible();

  for (const width of [1280, 901, 980, 1600, 2200, 840, 1280, 2200]) {
    await page.setViewportSize({ width, height: 900 });
    if (width <= 900) {
      await expect(
        page.getByRole("dialog", { name: "Context panel" }),
      ).toBeVisible();
      await expect(
        page.getByRole("separator", { name: "Resize files panel" }),
      ).toHaveCount(0);
    } else {
      const minimum = Math.min(400, width - 220 - 320 - 12);
      await expect
        .poll(async () => (await page.locator(".center").boundingBox())!.width)
        .toBeGreaterThanOrEqual(minimum - 1);
      await expect
        .poll(async () => (await page.locator(".ctx").boundingBox())!.width)
        .toBeGreaterThanOrEqual(320);
      await expect
        .poll(async () => (await page.locator(".nav").boundingBox())!.width)
        .toBeGreaterThanOrEqual(220);
      const right = await page
        .locator(".ctx")
        .evaluate((el) => el.getBoundingClientRect().right);
      expect(right).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(() => [
        localStorage.getItem("inspire.nav-width"),
        localStorage.getItem("inspire.ctx-width"),
      ]),
    ).toEqual(["460", "1200"]);
  }
  expect((await page.locator(".nav").boundingBox())!.width).toBe(460);
  expect((await page.locator(".ctx").boundingBox())!.width).toBe(1200);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await expect
    .poll(async () => (await page.locator(".nav").boundingBox())!.width)
    .toBe(460);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await expect
    .poll(async () => (await page.locator(".center").boundingBox())!.width)
    .toBeGreaterThanOrEqual(400);

  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(page.locator(".nav--rail")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect
    .poll(async () => (await page.locator(".center").boundingBox())!.width)
    .toBeGreaterThanOrEqual(400);
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await expect
    .poll(async () => (await page.locator(".nav").boundingBox())!.width)
    .toBeGreaterThanOrEqual(220);
  await expect
    .poll(async () => (await page.locator(".center").boundingBox())!.width)
    .toBeGreaterThanOrEqual(400);
});

test("resizing one side holds its peer still and exposes only the remaining reading budget", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("inspire.nav-width", "460");
    localStorage.setItem("inspire.ctx-width", "800");
  });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await expect(page.locator(".ctx__modes")).toBeVisible();
  const nav = page.locator(".nav");
  const ctx = page.locator(".ctx");
  const left = page.getByRole("separator", {
    name: "Resize navigation",
    exact: true,
  });
  const right = page.getByRole("separator", {
    name: "Resize files panel",
    exact: true,
  });
  const originalNav = (await nav.boundingBox())!.width;
  const originalContext = (await ctx.boundingBox())!.width;

  await left.focus();
  await left.press("ArrowLeft");
  await expect
    .poll(async () => (await nav.boundingBox())!.width)
    .toBeCloseTo(originalNav - 24, 0);
  expect((await ctx.boundingBox())!.width).toBeCloseTo(originalContext, 1);
  expect(
    await page.evaluate(() => localStorage.getItem("inspire.ctx-width")),
  ).toBe("800");
  await expect
    .poll(async () => Number(await right.getAttribute("aria-valuemax")))
    .toBeCloseTo(originalContext + 24, 1);

  const handleBox = (await right.boundingBox())!;
  const x = handleBox.x + handleBox.width / 2;
  const y = handleBox.y + 24;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 400, y, { steps: 8 });
  await page.mouse.up();
  expect((await nav.boundingBox())!.width).toBeCloseTo(originalNav - 24, 0);
  expect(
    (await page.locator(".center").boundingBox())!.width,
  ).toBeGreaterThanOrEqual(400);
  expect((await ctx.boundingBox())!.width).toBeCloseTo(originalContext + 24, 0);
  const pinnedContext = (await ctx.boundingBox())!.width;
  await left.press("ArrowRight");
  expect((await ctx.boundingBox())!.width).toBe(pinnedContext);
  expect((await nav.boundingBox())!.width).toBeCloseTo(originalNav - 24, 0);

  await right.dblclick({ position: { x: 4, y: 24 } });
  expect(
    await page.evaluate(() => localStorage.getItem("inspire.ctx-width")),
  ).toBeNull();
  expect((await nav.boundingBox())!.width).toBeCloseTo(originalNav - 24, 0);
  await page.setViewportSize({ width: 2200, height: 900 });
  await expect.poll(async () => (await ctx.boundingBox())!.width).toBe(760);
});

test("sidebar owns desktop toggles and creation while phones keep a full drawer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const title = page.locator(".topbar__title-button");
  await expect(
    page.locator(".topbar").getByRole("button", { name: "Toggle navigation" }),
  ).toHaveCount(0);
  await page.locator(".nav__brand-lockup").click();
  await expect(title).toHaveText(/Formula rendering and spectral analysis/);

  // One primary icon axis and one label axis, not a succession of unrelated paddings.
  const alignment = await page.locator(".nav").evaluate((nav) => {
    const box = (selector: string) =>
      nav.querySelector(selector)!.getBoundingClientRect();
    const icons = [
      ".nav__brand-icon",
      ".nav__new-session-label > svg",
      ".nav__search .search-field__icon",
      ".nav__group-toggle > svg",
      ...(nav.querySelector(".nav__dock-toggle")
        ? [".nav__dock-toggle > svg"]
        : []),
    ].map((s) => {
      const rect = box(s);
      return rect.x + rect.width / 2;
    });
    const labels = [
      ".wordmark",
      ".nav__new-session-label > span",
      ".nav__search input",
      ".nav__group-name",
      ".nav__row-title",
      ...(nav.querySelector(".nav__dock-title") ? [".nav__dock-title"] : []),
    ].map((s) => box(s).x);
    const right = [".nav__new-session", ".nav__search", ".nav__row"].map(
      (s) => box(s).right,
    );
    const metadata = [".nav__group-count", ".nav__row-age"].map(
      (s) => box(s).right,
    );
    return { icons, labels, right, metadata };
  });
  for (const positions of Object.values(alignment))
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(
      0.5,
    );

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
  expect((await create.boundingBox())!.height).toBe(36);
  expect((await drawer.locator(".nav__search").boundingBox())!.height).toBe(36);
  expect(await create.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
    "14px",
  );
  expect(await search.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
    "14px",
  );
  const controlsBox = (await drawer.locator(".nav__controls").boundingBox())!;
  const createBox = (await create.boundingBox())!;
  const searchBox = (await drawer.locator(".nav__search").boundingBox())!;
  expect(searchBox.y - createBox.y - createBox.height).toBe(8);
  expect(
    controlsBox.y + controlsBox.height - searchBox.y - searchBox.height,
  ).toBe(16);
  await drawer.getByRole("button", { name: "Close navigation" }).click();
  await expect(phoneToggle).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(expand).toBeVisible();
  await expect(phoneToggle).toHaveCount(0);
});

test("session title and workspace/status text share a baseline at every header tier", async ({
  page,
}) => {
  const withStatus = (snapshot: Record<string, unknown>) => {
    snapshot.extensionStatuses = { context: "mc: 93.7K (46%) · idle" };
    if (snapshot.active && typeof snapshot.active === "object")
      (snapshot.active as Record<string, unknown>).sessionName =
        "frontend cross val";
  };
  await page.routeWebSocket(/\/events(?:\?|$)/, (client) => {
    const upstream = client.connectToServer();
    upstream.onMessage((data) => {
      const event = JSON.parse(String(data));
      if (event.type === "snapshot" && event.data) withStatus(event.data);
      client.send(JSON.stringify(event));
    });
  });
  for (const pattern of [
    "**/api/bootstrap**",
    "**/api/snapshot**",
    "**/api/sessions/open",
  ])
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.snapshot) withStatus(body.snapshot);
      else if ("active" in body) withStatus(body);
      await route.fulfill({ response, json: body });
    });
  await pairedPage(page);
  await page
    .locator(".nav__row-main")
    .filter({ hasText: /Formula rendering and spectral analysis/ })
    .click();
  await expect(page.locator(".topbar__title-button")).toHaveText(
    "frontend cross val",
  );
  await expect(page.locator(".topbar__extension-text")).toHaveText(
    "mc: 93.7K (46%) · idle",
  );
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1440, 1024, 768, 390, 320]) {
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
    const header = (await page.locator(".topbar").boundingBox())!;
    for (const button of await page
      .locator(".topbar__actions > button, .topbar > .icon-button")
      .all()) {
      if (!(await button.isVisible())) continue;
      const box = (await button.boundingBox())!;
      expect(
        Math.abs(box.y + box.height / 2 - header.y - header.height / 2),
      ).toBeLessThanOrEqual(0.5);
    }
  }
});

test("workbench headers preserve controls, text baselines and drawer dismissal", async ({
  page,
}) => {
  await page.route("**/api/git/status?**", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    if (status.kind === "repository") status.total = 1234;
    await route.fulfill({ response, json: status });
  });
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  await page.route("**/api/bootstrap**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const model of body.availableModels ?? []) model.reasoning = false;
    const active = body.snapshot?.active;
    if (active?.model) active.model.reasoning = false;
    for (const model of active?.availableModels ?? []) model.reasoning = false;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Thinking level" }),
  ).toBeDisabled();
  await expect(page.locator(".topbar__git")).toHaveAccessibleName(
    "Open Git changes: mock/analysis, 1234 changes",
  );
  await page.evaluate(() => document.fonts.ready);

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const model = page
      .locator(".composer__meta")
      .getByRole("button", { name: "Model", exact: true });
    await expect(model).toBeVisible();
    expect((await model.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    const labelFits = await model
      .locator(".dropdown__value")
      .evaluate((label) => label.scrollWidth <= label.clientWidth + 1);
    expect(labelFits).toBe(true);
    const metadata = page.locator(".topbar__workspace-meta");
    if (width === 390) {
      // Read both boxes in the same layout; Git arrives asynchronously after
      // reload and can change the workspace metadata's width.
      const rightOverflow = await metadata.evaluate((element) => {
        const meta = element.getBoundingClientRect();
        const git = element
          .querySelector(".topbar__git")!
          .getBoundingClientRect();
        return git.right - meta.right;
      });
      expect(rightOverflow).toBeLessThanOrEqual(1);
    } else {
      // The 320px bar yields secondary workspace details to primary controls.
      await expect(metadata).toBeHidden();
    }
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    await toggle.click();
    const navigation = page.getByRole("dialog", {
      name: "Sessions",
      exact: true,
    });
    await navigation.getByRole("button", { name: "Close navigation" }).click();
    await expect(navigation).toBeHidden();
    await expect(toggle).toBeFocused();
  }

  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Context panel" });
  await expect(history.getByRole("button", { name: /Refresh/ })).toHaveCount(1);
  await expect(
    history.getByRole("tab", { name: "Changes", exact: true }),
  ).toHaveAttribute("title", "Changes (1234 changes)");
  await expect(history.locator(".ctx__mode-badge")).toHaveText("99+");
  const headerSpacing = await history.locator(".ctx__header").evaluate((el) => {
    const header = el.getBoundingClientRect();
    const tabs = el.querySelector(".ctx__modes")!.getBoundingClientRect();
    const strip = el.querySelector(".ctx__tabs")!.getBoundingClientRect();
    return {
      top: tabs.top - header.top,
      bottom: header.bottom - tabs.bottom,
      left: strip.left - header.left,
    };
  });
  expect(headerSpacing.top).toBeCloseTo(0, 2);
  expect(headerSpacing.bottom).toBeCloseTo(0, 2);
  expect(headerSpacing.left).toBeCloseTo(0, 2);
  const iconInsets = await history
    .locator(".ctx__modes [role='tab']")
    .evaluateAll((tabs) =>
      tabs.map((tab) => {
        const icon = tab.querySelector("svg")!.getBoundingClientRect();
        const bounds = tab.getBoundingClientRect();
        return Math.min(icon.left - bounds.left, bounds.right - icon.right);
      }),
    );
  expect(Math.min(...iconInsets)).toBeGreaterThanOrEqual(0);

  await page.setViewportSize({ width: 1440, height: 1000 });
  const badge = page.locator(".ctx__mode-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("99+");
  await expect(
    page.getByRole("tab", { name: "Changes", exact: true }),
  ).toHaveAttribute("title", "Changes (1234 changes)");
});
