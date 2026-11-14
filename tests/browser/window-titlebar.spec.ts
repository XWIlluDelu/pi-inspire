import { expect, type Page, test } from "@playwright/test";
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

test("Overlay adds a quiet corner icon, retains the centered wordmark and restores sidebar branding on exit", {
  tag: "@platform-ui",
}, async ({ page }) => {
  const brand = page.locator(".window-titlebar__brand-button");
  await expect(brand).toBeHidden();
  for (const [left, right, height, top] of [[0, 138, 24, 0], [80, 0, 32, 6]]) {
    await overlay(page, true, left, right, height, top);
    await expect(brand).toBeVisible();
    const safe = page.locator(".window-titlebar__safe");
    expect(await safe.boundingBox()).toEqual({
      x: left,
      y: top,
      width: 1280 - left - right,
      height,
    });
    const x = left ? 4 : 1276;
    expect(await page.evaluate(({ x, y }) =>
      Boolean(document.elementFromPoint(x, y)?.closest(".window-titlebar")),
      { x, y: top + height / 2 },
    )).toBe(false);
    expect((await page.getByRole("main").boundingBox())!.y)
      .toBeGreaterThanOrEqual(top + height);
  }
  await expect(page.locator(".nav__brand-lockup")).toBeHidden();
  await overlay(page, true);
  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(page.locator(".nav__brand-icon--rail")).toBeHidden();
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

});

test("needles reach both titlebar edges and foreground marks without taking their hit targets", {
  tag: "@platform-ui",
}, async ({ page }) => {
  await overlay(page, true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const brand = page.locator(".window-titlebar__brand-button");
  if ((await brand.getAttribute("aria-pressed")) === "true")
    await brand.click();
  const width = (await page.locator(".window-titlebar").boundingBox())!.width;
  const mark = (await brand.boundingBox())!;
  await page.evaluate(() => {
    (window as typeof window & { needleRandom?: () => number }).needleRandom =
      Math.random;
  });
  try {
    for (const x of [4, width - 4, mark.x + mark.width / 2]) {
      // Fix only the random sample, not production layout or arrival geometry.
      await page.evaluate(
        (sample) => {
          Math.random = () => sample;
        },
        (x - 2) / (width - 4),
      );
      await brand.click();
      const needles = page.locator(".window-titlebar__needle");
      await expect(needles.first()).toBeAttached();
      const needle = (await needles.first().boundingBox())!;
      expect(Math.abs(needle.x + needle.width / 2 - x)).toBeLessThan(1);
      await brand.click();
      await expect(needles).toHaveCount(0);
    }
    await brand.click();
    await expect(
      page.locator(".window-titlebar__needle").first(),
    ).toBeAttached();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator(".window-titlebar__needle")).toHaveCount(0);
    await expect(brand).toHaveAttribute("aria-pressed", "true");
    await brand.click();
  } finally {
    await page.evaluate(() => {
      const state = window as typeof window & { needleRandom?: () => number };
      if (state.needleRandom) Math.random = state.needleRandom;
      delete state.needleRandom;
    });
  }
});
