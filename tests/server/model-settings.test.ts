import {
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelOption } from "../../server/model-catalog.js";
import {
  type ModelMetadata,
  ModelMetadataCatalog,
} from "../../server/model-metadata.js";
import { ModelSettingsService } from "../../server/model-settings.js";
import { registerModelSettingsRoutes } from "../../server/model-settings-routes.js";
import { ModelRuntime, ProjectTrustStore } from "../../server/pi-runtime.js";
import { ProviderAuthService } from "../../server/provider-auth.js";
import type { ModelOption } from "../../shared/contracts.js";
import type { ModelConfigEdit } from "../../shared/model-settings.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";

let root: string;
let agent: string;
let cwd: string;
let service: ModelSettingsService;
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
function routes(
  overrides: Partial<Parameters<typeof registerModelSettingsRoutes>[1]> = {},
) {
  const runtime = {
    sessionCwd: vi.fn((): string | null => cwd),
    snapshot: vi.fn(async () => ({
      active: { availableModels: models as ModelOption[] },
    })),
    refreshModels: vi.fn(async () => ({ models: models as ModelOption[] })),
  };
  const modelMetadata = vi.fn(async (cwd: string) => metadata(cwd, models));
  const invalidateModels = vi.fn();
  const app = express();
  app.use(express.json());
  registerModelSettingsRoutes(app, {
    runtime: runtime as unknown as Parameters<
      typeof registerModelSettingsRoutes
    >[1]["runtime"],
    modelSettings: service,
    modelMetadata,
    invalidateModels,
    ...overrides,
  });
  app.use(
    (
      error: Error & { status?: number },
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => response.status(error.status ?? 500).json({ error: error.message }),
  );
  return { app, runtime, modelMetadata, invalidateModels };
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
    const { app } = routes({ providerAuth: discovery });
    const admissionApp = routes({ providerAuth: admission }).app;
    const provider = "new-provider";
    try {
      // The readers predate the edit and each operation must discover it on its own.
      for (const edit of [
        {
          kind: "provider",
          id: provider,
          values: {
            api: "openai-completions",
            baseUrl: "https://example.invalid/v1",
          },
        },
        { kind: "model", provider, values: { id: "new-model" } },
      ]) {
        const current = await request(app)
          .get("/api/model-settings")
          .query({ cwd })
          .expect(200);
        const saved = await request(app)
          .patch("/api/model-settings/config")
          .query({ cwd })
          .send({ revision: current.body.configRevision, edit })
          .expect(200);
        expect(saved.body.saved).toBe(true);
      }
      const listed = await request(app)
        .post("/api/provider-auth")
        .query({ cwd })
        .send({ operation: "providers" })
        .expect(200);
      expect(listed.body.result).toContainEqual({
        id: provider,
        name: provider,
        stored: null,
        methods: [{ type: "api_key", label: "API key" }],
      });
      const started = await request(admissionApp)
        .post("/api/provider-auth")
        .query({ cwd })
        .send({ operation: "start", provider, type: "api_key" })
        .expect(200);
      expect(started.body.result).toMatchObject({
        provider,
        type: "api_key",
        status: "pending",
      });
      await vi.waitFor(() =>
        expect(admission.snapshot(started.body.result.id).prompt?.type).toBe(
          "secret",
        ),
      );
    } finally {
      discovery.close();
      admission.close();
    }
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
    const { app, runtime, invalidateModels } = routes({
      modelMetadata: async (cwd, refresh) =>
        metadata(cwd, await availableModels(refresh)),
    });
    runtime.snapshot.mockResolvedValue({
      active: { availableModels: sessionChoices },
    });
    const host = await request(app).get("/api/model-settings").query({ cwd });
    expect(host.status).toBe(200);
    expect(host.body.models).toEqual(available);
    expect(host.body.nativeApiProviders).toContain("openai");
    expect(host.body.nativeApiProviders).not.toContain("custom");
    expect(
      host.body.providers.map((provider: { id: string }) => provider.id),
    ).not.toContain("openai");
    const session = await request(app).get(
      "/api/model-settings?sessionId=fixture",
    );
    expect(session.body.models).toEqual(sessionChoices);
    expect(session.body.saved.defaultModel).toEqual({
      provider: "fixture",
      id: "first",
    });
    expect(session.body.saved.enabledModels).toEqual(
      initialSettings.enabledModels,
    );
    expect(session.body.commonModels).toEqual([]);
    const saved = await request(app)
      .patch("/api/model-settings/config")
      .query({ cwd })
      .send({
        revision: host.body.configRevision,
        edit: {
          kind: "provider",
          id: "fixture",
          values: { apiKey: null, baseUrl: "https://changed.invalid/v1" },
        },
      });
    expect(saved.status).toBe(200);
    expect(saved.body.saved).toBe(true);
    expect(
      saved.body.snapshot.models.some(
        (model: { provider: string }) => model.provider === "fixture",
      ),
    ).toBe(false);
    expect(saved.body.snapshot.models).toEqual(await availableModels());
    const { apiKey: _key, ...provider } = initialConfig.providers.fixture;
    const editedProvider = {
      ...provider,
      baseUrl: "https://changed.invalid/v1",
    };
    expect(
      (await readJson(join(agent, "models.json"))).providers.fixture,
    ).toEqual(editedProvider);
    expect(await readFile(join(agent, "auth.json"), "utf8")).toBe("{}");
    expect(saved.body.snapshot.providers[0].apiKeyConfigured).toBe(false);
    expect(saved.body.snapshot.saved.enabledModels).toEqual(
      initialSettings.enabledModels,
    );
    expect(invalidateModels).toHaveBeenCalledOnce();
    expect(runtime.refreshModels).not.toHaveBeenCalled();
    await native.setRuntimeApiKey("fixture", "synthetic-not-requested");
    const declaration = await request(app)
      .patch("/api/model-settings/config")
      .query({ cwd })
      .send({
        revision: saved.body.snapshot.configRevision,
        edit: {
          kind: "model",
          provider: "fixture",
          values: newModel,
        },
      });
    expect(declaration.status).toBe(200);
    expect(declaration.body.snapshot.saved.enabledModels).toEqual(
      initialSettings.enabledModels,
    );
    expect(
      declaration.body.snapshot.savedCommonEntries.find(
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
    const { app, runtime } = routes({
      modelMetadata,
      invalidateModels: () => catalog.invalidate(),
    });
    const before = await snapshot();
    const response = await request(app)
      .patch("/api/model-settings/config?sessionId=fixture")
      .send({
        revision: before.configRevision,
        edit: { kind: "provider", id: "fixture", values: { apiKey: null } },
      });
    expect(response.status).toBe(200);
    expect(response.body.snapshot.models).toEqual(models);
    expect(runtime.refreshModels).toHaveBeenCalledWith("fixture");
    expect(modelMetadata).not.toHaveBeenCalled();
    expect(catalog.peek(cwd)).toBeUndefined();
    release(metadata(cwd, models));
    await inFlight;
    expect(catalog.peek(cwd)).toBeUndefined();
    expect((await catalog.read(cwd)).defaults.model?.id).toBe("first");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(["workspace", "session"])(
    "keeps file edits available when the %s model catalog fails",
    async (target) => {
      const { app, runtime, modelMetadata } = routes();
      const error = new Error("PRIVATE CATALOG DETAIL");
      modelMetadata.mockRejectedValue(error);
      runtime.snapshot.mockRejectedValue(error);
      runtime.refreshModels.mockRejectedValue(error);
      const owner = target === "session" ? { sessionId: "fixture" } : { cwd };
      const before = await request(app)
        .get("/api/model-settings")
        .query(owner)
        .expect(200);
      expect(before.body.models).toEqual([]);
      expect(before.body.providers).toContainEqual(
        expect.objectContaining({ id: "fixture" }),
      );
      expect(before.body.modelsWarning).toMatch(
        /Saved configuration is still editable/,
      );
      expect(JSON.stringify(before.body)).not.toContain(
        "PRIVATE CATALOG DETAIL",
      );
      const saved = await request(app)
        .patch("/api/model-settings/config")
        .query(owner)
        .send({
          revision: before.body.configRevision,
          edit: {
            kind: "model",
            provider: "fixture",
            originalId: "first",
            values: { id: "first", name: "Repaired" },
          },
        })
        .expect(200);
      expect(saved.body.saved).toBe(true);
      expect(saved.body.snapshot.providers[0].models[0].name).toBe("Repaired");
      expect(saved.body.snapshot.modelsWarning).toBe(before.body.modelsWarning);
      const preferences = await request(app)
        .patch("/api/model-settings")
        .query(owner)
        .send({
          revision: saved.body.snapshot.settingsRevision,
          patch: { defaultThinkingLevel: "medium" },
        })
        .expect(200);
      expect(preferences.body.saved).toBe(true);
      expect(preferences.body.snapshot.saved.defaultThinkingLevel).toBe(
        "medium",
      );
      expect(
        (await readJson(join(agent, "models.json"))).providers.fixture.models[0]
          .name,
      ).toBe("Repaired");
      expect(
        (await readJson(join(agent, "settings.json"))).defaultThinkingLevel,
      ).toBe("medium");
    },
  );

  it("keeps committed saves when the worker or readback retires", async () => {
    const { app, runtime } = routes();
    const before = await snapshot();
    const save = service.saveConfig.bind(service);
    vi.spyOn(service, "saveConfig").mockImplementation(async (...args) => {
      await save(...args);
      runtime.sessionCwd.mockReturnValue(null);
      runtime.snapshot.mockRejectedValue(new Error("Worker retired"));
    });
    runtime.refreshModels.mockRejectedValue(new Error("Worker retired"));
    const saved = await request(app)
      .patch("/api/model-settings/config?sessionId=fixture")
      .send({
        revision: before.configRevision,
        edit: {
          kind: "model",
          provider: "fixture",
          originalId: "first",
          values: { id: "first", name: "Committed" },
        },
      });
    expect(saved.status).toBe(200);
    expect(saved.body.saved).toBe(true);
    expect(saved.body.snapshot.modelsWarning).toMatch(
      /Model availability could not load/,
    );
    expect(saved.body.snapshot.providers[0].models[0].name).toBe("Committed");

    const after = await snapshot();
    vi.spyOn(service, "read").mockRejectedValue(
      new Error("Readback unavailable"),
    );
    const preferences = await request(app)
      .patch("/api/model-settings")
      .query({ cwd })
      .send({
        revision: after.settingsRevision,
        patch: { defaultThinkingLevel: "medium" },
      });
    expect(preferences.status).toBe(200);
    expect(preferences.body.saved).toBe(true);
    expect(preferences.body.snapshot).toBeUndefined();
    expect(preferences.body.warning).toMatch(/Saved to Pi/);
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
    expect(before.providers[0]).toMatchObject({
      apiKeyConfigured: true,
      advancedFields: ["headers", "modelOverrides"],
    });
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

  it("refuses stale, malformed and native-invalid writes instead of replacing existing data", async () => {
    const before = await snapshot();
    const external = JSON.stringify({
      ...initialSettings,
      defaultThinkingLevel: "max",
      newExternalField: 1,
    });
    await writeFile(join(agent, "settings.json"), external);
    await expect(
      service.savePreferences(before.settingsRevision, {
        defaultThinkingLevel: "low",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(agent, "settings.json"), "utf8")).toBe(external);
    await writeFile(join(agent, "models.json"), "{broken");
    const malformed = await snapshot();
    expect(malformed.configError).toMatch(/invalid/);
    await expect(
      service.saveConfig(cwd, malformed.configRevision, {
        kind: "provider",
        id: "new",
        values: {},
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(agent, "models.json"), "utf8")).toBe("{broken");
    await writeFile(join(agent, "models.json"), JSON.stringify(initialConfig));
    const valid = await snapshot();
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
