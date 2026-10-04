import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { modelSettingsScenario, pairAndOpen } from "./fixtures/model-settings";
import { openCommandPalette } from "./support/navigation";

test.use({ serviceWorkers: "block" });
for (const [name, width, height, theme] of [
  ["desktop-light", 1280, 900, "light"],
  ["desktop-dark", 1280, 900, "dark"],
  ["touch-light", 390, 844, "light"],
  ["phone320-dark", 320, 740, "dark"],
] as const) {
  test.describe(name, () => {
    test.use({ viewport: { width, height }, hasTouch: width < 600 });
    test("updates saved credentials by another method, exposes native remote help, and removes secondarily", async ({
      page,
    }) => {
      const scenario = await modelSettingsScenario(page, theme);
      await pairAndOpen(page);
      const draft = page.getByRole("textbox", { name: "Message", exact: true });
      await draft.fill("Keep my auth-task draft");
      const model = page.getByRole("button", { name: "Model", exact: true });
      const selected = await model.textContent();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Models", exact: true }).click();
      const initialSettings = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      await expect(
        initialSettings.getByRole("button", {
          name: "Manage Anthropic",
          exact: true,
        }),
      ).toBeVisible();
      await expect(initialSettings.getByLabel("Search providers")).toHaveCount(
        0,
      );
      await expect(
        initialSettings.getByRole("region", { name: "Available providers" }),
      ).toHaveCount(0);
      await page.screenshot({
        path: `output/playwright/auth-${name}.png`,
        animations: "disabled",
      });
      await initialSettings
        .getByRole("button", { name: "Connect provider", exact: true })
        .click();
      await expect(
        initialSettings.getByLabel("Search providers"),
      ).toBeVisible();
      expect(
        (await initialSettings
          .locator(".models-auth__providers")
          .boundingBox())!.height,
      ).toBeLessThanOrEqual(180);
      await page.screenshot({
        path: `output/playwright/auth-discovery-${name}.png`,
        animations: "disabled",
      });
      await initialSettings.getByLabel("Search providers").fill("copilot");
      await initialSettings
        .getByRole("button", { name: "Set up GitHub Copilot" })
        .click();
      await expect(initialSettings.getByLabel("Search providers")).toHaveCount(
        0,
      );
      await expect(
        initialSettings.locator(".models-auth__providers"),
      ).toHaveCount(0);
      const instruction = initialSettings.getByText(
        "Open the sign-in link on this device and enter the displayed code.",
        { exact: true },
      );
      await expect(instruction).toHaveCount(0);
      const remoteHelp = initialSettings.getByRole("button", {
        name: "About remote login",
      });
      if (width < 600) await remoteHelp.tap();
      else {
        await remoteHelp.focus();
        await remoteHelp.press("Enter");
      }
      await expect(instruction).toBeVisible();
      await page.screenshot({
        path: `output/playwright/auth-provider-method-${name}.png`,
        animations: "disabled",
      });
      await initialSettings
        .getByRole("button", { name: "Back to providers" })
        .click();
      await expect(initialSettings.getByLabel("Search providers")).toHaveValue(
        "copilot",
      );
      await expect(
        initialSettings.getByLabel("Search providers"),
      ).toBeFocused();
      await initialSettings
        .getByRole("button", {
          name: "Back to connected providers",
          exact: true,
        })
        .click();
      await initialSettings
        .getByRole("button", { name: "Close settings" })
        .click();
      const palette = await openCommandPalette(page);
      await palette.getByLabel("Filter commands").fill("/login");
      await palette.getByRole("option", { name: /^\/login/ }).click();
      const settings = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      await expect(
        settings.getByRole("heading", { name: "Login & API keys" }),
      ).toBeVisible();
      await expect(
        settings.getByRole("button", { name: "Models", exact: true }),
      ).toHaveAttribute("aria-current", "location");
      await expect(
        settings.getByRole("button", {
          name: "Claude authorization",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        settings.getByText("Remove credential", { exact: true }),
      ).toHaveCount(0);
      await expect(settings.getByLabel("Search providers")).toBeVisible();
      const directory = settings.locator(".models-auth__providers");
      expect((await directory.boundingBox())!.height).toBeLessThanOrEqual(180);
      await settings
        .getByRole("button", { name: "Back to connected providers" })
        .click();
      await settings
        .getByRole("button", { name: "Manage Anthropic", exact: true })
        .click();
      await settings
        .getByRole("button", { name: "Anthropic API key", exact: true })
        .click();
      const secret = settings.getByLabel("API key", { exact: true });
      await expect(
        settings.getByRole("region", { name: "Connected providers" }),
      ).toHaveCount(0);
      await expect(
        settings.getByRole("button", { name: "Connect provider" }),
      ).toHaveCount(0);
      await secret.fill("SYNTHETIC_API_KEY");
      await expect(secret).toHaveAttribute("type", "password");
      await settings
        .getByRole("button", { name: "Show credential", exact: true })
        .click();
      await expect(secret).toHaveAttribute("type", "text");
      await settings
        .getByRole("button", { name: "Hide credential", exact: true })
        .click();
      await page.screenshot({
        path: `output/playwright/auth-secret-${name}.png`,
        animations: "disabled",
      });
      expect(
        await settings
          .locator(".settings__main")
          .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
      ).toBe(false);
      if (width < 600)
        expect((await secret.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await settings
        .getByRole("button", { name: "Cancel login", exact: true })
        .click();
      await settings
        .getByRole("button", { name: "Dismiss", exact: true })
        .click();
      await settings
        .getByRole("button", { name: "Claude authorization", exact: true })
        .click();
      await settings
        .getByRole("button", { name: "About remote login" })
        .click();
      await expect(
        settings.getByText(
          "Open the sign-in link on this device, then paste the authorization code here.",
          { exact: true },
        ),
      ).toBeVisible();
      await page.screenshot({
        path: `output/playwright/auth-help-${name}.png`,
        animations: "disabled",
      });
      await settings
        .getByRole("button", { name: "Copy authorization code", exact: true })
        .click();
      await expect(
        settings.getByRole("link", { name: "Open sign-in link", exact: true }),
      ).toHaveAttribute("href", "https://example.invalid/authorize");
      await settings
        .getByLabel("Paste the authorization code")
        .fill("SYNTHETIC_AUTH_CODE");
      await settings
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      await expect(
        settings.getByText("Login complete.", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(
          () =>
            scenario.providers().find((provider) => provider.id === "anthropic")
              ?.stored,
        )
        .toBe("oauth");
      expect(
        scenario.authOperations.some(
          (operation) => operation.operation === "logout",
        ),
      ).toBe(false);
      await settings
        .getByRole("button", { name: "Dismiss", exact: true })
        .click();
      await settings
        .getByRole("button", { name: "Manage Anthropic", exact: true })
        .click();
      await settings
        .getByRole("button", {
          name: "Remove saved credentials for Anthropic",
          exact: true,
        })
        .click();
      await settings
        .getByRole("button", { name: "Remove saved credentials", exact: true })
        .click();
      await expect
        .poll(
          () =>
            scenario.providers().find((provider) => provider.id === "anthropic")
              ?.stored,
        )
        .toBeNull();
      await expect(
        settings.getByRole("region", { name: "Connected providers" }),
      ).toHaveCount(0);
      await expect(
        settings.getByRole("button", { name: "Connect provider", exact: true }),
      ).toBeVisible();
      await expect(settings.getByLabel("Search providers")).toHaveCount(0);
      await settings
        .getByRole("region", { name: "Login & API keys", exact: true })
        .evaluate((element) =>
          element.scrollIntoView({ block: "start", behavior: "instant" }),
        );
      await page.screenshot({
        path: `output/playwright/auth-empty-${name}.png`,
        animations: "disabled",
      });
      await settings
        .getByRole("button", { name: "Connect provider", exact: true })
        .click();
      await settings.getByLabel("Search providers").fill("no-such-provider");
      await expect(
        settings.getByText(
          'No available providers matching "no-such-provider"',
          {
            exact: true,
          },
        ),
      ).toBeVisible();
      const accessibility = await new AxeBuilder({ page })
        .include(".settings")
        .analyze();
      expect(
        accessibility.violations.filter(
          (violation) =>
            violation.impact === "critical" || violation.impact === "serious",
        ),
      ).toEqual([]);
      await settings.getByRole("button", { name: "Close settings" }).click();
      await expect(draft).toHaveValue("Keep my auth-task draft");
      await expect(model).toHaveText(selected!);
      expect(scenario.modelChanges).toEqual([]);
      expect(scenario.errors).toEqual([]);
    });
  });
}
