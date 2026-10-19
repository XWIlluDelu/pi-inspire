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
  for (const [left, right, height, top] of [
    [0, 138, 32, 0],
    [80, 0, 28, 0],
    [0, 138, 40, 0],
    [0, 138, 24, 0],
    [80, 0, 32, 6],
  ]) {
    await overlay(page, true, left, right, height, top);
    await expect(brand).toBeVisible();
    if ((await brand.getAttribute("aria-pressed")) !== "true")
      await brand.click();
    const decoration = page.locator(".window-titlebar__needles");
    await expect(decoration).toHaveCSS("pointer-events", "none");
    expect(await decoration.boundingBox()).toEqual({
      x: 0,
      y: top,
      width: 1280,
      height,
    });
    const safe = await page.locator(".window-titlebar__safe").boundingBox();
    expect(safe).toEqual({
      x: left,
      y: top,
      width: 1280 - left - right,
      height,
    });
    for (const x of [left > 0 ? 4 : null, right > 0 ? 1276 : null]) {
      if (x === null) continue;
      expect(
        await page.evaluate(
          ({ x, y }) =>
            !!document.elementFromPoint(x, y)?.closest(".window-titlebar"),
          { x, y: top + height / 2 },
        ),
      ).toBe(false);
    }
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
  await overlay(page, true);
  const collapse = page.getByRole("button", { name: "Collapse navigation" });
  await page.mouse.move(1270, 830);
  const restingColor = await collapse.evaluate(
    (el) => getComputedStyle(el).color,
  );
  await collapse.click();
  await page.mouse.move(1270, 830);
  await expect(page.locator(".nav__brand-icon--rail")).toBeHidden();
  const railIcon = page.locator(".nav__rail-toggle-icon");
  await expect(railIcon).toBeVisible();
  await expect(railIcon).toHaveCSS("color", restingColor);
  // Sample the same layout frame after the rail finishes its width transition.
  await expect
    .poll(() =>
      railIcon.evaluate((el) => {
        const rail = el.getBoundingClientRect();
        const topbar = document
          .querySelector(".topbar")!
          .getBoundingClientRect();
        const offsets = [
          ".window-titlebar__corner-logo",
          ".nav__new-session-icon",
        ].map((selector) => {
          const box = document.querySelector(selector)!.getBoundingClientRect();
          return Math.abs(box.x + box.width / 2 - rail.x - rail.width / 2);
        });
        offsets.push(
          Math.abs(topbar.y + topbar.height / 2 - rail.y - rail.height / 2),
        );
        return Math.max(...offsets);
      }),
    )
    .toBeLessThanOrEqual(0.5);
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

test("needles reach both titlebar edges and foreground marks without taking their hit targets", {
  tag: "@platform-ui",
}, async ({ page }) => {
  await overlay(page, true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const brand = page.locator(".window-titlebar__brand-button");
  if ((await brand.getAttribute("aria-pressed")) === "true")
    await brand.click();
  const geometry = await page.locator(".window-titlebar").evaluate((safe) => {
    const bounds = safe.getBoundingClientRect();
    const icon = safe
      .querySelector(".window-titlebar__corner-logo")!
      .getBoundingClientRect();
    const mark = safe
      .querySelector(".window-titlebar__brand-button")!
      .getBoundingClientRect();
    return {
      width: bounds.width,
      targets: [
        4,
        bounds.width - 4,
        icon.left - bounds.left - 6,
        icon.right - bounds.left + 6,
        mark.left - bounds.left - 6,
        mark.right - bounds.left + 6,
      ],
    };
  });
  await page.evaluate(() => {
    (window as typeof window & { needleRandom?: () => number }).needleRandom =
      Math.random;
  });
  try {
    for (const x of geometry.targets) {
      // Fix only the random sample, not production layout or arrival geometry.
      await page.evaluate(
        (sample) => {
          Math.random = () => sample;
        },
        (x - 2) / (geometry.width - 4),
      );
      await brand.click();
      const needles = page.locator(".window-titlebar__needle");
      await expect(needles.first()).toBeAttached();
      const center = await needles
        .first()
        .evaluate((el) => parseFloat(el.style.left));
      expect((center * geometry.width) / 100).toBeCloseTo(x, 1);
      await expect(needles.first()).toHaveCSS("pointer-events", "none");
      await brand.click();
      await expect(needles).toHaveCount(0);
    }
    for (const foreground of [
      page.locator(".window-titlebar__corner-logo > svg"),
      brand,
    ]) {
      await expect(foreground).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
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

test("Overlay chrome and needle colors follow every palette and luminosity, and revert on exit", {
  tag: "@platform-ui",
}, async ({ page }) => {
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
      // Sample the production needle styles without waiting for random arrivals.
      const colors = await page
        .locator(".window-titlebar__safe")
        .evaluate((safe) =>
          ["tool", "think"].map((role) => {
            const needle = document.createElement("span");
            needle.className = `window-titlebar__needle window-titlebar__needle--${role}`;
            const identity = document.createElement("span");
            identity.style.color = `var(--activity-${role})`;
            safe.append(needle, identity);
            const actual = getComputedStyle(needle).backgroundColor;
            const expected = getComputedStyle(identity).color;
            needle.remove();
            identity.remove();
            return { role, actual, expected };
          }),
        );
      for (const { role, actual, expected } of colors)
        expect(actual, `${palette} ${theme} ${role} needle`).toBe(expected);
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

test("settings menus keep their anchor and clear window chrome when the Overlay height changes", {
  tag: "@platform-ui",
}, async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Behavior", exact: true }).click();
  const trigger = settings.getByRole("combobox", {
    name: "On launch",
    exact: true,
  });
  await trigger.click();
  const menu = page.getByRole("listbox", { name: "On launch", exact: true });
  for (const [width, windowHeight, height] of [
    [1280, 840, 32],
    [820, 700, 32],
    [390, 844, 32],
    [1280, 700, 40],
    [1280, 840, 28],
    [1280, 840, 0],
  ]) {
    await page.setViewportSize({ width, height: windowHeight });
    await overlay(page, height > 0, 0, 138, height || 32);
    await expect(menu).toHaveAttribute("data-placement", "down");
    await expect
      .poll(() =>
        settings.evaluate((el) => {
          const root = el.closest(".overlay")!;
          const box = root.getBoundingClientRect();
          const style = getComputedStyle(root);
          return (
            el.getBoundingClientRect().bottom -
            (box.bottom - parseFloat(style.paddingBottom))
          );
        }),
      )
      .toBeLessThanOrEqual(0.5);
    await expect
      .poll(async () => {
        const anchor = (await trigger.boundingBox())!;
        const box = (await menu.boundingBox())!;
        return Math.abs(box.y - anchor.y - anchor.height - 4);
      })
      .toBeLessThanOrEqual(0.5);
  }
  await menu.getByRole("option", { selected: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(settings).toBeVisible();

  await overlay(page, true);
  const lower = settings.getByRole("combobox", {
    name: "Follow-up delivery",
    exact: true,
  });
  await lower.scrollIntoViewIfNeeded();
  await lower.click();
  const upward = page.getByRole("listbox", {
    name: "Follow-up delivery",
    exact: true,
  });
  await expect(upward).toHaveAttribute("data-placement", "up");
  await expect
    .poll(async () => {
      const anchor = (await lower.boundingBox())!;
      const box = (await upward.boundingBox())!;
      return Math.abs(anchor.y - box.y - box.height - 4);
    })
    .toBeLessThanOrEqual(0.5);
  expect((await upward.boundingBox())!.y).toBeGreaterThanOrEqual(40);
  await page.keyboard.press("Escape");
  await expect(upward).toHaveCount(0);
  await expect(lower).toBeFocused();
  await expect(settings).toBeVisible();
});
