import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { modelSettingsScenario } from "./fixtures/model-settings";
import { openCommandPalette, pairAndOpen } from "./support/navigation";

test.use({ serviceWorkers: "block" });

test.describe("narrow touch screen", () => {
  test.use({ viewport: { width: 320, height: 740 }, hasTouch: true });

  test("updates and removes saved credentials from /login without changing the active session", async ({
    page,
  }) => {
    const scenario = await modelSettingsScenario(page, "dark");
    const provider = scenario.providers().find(({ id }) => id === "anthropic")!;
    provider.name =
      "区域标定服务RegionalCalibrationReferenceDeviceAuthorization";
    await pairAndOpen(page);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    const model = page.getByRole("button", { name: "Model", exact: true });
    await expect(model).toHaveText("Offline model");

    await draft.fill("/login copilot");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    const search = settings.getByLabel("Search providers");
    await expect(
      settings.getByRole("button", { name: "GitHub authorization" }),
    ).toBeEnabled();
    expect(
      scenario.authOperations.some(({ operation }) => operation === "start"),
    ).toBe(false);
    const instruction = settings.getByText(
      "Open the sign-in link on this device and enter the displayed code.",
      { exact: true },
    );
    await expect(instruction).toBeHidden();
    await settings.getByRole("button", { name: "About remote login" }).tap();
    await expect(instruction).toBeVisible();
    await settings.getByRole("button", { name: "Back to providers" }).click();
    await expect(search).toHaveValue("copilot");
    await expect(search).toBeFocused();
    const directory = settings.getByRole("region", {
      name: "Available providers",
    });
    await expect(
      directory.getByRole("button", { name: "Set up GitHub Copilot" }),
    ).toBeVisible();
    await expect(directory).not.toContainText("github-copilot");
    await search.fill("  GITHUB-  ");
    await expect(directory).toContainText("github-copilot");
    await settings.getByRole("button", { name: "Close settings" }).click();

    await draft.fill("Keep my auth-task draft");
    const palette = await openCommandPalette(page);
    await palette.getByLabel("Filter commands").fill("/login");
    await palette.getByRole("option", { name: /^\/login/ }).click();
    await expect(search).toBeFocused();
    await settings
      .getByRole("button", { name: "Back to connected providers" })
      .click();
    const manage = settings.getByRole("button", {
      name: `Manage ${provider.name}`,
      exact: true,
    });
    await manage.click();
    await settings
      .getByRole("button", { name: "Anthropic API key", exact: true })
      .click();
    const secret = settings.getByLabel("API key", { exact: true });
    await secret.fill("SYNTHETIC_API_KEY");
    await expect(secret).toHaveAttribute("type", "password");
    await settings.getByRole("button", { name: "Show credential" }).click();
    await expect(secret).toHaveAttribute("type", "text");
    await settings.getByRole("button", { name: "Hide credential" }).click();
    await expect(secret).toHaveAttribute("type", "password");

    await settings
      .getByRole("button", { name: "Cancel login", exact: true })
      .click();
    const dismiss = settings.getByRole("button", {
      name: "Dismiss",
      exact: true,
    });
    await dismiss.click();
    const authorize = settings.getByRole("button", {
      name: "Claude authorization",
      exact: true,
    });
    const login = settings.getByRole("group", {
      name: "Login to anthropic",
      exact: true,
    });
    await authorize.click();
    await login
      .getByRole("button", { name: "About remote login" })
      .press("Enter");
    await expect(
      login.getByText(/paste the authorization code here/),
    ).toBeVisible();
    const failure =
      "AuthorizationRejectedBecauseThisCalibrationServiceRequiresAdditionalOrganizationApproval";
    scenario.failLogin(failure);
    const header = login.locator(":scope > .models-subheading");
    await expect(header.getByRole("status")).toHaveText(failure);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await header.evaluate((root) => {
        const frame = root.getBoundingClientRect();
        return [...root.querySelectorAll("h4, [role=status]")].every(
          (element) => {
            const text = document.createRange();
            text.selectNodeContents(element);
            return [...text.getClientRects()].every(
              (rect) =>
                rect.left >= frame.left - 0.5 &&
                rect.right <= frame.right + 0.5,
            );
          },
        );
      }),
    ).toBe(true);
    await dismiss.click();
    await authorize.click();
    await settings
      .getByRole("button", { name: "Copy authorization code" })
      .click();
    await expect(
      settings.getByRole("link", { name: "Open sign-in link" }),
    ).toHaveAttribute("href", "https://example.invalid/authorize");
    await settings
      .getByLabel("Paste the authorization code")
      .fill("SYNTHETIC_AUTH_CODE");
    await settings
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await expect(settings.getByRole("status")).toHaveText("Login complete.");

    const storedCredential = () =>
      scenario.providers().find((provider) => provider.id === "anthropic")
        ?.stored;
    await expect.poll(storedCredential).toBe("oauth");
    await dismiss.click();
    await manage.click();
    await settings
      .getByRole("button", {
        name: `Remove saved credentials for ${provider.name}`,
      })
      .click();
    expect(storedCredential()).toBe("oauth");
    await settings
      .getByRole("button", { name: "Remove saved credentials", exact: true })
      .click();
    await expect.poll(storedCredential).toBeNull();

    await settings
      .getByRole("button", { name: "Connect provider", exact: true })
      .click();
    await search.fill("no-such-provider");
    await expect(
      settings.getByText('No available providers matching "no-such-provider"'),
    ).toBeVisible();
    const { violations } = await new AxeBuilder({ page })
      .include(".settings")
      .analyze();
    expect(
      violations.filter(
        ({ impact }) => impact === "critical" || impact === "serious",
      ),
    ).toEqual([]);

    await settings.getByRole("button", { name: "Close settings" }).click();
    await expect(draft).toHaveValue("Keep my auth-task draft");
    await expect(model).toHaveText("Offline model");
    expect(scenario.modelChanges).toEqual([]);
    expect(scenario.errors).toEqual([]);
  });
});
