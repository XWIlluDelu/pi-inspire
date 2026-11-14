import {
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelOption } from "../../server/model-catalog.js";
import {
  type ModelMetadata,
  ModelMetadataCatalog,
} from "../../server/model-metadata.js";
import { ModelSettingsService } from "../../server/model-settings.js";
import { ModelRuntime, ProjectTrustStore } from "../../server/pi-runtime.js";
import { ProviderAuthService } from "../../server/provider-auth.js";
import type { ModelOption } from "../../shared/contracts.js";
import type {
  ModelConfigEdit,
  ModelSettingsOwner,
} from "../../shared/model-settings.js";
import { closeHostApiFixture, configurationHost } from "./fixtures/host-api.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";

let root: string;
let agent: string;
let cwd: string;
let service: ModelSettingsService;
let host: Awaited<ReturnType<typeof configurationHost>> | undefined;
const sessionOwner = { sessionId: "fixture-active" };
const models = [
  { provider: "fixture", id: "second", name: "Second", reasoning: true },
  { provider: "fixture", id: "first", name: "First", reasoning: true },
];
const metadata = (cwd: string, models: ModelOption[]): ModelMetadata => ({
  models,
  virtualModels: [],
  defaults: { cwd, model: models[0] ?? null, thinkingLevel: "high" },
});
const initialSettings = {
  defaultProvider: "fixture",
  defaultModel: "first",
  defaultThinkingLevel: "high",
  modelThinkingLevels: { "fixture/first": "low" },
  enabledModels: ["fixture/second", "fixture/*:high"],
  compaction: { enabled: false, keepRecentTokens: 1234 },
  customExtensionSetting: { untouched: true },
};
const initialConfig = {
  providers: {
    fixture: {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      apiKey: "stored-config-secret",
      headers: { Authorization: "never-project-this" },
      modelOverrides: {
        first: { name: "override", compat: { supportsStore: false } },
      },
      models: [
        {
          id: "first",
          name: "First",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 8192,
          maxTokens: 512,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          compat: { supportsStore: false },
          thinkingLevelMap: { high: "high" },
        },
      ],
    },
  },
};
const newModel = { id: "later-model", contextWindow: 4096, maxTokens: 128 };

beforeEach(async () => {
  const workspace = await nativePiWorkspace(
    "inspire-model-settings-",
    initialSettings,
  );
  ({ root, agent, cwd } = workspace);
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(agent, "models.json"), JSON.stringify(initialConfig));
  stubNativePiEnvironment(workspace.env);
  service = new ModelSettingsService(agent);
});
afterEach(async () => {
  if (host) await closeHostApiFixture(host);
  host = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));
const snapshot = () => service.read(cwd, models);
async function editConfig(edit: ModelConfigEdit) {
  await service.saveConfig(cwd, (await snapshot()).configRevision, edit);
}
async function routes(overrides: Parameters<typeof configurationHost>[2] = {}) {
  host = await configurationHost(root, cwd, {
    modelSettings: service,
    ...overrides,
  });
  const { localRequest: http, runtime } = host;
  return {
    runtime,
    read: (owner: ModelSettingsOwner = { cwd }, refresh = false) =>
      http
        .get("/api/model-settings")
        .query({ ...owner, ...(refresh && { refresh: "1" }) })
        .expect(200),
    edit: (
      revision: string,
      edit: ModelConfigEdit,
      owner: ModelSettingsOwner = { cwd },
    ) =>
      http
        .patch("/api/model-settings/config")
        .query(owner)
        .send({ revision, edit })
        .expect(200),
    auth: (operation: object) =>
      http
        .post("/api/provider-auth")
        .query({ cwd })
        .send(operation)
        .expect(200),
  };
}

