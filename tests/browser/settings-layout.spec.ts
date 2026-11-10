import { expect, test } from "@playwright/test";
import type { HostUpdateStatus } from "../../shared/contracts";
import { modelSettingsScenario } from "./fixtures/model-settings";
import { clipboardLines } from "./support/clipboard";
import { focusRingClipping } from "./support/focus-bounds";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import {
  openCommandPalette,
  openSettings,
  pairAndOpen,
  pairedPage,
} from "./support/navigation";
import { textMarkOffsets } from "./support/text-baseline";

// These suites own mocked Host responses, not Service Worker fetch handling.
test.use({ serviceWorkers: "block" });

test("update checks keep button geometry stable throughout checking and results", async ({
  page,
}) => {
  let status: HostUpdateStatus = {
    revision: 10_000,
    piUpdateCheck: null,
    inspireUpdateCheck: null,
    piUpdateChecking: false,
    inspireUpdateChecking: false,
    availableUpdateIdentity: null,
    updateSnoozedUntil: null,
  };
  const transport = await routeSnapshots(page, {
    bootstrap: (body) => {
      body.updateStatus = status;
    },
  });
  let release: (() => void) | undefined;
  let responseReady: Promise<void>;
  await page.route(/\/api\/(?:pi-)?update\?refresh=1$/, async (route) => {
    await responseReady;
    await route.fulfill({ json: { updateStatus: status } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openSettings(page);
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "System", exact: true })
    .click();
  const versions = page.locator("#settings-section-updates");
  const button = versions.getByRole("button", {
    name: "Check for updates",
    exact: true,
  });
  const label = button.locator(".system-versions__check-label");
  const publish = (patch: Partial<typeof status>) => {
    status = { ...status, ...patch, revision: status.revision + 1 };
    transport.send({ type: "update_status", updateStatus: status });
  };
  try {
    for (const width of [1280, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        publish({ piUpdateCheck: null, inspireUpdateCheck: null });
        await expect(label).toHaveText("Check updates");
        await page.evaluate(() => document.fonts.ready);
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .evaluate((el) =>
            Promise.allSettled(
              el.getAnimations().map((animation) => animation.finished),
            ),
          );
        const before = (await button.boundingBox())!;
        const stable = async (text: string) => {
          await expect(label).toHaveText(text);
          await expect(label).toBeVisible();
          const after = (await button.boundingBox())!;
          for (const key of ["x", "y", "width", "height"] as const)
            expect(
              after[key],
              `${width} / ${theme} / ${text} / ${key}`,
            ).toBeCloseTo(before[key], 1);
          const alignment = await button.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const content = el.querySelector(
              ".system-versions__check-content",
            )!;
            const group = content.getBoundingClientRect();
            const icon = content.querySelector("svg")!.getBoundingClientRect();
            const text = content.querySelector("span")!.getBoundingClientRect();
            return {
              x: group.x + group.width / 2 - box.x - box.width / 2,
              y: icon.y + icon.height / 2 - box.y - box.height / 2,
              gap: text.left - icon.right,
              labelOffset: text.y + text.height / 2 - icon.y - icon.height / 2,
            };
          });
          expect(Math.abs(alignment.x)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(alignment.y)).toBeLessThanOrEqual(0.5);
          expect(alignment.gap).toBeCloseTo(8, 1);
          expect(alignment.labelOffset).toBeCloseTo(0, 1);
          expect(
            await versions
              .locator(".settings__section-title-wrap")
              .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          ).toBe(true);
        };
        await stable("Check updates");
        responseReady = new Promise<void>((resolve) => {
          release = resolve;
        });
        await button.click();
        await stable("Checking…");
        status = {
          ...status,
          revision: status.revision + 1,
          piUpdateChecking: true,
        };
        release!();
        await stable("Checking…");
        publish({
          piUpdateChecking: false,
          piUpdateCheck: {
            currentVersion: "1.0.0",
            pi: {
              kind: "available",
              latestVersion: "1.1.0",
              releaseUrl: "https://example.invalid/pi",
            },
            extensions: { kind: "none" },
          },
          inspireUpdateCheck: { kind: "current" },
        });
        await stable("Check again");
        await expect(button).toBeEnabled();
        await expect(
          versions.getByRole("button", {
            name: "Copy update details",
            exact: true,
          }),
        ).toBeVisible();
        publish({
          piUpdateCheck: {
            currentVersion: "1.0.0",
            pi: { kind: "unavailable" },
            extensions: { kind: "unavailable" },
          },
          inspireUpdateCheck: { kind: "unavailable" },
        });
        await stable("Check again");
      }
    }
  } finally {
    release?.();
  }
});

