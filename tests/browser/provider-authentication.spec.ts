import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { browserFixtureHome } from "./fixtures/workspace.mjs";
import { openCommandPalette, pairAndOpen } from "./support/navigation";

test.use({
  serviceWorkers: "block",
  viewport: { width: 320, height: 740 },
  hasTouch: true,
});

test("updates and removes real provider credentials through /login while preserving the draft", async ({
  page,
}) => {
  const auth = join(browserFixtureHome, "agent", "auth.json");
  const original = await readFile(auth);
  const stored = async () => JSON.parse(await readFile(auth, "utf8")).anthropic;
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await writeFile(
      auth,
      JSON.stringify({
        ...JSON.parse(original.toString("utf8")),
        anthropic: { type: "api_key", key: "synthetic" },
      }),
    );
    await pairAndOpen(page);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    const model = page.getByRole("button", { name: "Model", exact: true });
    const current = /^(Offline model|offline) — workbench$/;
    await expect(model).toHaveAttribute("title", current);
    await draft.fill("/login copilot");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    const method = settings.getByRole("button", {
      name: "Anthropic API key",
      exact: true,
    });
    await settings.getByText("Remote login", { exact: true }).tap();
    await expect(settings.getByText(/enter the displayed code/)).toBeVisible();
    const search = settings.getByLabel("Search providers");
    await settings.getByRole("button", { name: "Back to providers" }).click();
    await expect(search).toHaveValue("copilot");
    await expect(search).toBeFocused();
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
      name: "Manage Anthropic",
      exact: true,
    });
    await manage.click();
    await method.click();
    const secret = settings.getByLabel("Enter Anthropic API key", {
      exact: true,
    });
    await secret.fill("SYNTHETIC_API_KEY");
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
    expect(await stored()).toEqual({ type: "api_key", key: "synthetic" });

    await method.click();
    await secret.fill("SYNTHETIC_API_KEY");
    await settings
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await expect(
      settings.getByText("API key saved.", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(stored)
      .toEqual({ type: "api_key", key: "SYNTHETIC_API_KEY" });
    await dismiss.click();
    await manage.click();
    await settings
      .getByRole("button", {
        name: "Remove saved credentials for Anthropic",
      })
      .click();
    expect((await stored()).key).toBe("SYNTHETIC_API_KEY");
    await settings
      .getByRole("button", { name: "Remove saved credentials", exact: true })
      .click();
    await expect.poll(stored).toBeUndefined();

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
    await expect(model).toHaveAttribute("title", current);
  } finally {
    await writeFile(auth, original);
  }
});