// Only scenarios with two serial native validations use a 45s integration
// budget: each query already has a 15s deadline and Windows process-tree
// retirement can take another 5s. Let both complete before test cleanup.
describe("model settings routes", () => {
  it("admits standalone login after adding a provider without a prior discovery call", async () => {
    const admission = new ProviderAuthService(
      await ModelRuntime.create({
        modelsPath: join(agent, "models.json"),
        authPath: join(agent, "auth.json"),
        refreshOnCreate: false,
      }),
    );
    const host = await routes({ providerAuth: admission });
    const provider = "new-provider";
    const initial = await readJson(join(agent, "models.json"));
    initial.providers[provider] = {
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      models: [{ id: "new-model" }],
    };
    await writeFile(join(agent, "models.json"), JSON.stringify(initial));
    const { result } = (
      await host.auth({
        operation: "start",
        provider,
        type: "api_key",
      })
    ).body;
    await vi.waitFor(() => {
      expect(admission.snapshot(result.id)).toMatchObject({
        provider,
        status: "pending",
        prompt: { type: "secret" },
      });
    });
  });

  it("offers native available models, not the full catalog, and refreshes configuration choices while retaining unavailable saved scope", async () => {
    const native = await ModelRuntime.create({
      modelsPath: join(agent, "models.json"),
      authPath: join(agent, "auth.json"),
      refreshOnCreate: false,
    });
    await native.setRuntimeApiKey("openai", "synthetic-not-requested");
    const invalidateModels = vi.fn();
    const host = await routes({
      modelMetadata: async (cwd, refresh) => {
        if (refresh) await native.refresh();
        return metadata(cwd, (await native.getAvailable()).map(modelOption));
      },
      invalidateModels,
    });
    const settings = (await host.read()).body;
    expect(settings.models.length).toBeLessThan(native.getModels().length);
    expect(settings.models).toContainEqual(
      expect.objectContaining({ provider: "openai" }),
    );
    expect(settings.nativeApiProviders).toContain("openai");
    expect(settings.nativeApiProviders).not.toContain("custom");
    expect(
      settings.providers.map((provider: { id: string }) => provider.id),
    ).not.toContain("openai");
    const saved = (
      await host.edit(settings.configRevision, {
        kind: "provider",
        id: "fixture",
        values: { apiKey: null, baseUrl: "https://changed.invalid/v1" },
      })
    ).body;
    expect(saved).toMatchObject({
      saved: true,
      snapshot: {
        providers: [expect.objectContaining({ apiKeyConfigured: false })],
        saved: { enabledModels: initialSettings.enabledModels },
      },
    });
    expect(saved.snapshot.models).not.toContainEqual(
      expect.objectContaining({ provider: "fixture" }),
    );
    const provider = (await readJson(join(agent, "models.json"))).providers
      .fixture;
    expect(provider).toMatchObject({
      baseUrl: "https://changed.invalid/v1",
      modelOverrides: initialConfig.providers.fixture.modelOverrides,
    });
    expect(provider.apiKey).toBeUndefined();
    expect(await readFile(join(agent, "auth.json"), "utf8")).toBe("{}");
    expect(invalidateModels).toHaveBeenCalledOnce();
    await native.setRuntimeApiKey("fixture", "synthetic-not-requested");
    const declaration = (
      await host.edit(saved.snapshot.configRevision, {
        kind: "model",
        provider: "fixture",
        values: newModel,
      })
    ).body.snapshot;
    expect(
      declaration.savedCommonEntries.find(
        (entry: { pattern: string }) => entry.pattern === "fixture/*:high",
      ).models,
    ).toContainEqual({
      provider: "fixture",
      id: newModel.id,
      thinkingLevel: "high",
    });
    expect(await readJson(join(agent, "settings.json"))).toEqual(
      initialSettings,
    );
  }, 45_000);
  it("invalidates workspace discovery without delaying a session save or retaining stale results", async () => {
    const old = Promise.withResolvers<ModelMetadata>();
    const query = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(metadata(cwd, [models[1]!]));
    const catalog = new ModelMetadataCatalog(query);
    const inFlight = catalog.read(cwd);
    const modelMetadata = vi.fn((cwd: string, refresh?: boolean) =>
      catalog.read(cwd, refresh),
    );
    const host = await routes({
      modelMetadata,
      invalidateModels: () => catalog.invalidate(),
    });
    await host.runtime.openSession(sessionOwner.sessionId);
    const refresh = vi
      .spyOn(host.runtime, "refreshModels")
      .mockResolvedValue({ models });
    const response = await host.edit(
      (await snapshot()).configRevision,
      {
        kind: "provider",
        id: "fixture",
        values: { apiKey: null },
      },
      sessionOwner,
    );
    expect(response.body.snapshot.models).toEqual(models);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(sessionOwner.sessionId);
    expect(modelMetadata).not.toHaveBeenCalled();
    expect(catalog.peek(cwd)).toBeUndefined();
    old.resolve(metadata(cwd, models));
    await inFlight;
    expect(catalog.peek(cwd)).toBeUndefined();
    expect((await catalog.read(cwd)).defaults.model?.id).toBe("first");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps files editable across discovery failure and session retirement", async () => {
    const error = new Error("PRIVATE CATALOG DETAIL");
    const modelMetadata = vi.fn().mockRejectedValue(error);
    const host = await routes({ modelMetadata });
    await host.runtime.openSession(sessionOwner.sessionId);
    const refresh = vi
      .spyOn(host.runtime, "refreshModels")
      .mockRejectedValue(error);
    const workspace = (await host.read({ cwd }, true)).body;
    const session = (await host.read(sessionOwner, true)).body;
    for (const before of [workspace, session]) {
      expect(before).toMatchObject({
        models: [],
        modelDiscoveryFailed: true,
        providers: [expect.objectContaining({ id: "fixture" })],
        modelsWarning: expect.stringMatching(
          /Saved configuration is still editable/,
        ),
      });
      expect(JSON.stringify(before)).not.toContain(error.message);
    }
    expect(modelMetadata).toHaveBeenCalledExactlyOnceWith(cwd, true);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(sessionOwner.sessionId);

    const save = service.saveConfig.bind(service);
    vi.spyOn(service, "saveConfig").mockImplementation(async (...args) => {
      await save(...args);
      vi.spyOn(host.runtime, "sessionCwd").mockReturnValue(null);
    });
    const saved = (
      await host.edit(
        session.configRevision,
        {
          kind: "model",
          provider: "fixture",
          originalId: "first",
          values: { id: "first", name: "Committed" },
        },
        sessionOwner,
      )
    ).body;
    expect(saved).toMatchObject({
      saved: true,
      snapshot: {
        modelsWarning: session.modelsWarning,
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: "fixture",
            models: expect.arrayContaining([
              expect.objectContaining({ id: "first", name: "Committed" }),
            ]),
          }),
        ]),
      },
    });
  });
});

