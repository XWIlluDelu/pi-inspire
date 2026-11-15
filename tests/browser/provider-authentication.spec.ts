import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Request, type Route, test } from "@playwright/test";
import type { ProviderAuthOperation } from "../../shared/provider-auth-bridge";
import { browserFixtureHome } from "./fixtures/workspace.mjs";
import { openCommandPalette, pairAndOpen } from "./support/navigation";

function loginRequest(request: Request): ProviderAuthOperation | undefined {
  if (new URL(request.url()).pathname === "/api/provider-auth")
    return request.postDataJSON();
}

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
  const unavailable = (route: Route) =>
    route.fulfill({
      status: 503,
      json: { error: "Provider service unavailable" },
    });
  let directoryFault = false;
  let discardCancelReply = false;
  let holdStartReply = false;
  const directoryReply = Promise.withResolvers<void>();
  const start = () =>
    Promise.withResolvers<{ owner: string | null; id: string }>();
  let created = start();
  let activeStart: PromiseWithResolvers<void> | undefined;
  const startReplies = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  await page.route("**/api/provider-auth**", async (route) => {
    const request = loginRequest(route.request());
    if (request?.operation === "providers" && directoryFault) {
      await directoryReply.promise;
      return unavailable(route);
    }
    if (request?.operation === "cancel" && discardCancelReply) {
      const cancelled = await route.fetch();
      expect(cancelled.ok()).toBe(true);
      return unavailable(route);
    }
    if (request?.operation === "start" && holdStartReply) {
      holdStartReply = false;
      const response = await route.fetch();
      const { result } = await response.json();
      const reply = startReplies.shift()!;
      activeStart = reply;
      created.resolve({
        owner: new URL(route.request().url()).searchParams.get("sessionId"),
        id: result.id,
      });
      await reply.promise;
      return route.fulfill({ response });
    }
    await route.fallback();
  });
  try {
    await writeFile(
      auth,
      JSON.stringify({
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
    await expect(search).toHaveValue("copilot");
    const provider = settings.getByRole("button", {
      name: "Set up GitHub Copilot",
    });
    await provider.click();
    await expect(provider).toHaveAttribute("aria-expanded", "false");
    await expect(search).toBeVisible();
    await settings.getByRole("button", { name: "Close settings" }).click();

    await draft.fill("Keep my auth-task draft");
    const palette = await openCommandPalette(page);
    await palette.getByLabel("Filter commands").fill("/login");
    directoryFault = true;
    await palette.getByRole("option", { name: /^\/login/ }).click();
    await expect(search).toBeFocused();
    await settings
      .getByRole("button", { name: "Back to connected providers" })
      .click();
    const credentials = settings.getByRole("region", {
      name: "Login & API keys",
    });
    const retry = credentials.getByRole("button", { name: "Retry" });
    const connect = credentials.getByRole("button", {
      name: "Connect provider",
    });
    await expect(credentials.getByText("Loading providers…")).toBeVisible();
    await expect(connect).toBeDisabled();
    directoryReply.resolve();
    await expect(credentials.getByRole("alert")).toContainText(
      "Failed to load providers",
    );
    await expect(connect).toBeDisabled();
    directoryFault = false;
    await retry.click();
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
    discardCancelReply = true;
    await settings
      .getByRole("button", { name: "Cancel login", exact: true })
      .click();
    await expect(credentials.getByText("Login cancelled.")).toBeVisible();
    await expect(credentials.getByRole("alert")).toHaveCount(0);
    discardCancelReply = false;
    const dismiss = settings.getByRole("button", {
      name: "Dismiss",
      exact: true,
    });
    await dismiss.click();
    expect(await stored()).toEqual({ type: "api_key", key: "synthetic" });

    const categories = settings.getByRole("navigation", {
      name: "Settings categories",
    });
    const models = categories.getByRole("button", {
      name: "Models",
      exact: true,
    });
    const display = categories.getByRole("button", {
      name: "Display",
      exact: true,
    });
    const modelSearch = settings.getByRole("combobox", {
      name: "Search available models",
    });
    await modelSearch.fill("offline");
    holdStartReply = true;
    await method.click();
    await created.promise;
    await display.click();
    const arrived = page.waitForResponse(
      (response) => loginRequest(response.request())?.operation === "start",
    );
    activeStart?.resolve();
    await arrived;
    await expect(display).toBeFocused();
    await expect(secret).toHaveCount(0);
    await models.click();
    await expect(modelSearch).toHaveValue("offline");
    await secret.fill("SYNTHETIC_API_KEY");
    await expect(secret).toHaveValue("SYNTHETIC_API_KEY");
    directoryFault = true;
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
    await expect(credentials.getByRole("alert")).toContainText(
      "Provider refresh failed",
    );
    await expect(manage).toBeEnabled();
    directoryFault = false;
    await retry.click();
    await expect(credentials.getByRole("alert")).toHaveCount(0);
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
    await expect(
      credentials.getByText("No connected providers."),
    ).toBeVisible();

    await settings
      .getByRole("button", { name: "Connect provider", exact: true })
      .click();
    await search.fill("anthropic");
    await settings.getByRole("button", { name: "Set up Anthropic" }).click();
    created = start();
    holdStartReply = true;
    await method.click();
    const old = await created.promise;
    await settings.getByRole("button", { name: "Close settings" }).click();
    const cancelled = page.waitForResponse((response) => {
      const request = loginRequest(response.request());
      return request?.operation === "cancel" && request.id === old.id;
    });
    activeStart?.resolve();
    const receipt = await cancelled;
    expect(new URL(receipt.url()).searchParams.get("sessionId")).toBe(
      old.owner,
    );
    expect((await receipt.json()).result.status).toBe("cancelled");
    await expect(draft).toHaveValue("Keep my auth-task draft");
    await expect(model).toHaveAttribute("title", current);
  } finally {
    directoryReply.resolve();
    activeStart?.resolve();
    for (const reply of startReplies) reply.resolve();
    await writeFile(auth, original);
  }
});
