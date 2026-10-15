import { expect, test, type Page } from "@playwright/test";
import { pairAndOpen } from "./support/navigation";

// Chromium's media emulation does not implement display-mode. Exercise the
// production rules, replacing only that predicate and browser-owned geometry.
async function overlay(
  page: Page,
  enabled: boolean,
  left = 0,
  right = 138,
  height = 32,
  top = 0,
) {
  await page.evaluate(
    ({ enabled, left, right, height, top }) => {
      const state = window as typeof window & {
        overlayMedia: MediaQueryList;
        overlayActive: boolean;
        overlayRules?: Map<CSSMediaRule, string>;
        overlayGeometry?: Map<CSSStyleRule, string>;
      };
      state.overlayRules ??= new Map();
      state.overlayGeometry ??= new Map();
      const visit = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (
            rule instanceof CSSStyleRule &&
            rule.style.cssText.includes("env(titlebar-area-")
          ) {
            if (!state.overlayGeometry!.has(rule))
              state.overlayGeometry!.set(rule, rule.style.cssText);
          }
          if (rule instanceof CSSMediaRule) {
            if (
              rule.conditionText.includes(
                "display-mode: window-controls-overlay",
              )
            )
              state.overlayRules!.set(rule, rule.conditionText);
          }
          if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of document.styleSheets) visit(sheet.cssRules);
      for (const [rule, original] of state.overlayRules)
        rule.media.mediaText = enabled
          ? original.replace(
              "(display-mode: window-controls-overlay)",
              "(min-width: 0px)",
            )
          : original;
      // Substitute only browser env() inputs, including the centered mark's
      // x offset. Do not duplicate or override production positioning formulas.
      const values = {
        x: left,
        y: top,
        width: innerWidth - left - right,
        height,
      };
      for (const [rule, original] of state.overlayGeometry) {
        rule.style.cssText = enabled
          ? original.replace(
              /env\(titlebar-area-(x|y|width|height),\s*[^)]+\)/g,
              (_, key: keyof typeof values) => values[key] + "px",
            )
          : original;
      }
      state.overlayActive = enabled;
      state.overlayMedia.dispatchEvent(
        new MediaQueryListEvent("change", {
          matches: enabled,
          media: "(display-mode: window-controls-overlay)",
        }),
      );
    },
    { enabled, left, right, height, top },
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const native = window.matchMedia.bind(window);
    const state = window as typeof window & {
      overlayMedia: MediaQueryList;
      overlayActive: boolean;
    };
    state.overlayActive = false;
    state.overlayMedia = native("(display-mode: window-controls-overlay)");
    Object.defineProperty(state.overlayMedia, "matches", {
      get: () => state.overlayActive,
    });
    window.matchMedia = (query) =>
      query === "(display-mode: window-controls-overlay)"
        ? state.overlayMedia
        : native(query);
  });
  await pairAndOpen(page);
});

test("Overlay adds a quiet corner icon, retains the centered wordmark and restores sidebar branding on exit", async ({
  page,
}) => {
  const brand = page.locator(".window-titlebar__brand-button");
  await expect(brand).toBeHidden();
  for (const [left, right, height, top] of [
    [0, 138, 32, 0],
    [80, 0, 28, 0],
    [0, 138, 40, 0],
    [0, 138, 24, 0],
    [80, 0, 32, 6],
  ]) {
    await overlay(page, true, left, right, height, top);
    await expect(brand).toBeVisible();
    await expect(page.locator(".nav__brand-lockup")).toBeHidden();
    const corner = page.locator(".window-titlebar__corner-logo");
    const icon = (await corner.boundingBox())!;
    if (left === 0) {
      const navIcon = (await page
        .locator(".nav__new-session-icon")
        .boundingBox())!;
      expect(icon.x + icon.width / 2).toBeCloseTo(
        navIcon.x + navIcon.width / 2,
      );
    } else {
      // Native left-hand controls take precedence over the sidebar axis.
      expect(icon.x).toBeGreaterThanOrEqual(left + 12);
    }
    expect(icon.width).toBe(16);
    expect(icon.x + icon.width).toBeLessThan(1280 - right);
    await expect(corner).toHaveCSS("pointer-events", "none");
    await expect(corner.locator("svg")).toHaveAttribute("height", "16");
    const box = (await brand.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(left);
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(1);
    expect(box.x + box.width).toBeLessThan(1280 - right);
    expect(Math.abs(box.y + box.height / 2 - (top + height / 2))).toBeLessThan(
      1,
    );
    await brand.focus();
    const ring = await brand.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).outlineWidth),
    );
    expect(box.y - ring).toBeGreaterThanOrEqual(top);
    expect(box.y + box.height + ring).toBeLessThanOrEqual(top + height);
    const stage = (await page.getByRole("main").boundingBox())!;
    expect(stage.y).toBeGreaterThanOrEqual(top + height);
    const create = (await page
      .getByRole("button", { name: "New session", exact: true })
      .boundingBox())!;
    const collapse = (await page
      .getByRole("button", { name: "Collapse navigation" })
      .boundingBox())!;
    expect(create.y + create.height / 2).toBeCloseTo(
      collapse.y + collapse.height / 2,
    );
    expect(create.x + create.width).toBeLessThanOrEqual(collapse.x);
    const background = await page
      .locator(".window-titlebar")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect(page.locator(".nav")).toHaveCSS(
      "background-color",
      background,
    );
  }
  const before = await brand.getAttribute("aria-pressed");
  await brand.click();
  await expect(brand).toHaveAttribute(
    "aria-pressed",
    before === "true" ? "false" : "true",
  );
  await brand.click();
  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(page.locator(".nav__brand-icon--rail")).toBeHidden();
  await expect(page.locator(".nav__rail-toggle-icon")).toBeVisible();
  const centered = (await brand.boundingBox())!;
  expect(Math.abs(centered.x + centered.width / 2 - 640)).toBeLessThan(1);
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await page.setViewportSize({ width: 320, height: 700 });
  await overlay(page, true, 80, 120, 28);
  await expect(brand).toBeHidden();
  await expect(page.locator(".window-titlebar__corner-logo")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 840 });
  await overlay(page, true);
  await expect(brand).toBeVisible();
  await overlay(page, false);
  await expect(brand).toBeHidden();
  await expect(page.locator(".window-titlebar__corner-logo")).toBeHidden();
  await expect(page.locator(".nav__brand-lockup")).toBeVisible();
  const create = (await page
    .getByRole("button", { name: "New session", exact: true })
    .boundingBox())!;
  const header = (await page.locator(".nav__header").boundingBox())!;
  expect(create.y).toBeGreaterThanOrEqual(header.y + header.height);
});

test("Overlay native-color hints follow every palette and luminosity, and revert on exit", async ({
  page,
}) => {
  await overlay(page, true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  for (const theme of ["Light", "Dark"]) {
    await settings
      .getByRole("group", { name: "Theme", exact: true })
      .getByRole("button", { name: theme, exact: true })
      .click();
    for (const palette of [
      "Wisteria",
      "Hydrangea",
      "Lycoris",
      "Chimonanthus",
      "Jade",
      "Amber",
    ]) {
      await settings
        .getByRole("group", { name: "Color palette", exact: true })
        .getByRole("button", { name: palette, exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const root = document.documentElement;
            return (
              document
                .querySelector<HTMLMetaElement>('meta[name="theme-color"]')!
                .content.toLowerCase() ===
              getComputedStyle(root)
                .getPropertyValue("--bg-rail")
                .trim()
                .toLowerCase()
            );
          }),
        )
        .toBe(true);
    }
  }
  await overlay(page, false);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#14171A",
  );
});
