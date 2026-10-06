import { expect, type Route, test } from "@playwright/test";
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

test.use({ serviceWorkers: "block" });
for (const width of [1280, 320]) {
  test.describe(`terminal settings · ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width < 600 });
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
      const open = async () => {
        const palette = await openCommandPalette(page);
        await palette.getByLabel("Filter commands").fill("Terminal settings");
        await palette
          .getByRole("option", { name: /Terminal settings/ })
          .click();
        return page.getByRole("dialog", {
          name: "Terminal settings",
          exact: true,
        });
      };
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
      await expect(
        reopened.getByRole("switch", { name: "Persist terminal output" }),
      ).not.toBeChecked();
      page.once("dialog", (dialog) => dialog.accept());
      await reopened.getByRole("button", { name: "Clear history" }).click();
      await expect.poll(() => clears).toBe(1);
    });
  });
}
