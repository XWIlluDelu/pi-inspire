import { expect, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

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

    await handle.focus();
    await handle.press(selector === ".nav" ? "ArrowRight" : "ArrowLeft");
    await expect
      .poll(async () => (await pane.boundingBox())!.width)
      .toBeCloseTo(initial + 72, 0);
  }

  const saved = await Promise.all(
    [".nav", ".ctx"].map((selector) =>
      page.locator(selector).evaluate((el) => el.getBoundingClientRect().width),
    ),
  );
  await page.reload();
  // Widths persist independently of whether the contextual pane starts open.
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
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
      ".nav__search > svg",
      ".nav__group-toggle > svg",
      ".nav__dock-toggle > svg",
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
      ".nav__dock-title",
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
  expect((await drawer.locator(".nav__controls").boundingBox())!.height).toBe(
    88,
  );
  await drawer.getByRole("button", { name: "Close navigation" }).click();
  await expect(phoneToggle).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(expand).toBeVisible();
  await expect(phoneToggle).toHaveCount(0);
});

test("narrow workbench preserves primary controls and drawer dismissal", async ({
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
      const meta = await metadata.boundingBox();
      const git = await page.locator(".topbar__git").boundingBox();
      expect(git!.x + git!.width).toBeLessThanOrEqual(
        meta!.x + meta!.width + 1,
      );
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
  await page.getByRole("button", { name: "History", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Context panel" });
  await expect(history.getByRole("button", { name: /Refresh/ })).toHaveCount(1);
  await expect(
    history.getByRole("button", { name: "Changes", exact: true }),
  ).toHaveAttribute("title", "Changes (1234 changes)");
  await expect(history.locator(".ctx__mode-badge")).toBeHidden();
  const headerSpacing = await history.locator(".ctx__header").evaluate((el) => {
    const header = el.getBoundingClientRect();
    const tabs = el.querySelector(".ctx__modes")!.getBoundingClientRect();
    return { top: tabs.top - header.top, bottom: header.bottom - tabs.bottom };
  });
  expect(headerSpacing.top).toBeGreaterThanOrEqual(1);
  expect(headerSpacing.bottom).toBeGreaterThanOrEqual(1);
  const labelInsets = await history
    .locator(".ctx__modes button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const range = document.createRange();
        range.selectNodeContents(button);
        const text = range.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        return Math.min(text.left - bounds.left, bounds.right - text.right);
      }),
    );
  expect(Math.min(...labelInsets)).toBeGreaterThanOrEqual(0);
});