test("selected Settings categories remain visible across responsive layouts without trapping manual navigation scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await pairAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const navigation = settings.getByRole("navigation", {
    name: "Settings categories",
  });
  await navigation.getByRole("button", { name: "System", exact: true }).click();
  for (const [width, height] of [
    [390, 844],
    [320, 640],
    [844, 390],
    [1366, 768],
  ]) {
    await page.setViewportSize({ width, height });
    const safe =
      width === 844
        ? { left: 44, right: 44, bottom: 21 }
        : { left: 0, right: 0, bottom: 0 };
    await page.evaluate((safe) => {
      for (const [edge, value] of Object.entries(safe))
        document.documentElement.style.setProperty(
          `--safe-${edge}`,
          `${value}px`,
        );
    }, safe);
    await expect
      .poll(async () => {
        const bounds = (await settings.boundingBox())!;
        return Math.max(
          safe.left - bounds.x,
          bounds.x + bounds.width - (width - safe.right),
          bounds.y + bounds.height - (height - safe.bottom),
        );
      })
      .toBeLessThanOrEqual(0.5);
    const active = navigation.locator('[aria-current="location"]');
    await expect(active).toHaveText("System");
    await expect
      .poll(() =>
        active.evaluate((element) => {
          const item = element.getBoundingClientRect();
          const strip = element.closest("nav")!;
          const viewport = strip.getBoundingClientRect();
          const label = element
            .querySelector(".settings__nav-label")!
            .getBoundingClientRect();
          const fade = getComputedStyle(strip).maskImage === "none" ? 0 : 16;
          return Math.max(
            viewport.left - item.left,
            item.right - viewport.right,
            viewport.top - item.top,
            item.bottom - viewport.bottom,
            viewport.left + fade - label.left,
            label.right + fade - viewport.right,
            0,
          );
        }),
      )
      .toBeLessThanOrEqual(0.5);
  }
  // Browsing the category strip deliberately must not fight an active-item loop.
  await page.setViewportSize({ width: 320, height: 640 });
  await expect
    .poll(() => navigation.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  const content = settings.locator(".settings__content");
  await content.evaluate((el) => {
    el.scrollTop = 8;
  });
  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBe(8);
  await page.setViewportSize({ width: 390, height: 640 });
  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBe(8);
  await navigation.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect
    .poll(() => navigation.evaluate((el) => el.scrollLeft))
    .toBeLessThanOrEqual(0.5);
  await navigation
    .getByRole("button", { name: "Display", exact: true })
    .click();
  await expect(
    navigation.getByRole("button", { name: "Display", exact: true }),
  ).toHaveAttribute("aria-current", "location");

  await page.setViewportSize({ width: 320, height: 640 });
  for (const name of [
    "Conversation",
    "Behavior",
    "Models",
    "MCP",
    "Adapters",
    "System",
  ]) {
    await page.keyboard.press("Tab");
    await expect(
      navigation.getByRole("button", { name, exact: true }),
    ).toBeFocused();
  }
  const system = navigation.getByRole("button", {
    name: "System",
    exact: true,
  });
  await expect(navigation.locator('[aria-current="location"]')).toHaveText(
    "Display",
  );
  await expect
    .poll(() => system.evaluate(focusRingClipping))
    .toBeLessThanOrEqual(0.5);
  await expect
    .poll(() =>
      system.evaluate((button) => {
        const strip = button.closest("nav")!;
        return (
          strip.getBoundingClientRect().right -
          button.getBoundingClientRect().right
        );
      }),
    )
    .toBeGreaterThanOrEqual(15.5);
});

test("Settings headings sit outside their cards and nested fills follow the border", async ({
  page,
}) => {
  await modelSettingsScenario(page);
  await pairAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });

  await page.evaluate(() => document.fonts.ready);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await settings
      .getByRole("button", { name: "Display", exact: true })
      .click();
    const section = settings.locator(".settings__section:visible").first();
    const layout = await section.evaluate((el) => {
      const header = el.querySelector(".settings__section-header")!;
      const card = el.querySelector(".settings__card")!;
      return {
        gap:
          card.getBoundingClientRect().top -
          header.getBoundingClientRect().bottom,
        headerFill: getComputedStyle(header).backgroundColor,
        sectionBorder: getComputedStyle(el).borderWidth,
        cardBorder: Number.parseFloat(getComputedStyle(card).borderWidth),
        radius: Number.parseFloat(getComputedStyle(card).borderTopLeftRadius),
      };
    });
    expect(layout.gap).toBeGreaterThan(0);
    expect(layout.headerFill).toBe("rgba(0, 0, 0, 0)");
    expect(layout.sectionBorder).toBe("0px");
    expect(layout.cardBorder).toBeGreaterThan(0);
    expect(layout.radius).toBeGreaterThan(layout.cardBorder);
    // Card presentation must not add a clipping ancestor for menus or focus.
    await expect(section).toHaveCSS("overflow", "visible");
    await expect(section.locator(".settings__card")).toHaveCSS(
      "overflow",
      "visible",
    );
    if (width < 600) {
      const picker = section.getByRole("group", {
        name: "Color palette",
        exact: true,
      });
      const geometry = await picker.evaluate((el) => {
        const control = el.parentElement!.getBoundingClientRect();
        const grid = el.getBoundingClientRect();
        return {
          start: grid.left - control.left,
          end: control.right - grid.right,
        };
      });
      expect(Math.abs(geometry.start)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.end)).toBeLessThanOrEqual(1);
    }
    const needlesField = settings
      .locator(".settings__field")
      .filter({ hasText: "Titlebar needles" });
    const switchDelta = await needlesField.evaluate((el) => {
      const label = el
        .querySelector(".settings__field-label")!
        .getBoundingClientRect();
      const track = el
        .querySelector(".settings-switch__track")!
        .getBoundingClientRect();
      return track.top + track.height / 2 - (label.top + label.height / 2);
    });
    expect(Math.abs(switchDelta)).toBeLessThanOrEqual(1.5);

    await settings.getByRole("button", { name: "Models", exact: true }).click();
    const providers = settings.getByRole("region", {
      name: "Custom providers",
      exact: true,
    });
    // Custom providers wraps beside its action at 320px. Its icon belongs
    // to the first line, not the center of the whole multi-line heading.
    const offsets = await providers
      .locator(".settings__section-title-wrap")
      .evaluate(textMarkOffsets, {
        label: ".settings__section-title",
        marks: ".settings__section-icon",
      });
    expect(offsets).toHaveLength(1);
    expect(Math.abs(offsets[0]!)).toBeLessThanOrEqual(0.5);
    const declarations = providers.getByLabel("Custom provider declarations");
    if (
      !(await declarations.evaluate(
        (el) => (el.parentElement as HTMLDetailsElement).open,
      ))
    )
      await declarations.click();
    const provider = settings.locator(".models-provider-config").first();
    await expect(provider).toBeVisible();
    const corner = await provider.evaluate((el) => {
      const outer = getComputedStyle(el);
      const inner = getComputedStyle(
        el.querySelector(".models-provider__heading")!,
      );
      return [
        outer.borderTopLeftRadius,
        inner.borderTopLeftRadius,
        outer.borderTopWidth,
      ].map(Number.parseFloat);
    });
    expect(corner[1]).toBeCloseTo(corner[0]! - corner[2]!);

    await settings.getByRole("button", { name: "System", exact: true }).click();
    const status = settings.locator(".host-restart__status-row");
    await expect(status).toBeVisible();
    const statusCorner = await status.evaluate((el) => {
      const outer = getComputedStyle(el.closest(".settings__card")!);
      const inner = getComputedStyle(el);
      return [
        Number.parseFloat(outer.borderBottomLeftRadius),
        Number.parseFloat(outer.borderBottomWidth),
        Number.parseFloat(inner.borderBottomLeftRadius),
        Number.parseFloat(inner.borderTopWidth),
      ];
    });
    expect(statusCorner[2]).toBeCloseTo(statusCorner[0]! - statusCorner[1]!);
    expect(statusCorner[3]).toBe(0);
  }
});

