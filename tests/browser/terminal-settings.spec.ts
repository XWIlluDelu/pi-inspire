import { expect, type Page, type Route, test } from "@playwright/test";
import { DEFAULT_TERMINAL_UI_SETTINGS } from "../../src/terminal-settings";
import { modelSettingsScenario, pairAndOpen } from "./fixtures/model-settings";
import { openCommandPalette } from "./support/navigation";

function receiptHeaders(route: Route) {
  const identity = route.request().headers()["x-terminal-operation"];
  return identity
    ? {
        "X-Terminal-Operation": JSON.parse(identity).id as string,
        "X-Terminal-Outcome": "completed",
      }
    : {};
}

async function openTerminalSettings(page: Page) {
  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("Terminal settings");
  await palette.getByRole("option", { name: /Terminal settings/ }).click();
  return page.getByRole("dialog", { name: "Terminal settings", exact: true });
}

test.use({ serviceWorkers: "block" });
for (const width of [1280, 320]) {
  test.describe(`terminal settings · ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width < 600 });
    test("isolates categories, resets their scroll and excludes hidden controls from Tab", async ({
      page,
    }) => {
      const scenario = await modelSettingsScenario(page);
      await page.route("**/api/terminal-settings", (route) =>
        route.fulfill({
          json: { persistOutput: true, historyRetentionDays: 30 },
        }),
      );
      await pairAndOpen(page);
      const settings = await openTerminalSettings(page);
      if (width < 600) {
        const frame = (await settings.boundingBox())!;
        const available = await settings.locator("..").evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            width:
              el.clientWidth -
              Number.parseFloat(style.paddingLeft) -
              Number.parseFloat(style.paddingRight),
            height:
              el.clientHeight -
              Number.parseFloat(style.paddingTop) -
              Number.parseFloat(style.paddingBottom),
          };
        });
        expect(frame.width).toBeCloseTo(available.width, 0);
        expect(frame.height).toBeCloseTo(available.height, 0);
      }
      await page.setViewportSize({ width, height: 460 });
      const nav = settings.getByRole("navigation", {
        name: "Terminal settings categories",
      });
      const body = settings.getByRole("main");
      const interaction = nav.getByRole("button", {
        name: "Interaction",
        exact: true,
      });
      const output = nav.getByRole("button", {
        name: "Saved output",
        exact: true,
      });
      await interaction.click();
      await expect(
        settings.getByRole("region", { name: "Appearance" }),
      ).toHaveCount(0);
      await expect(
        settings.getByRole("group", { name: "Terminal font size" }),
      ).toHaveCount(0);
      await expect(
        settings.getByRole("switch", { name: "Persist terminal output" }),
      ).toHaveCount(0);
      await body.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expect(interaction).toHaveAttribute("aria-current", "location");
      await interaction.click();
      expect(await body.evaluate((el) => el.scrollTop)).toBe(0);

      // Tab stays inside the modal and visits only the active category's fields.
      await settings
        .getByRole("button", { name: "Close terminal settings" })
        .focus();
      for (let index = 0; index < 16; index++) {
        await page.keyboard.press("Tab");
        expect(
          await settings.evaluate((el) => el.contains(document.activeElement)),
        ).toBe(true);
        expect(
          await page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            return (
              el.getBoundingClientRect().width > 0 && !el.closest("[hidden]")
            );
          }),
        ).toBe(true);
      }
      const bell = settings.getByRole("combobox", {
        name: "Terminal bell behavior",
      });
      await bell.click();
      await expect(
        page.getByRole("listbox", { name: "Terminal bell behavior" }),
      ).toBeVisible();
      await bell.press("Escape");
      await expect(settings).toBeVisible();
      await expect(bell).toBeFocused();
      await bell.click();
      await output.focus();
      await output.press("Enter");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
      await expect(
        settings.getByRole("region", { name: "Saved output" }),
      ).toBeVisible();
      await interaction.focus();
      await page.keyboard.press("Enter");
      await expect(interaction).toBeFocused();
      expect(
        await interaction.evaluate((el) => getComputedStyle(el).outlineWidth),
      ).toBe("2px");
      await expect(interaction).toHaveAttribute("aria-current", "location");
      expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
      expect(
        await body.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
      ).toBe(false);
      if (width < 600) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(async () => (await settings.boundingBox())!.height)
          .toBeCloseTo(884, 0);
        for (const field of await settings.locator(".settings__field").all()) {
          const label = (await field
            .locator(".settings__field-info")
            .boundingBox())!;
          const control = (await field
            .locator(".settings__field-control")
            .boundingBox())!;
          expect(
            label.x + label.width <= control.x + 1 ||
              label.y + label.height <= control.y + 1,
          ).toBe(true);
        }
        const content = (await body.boundingBox())!;
        const footer = (await settings
          .locator(".terminal-settings__footer")
          .boundingBox())!;
        const lastField = (await settings
          .getByRole("switch", { name: "Terminal screen reader mode" })
          .boundingBox())!;
        expect(lastField.y + lastField.height).toBeLessThanOrEqual(
          content.y + content.height,
        );
        expect(footer.y + footer.height).toBeLessThanOrEqual(900 - 8);
        await expect(
          settings.getByRole("button", { name: "Restore browser defaults" }),
        ).toBeInViewport();
      }
      expect(scenario.errors).toEqual([]);
    });

    test("persists browser controls, keeps Host output choices separate and confirms destructive changes", async ({
      page,
    }) => {
      let service = { persistOutput: true, historyRetentionDays: 30 };
      const patches: unknown[] = [];
      let clears = 0;
      await modelSettingsScenario(page, width === 1280 ? "dark" : "light");
      await page.route("**/api/terminal-operations", (route) =>
        route.fulfill({ json: { epoch: "settings-fixture" } }),
      );
      await page.route("**/api/terminal-settings", async (route) => {
        if (route.request().method() === "PATCH") {
          const patch = route.request().postDataJSON();
          patches.push(patch);
          service = { ...service, ...patch };
        }
        await route.fulfill({ json: service, headers: receiptHeaders(route) });
      });
      await page.route("**/api/terminal-history", async (route) => {
        clears++;
        await route.fulfill({
          json: { ok: true },
          headers: receiptHeaders(route),
        });
      });
      await pairAndOpen(page);
      const open = () => openTerminalSettings(page);
      const settings = await open();
      const stepper = settings.getByRole("group", {
        name: "Terminal font size",
      });
      const stepperValue = stepper.locator(".terminal-settings__stepper-value");
      const fontField = settings.locator(".terminal-settings__font");
      const label = (await fontField
        .locator(".settings__field-label")
        .boundingBox())!;
      const control = (await fontField
        .locator(".settings__field-control")
        .boundingBox())!;
      expect(
        label.x + label.width <= control.x + 1 ||
          label.y + label.height <= control.y + 1,
      ).toBe(true);
      expect((await stepper.boundingBox())!.width).toBeGreaterThan(80);
      const title = (await settings
        .getByRole("heading", { name: "Terminal settings" })
        .boundingBox())!;
      const close = (await settings
        .getByRole("button", { name: "Close terminal settings" })
        .boundingBox())!;
      expect(
        Math.abs(title.y + title.height / 2 - close.y - close.height / 2),
      ).toBeLessThan(1);
      await expect(stepperValue).toHaveText(
        `${DEFAULT_TERMINAL_UI_SETTINGS.fontSize}px`,
      );
      await settings
        .getByRole("button", { name: "Increase terminal font size" })
        .click();
      await expect(stepperValue).toHaveText(
        `${DEFAULT_TERMINAL_UI_SETTINGS.fontSize + 1}px`,
      );
      if (width < 600)
        expect(
          (await settings
            .getByRole("button", { name: "Increase terminal font size" })
            .boundingBox())!.height,
        ).toBeGreaterThanOrEqual(36);
      await settings
        .getByRole("group", { name: "Terminal cursor shape" })
        .getByRole("button", { name: "Underline" })
        .click();
      await settings
        .getByRole("group", { name: "Terminal line height" })
        .getByRole("button", { name: "Compact" })
        .click();
      const scrollback = settings.getByRole("combobox", {
        name: "Terminal scrollback lines",
      });
      await scrollback.click();
      await page
        .locator(`[id="${await scrollback.getAttribute("aria-controls")}"]`)
        .getByRole("option", { name: "50,000 lines", exact: true })
        .click();
      if (width < 600)
        expect((await scrollback.boundingBox())!.height).toBeGreaterThanOrEqual(
          40,
        );
      await settings
        .getByRole("navigation")
        .getByRole("button", { name: "Interaction", exact: true })
        .click();
      await settings
        .getByRole("switch", { name: "Protect terminal paste" })
        .locator("..")
        .click();
      await settings
        .getByRole("group", { name: "Terminal shortcut priority" })
        .getByRole("button", { name: "Shell", exact: true })
        .click();
      const stored = () =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem("inspire:terminal-ui-settings:v1")!),
        );
      await expect.poll(stored).toMatchObject({
        fontSize: DEFAULT_TERMINAL_UI_SETTINGS.fontSize + 1,
        cursorStyle: "underline",
        lineHeight: 1,
        scrollbackRows: 50000,
        pasteProtection: false,
        shortcutMode: "shell",
      });
      expect(patches).toEqual([]);
      await settings
        .getByRole("navigation")
        .getByRole("button", { name: "Saved output", exact: true })
        .click();
      const retention = settings.getByRole("combobox", {
        name: "Terminal output retention",
      });
      await retention.click();
      await page
        .locator(`[id="${await retention.getAttribute("aria-controls")}"]`)
        .getByRole("option", { name: "90 days", exact: true })
        .click();
      await expect.poll(() => patches).toEqual([{ historyRetentionDays: 90 }]);
      await expect(retention).toBeEnabled();
      page.once("dialog", (dialog) => dialog.dismiss());
      await settings
        .getByRole("switch", { name: "Persist terminal output" })
        .locator("..")
        .click();
      await expect(
        settings.getByRole("switch", { name: "Persist terminal output" }),
      ).toBeChecked();
      expect(patches).toHaveLength(1);
      await settings
        .locator(".terminal-settings__body")
        .evaluate((el) => (el.scrollTop = el.scrollHeight));
      await page.screenshot({
        path: `output/playwright/terminal-settings-output-${width}.png`,
        animations: "disabled",
      });
      page.once("dialog", (dialog) => dialog.accept());
      await settings
        .getByRole("switch", { name: "Persist terminal output" })
        .locator("..")
        .click();
      await expect(
        settings.getByRole("switch", { name: "Persist terminal output" }),
      ).not.toBeChecked();
      await expect(retention).toBeDisabled();
      expect(patches).toEqual([
        { historyRetentionDays: 90 },
        { persistOutput: false },
      ]);
      await settings
        .getByRole("button", { name: "Restore browser defaults" })
        .click();
      await expect.poll(stored).toEqual(DEFAULT_TERMINAL_UI_SETTINGS);
      expect(service).toEqual({
        persistOutput: false,
        historyRetentionDays: 90,
      });
      await settings
        .getByRole("button", { name: "Close terminal settings" })
        .click();
      if (width < 600) {
        await expect(
          page.getByRole("dialog", { name: "Context panel" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Close context pane" }).click();
      }
      const reopened = await open();
      await expect(
        reopened
          .getByRole("group", { name: "Terminal cursor shape" })
          .getByRole("button", { name: "Block" }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        await reopened
          .locator(".terminal-settings__body")
          .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
      ).toBe(false);
      await page.screenshot({
        path: `output/playwright/terminal-settings-${width}.png`,
        animations: "disabled",
      });
      await reopened
        .getByRole("navigation")
        .getByRole("button", { name: "Saved output", exact: true })
        .click();
      await expect(
        reopened.getByRole("switch", { name: "Persist terminal output" }),
      ).not.toBeChecked();
      page.once("dialog", (dialog) => dialog.accept());
      await reopened.getByRole("button", { name: "Clear history" }).click();
      await expect.poll(() => clears).toBe(1);
    });
  });
}
