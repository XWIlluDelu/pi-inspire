import { expect, type Page } from "@playwright/test";
import type {
  ModelPreferencesPatch,
  ProviderLoginAttempt,
} from "../../../shared/model-settings";
import {
  loginProviders,
  modelSettingsSnapshot,
  pendingLogin,
} from "../../web/fixtures/model-settings";

export async function modelSettingsScenario(page: Page, theme = "light") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let snapshot = modelSettingsSnapshot();
  let providers = [
    ...loginProviders(),
    {
      id: "amazon-bedrock",
      name: "Amazon Bedrock",
      stored: null,
      methods: [
        { type: "api_key" as const, label: "AWS credentials or bearer token" },
      ],
    },
    ...[
      ["azure-openai-responses", "Azure OpenAI"],
      ["baseten", "Baseten"],
      ["cerebras", "Cerebras"],
    ].map(([id, name]) => ({
      id: id!,
      name: name!,
      stored: null,
      methods: [{ type: "api_key" as const, label: `${name} API key` }],
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  let attempt: ProviderLoginAttempt | null = null;
  let authority = "";
  const modelChanges: unknown[] = [];
  const authOperations: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const pattern of [
    "**/api/bootstrap**",
    "**/api/snapshot**",
    "**/api/sessions/open",
  ])
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      authority = response.headers()["x-inspire-authority"] ?? authority;
      const payload = await response.json();
      if (payload.preferences)
        payload.preferences = { ...payload.preferences, theme };
      await route.fulfill({ response, json: payload });
    });
  await page.route("**/api/models**", (route) =>
    route.fulfill({
      json: { models: snapshot.models, commonModels: snapshot.commonModels },
    }),
  );
  await page.route("**/api/control/model", (route) => {
    modelChanges.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/model-settings**", async (route) => {
    if (route.request().method() !== "PATCH")
      return route.fulfill({ json: snapshot });
    const { edit, patch } = route.request().postDataJSON();
    // Only the provider -> model task is modeled here. Native validation and
    // optional-field preservation belong to server/component tests.
    if (edit?.kind === "provider") {
      snapshot.providers.push({
        id: edit.id,
        baseUrl: edit.values.baseUrl,
        api: edit.values.api,
        apiKeyConfigured: Boolean(edit.values.apiKey),
        models: [],
        advancedFields: [],
      });
    } else if (edit?.kind === "model") {
      snapshot.providers
        .find((provider) => provider.id === edit.provider)!
        .models.push({ ...edit.values, advancedFields: [] });
      snapshot.models.push({ ...edit.values, provider: edit.provider });
    } else if (patch) {
      snapshot.saved = {
        ...snapshot.saved,
        ...(patch as ModelPreferencesPatch),
      };
      snapshot.savedCommonEntries = snapshot.saved.enabledModels.map(
        (pattern) =>
          snapshot.savedCommonEntries.find(
            (entry) => entry.pattern === pattern,
          ) ?? {
            pattern,
            models: snapshot.models.filter(
              (model) => `${model.provider}/${model.id}` === pattern,
            ),
          },
      );
      snapshot.commonModels = snapshot.savedCommonEntries.flatMap(
        (entry) => entry.models,
      );
    }
    snapshot = {
      ...snapshot,
      settingsRevision: "c".repeat(64),
      configRevision: "d".repeat(64),
    };
    await route.fulfill({
      headers: { "X-Inspire-Authority": authority },
      json: { saved: true, snapshot },
    });
  });
  await page.route("**/api/provider-auth**", async (route) => {
    const body = route.request().postDataJSON();
    authOperations.push(body);
    if (body.operation === "start")
      attempt = pendingLogin({
        type: body.type,
        ...(body.type === "api_key"
          ? { prompt: { id: "key", type: "secret", message: "API key" } }
          : {}),
      });
    if (body.operation === "answer") {
      if (body.value === "copy_code")
        attempt = pendingLogin({
          prompt: {
            id: "code",
            type: "manual_code",
            message: "Paste the authorization code",
          },
          events: [
            { type: "auth_url", url: "https://example.invalid/authorize" },
          ],
        });
      else {
        attempt = pendingLogin({
          type: attempt!.type,
          status: "completed",
          prompt: null,
          message: "Login complete.",
        });
        providers = providers.map((provider) =>
          provider.id === "anthropic"
            ? { ...provider, stored: attempt!.type }
            : provider,
        );
      }
    }
    if (body.operation === "cancel")
      attempt = pendingLogin({
        status: "cancelled",
        prompt: null,
        message: "Login cancelled.",
      });
    if (body.operation === "logout")
      providers = providers.map((provider) =>
        provider.id === body.provider
          ? { ...provider, stored: null }
          : provider,
      );
    await route.fulfill({
      headers: { "X-Inspire-Authority": authority },
      json: {
        result:
          body.operation === "providers"
            ? providers
            : body.operation === "logout"
              ? null
              : attempt,
      },
    });
  });
  return {
    snapshot: () => snapshot,
    providers: () => providers,
    modelChanges,
    authOperations,
    errors,
  };
}

export async function pairAndOpen(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill("inspire-browser-test-token");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  const toggle = page.getByRole("button", {
    name: "Toggle navigation",
    exact: true,
  });
  if (
    (await toggle.getAttribute("aria-expanded")) === "false" ||
    (await page.locator(".nav--rail").count())
  )
    await toggle.click();
  await page
    .getByRole("button", { name: /Review extension event lifecycle/ })
    .first()
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
}