test("Settings keeps independent palette tiles and a responsive choice column", async ({
  page,
}) => {
  await pairAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const navigation = settings.getByRole("navigation", {
    name: "Settings categories",
  });
  await page.evaluate(() => document.fonts.ready);

  for (const theme of ["Light", "Dark"]) {
    await navigation
      .getByRole("button", { name: "Display", exact: true })
      .click();
    const themeChoices = settings.getByRole("group", {
      name: "Theme",
      exact: true,
    });
    await themeChoices
      .getByRole("button", { name: theme, exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme.toLowerCase(),
    );
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const controls = settings.locator(
        '[data-category="display"] .settings__field-control > :is(.segmented, .palette-picker)',
      );
      const boxes = await controls.evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left, width: box.width };
        }),
      );
      expect(boxes).toHaveLength(5);
      for (const box of boxes) {
        expect(Math.abs(box.left - boxes[0]!.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.width - boxes[0]!.width)).toBeLessThanOrEqual(1);
      }
      const palette = settings.getByRole("group", {
        name: "Color palette",
        exact: true,
      });
      for (const choice of await palette.getByRole("button").all()) {
        const fits = await choice.evaluate((element) => {
          const label = element.lastElementChild!;
          const range = document.createRange();
          range.selectNodeContents(label);
          return (
            range.getBoundingClientRect().right <=
            element.getBoundingClientRect().right - 3
          );
        });
        expect(fits).toBe(true);
      }
      // Theme selection animates; compare the settled feedback, not an
      // intermediate frame where only the newly selected segment is fading in.
      await expect(async () => {
        const selection = await settings.evaluate((element) => {
          const style = (selector: string) => {
            const css = getComputedStyle(element.querySelector(selector)!);
            return {
              background: css.backgroundColor,
              border: css.borderColor,
              color: css.color,
              weight: css.fontWeight,
            };
          };
          const role = (name: string) => {
            const marker = document.createElement("span");
            marker.style.color = `var(--${name})`;
            element.append(marker);
            const color = getComputedStyle(marker).color;
            marker.remove();
            return color;
          };
          return {
            segment: style('[aria-label="Theme"] [aria-pressed="true"]'),
            palette: style('.palette-picker [aria-pressed="true"]'),
            unselected: style('.palette-picker [aria-pressed="false"]'),
            tray: style(".palette-picker"),
            accent: role("accent-deep"),
            tint: role("accent-tint"),
            surface: role("bg-surface"),
          };
        });
        expect(selection.tray.background).toBe("rgba(0, 0, 0, 0)");
        expect(selection.palette.color).toBe(selection.segment.color);
        expect(selection.palette.border).toBe(selection.accent);
        expect(selection.palette.background).toBe(selection.tint);
        expect(selection.unselected.background).toBe(selection.surface);
        expect(selection.palette.background).not.toBe(
          selection.unselected.background,
        );
        expect(selection.palette.weight).not.toBe(selection.unselected.weight);
      }).toPass({ timeout: 2000 });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    // Returning from the mobile sheet enables the desktop dialog entrance.
    await settings.evaluate((element) =>
      Promise.allSettled(
        element.getAnimations().map((animation) => animation.finished),
      ),
    );
    const choiceBox = (await themeChoices.boundingBox())!;
    await navigation
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const dropdownBox = (await settings
      .getByRole("combobox", { name: "Reasoning detail" })
      .boundingBox())!;
    const sendBox = (await settings
      .getByRole("group", { name: "Send key", exact: true })
      .boundingBox())!;
    for (const box of [dropdownBox, sendBox]) {
      expect(Math.abs(box.x - choiceBox.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - choiceBox.width)).toBeLessThanOrEqual(1);
    }
  }
});

test("Tab from a Settings dropdown skips collapsed content and reaches its disclosure", async ({
  page,
}) => {
  await modelSettingsScenario(page);
  await pairAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Models", exact: true }).click();
  const thinking = settings.getByRole("combobox", { name: "Default thinking" });
  await thinking.click();
  await expect(
    page.getByRole("listbox", { name: "Default thinking" }),
  ).toBeVisible();
  await thinking.press("Tab");
  await expect(
    settings.locator(".models-saved-entries > summary"),
  ).toBeFocused();
  await expect(
    page.getByRole("listbox", { name: "Default thinking" }),
  ).toHaveCount(0);
});

