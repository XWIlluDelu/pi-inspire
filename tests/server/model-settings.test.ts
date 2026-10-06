import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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
import type { RuntimeLike } from "../../server/runtime.js";
import type { ModelOption } from "../../shared/contracts.js";
import type { ModelConfigEdit } from "../../shared/model-settings.js";

let root: string;
let agent: string;
let cwd: string;
let service: ModelSettingsService;
const models = [
  { provider: "fixture", id: "second", name: "Second", reasoning: true },
  { provider: "fixture", id: "first", name: "First", reasoning: true },
];
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
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inspire-model-settings-"));
  agent = join(root, "agent");
  cwd = join(root, "workspace");
  await Promise.all([
    mkdir(agent),
    mkdir(join(cwd, ".pi"), { recursive: true }),
  ]);
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify(initialSettings),
  );
  await writeFile(join(agent, "models.json"), JSON.stringify(initialConfig));
  await writeFile(join(agent, "auth.json"), "{}");
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(root, "sessions"));
  vi.stubEnv("PI_OFFLINE", "1");
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
  await service.saveConfig((await snapshot()).configRevision, edit);
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
  const availableModels = vi.fn(async () => models);
  const invalidateModels = vi.fn();
  const app = express();
  app.use(express.json());
  registerModelSettingsRoutes(app, {
    runtime: runtime as unknown as RuntimeLike,
    modelSettings: service,
    availableModels,
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
  return { app, runtime, availableModels, invalidateModels };
}

describe("model settings routes", () => {
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
    const { app, runtime, invalidateModels } = routes({ availableModels });
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
        edit: { kind: "provider", id: "fixture", values: { apiKey: null } },
      });
    expect(saved.status).toBe(200);
    expect(saved.body.saved).toBe(true);
    expect(
      saved.body.snapshot.models.some(
        (model: { provider: string }) => model.provider === "fixture",
      ),
    ).toBe(false);
    expect(saved.body.snapshot.models).toEqual(await availableModels());
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
          values: { id: "later-model", name: "Later available model" },
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
      id: "later-model",
      thinkingLevel: "high",
    });
    expect(
      (await readJson(join(agent, "settings.json"))).enabledModels,
    ).toEqual(initialSettings.enabledModels);
  });
  it("invalidates workspace discovery without delaying a session save or retaining stale results", async () => {
    const metadata = (items: typeof models): ModelMetadata => ({
      models: items,
      virtualModels: [],
      defaults: { cwd, model: items[0]!, thinkingLevel: "high" },
    });
    let release!: (value: ModelMetadata) => void;
    const old = new Promise<ModelMetadata>((resolve) => {
      release = resolve;
    });
    const query = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValue(metadata([models[1]!]));
    const catalog = new ModelMetadataCatalog(query);
    const inFlight = catalog.read(cwd);
    const availableModels = vi.fn(
      async (refresh?: boolean, target?: string) =>
        (await catalog.read(target!, refresh)).models,
    );
    const { app, runtime } = routes({
      availableModels,
      invalidateModels: () => catalog.invalidate(),
    });
    const before = await snapshot();
    const read = vi.spyOn(service, "read");
    const response = await request(app)
      .patch("/api/model-settings/config?sessionId=fixture")
      .send({
        revision: before.configRevision,
        edit: { kind: "provider", id: "fixture", values: { apiKey: null } },
      });
    expect(response.status).toBe(200);
    expect(response.body.snapshot.models).toEqual(models);
    expect(runtime.refreshModels).toHaveBeenCalledWith("fixture");
    expect(runtime.snapshot).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(availableModels).not.toHaveBeenCalled();
    expect(catalog.peek(cwd)).toBeUndefined();
    release(metadata(models));
    await inFlight;
    expect(catalog.peek(cwd)).toBeUndefined();
    expect((await catalog.read(cwd)).defaults.model?.id).toBe("first");
    expect(query).toHaveBeenCalledTimes(2);
  });

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
    expect(saved.body.warning).toMatch(/Configuration saved/);
    expect(saved.body.snapshot.providers[0].models[0].name).toBe("Committed");
    expect(runtime.sessionCwd).toHaveBeenCalledOnce();

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

  it("preserves advanced declarations and secrets while adding, editing and removing graphical fields", async () => {
    const before = await snapshot();
    expect(before.commonModels).toEqual([
      { provider: "fixture", id: "second" },
      { provider: "fixture", id: "first", thinkingLevel: "high" },
    ]);
    expect(JSON.stringify(before)).not.toContain("stored-config-secret");
    expect(JSON.stringify(before)).not.toContain("never-project-this");
    expect(before.providers[0]?.apiKeyConfigured).toBe(true);
    expect(before.providers[0]?.advancedFields).toEqual([
      "headers",
      "modelOverrides",
    ]);
    await service.saveConfig(before.configRevision, {
      kind: "model",
      provider: "fixture",
      originalId: "first",
      values: { id: "first", name: "Edited" },
    });
    const edited = await readJson(join(agent, "models.json"));
    expect(edited.providers.fixture).toEqual({
      ...initialConfig.providers.fixture,
      models: [
        { ...initialConfig.providers.fixture.models[0], name: "Edited" },
      ],
    });
    await editConfig({
      kind: "model",
      provider: "fixture",
      values: {
        id: "new-model",
        reasoning: false,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 128,
      },
    });
    await editConfig({
      kind: "provider",
      id: "fixture",
      values: { baseUrl: "https://changed.invalid/v1" },
    });
    await editConfig({
      kind: "remove-model",
      provider: "fixture",
      id: "new-model",
    });
    await editConfig({
      kind: "provider",
      id: "fixture",
      values: { apiKey: null },
    });
    const { apiKey: _key, ...provider } = edited.providers.fixture;
    expect(
      (await readJson(join(agent, "models.json"))).providers.fixture,
    ).toEqual({
      ...provider,
      baseUrl: "https://changed.invalid/v1",
    });
    expect(await readFile(join(agent, "auth.json"), "utf8")).toBe("{}");
    await editConfig({ kind: "remove-provider", id: "fixture" });
    expect(await readJson(join(agent, "models.json"))).toEqual({
      providers: {},
    });
  });

  it("edits symlink targets and accepts native models comments/settings BOM without losing fields", async () => {
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
    await service.savePreferences(before.settingsRevision, {
      defaultThinkingLevel: "medium",
    });
    await service.saveConfig(before.configRevision, {
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
    const linked = await readJson(modelsTarget);
    expect(linked.providers.fixture.models[0]).toEqual({
      ...initialConfig.providers.fixture.models[0],
      name: "Linked edit",
    });
    expect(linked.providers.fixture.headers).toEqual(
      initialConfig.providers.fixture.headers,
    );
    const saved = await snapshot();
    const external = JSON.stringify({
      ...initialSettings,
      defaultThinkingLevel: "low",
    });
    await writeFile(settingsTarget, external);
    await expect(
      service.savePreferences(saved.settingsRevision, {
        defaultThinkingLevel: "high",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(settingsTarget, "utf8")).toBe(external);
  });

  it("recovers an abandoned native-compatible lock", async () => {
    const lock = join(agent, "models.json.lock");
    await mkdir(lock);
    const old = new Date(Date.now() - 20_000);
    await utimes(lock, old, old);
    await editConfig({
      kind: "model",
      provider: "fixture",
      originalId: "first",
      values: { id: "first", name: "Recovered" },
    });
    expect(
      (await readJson(join(agent, "models.json"))).providers.fixture.models[0]
        .name,
    ).toBe("Recovered");
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
      service.saveConfig(malformed.configRevision, {
        kind: "provider",
        id: "new",
        values: {},
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(agent, "models.json"), "utf8")).toBe("{broken");
    await writeFile(join(agent, "models.json"), JSON.stringify(initialConfig));
    const valid = await snapshot();
    await expect(
      service.saveConfig(valid.configRevision, {
        kind: "model",
        provider: "fixture",
        values: { id: "invalid", maxTokens: -1 },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readJson(join(agent, "models.json"))).toEqual(initialConfig);
  });
});
