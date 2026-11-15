import { expect, type Page, test } from "@playwright/test";
import {
  type TerminalOperation,
  terminalReceiptIdentity,
} from "../../shared/terminal-operations";
import { openCommandPalette, pairAndOpen } from "./support/navigation";

async function openTerminalSettings(page: Page) {
  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("Terminal settings");
  await palette.getByRole("option", { name: /Terminal settings/ }).click();
  return page.getByRole("dialog", { name: "Terminal settings", exact: true });
}

test.use({ serviceWorkers: "block" });
test.describe("narrow terminal settings", () => {
  test.use({ viewport: { width: 320, height: 900 }, hasTouch: true });
  test("keeps keyboard focus and receipt recovery in terminal settings", async ({
    page,
  }) => {
    let service = { persistOutput: true, historyRetentionDays: 30 };
    const patches: unknown[] = [];
    let clears = 0;
    const failedClear = Promise.withResolvers<void>();
    await page.route("**/api/terminal-operations", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          json: { epoch: "11111111-1111-4111-8111-111111111111" },
        });
        return;
      }
      const operation = route.request().postDataJSON() as TerminalOperation;
      const { intent } = operation;
      const receipt = terminalReceiptIdentity(operation);
      if (intent.command === "clearHistory" && ++clears === 1) {
        await failedClear.promise;
        return route.fulfill({
          status: 409,
          json: {
            ...receipt,
            state: "rejected",
            error: { status: 409, message: "Saved output is busy." },
          },
        });
      }
      if (intent.command === "updateSettings") {
        const { patch } = intent.params;
        patches.push(patch);
        service = { ...service, ...patch };
      }
      await route.fulfill({
        json: {
          ...receipt,
          state: "completed",
          result: intent.command === "clearHistory" ? null : service,
        },
      });
    });
    await page.route("**/api/terminal-settings", (route) =>
      route.fulfill({ json: service }),
    );
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
    await settings
      .getByRole("group", { name: "Terminal cursor shape" })
      .getByRole("button", { name: "Bar", exact: true })
      .click();
    await page.setViewportSize({ width: 320, height: 460 });
    await category("Interaction").click();
    await expect(reset).toBeInViewport();
    await close.press("Shift+Tab");
    await expect(reset).toBeFocused();
    await reset.press("Tab");
    await expect(close).toBeFocused();
    await page.setViewportSize({ width: 320, height: 900 });

    const stored = () =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("inspire:terminal-ui-settings:v1")!),
      );
    await expect.poll(stored).toMatchObject({ cursorStyle: "bar" });
    expect(patches).toEqual([]);
    await category("Saved output").press("Enter");
    const retention = settings.getByRole("combobox", {
      name: "Terminal output retention",
    });
    await retention.click();
    await settings
      .getByRole("option", { name: "90 days", exact: true })
      .click();
    await expect(retention).toHaveText("90 days");
    await expect(retention).toBeEnabled();
    page.once("dialog", (dialog) => dialog.accept());
    await settings
      .getByRole("switch", { name: "Persist terminal output" })
      .click();
    await expect(
      settings.getByRole("switch", { name: "Persist terminal output" }),
    ).not.toBeChecked();
    await expect(retention).toBeDisabled();
    expect(patches).toEqual([
      { historyRetentionDays: 90 },
      { persistOutput: false },
    ]);
    const clear = settings.getByRole("button", {
      name: "Clear history",
      exact: true,
    });
    const requestClear = () => {
      page.once("dialog", (dialog) => dialog.accept());
      return clear.click();
    };
    try {
      await requestClear();
      await expect(
        settings.getByRole("button", { name: "Clearing…" }),
      ).toBeDisabled();
      await category("Appearance").click();
      failedClear.resolve();
      await expect(settings.getByRole("alert")).toHaveText(
        "Saved output is busy.",
      );
    } finally {
      failedClear.resolve();
    }
    await category("Saved output").click();
    await requestClear();
    await expect(clear).toBeEnabled();
    expect(clears).toBe(2);
    await close.click();
    await expect(
      page.getByRole("dialog", { name: "Context panel" }),
    ).toBeVisible();
  });
});
