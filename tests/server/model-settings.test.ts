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
const hosts: Awaited<ReturnType<typeof configurationHost>>[] = [];
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
const newModel = {
  id: "later-model",
  name: "Later available model",
  reasoning: false,
  input: ["text"],
  contextWindow: 4096,
  maxTokens: 128,
} satisfies Extract<ModelConfigEdit, { kind: "model" }>["values"];

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
  for (const host of hosts.splice(0).reverse()) await closeHostApiFixture(host);
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
  const modelMetadata = vi.fn(async (cwd: string) => metadata(cwd, models));
  const invalidateModels = vi.fn();
  const host = await configurationHost(root, cwd, {
    modelSettings: service,
    modelMetadata,
    invalidateModels,
    ...overrides,
  });
  hosts.push(host);
  const { localRequest: http, runtime } = host;
  return {
    runtime,
    modelMetadata,
    invalidateModels,
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
    preferences: (revision: string) =>
      http
        .patch("/api/model-settings")
        .query({ cwd })
        .send({ revision, patch: { defaultThinkingLevel: "medium" } })
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
  it("discovers and admits login for a newly saved provider through existing Host auth readers", async () => {
    const createAuthReader = async () =>
      new ProviderAuthService(
        await ModelRuntime.create({
          modelsPath: join(agent, "models.json"),
          authPath: join(agent, "auth.json"),
          refreshOnCreate: false,
        }),
      );
    const discovery = await createAuthReader();
    const admission = await createAuthReader();
    const host = await routes({ providerAuth: discovery });
    const login = await routes({ providerAuth: admission });
    const provider = "new-provider";
    // The readers predate the edit and each operation must discover it on its own.
    const current = (await host.read()).body;
    const saved = (
      await host.edit(current.configRevision, {
        kind: "provider",
        id: provider,
        values: {
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
        },
      })
    ).body;
    expect(saved.saved).toBe(true);
    expect(
      (
        await host.edit(saved.snapshot.configRevision, {
          kind: "model",
          provider,
          values: { id: "new-model" },
        })
      ).body.saved,
    ).toBe(true);
    expect(
      (await host.auth({ operation: "providers" })).body.result,
    ).toContainEqual({
      id: provider,
      name: provider,
      stored: null,
      methods: [{ type: "api_key", label: "API key" }],
    });
    const { result } = (
      await login.auth({ operation: "start", provider, type: "api_key" })
    ).body;
    expect(result).toMatchObject({
      provider,
      type: "api_key",
      status: "pending",
    });
    await vi.waitFor(() =>
      expect(admission.snapshot(result.id).prompt?.type).toBe("secret"),
    );
  }, 45_000);

  it("offers native available models, not the full catalog, and refreshes configuration choices while retaining unavailable saved scope", async () => {
    const native = await ModelRuntime.create({
      modelsPath: join(agent, "models.json"),
      authPath: join(agent, "auth.json"),
      refreshOnCreate: false,
    });
    await native.setRuntimeApiKey("openai", "synthetic-not-requested");
    const availableModels = async (refresh = false) => {
      if (refresh) await native.refresh();
      return (await native.getAvailable()).map(modelOption);
    };
    const available = await availableModels();
    const builtIn = available.find((model) => model.provider === "openai")!;
    expect(builtIn).toBeDefined();
    expect(native.getModels().length).toBeGreaterThan(available.length);
    const sessionChoices = [builtIn];
    const host = await routes({
      modelMetadata: async (cwd, refresh) =>
        metadata(cwd, await availableModels(refresh)),
    });
    const nativeSession = await host.runtime.openSession(
      sessionOwner.sessionId,
    );
    nativeSession.active!.availableModels = sessionChoices;
    vi.spyOn(host.runtime, "snapshot").mockResolvedValue(nativeSession);
    const refresh = vi.spyOn(host.runtime, "refreshModels");
    const settings = (await host.read()).body;
    expect(settings.models).toEqual(available);
    expect(settings.nativeApiProviders).toContain("openai");
    expect(settings.nativeApiProviders).not.toContain("custom");
    expect(
      settings.providers.map((provider: { id: string }) => provider.id),
    ).not.toContain("openai");
    expect((await host.read(sessionOwner)).body).toMatchObject({
      models: sessionChoices,
      saved: {
        defaultModel: { provider: "fixture", id: "first" },
        enabledModels: initialSettings.enabledModels,
      },
      commonModels: [],
    });
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
        models: await availableModels(),
        providers: [expect.objectContaining({ apiKeyConfigured: false })],
        saved: { enabledModels: initialSettings.enabledModels },
      },
    });
    expect(saved.snapshot.models).not.toContainEqual(
      expect.objectContaining({ provider: "fixture" }),
    );
    const { apiKey: _key, ...provider } = initialConfig.providers.fixture;
    const editedProvider = {
      ...provider,
      baseUrl: "https://changed.invalid/v1",
    };
    expect(
      (await readJson(join(agent, "models.json"))).providers.fixture,
    ).toEqual(editedProvider);
    expect(await readFile(join(agent, "auth.json"), "utf8")).toBe("{}");
    expect(host.invalidateModels).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    await native.setRuntimeApiKey("fixture", "synthetic-not-requested");
    const declaration = (
      await host.edit(saved.snapshot.configRevision, {
        kind: "model",
        provider: "fixture",
        values: newModel,
      })
    ).body.snapshot;
    expect(declaration.saved.enabledModels).toEqual(
      initialSettings.enabledModels,
    );
    expect(
      declaration.savedCommonEntries.find(
        (entry: { pattern: string }) => entry.pattern === "fixture/*:high",
      ).models,
    ).toContainEqual({
      provider: "fixture",
      id: newModel.id,
      thinkingLevel: "high",
    });
    expect(
      (await readJson(join(agent, "models.json"))).providers.fixture,
    ).toEqual({ ...editedProvider, models: [...provider.models, newModel] });
    expect(
      (await readJson(join(agent, "settings.json"))).enabledModels,
    ).toEqual(initialSettings.enabledModels);
  }, 45_000);
  it("invalidates workspace discovery without delaying a session save or retaining stale results", async () => {
    let release!: (value: ModelMetadata) => void;
    const old = new Promise<ModelMetadata>((resolve) => {
      release = resolve;
    });
    const query = vi
      .fn()
      .mockReturnValueOnce(old)
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
    release(metadata(cwd, models));
    await inFlight;
    expect(catalog.peek(cwd)).toBeUndefined();
    expect((await catalog.read(cwd)).defaults.model?.id).toBe("first");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps file edits available when workspace and session discovery fail", async () => {
    const host = await routes();
    await host.runtime.openSession(sessionOwner.sessionId);
    const error = new Error("PRIVATE CATALOG DETAIL");
    host.modelMetadata.mockRejectedValue(error);
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
    expect(host.modelMetadata).toHaveBeenCalledExactlyOnceWith(cwd, true);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(sessionOwner.sessionId);

    const saved = (
      await host.edit(
        session.configRevision,
        {
          kind: "model",
          provider: "fixture",
          originalId: "first",
          values: { id: "first", name: "Repaired" },
        },
        sessionOwner,
      )
    ).body;
    expect(saved).toMatchObject({
      saved: true,
      snapshot: { modelsWarning: session.modelsWarning },
    });
    expect(saved.snapshot.providers[0].models[0].name).toBe("Repaired");
    expect(
      (await readJson(join(agent, "models.json"))).providers.fixture.models[0]
        .name,
    ).toBe("Repaired");
    expect(
      (await host.preferences(workspace.settingsRevision)).body,
    ).toMatchObject({
      saved: true,
      snapshot: { saved: { defaultThinkingLevel: "medium" } },
    });
    expect(
      (await readJson(join(agent, "settings.json"))).defaultThinkingLevel,
    ).toBe("medium");
  });

  it("keeps committed saves when the worker or readback retires", async () => {
    const host = await routes();
    await host.runtime.openSession(sessionOwner.sessionId);
    const before = await snapshot();
    const save = service.saveConfig.bind(service);
    vi.spyOn(service, "saveConfig").mockImplementation(async (...args) => {
      await save(...args);
      vi.spyOn(host.runtime, "sessionCwd").mockReturnValue(null);
    });
    vi.spyOn(host.runtime, "refreshModels").mockRejectedValue(
      new Error("Worker retired"),
    );
    const saved = (
      await host.edit(
        before.configRevision,
        {
          kind: "model",
          provider: "fixture",
          originalId: "first",
          values: { id: "first", name: "Committed" },
        },
        sessionOwner,
      )
    ).body;
    expect(saved.saved).toBe(true);
    expect(saved.snapshot.modelsWarning).toMatch(
      /Model availability could not load/,
    );
    expect(saved.snapshot.providers[0].models[0].name).toBe("Committed");

    vi.spyOn(service, "read").mockRejectedValue(
      new Error("Readback unavailable"),
    );
    const preferences = (
      await host.preferences(saved.snapshot.settingsRevision)
    ).body;
    expect(preferences).toEqual({
      saved: true,
      warning: expect.stringMatching(/Saved to Pi/),
    });
    expect(
      (await readJson(join(agent, "settings.json"))).defaultThinkingLevel,
    ).toBe("medium");
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
    expect((await snapshot()).saved.defaultThinkingLevel).toBe("medium");
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
    expect(before.saved).toEqual({
      defaultModel: { provider: "fixture", id: "first" },
      defaultThinkingLevel: "high",
      enabledModels: initialSettings.enabledModels,
    });
    expect(before.effective.defaultThinkingLevel).toBe("low");
    expect(before.commonModels).toEqual([{ provider: "fixture", id: "first" }]);
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
    expect(after.saved.defaultModel).toEqual({
      provider: "fixture",
      id: "second",
    });
    expect(after.saved.defaultThinkingLevel).toBe("medium");
    expect(after.effective.defaultThinkingLevel).toBe("low");
    expect(after.effective.enabledModels).toEqual(["fixture/first"]);
    await service.savePreferences(after.settingsRevision, {
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledModels: [],
    });
    const cleared = await readJson(join(agent, "settings.json"));
    expect(cleared.defaultModel).toBeUndefined();
    expect(cleared.defaultProvider).toBeUndefined();
    expect(cleared.defaultThinkingLevel).toBeUndefined();
    expect(cleared.enabledModels).toBeUndefined();
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
    expect((await snapshot()).providers[0]?.models[0]?.name).toBe(
      "Linked edit",
    );
  });

  it("reports malformed, conflicting and native-invalid declarations without publishing them", async () => {
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
    await expect(
      service.saveConfig(cwd, valid.configRevision, {
        kind: "model",
        provider: "fixture",
        values: { id: "invalid", maxTokens: -1 },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readJson(join(agent, "models.json"))).toEqual(initialConfig);
  });
});