test("settings dropdown escapes a clipped scroller and keeps pointer hover separate from keyboard selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 460 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Behavior", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  const trigger = settings.getByRole("combobox", {
    name: "On launch",
    exact: true,
  });
  const content = settings.locator(".settings__content");
  // Leave viewport room beyond the scroller so the menu must escape its clip.
  await trigger.evaluate((el) => {
    const content = el.closest<HTMLElement>(".settings__content")!;
    const height =
      el.getBoundingClientRect().bottom - content.getBoundingClientRect().top;
    content.style.maxHeight = `${height + 12}px`;
  });
  expect(
    await content.evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await trigger.click();
  const menu = page.getByRole("listbox", {
    name: "On launch",
    exact: true,
  });
  const last = menu.getByRole("option").last();
  await expect(menu).toBeVisible();
  const clipBounds = (await content.boundingBox())!;
  const menuBounds = (await menu.boundingBox())!;
  expect(
    menuBounds.y < clipBounds.y ||
      menuBounds.y + menuBounds.height > clipBounds.y + clipBounds.height,
  ).toBe(true);
  expect(
    await menu.evaluate((el) => Boolean(el.closest(".settings__content"))),
  ).toBe(false);
  expect(
    await last.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        ),
      );
    }),
  ).toBe(true);
  await last.hover();
  await page.mouse.move(100, 100);
  await expect(menu.locator(".dropdown__option--active")).toHaveCount(0);
  await expect(last).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(trigger).toBeFocused();
  await last.hover();
  await trigger.press("Home");
  await expect(last).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(menu.getByRole("option").first()).toHaveClass(
    /dropdown__option--active/,
  );

  await trigger.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("settings dropdown follows its trigger until scrolling clips it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 460 });
  await pairedPage(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Behavior", exact: true }).click();
  const trigger = settings.getByRole("combobox", { name: "On launch" });
  const menu = page.getByRole("listbox", { name: "On launch" });
  const content = settings.locator(".settings__content");
  const scrollTop = () => content.evaluate((el) => el.scrollTop);
  const bounds = (await content.boundingBox())!;

  await trigger.click();
  await expect(menu).toBeVisible();
  await page.mouse.move(bounds.x + 72, bounds.y + 206);
  await page.mouse.wheel(0, 40);
  await expect.poll(scrollTop).toBe(40);
  await expect(menu).toBeVisible();

  await page.mouse.wheel(0, 85);
  await expect.poll(scrollTop).toBe(125);
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  expect(await scrollTop()).toBe(125);
});

