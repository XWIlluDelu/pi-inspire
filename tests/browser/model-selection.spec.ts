import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { modelSettingsScenario } from "./fixtures/model-settings";
import { pairAndOpen, openSettings } from "./support/navigation";

test("model labels and selection retain text contrast across palettes and themes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairAndOpen(page);
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await expect(page.getByRole("option", { selected: true })).toBeVisible();
  for (const palette of ["chimonanthus", "hydrangea", "wisteria", "lycoris"]) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        ({ palette, theme }) => {
          document.documentElement.dataset.palette = palette;
          document.documentElement.dataset.theme = theme;
        },
        { palette, theme },
      );
      const result = await new AxeBuilder({ page })
        .include(".model-picker__menu")
        .withRules(["color-contrast"])
        .analyze();
      expect(result.violations, `${palette}/${theme}`).toEqual([]);
    }
  }
});

test("long provider headings keep their virtual row in menus and Settings", async ({
  page,
}) => {
  const scenario = await modelSettingsScenario(page);
  const providers = [
    "research-calibration-openai-compatible-service",
    "本地科研仪器校准与测量数据兼容服务",
  ];
  for (const [index, provider] of providers.entries())
    scenario.snapshot().models.push({
      provider,
      id: "calibration-reader-" + index,
      name: "Calibration reader",
      reasoning: true,
    });
  await pairAndOpen(page);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep the current calibration draft");
  const trigger = page.getByRole("button", { name: "Model", exact: true });
  await trigger.click();
  const menu = page.locator(".model-picker__menu");
  await menu
    .getByRole("combobox", { name: "Search models" })
    .fill("calibration");
  const check = async (scope: typeof menu) => {
    for (const provider of providers) {
      const heading = scope
        .locator(".model-picker__heading")
        .filter({ hasText: provider });
      await expect(heading).toBeVisible();
      await expect(heading).toHaveAttribute("title", provider);
      const geometry = await heading.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const style = getComputedStyle(el);
        return {
          height: el.getBoundingClientRect().height,
          lines: new Set(
            [...range.getClientRects()]
              .filter((rect) => rect.width > 0)
              .map((rect) => rect.top),
          ).size,
          whiteSpace: style.whiteSpace,
          overflow: style.overflow,
          textOverflow: style.textOverflow,
          nextRow:
            el.nextElementSibling!.getBoundingClientRect().top -
            el.getBoundingClientRect().bottom,
          label: el.parentElement!.getAttribute("aria-label"),
        };
      });
      expect(geometry).toEqual({
        height: 28,
        lines: 1,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        nextRow: 0,
        label: provider,
      });
    }
  };
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() =>
        menu.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left >= 8 && rect.right <= innerWidth - 8;
        }),
      )
      .toBe(true);
    await check(menu);
  }
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(draft).toHaveValue("Keep the current calibration draft");
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Models", exact: true }).click();
  const available = settings.locator(".models-available");
  await available
    .getByRole("combobox", { name: "Search available models" })
    .fill("calibration");
  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await check(available);
  }
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(draft).toHaveValue("Keep the current calibration draft");
});
