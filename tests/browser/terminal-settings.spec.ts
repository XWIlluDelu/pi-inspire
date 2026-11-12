import { expect, type Page, type Route, test } from "@playwright/test";
import { DEFAULT_TERMINAL_UI_SETTINGS } from "../../src/terminal-settings";
import { openCommandPalette, pairAndOpen } from "./support/navigation";

function receiptHeaders(route: Route): Record<string, string> {
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
test.describe("narrow terminal settings", () => {
  test.use({ viewport: { width: 320, height: 900 }, hasTouch: true });
  test("keeps browser and Host choices separate in the keyboard-accessible settings dialog", async ({
    page,
  }) => {
    let service = { persistOutput: true, historyRetentionDays: 30 };
    const patches: unknown[] = [];
    let clears = 0;
    const loading = Promise.withResolvers<void>();
    const savingRetention = Promise.withResolvers<void>();
    await page.route("**/api/terminal-operations", (route) =>
      route.fulfill({ json: { epoch: "settings-fixture" } }),
    );
    await page.route("**/api/terminal-settings", async (route) => {
      if (route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON();
        patches.push(patch);
        if (patch.historyRetentionDays !== undefined)
          await savingRetention.promise;
        service = { ...service, ...patch };
      } else await loading.promise;
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
    const settings = await openTerminalSettings(page);
    const category = (name: string) =>
      settings
        .getByRole("navigation")
        .getByRole("button", { name, exact: true });
    const close = settings.getByRole("button", {
      name: "Close terminal settings",
    });
    const reset = settings.getByRole("button", {
      name: "Restore browser defaults",
    });
    const body = settings.getByRole("main");
    const stepper = settings.getByRole("group", {
      name: "Terminal font size",
    });
    try {
      await category("Saved output").click();
      await expect(settings.getByRole("status")).toContainText(
        "Loading Host settings",
      );
      await category("Appearance").click();
    } finally {
      loading.resolve();
    }
    const stepperValue = stepper.locator(".terminal-settings__stepper-value");
    await expect(stepperValue).toHaveText(
      `${DEFAULT_TERMINAL_UI_SETTINGS.fontSize}px`,
    );
    await settings
      .getByRole("button", { name: "Increase terminal font size" })
      .click();
    await expect(stepperValue).toHaveText(
      `${DEFAULT_TERMINAL_UI_SETTINGS.fontSize + 1}px`,
    );
    await page.setViewportSize({ width: 320, height: 460 });
    await category("Interaction").click();
    await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
    expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(close).toBeInViewport({ ratio: 1 });
    await expect(reset).toBeInViewport({ ratio: 1 });
    await category("Interaction").click();
    expect(await body.evaluate((el) => el.scrollTop)).toBe(0);

    await close.press("Shift+Tab");
    await expect(reset).toBeFocused();
    await reset.press("Tab");
    await expect(close).toBeFocused();
    const bell = settings.getByRole("combobox", {
      name: "Terminal bell behavior",
    });
    const options = page.getByRole("listbox", {
      name: "Terminal bell behavior",
    });
    await bell.click();
    await expect(options).toBeVisible();
    await bell.press("Escape");
    await expect(options).toHaveCount(0);
    await expect(bell).toBeFocused();
    await page.setViewportSize({ width: 320, height: 900 });

    await settings
      .getByRole("switch", { name: "Protect terminal paste" })
      .locator("..")
      .click();
    const stored = () =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("inspire:terminal-ui-settings:v1")!),
      );
    await expect.poll(stored).toMatchObject({
      fontSize: DEFAULT_TERMINAL_UI_SETTINGS.fontSize + 1,
      pasteProtection: false,
    });
    expect(patches).toEqual([]);
    await bell.click();
    await category("Saved output").press("Enter");
    await expect(options).toHaveCount(0);
    const retention = settings.getByRole("combobox", {
      name: "Terminal output retention",
    });
    await retention.click();
    try {
      await page.getByRole("option", { name: "90 days", exact: true }).click();
      await expect.poll(() => patches).toEqual([{ historyRetentionDays: 90 }]);
      await category("Appearance").click();
      await category("Saved output").click();
      await expect(retention).toBeDisabled();
      await category("Appearance").click();
    } finally {
      savingRetention.resolve();
    }
    await category("Saved output").click();
    await expect(retention).toContainText("90 days");
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
    await expect(
      settings.getByText("Saved on this Host.", { exact: true }),
    ).toBeVisible();
    await category("Appearance").click();
    await reset.click();
    await expect(stepperValue).toHaveText(
      `${DEFAULT_TERMINAL_UI_SETTINGS.fontSize}px`,
    );
    await expect.poll(stored).toMatchObject({
      pasteProtection: DEFAULT_TERMINAL_UI_SETTINGS.pasteProtection,
    });
    expect(service).toEqual({
      persistOutput: false,
      historyRetentionDays: 90,
    });
    await close.click();
    await expect(
      page.getByRole("dialog", { name: "Context panel" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close context pane" }).click();
    const reopened = await openTerminalSettings(page);
    await category("Saved output").click();
    await expect(
      reopened.getByRole("switch", { name: "Persist terminal output" }),
    ).not.toBeChecked();
    page.once("dialog", (dialog) => dialog.accept());
    await reopened.getByRole("button", { name: "Clear history" }).click();
    await expect.poll(() => clears).toBe(1);
  });
});