describe("native configuration round trips", () => {
  it("keeps global settings available while project settings are malformed and after workspace removal", async () => {
    new ProjectTrustStore(agent).set(cwd, true);
    const projectPath = join(cwd, ".pi", "settings.json");
    await writeFile(projectPath, "{broken project settings");
    const before = await snapshot();
    expect(before.settingsError).toBeUndefined();
    expect(before.projectSettingsError).toMatch(/Project settings/);
    expect(before.saved.defaultThinkingLevel).toBe("high");
    await service.savePreferences(before.settingsRevision, {
      defaultThinkingLevel: "medium",
    });
    expect(await readFile(projectPath, "utf8")).toBe(
      "{broken project settings",
    );

    await rm(cwd, { recursive: true });
    const after = await snapshot();
    expect(after.saved.defaultThinkingLevel).toBe("medium");
    expect(after.effective).toEqual(after.saved);
  });

  it("keeps saved defaults distinct from project precedence, per-model thinking and ordered native patterns", async () => {
    new ProjectTrustStore(agent).set(cwd, true);
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        defaultThinkingLevel: "low",
        enabledModels: ["fixture/first"],
      }),
    );
    const before = await snapshot();
    await service.savePreferences(before.settingsRevision, {
      defaultModel: { provider: "fixture", id: "second" },
      defaultThinkingLevel: "medium",
      enabledModels: ["fixture/first", "fixture/second", "*sonnet*:high"],
    });
    const settings = await readJson(join(agent, "settings.json"));
    expect(settings).toEqual({
      ...initialSettings,
      defaultModel: "second",
      defaultThinkingLevel: "medium",
      enabledModels: ["fixture/first", "fixture/second", "*sonnet*:high"],
    });
    const after = await snapshot();
    expect(after).toMatchObject({
      saved: {
        defaultModel: { provider: "fixture", id: "second" },
        defaultThinkingLevel: "medium",
      },
      effective: {
        defaultThinkingLevel: "low",
        enabledModels: ["fixture/first"],
      },
      commonModels: [{ provider: "fixture", id: "first" }],
    });
    await service.savePreferences(after.settingsRevision, {
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledModels: [],
    });
    const cleared = await readJson(join(agent, "settings.json"));
    for (const key of [
      "defaultModel",
      "defaultProvider",
      "defaultThinkingLevel",
      "enabledModels",
    ])
      expect(cleared).not.toHaveProperty(key);
    expect(cleared.modelThinkingLevels).toEqual(
      initialSettings.modelThinkingLevels,
    );
    const readback = await snapshot();
    expect(readback.saved.defaultModel).toBeNull();
    expect(readback.saved.defaultThinkingLevel).toBeNull();
    expect(readback.effective.defaultThinkingLevel).toBe("low");
  });

  it("removes declarations without changing remaining models, saved preferences or login credentials", async () => {
    const auth = JSON.stringify({
      fixture: { type: "api_key", key: "saved-login-secret" },
    });
    await writeFile(join(agent, "auth.json"), auth);
    const provider = initialConfig.providers.fixture;
    await writeFile(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          fixture: { ...provider, models: [...provider.models, newModel] },
        },
      }),
    );
    await editConfig({
      kind: "remove-model",
      provider: "fixture",
      id: newModel.id,
    });
    expect(await readJson(join(agent, "models.json"))).toEqual(initialConfig);
    await editConfig({ kind: "remove-provider", id: "fixture" });
    expect(await readJson(join(agent, "models.json"))).toEqual({
      providers: {},
    });
    expect(await readJson(join(agent, "settings.json"))).toEqual(
      initialSettings,
    );
    expect(await readFile(join(agent, "auth.json"), "utf8")).toBe(auth);
  }, 45_000);

  it("edits linked Pi files with BOM/comments while preserving advanced declarations and secrets", async () => {
    const settingsTarget = join(root, "managed-settings.json");
    const modelsTarget = join(root, "managed-models.json");
    await writeFile(settingsTarget, `\uFEFF${JSON.stringify(initialSettings)}`);
    await writeFile(
      modelsTarget,
      `\uFEFF// Managed provider configuration\n${JSON.stringify(initialConfig)}`,
    );
    await Promise.all([
      rm(join(agent, "settings.json")),
      rm(join(agent, "models.json")),
    ]);
    await Promise.all([
      symlink(settingsTarget, join(agent, "settings.json")),
      symlink(modelsTarget, join(agent, "models.json")),
    ]);
    const before = await snapshot();
    expect(before.settingsError).toBeUndefined();
    expect(before.configError).toBeUndefined();
    expect(before.providers[0]).toMatchObject({ apiKeyConfigured: true });
    for (const secret of ["stored-config-secret", "never-project-this"])
      expect(JSON.stringify(before)).not.toContain(secret);
    await service.savePreferences(before.settingsRevision, {
      defaultThinkingLevel: "medium",
    });
    await service.saveConfig(cwd, before.configRevision, {
      kind: "model",
      provider: "fixture",
      originalId: "first",
      values: { id: "first", name: "Linked edit" },
    });
    expect((await lstat(join(agent, "settings.json"))).isSymbolicLink()).toBe(
      true,
    );
    expect((await lstat(join(agent, "models.json"))).isSymbolicLink()).toBe(
      true,
    );
    expect(await readJson(settingsTarget)).toEqual({
      ...initialSettings,
      defaultThinkingLevel: "medium",
    });
    expect(await readJson(modelsTarget)).toEqual({
      providers: {
        fixture: {
          ...initialConfig.providers.fixture,
          models: [
            {
              ...initialConfig.providers.fixture.models[0],
              name: "Linked edit",
            },
          ],
        },
      },
    });
  });

  it("reports malformed and duplicate declarations without publishing them", async () => {
    await writeFile(join(agent, "models.json"), "{broken");
    const malformed = await snapshot();
    expect(malformed.configError).toMatch(/invalid/);
    await writeFile(join(agent, "models.json"), JSON.stringify(initialConfig));
    const valid = await snapshot();
    await expect(
      service.saveConfig(cwd, valid.configRevision, {
        kind: "model",
        provider: "fixture",
        values: { id: "first" },
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: "A model with that ID already exists",
    });
    expect(await readJson(join(agent, "models.json"))).toEqual(initialConfig);
  });
});