test("category switches retain model browsing, provider drafts and a login arriving while hidden", async ({
  page,
}) => {
  const scenario = await modelSettingsScenario(page);
  const models = scenario.snapshot().models;
  models.push(
    ...Array.from({ length: 80 }, (_, index) => ({
      ...models[0]!,
      id: `catalog-${String(index).padStart(3, "0")}`,
      name: `Catalog model ${index}`,
    })),
  );
  let releaseLogin!: () => void;
  const loginResponse = new Promise<void>((resolve) => {
    releaseLogin = resolve;
  });
  await page.route("**/api/provider-auth**", async (route) => {
    if (route.request().postDataJSON().operation === "start")
      await loginResponse;
    await route.fallback();
  });
  await pairAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const nav = settings.getByRole("navigation", { name: "Settings categories" });
  // The list has loaded while its category is initially hidden.
  await expect(
    settings.locator('[data-category="models"] .models-results'),
  ).toHaveCount(1);
  await nav.getByRole("button", { name: "Models", exact: true }).click();
  const grid = settings.getByRole("grid", { name: "Available models" });
  await expect(grid.getByRole("row").first()).toBeVisible();
  expect(await grid.getByRole("row").count()).toBeLessThan(30);
  const search = settings.getByRole("combobox", {
    name: "Search available models",
  });
  await search.fill("catalog-079");
  await expect(grid.getByRole("row")).toHaveCount(1);
  await expect(grid.getByRole("row")).toContainText("Catalog model 79");

  await settings
    .getByRole("button", { name: "Add provider", exact: true })
    .click();
  await settings
    .getByLabel("Provider ID", { exact: true })
    .fill("draft-provider");
  await settings
    .getByLabel("Base URL", { exact: true })
    .fill("https://draft.invalid/v1");
  await nav.getByRole("button", { name: "Display", exact: true }).click();
  await nav.getByRole("button", { name: "Models", exact: true }).click();
  await expect(settings.getByLabel("Provider ID", { exact: true })).toHaveValue(
    "draft-provider",
  );
  await expect(settings.getByLabel("Base URL", { exact: true })).toHaveValue(
    "https://draft.invalid/v1",
  );
  await settings
    .getByRole("button", { name: "Back to models", exact: true })
    .click();
  const credentials = settings.getByRole("region", {
    name: "Login & API keys",
  });
  await credentials
    .getByRole("button", { name: "Manage Anthropic", exact: true })
    .click();
  await credentials
    .getByRole("button", { name: "Anthropic API key", exact: true })
    .click();
  const display = nav.getByRole("button", { name: "Display", exact: true });
  await display.click();
  releaseLogin();
  const hiddenSecret = settings
    .locator('[data-category="models"] .models-auth')
    .getByLabel("API key", { exact: true });
  await expect(hiddenSecret).toHaveCount(1);
  await expect(display).toBeFocused();
  await expect(
    settings.getByRole("textbox", { name: "API key", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      settings
        .locator(".settings__content")
        .evaluate((element) => element.scrollTop),
    )
    .toBe(0);
  expect(
    scenario.authOperations.some(
      (operation) => operation.operation === "cancel",
    ),
  ).toBe(false);

  await nav.getByRole("button", { name: "Models", exact: true }).click();
  await expect(search).toHaveValue("catalog-079");
  await expect(grid.getByRole("row")).toContainText("Catalog model 79");

  const secret = credentials.getByLabel("API key", { exact: true });
  await secret.fill("SYNTHETIC_CATEGORY_KEY");
  await nav.getByRole("button", { name: "Conversation", exact: true }).click();
  await nav.getByRole("button", { name: "Models", exact: true }).click();
  await expect(secret).toHaveValue("SYNTHETIC_CATEGORY_KEY");
  await credentials
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    credentials.getByText("Login complete.", { exact: true }),
  ).toBeVisible();
  expect(
    scenario.authOperations.filter(
      (operation) => operation.operation === "start",
    ),
  ).toHaveLength(1);
  expect(
    scenario.authOperations.some(
      (operation) => operation.operation === "cancel",
    ),
  ).toBe(false);

  await settings.getByRole("button", { name: "Close settings" }).click();
  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("/login");
  await palette.getByRole("option", { name: /^\/login/ }).click();
  await expect(
    nav.getByRole("button", { name: "Models", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await expect(
    settings.getByRole("heading", { name: "Login & API keys" }),
  ).toBeInViewport();
  expect(scenario.errors).toEqual([]);
});

for (const width of [540, 390, 320]) {
  const touch = width < 540;
  test.describe(`${touch ? "touch" : "desktop"} settings · ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      hasTouch: touch,
      serviceWorkers: "block",
    });
    test("keeps category controls readable and keyboard navigation inside the dialog", async ({
      page,
    }) => {
      await modelSettingsScenario(page);
      await pairAndOpen(page);
      await openSettings(page);
      const settings = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      const nav = settings.getByRole("navigation", {
        name: "Settings categories",
      });
      const content = settings.locator(".settings__content");
      await expect(settings.locator(".settings__page:visible")).toHaveCount(1);
      await expect(
        settings.getByRole("combobox", { name: "On launch" }),
      ).toHaveCount(0);
      await expect(
        settings.getByRole("group", { name: "Project location" }),
      ).toBeVisible();
      for (const [category, name] of [
        ["Display", "Project location"],
        ["Conversation", "Send key"],
      ]) {
        await nav.getByRole("button", { name: category, exact: true }).click();
        const control = settings.getByRole("group", { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        for (const button of await control.getByRole("button").all()) {
          expect(
            await button.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          ).toBe(true);
          const label = button.locator("span");
          const height = (await label.boundingBox())!.height;
          expect(height).toBeLessThan(24);
        }
      }
      await nav.getByRole("button", { name: "Behavior", exact: true }).click();
      const launch = settings.getByRole("combobox", { name: "On launch" });
      const launchInfo = launch.locator(
        "xpath=ancestor::*[contains(@class, 'settings__field-control')]/preceding-sibling::*",
      );
      const infoBox = (await launchInfo.boundingBox())!;
      const controlBox = (await launch.boundingBox())!;
      if (touch) {
        expect(controlBox.y).toBeGreaterThanOrEqual(infoBox.y + infoBox.height);
      } else {
        expect(controlBox.x).toBeGreaterThan(infoBox.x + infoBox.width);
      }
      const system = nav.getByRole("button", { name: "System", exact: true });
      await system.focus();
      await system.press("Enter");
      await expect(system).toBeInViewport();
      await expect(system).toBeFocused();
      await expect(settings.locator(".settings__page:visible")).toHaveCount(1);
      await expect
        .poll(() => content.evaluate((element) => element.scrollTop))
        .toBe(0);
      await expect(
        settings.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeInViewport();
      await expect(nav).toBeInViewport();
      const versions = settings.getByRole("region", {
        name: "Versions",
        exact: true,
      });
      await expect(versions).toBeInViewport();
      await nav.getByRole("button", { name: "Models", exact: true }).click();
      await content.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(
        nav.getByRole("button", { name: "Models", exact: true }),
      ).toHaveAttribute("aria-current", "location");
      await nav
        .getByRole("button", { name: "Conversation", exact: true })
        .click();
      await expect
        .poll(() => content.evaluate((element) => element.scrollTop))
        .toBe(0);
      await expect(
        settings.getByRole("region", { name: "Conversation", exact: true }),
      ).toBeInViewport();
      await expect(
        settings.getByRole("region", { name: "Versions", exact: true }),
      ).toHaveCount(0);
      // Native focus and modal Tab must both skip inactive category controls.
      await settings
        .locator('[data-category="models"] input')
        .first()
        .evaluate((element) => (element as HTMLElement).focus());
      await expect(
        nav.getByRole("button", { name: "Conversation", exact: true }),
      ).toBeFocused();
      await system.focus();
      await system.press("Tab");
      await expect(
        settings.getByRole("combobox", { name: "Reasoning detail" }),
      ).toBeFocused();
    });
  });
}

test("Settings activity menus remain clickable beyond their card and persist the choice", async ({
  page,
}) => {
  await pairedPage(page);
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await openSettings(page);
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByRole("button", { name: "Reset preferences" }).click();
    const confirmReset = page.getByRole("alertdialog", {
      name: "Reset preferences?",
    });
    await expect(confirmReset).toContainText(
      "Restore Display, Conversation, Behavior, and Herdr preferences to their defaults.",
    );
    await confirmReset
      .getByRole("button", { name: "Reset preferences", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    await dialog.getByRole("combobox", { name: "Activity groups" }).click();
    await page
      .getByRole("listbox", { name: "Activity groups", exact: true })
      .getByRole("option", { name: "Collapsed", exact: false })
      .click();
    await expect(
      dialog.getByRole("combobox", { name: "Activity groups" }),
    ).toHaveText("Collapsed");
    await expect
      .poll(async () => {
        const response = await hostRequest(page).get("/api/bootstrap");
        return (await response.json()).preferences.activityFoldVisibility;
      })
      .toBe("collapsed");
    await page.reload();
    await openSettings(page);
    await dialog
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    await expect(
      dialog.getByRole("combobox", { name: "Activity groups" }),
    ).toHaveText("Collapsed");
    const restored = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/preferences") &&
        response.request().method() === "PATCH",
    );
    await dialog.getByRole("button", { name: "Reset preferences" }).click();
    await confirmReset
      .getByRole("button", { name: "Reset preferences", exact: true })
      .click();
    await restored;
    const activity = dialog.getByRole("combobox", { name: "Activity groups" });
    await activity.click();
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("listbox")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(activity).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

test("canceling preference reset preserves settings and returns focus to its opener", async ({
  page,
}) => {
  await modelSettingsScenario(page);
  await pairAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const dark = settings
    .getByRole("group", { name: "Theme", exact: true })
    .getByRole("button", { name: "Dark", exact: true });
  await dark.click();

  const reset = settings.getByRole("button", {
    name: "Reset preferences",
    exact: true,
  });
  const confirmation = page.getByRole("alertdialog", {
    name: "Reset preferences?",
  });
  for (const exit of ["Escape", "Cancel"]) {
    await reset.click();
    await expect(confirmation).toBeVisible();
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press("Tab");
      expect(
        await confirmation.evaluate((el) =>
          el.contains(document.activeElement),
        ),
      ).toBe(true);
    }
    if (exit === "Escape") await page.keyboard.press("Escape");
    else
      await confirmation
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
    await expect(confirmation).toHaveCount(0);
    await expect(settings).toBeVisible();
    await expect(reset).toBeFocused();
    await expect(dark).toHaveAttribute("aria-pressed", "true");
  }
});

for (const touch of [false, true]) {
  test.describe(
    touch ? "touch setting actions" : "pointer setting actions",
    () => {
      test.use({
        hasTouch: touch,
        contextOptions: { reducedMotion: "reduce" },
        serviceWorkers: "block",
      });
      test("Host status paths wrap inside their text columns without resizing controls", async ({
        page,
      }) => {
        const socket =
          "/run/user/1000/herdr/instrument_calibration_reference_acquisition_control.sock";
        const ordinary = "Herdr is unavailable on this Host.";
        let issue = ordinary;
        let requests = 0;
        await page.route("**/api/host/herdr", (route) => {
          requests++;
          return route.fulfill({
            json: {
              enabled: false,
              ready: false,
              supported: true,
              installed: true,
              running: false,
              compatible: true,
              version: "1.0.0",
              issue,
            },
          });
        });
        const reason = "Restart controller cannot read " + socket;
        await page.route("**/api/host/restart", async (route) => {
          expect(route.request().method()).toBe("GET");
          const response = await route.fetch();
          await route.fulfill({
            response,
            json: { ...(await response.json()), available: false, reason },
          });
        });
        await pairedPage(page);
        await openSettings(page);
        const settings = page.getByRole("dialog", {
          name: "Settings",
          exact: true,
        });
        await settings
          .getByRole("navigation", { name: "Settings categories" })
          .getByRole("button", { name: "System", exact: true })
          .click();
        const field = settings.locator(".settings__field").filter({
          has: page.locator(".settings__field-label", {
            hasText: /^Herdr enhancement$/,
          }),
        });
        const status = field.locator(".settings__field-status-block");
        const recheck = field.getByRole("button", {
          name: "Recheck availability",
          exact: true,
        });
        const restart = settings.locator(".host-restart__status-row");
        await expect(status).toContainText(ordinary);
        await expect(restart).toHaveText(reason);
        await page.evaluate(() => document.fonts.ready);
        for (const width of [1280, 820, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          issue = ordinary;
          await recheck.click();
          await expect(status).toContainText(ordinary);
          const control = await recheck.boundingBox();
          const shortHeight = (await field.boundingBox())!.height;
          for (const message of [
            "Cannot connect to " + socket + ". Recheck the installation.",
            "无法连接校准工作区 " + socket + "，请重新检查安装。",
          ]) {
            issue = message;
            const before = requests;
            await recheck.click();
            await expect.poll(() => requests).toBeGreaterThan(before);
            await expect(status.locator("span").first()).toHaveText(message);
            for (const note of [status, restart]) {
              const fits = await note.evaluate((el) => {
                const text = el.querySelector("span") ?? el.querySelector("p")!;
                const range = document.createRange();
                range.selectNodeContents(text);
                const bounds = el.getBoundingClientRect();
                const textBounds = text.getBoundingClientRect();
                const rangeBounds = range.getBoundingClientRect();
                return (
                  el.scrollWidth <= el.clientWidth + 1 &&
                  textBounds.left >= bounds.left &&
                  textBounds.right <= bounds.right + 1 &&
                  rangeBounds.left >= textBounds.left - 1 &&
                  rangeBounds.right <= textBounds.right + 1
                );
              });
              expect(fits).toBe(true);
            }
            const button = await recheck.boundingBox();
            expect(button!.width).toBeCloseTo(control!.width, 1);
            expect(button!.height).toBeCloseTo(control!.height, 1);
            expect(
              await field.locator(".settings-switch").evaluate((el) => {
                const field = el
                  .closest(".settings__field")!
                  .getBoundingClientRect();
                return el.getBoundingClientRect().right <= field.right;
              }),
            ).toBe(true);
            await recheck.scrollIntoViewIfNeeded();
            await recheck.focus();
            await expect(recheck).toBeFocused();
          }
          issue = ordinary;
          await recheck.click();
          await expect(status.locator("span").first()).toHaveText(ordinary);
          expect((await field.boundingBox())!.height).toBeCloseTo(
            shortHeight,
            1,
          );
        }
      });

      test("fixed-height and inline text actions keep their icons centered, including loading", {
        tag: "@platform-ui",
      }, async ({ page }) => {
        let release: (() => void) | undefined;
        let checksPaused = false;
        await page.route("**/api/host/herdr", async (route) => {
          if (checksPaused)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          await route.fulfill({
            json: {
              enabled: false,
              ready: false,
              supported: false,
              installed: false,
              running: false,
              compatible: false,
              issue: "Herdr is unavailable on this platform.",
            },
          });
        });
        await pairedPage(page);
        await openSettings(page);
        const settings = page.getByRole("dialog", {
          name: "Settings",
          exact: true,
        });
        await settings
          .getByRole("navigation", { name: "Settings categories" })
          .getByRole("button", { name: "System", exact: true })
          .click();
        const recheck = settings.getByRole("button", {
          name: "Recheck availability",
          exact: true,
        });
        await expect(recheck).toBeVisible();
        await settings.evaluate(async (el) =>
          Promise.all(
            el.getAnimations().map((animation) => animation.finished),
          ),
        );
        const geometry = (el: Element) => {
          const row = el.getBoundingClientRect(),
            mark = el.querySelector("svg")!.getBoundingClientRect();
          return {
            width: row.width,
            height: row.height,
            offset: (mark.top + mark.bottom - row.top - row.bottom) / 2,
          };
        };
        try {
          for (const width of [1280, 820, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            for (const name of [
              "Check for updates",
              "Restart Host",
              "Restart all",
              "Recheck availability",
            ]) {
              const control = settings.getByRole("button", {
                name,
                exact: true,
              });
              const box = await control.evaluate(geometry);
              expect(Math.abs(box.offset), name).toBeLessThan(0.1);
            }
            await page.evaluate(() => document.fonts.ready);
            for (const name of [
              "Check for updates",
              "Restart Host",
              "Restart all",
            ]) {
              const alignment = await settings
                .getByRole("button", { name, exact: true })
                .evaluate((button) => {
                  const walker = document.createTreeWalker(
                    button,
                    NodeFilter.SHOW_TEXT,
                  );
                  let node: Node | null;
                  while ((node = walker.nextNode())) {
                    if (node.textContent?.trim()) break;
                  }
                  const range = document.createRange();
                  range.selectNode(node!);
                  const text = range.getBoundingClientRect();
                  const icon = button
                    .querySelector("svg")!
                    .getBoundingClientRect();
                  const style = getComputedStyle(button);
                  const canvas = document
                    .createElement("canvas")
                    .getContext("2d")!;
                  canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                  const metrics = canvas.measureText("x");
                  // Match the lowercase ink center, not just the text's line box.
                  const inkCenter =
                    text.top +
                    metrics.fontBoundingBoxAscent -
                    metrics.actualBoundingBoxAscent / 2;
                  return {
                    gap: text.left - icon.right,
                    inkOffset: inkCenter - (icon.top + icon.height / 2),
                  };
                });
              expect(alignment.gap, name).toBeCloseTo(8, 1);
              expect(Math.abs(alignment.inkOffset), name).toBeLessThan(0.5);
            }
            // Centered boxes alone miss different raster baselines in fractional-height rows.
            const restartTops = await settings
              .locator(".host-restart .button--danger-outline")
              .evaluateAll((buttons) =>
                buttons.map((button) => button.getBoundingClientRect().top),
              );
            expect(restartTops).toHaveLength(2);
            for (const [index, top] of restartTops.slice(1).entries()) {
              const separation = top - restartTops[index]!;
              expect(
                Math.abs(separation - Math.round(separation)),
              ).toBeLessThan(0.02);
            }
            const before = await recheck.evaluate(geometry);
            // Delay this explicit recheck, not a guessed ordinal startup read.
            checksPaused = true;
            await recheck.click();
            await expect(recheck.locator(".pi-loading")).toBeVisible();
            const loading = await recheck.evaluate(geometry);
            expect(loading.width).toBeCloseTo(before.width, 1);
            expect(loading.height).toBeCloseTo(before.height, 1);
            expect(Math.abs(loading.offset)).toBeLessThan(0.1);
            await expect.poll(() => !!release).toBe(true);
            checksPaused = false;
            release!();
            release = undefined;
            await expect(recheck).not.toHaveAttribute("aria-busy", "true");
          }
        } finally {
          checksPaused = false;
          release?.();
        }
      });
    },
  );
}

for (const hasTouch of [false, true]) {
  test.describe(`Versions row alignment · ${hasTouch ? "touch" : "mouse"}`, () => {
    test.use({
      hasTouch,
      deviceScaleFactor: hasTouch ? 2 : 1,
      serviceWorkers: "block",
    });
    test("centers each complete row while preserving first-line baselines and action targets", async ({
      page,
    }) => {
      await modelSettingsScenario(page);
      await page.route("**/api/bootstrap**", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        data.updateStatus = {
          revision: 999,
          piUpdateCheck: {
            currentVersion: "1.3.0",
            pi: { kind: "current" },
            extensions: { kind: "none" },
          },
          inspireUpdateCheck: { kind: "unavailable" },
          piUpdateChecking: false,
          inspireUpdateChecking: false,
          availableUpdateIdentity: null,
          updateSnoozedUntil: Date.now() + 3600000,
        };
        await route.fulfill({ response, json: data });
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await pairAndOpen(page);
      await openSettings(page);
      const settings = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      await settings
        .getByRole("navigation", { name: "Settings categories" })
        .getByRole("button", { name: "System", exact: true })
        .click();
      const versions = settings.locator("#settings-section-updates");
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (t) => (document.documentElement.dataset.theme = t),
          theme,
        );
        for (const width of [1280, 820, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await versions.scrollIntoViewIfNeeded();
          const geometry = await versions.evaluate((root) => {
            const baseline = (el: Element) => {
              const probe = document.createElement("span");
              probe.style.cssText =
                "display:inline-block;vertical-align:baseline;width:0;height:0;margin:0;border:0;padding:0";
              el.append(probe);
              const y = probe.getBoundingClientRect().top;
              probe.remove();
              return y;
            };
            return [...root.querySelectorAll(".system-versions__row")].map(
              (row) => {
                const r = row.getBoundingClientRect(),
                  label = row.querySelector("dt")!,
                  details = row.querySelector("dd")!;
                const a = label.getBoundingClientRect(),
                  b = details.getBoundingClientRect();
                return {
                  height: r.height,
                  columns:
                    getComputedStyle(row).gridTemplateColumns.split(" ").length,
                  contentCenter:
                    (Math.min(a.top, b.top) +
                      Math.max(a.bottom, b.bottom) -
                      r.top -
                      r.bottom) /
                    2,
                  baseline:
                    baseline(label.querySelector("span")!) -
                    baseline(
                      details.querySelector(".system-versions__value>span")!,
                    ),
                  overflow: row.scrollWidth - row.clientWidth,
                  links: [
                    ...row.querySelectorAll(".system-versions__references a"),
                  ].map((el) => el.getBoundingClientRect().height),
                };
              },
            );
          });
          for (const row of geometry) {
            expect(row.overflow).toBeLessThanOrEqual(1);
            expect(Math.abs(row.contentCenter)).toBeLessThanOrEqual(0.5);
            if (row.columns === 2)
              expect(Math.abs(row.baseline)).toBeLessThanOrEqual(0.5);
            expect(row.height).toBeGreaterThanOrEqual(50);
            for (const height of row.links)
              expect(height).toBeGreaterThanOrEqual(24);
          }
        }
      }
    });
  });
}

for (const hasTouch of [false, true]) {
  for (const install of ["available", "installed"] as const) {
    test.describe(`Settings footer · ${hasTouch ? "touch" : "pointer"} · ${install}`, () => {
      test.use({ hasTouch });
      test("keeps installation status and full utility labels inside the narrow footer", async ({
        page,
      }) => {
        if (install === "installed")
          await page.addInitScript(() => {
            const original = window.matchMedia.bind(window);
            window.matchMedia = (query) => {
              const media = original(query);
              if (query === "(display-mode: standalone)")
                Object.defineProperty(media, "matches", { value: true });
              return media;
            };
          });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await pairedPage(page);
        await openSettings(page);
        const settings = page.getByRole("dialog", {
          name: "Settings",
          exact: true,
        });
        const footer = settings.locator(".settings__footer");
        await expect(
          footer.getByRole("button", {
            name: "Reset preferences",
            exact: true,
          }),
        ).toBeVisible();
        if (install === "available")
          await page.evaluate(() => {
            const event = new Event("beforeinstallprompt", {
              cancelable: true,
            });
            Object.assign(event, {
              prompt: () => Promise.resolve(),
              userChoice: Promise.resolve({ outcome: "dismissed" }),
            });
            window.dispatchEvent(event);
          });
        else
          await expect(
            footer.getByText("App installed", { exact: true }),
          ).toBeVisible();
        for (const width of [1440, 820, 390, 360, 320]) {
          await page.setViewportSize({ width, height: 740 });
          await page.evaluate(() => document.fonts.ready);
          const buttons = footer.getByRole("button");
          await expect(buttons).toHaveCount(install === "available" ? 2 : 1);
          expect(
            await footer.evaluate((el) => el.scrollWidth - el.clientWidth),
          ).toBeLessThanOrEqual(0.5);
          for (const button of await buttons.all()) {
            await expect(button).toBeInViewport({ ratio: 1 });
            await page.keyboard.press("Tab");
            await button.focus();
            await expect(button).toBeFocused();
            await expect(button).toHaveCSS("outline-width", "2px");
            expect(
              await button.evaluate(focusRingClipping),
            ).toBeLessThanOrEqual(0.5);
            expect(
              await button.evaluate((el) => el.scrollWidth - el.clientWidth),
            ).toBeLessThanOrEqual(0.5);
          }
          if (install === "available")
            await expect(
              footer.getByRole("button", { name: "Install app", exact: true }),
            ).toHaveText("Install app");
          await expect(
            footer.getByRole("button", {
              name: "Reset preferences",
              exact: true,
            }),
          ).toHaveText("Reset preferences");
        }
      });
    });
  }
}

test("System copies update details and native commands while the notice is snoozed", {
  tag: "@platform-ui",
}, async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await modelSettingsScenario(page);
  await page.route("**/api/bootstrap**", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.updateStatus = {
      revision: 999,
      piUpdateCheck: {
        currentVersion: "1.0.0",
        pi: {
          kind: "available",
          latestVersion: "1.0.2",
          releaseUrl: "https://example.invalid/pi",
        },
        extensions: {
          kind: "available",
          updates: [
            { displayName: "github.com/example/pi-tools", type: "git" },
            { displayName: "@example/pi-tools", type: "npm" },
          ],
        },
      },
      inspireUpdateCheck: { kind: "unreleased" },
      piUpdateChecking: false,
      inspireUpdateChecking: false,
      availableUpdateIdentity: null,
      updateSnoozedUntil: Date.now() + 3600000,
    };
    await route.fulfill({ response, json: data });
  });
  await pairAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "System", exact: true })
    .click();
  const versions = settings.locator("#settings-section-updates");
  const copy = versions.getByRole("button", {
    name: "Copy update details",
    exact: true,
  });
  await expect(copy).toBeVisible();
  await expect(
    page.getByText("Updates available", { exact: true }),
  ).toHaveCount(0);
  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await copy.scrollIntoViewIfNeeded();
    const geometry = await versions.evaluate((el) => {
      const header = el.querySelector(".settings__section-title-wrap")!;
      const copy = el
        .querySelector(".system-versions__copy")!
        .getBoundingClientRect();
      const check = el
        .querySelector(".system-versions__check")!
        .getBoundingClientRect();
      const icon = el
        .querySelector(".system-versions__copy svg")!
        .getBoundingClientRect();
      return {
        fits: header.scrollWidth <= header.clientWidth + 1,
        separated: copy.right <= check.left,
        center: (copy.top + copy.bottom - check.top - check.bottom) / 2,
        x: (icon.left + icon.right - copy.left - copy.right) / 2,
        y: (icon.top + icon.bottom - copy.top - copy.bottom) / 2,
      };
    });
    expect(geometry.fits).toBe(true);
    expect(geometry.separated).toBe(true);
    for (const offset of [geometry.center, geometry.x, geometry.y])
      expect(Math.abs(offset)).toBeLessThanOrEqual(0.5);
  }
  await copy.focus();
  await copy.press("Enter");
  await expect(
    versions.getByRole("button", {
      name: "Update details copied",
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() => clipboardLines(page))
    .toEqual([
      "Pi 1.0.0 → 1.0.2",
      "Run pi update",
      "https://example.invalid/pi",
      "",
      "Extensions",
      "- @example/pi-tools",
      "- github.com/example/pi-tools",
      "Run pi update --extensions",
    ]);
  await versions
    .getByRole("button", { name: "Copy pi update", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("pi update");
});
