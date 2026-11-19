import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, test } from "@playwright/test";
import { openFixtureSession, pairedPage } from "./support/navigation";

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

test("side panes fit the reading budget and restore their independent widths", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 2200, height: 900 });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  const toggle = page.getByRole("button", { name: "Toggle resources panel" });
  await toggle.click();
  const nav = page.locator(".nav");
  const ctx = page.locator(".ctx");
  const center = page.locator(".center");
  const left = page.getByRole("separator", { name: "Resize navigation" });
  const right = page.getByRole("separator", { name: "Resize files panel" });
  const widths = () => Promise.all([width(nav), width(ctx)]);
  await expect(
    ctx.getByRole("tab", { name: "Files", exact: true }),
  ).toBeVisible();
  const [defaultNav, defaultContext] = await widths();

  for (const [handle, pane, peer, offset, key] of [
    [left, nav, ctx, 48, "ArrowRight"],
    [right, ctx, nav, -48, "ArrowLeft"],
  ] as const) {
    const initial = await width(pane);
    const peerWidth = await width(peer);
    await drag(handle, offset);
    await expect.poll(() => width(pane)).toBeCloseTo(initial + 48, 0);
    await handle.press(key);
    const reported = Number(await handle.getAttribute("aria-valuenow"));
    expect(reported).toBeGreaterThan(initial + 48);
    await expect.poll(() => width(pane)).toBeCloseTo(reported, 0);
    expect(await width(peer)).toBeCloseTo(peerWidth, 0);
  }

  // Keep a real manually chosen right width above the former 760px cap.
  await drag(right, (await width(ctx)) - 850);
  await expect.poll(() => width(ctx)).toBeCloseTo(850, 0);
  const saved = await widths();
  await page.setViewportSize({ width: 901, height: 900 });
  await expect.poll(() => width(nav)).toBeGreaterThanOrEqual(220);
  expect(await width(ctx)).toBeGreaterThanOrEqual(320);
  expect(await width(center)).toBeGreaterThanOrEqual(344);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("dialog", { name: "Context panel" }),
  ).toBeVisible();
  await expect(left).toHaveCount(0);
  await expect(right).toHaveCount(0);
  await page.setViewportSize({ width: 2200, height: 900 });
  await expect.poll(widths).toEqual(saved);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(widths).toEqual(saved);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => width(center)).toBeGreaterThanOrEqual(400);
  const previous = await width(ctx);
  const originalNav = await width(nav);
  await left.press("ArrowLeft");
  await expect.poll(() => width(nav)).toBeLessThan(originalNav);
  expect(await width(ctx)).toBeCloseTo(previous, 0);
  const leftWidth = await width(nav);
  const rightLimit = async () => Number(await right.getAttribute("aria-valuemax"));
  await expect.poll(rightLimit).toBeGreaterThan(previous);
  const limit = await rightLimit();
  await drag(right, -400);
  await expect.poll(() => width(ctx)).toBeCloseTo(limit, 0);
  await left.press("ArrowRight");
  expect(await width(nav)).toBeCloseTo(leftWidth, 0);
  expect(await width(ctx)).toBeCloseTo(limit, 0);
  expect(await width(center)).toBeGreaterThanOrEqual(400);

  await page.setViewportSize({ width: 2200, height: 900 });
  await left.dblclick({ position: { x: 4, y: 24 } });
  await right.dblclick({ position: { x: 4, y: 24 } });
  await expect.poll(widths).toEqual([defaultNav, defaultContext]);
});

test("sidebar owns desktop toggles and creation while phones keep a full drawer", async ({
  page,
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
