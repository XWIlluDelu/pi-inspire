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
import { ModelSettingsService } from "../../server/model-settings.js";
import { registerModelSettingsRoutes } from "../../server/model-settings-routes.js";
import { ModelRuntime } from "../../server/pi-runtime.js";
import type { RuntimeLike } from "../../server/runtime.js";

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
  await rm(root, { recursive: true, force: true });
});

describe("native model settings and declarations", () => {
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
    const runtime = {
      sessionCwd: () => cwd,
      snapshot: async () => ({ active: { availableModels: sessionChoices } }),
      refreshModels: vi.fn(async () => ({ models: sessionChoices })),
    } as unknown as RuntimeLike;
    const app = express();
    app.use(express.json());
    registerModelSettingsRoutes(app, {
      runtime,
      modelSettings: service,
      availableModels,
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
    const sessionSave = await request(app)
      .patch("/api/model-settings/config?sessionId=fixture")
      .send({
        revision: saved.body.snapshot.configRevision,
        edit: {
          kind: "provider",
          id: "fixture",
          values: { apiKey: "synthetic-config-key" },
        },
      });
    expect(sessionSave.status).toBe(200);
    expect(runtime.refreshModels).toHaveBeenCalledWith("fixture");
    expect(sessionSave.body.snapshot.models).toEqual(sessionChoices);
    expect(
      (await availableModels()).some((model) => model.provider === "fixture"),
    ).toBe(true);
    const declaration = await request(app)
      .patch("/api/model-settings/config")
      .query({ cwd })
      .send({
        revision: sessionSave.body.snapshot.configRevision,
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
      JSON.parse(await readFile(join(agent, "settings.json"), "utf8"))
        .enabledModels,
    ).toEqual(initialSettings.enabledModels);
  });
  it("keeps saved defaults distinct from project precedence, per-model thinking and ordered native patterns", async () => {
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        defaultThinkingLevel: "low",
        enabledModels: ["fixture/first"],
      }),
    );
    const before = await service.read(cwd, models);
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
    const settings = JSON.parse(
      await readFile(join(agent, "settings.json"), "utf8"),
    );
    expect(settings).toEqual({
      ...initialSettings,
      defaultModel: "second",
      defaultThinkingLevel: "medium",
      enabledModels: ["fixture/first", "fixture/second", "*sonnet*:high"],
    });
    const after = await service.read(cwd, models);
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
    const cleared = JSON.parse(
      await readFile(join(agent, "settings.json"), "utf8"),
    );
    expect(cleared.defaultModel).toBeUndefined();
    expect(cleared.defaultProvider).toBeUndefined();
    expect(cleared.defaultThinkingLevel).toBeUndefined();
    expect(cleared.enabledModels).toBeUndefined();
    expect(cleared.modelThinkingLevels).toEqual(
      initialSettings.modelThinkingLevels,
    );
    const readback = await service.read(cwd, models);
    expect(readback.saved.defaultModel).toBeNull();
    expect(readback.saved.defaultThinkingLevel).toBeNull();
    expect(readback.effective.defaultThinkingLevel).toBe("low");
  });

  it("preserves advanced declarations and secrets while adding, editing and removing graphical fields", async () => {
    const before = await service.read(cwd, models);
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
    const edited = JSON.parse(
      await readFile(join(agent, "models.json"), "utf8"),
    );
    expect(edited.providers.fixture).toEqual({
      ...initialConfig.providers.fixture,
      models: [
        { ...initialConfig.providers.fixture.models[0], name: "Edited" },
      ],
    });
    let snapshot = await service.read(cwd, models);
    await service.saveConfig(snapshot.configRevision, {
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
    snapshot = await service.read(cwd, models);
    await service.saveConfig(snapshot.configRevision, {
      kind: "provider",
      id: "fixture",
      values: { baseUrl: "https://changed.invalid/v1" },
    });
    snapshot = await service.read(cwd, models);
    await service.saveConfig(snapshot.configRevision, {
      kind: "remove-model",
      provider: "fixture",
      id: "new-model",
    });
    snapshot = await service.read(cwd, models);
    await service.saveConfig(snapshot.configRevision, {
      kind: "provider",
      id: "fixture",
      values: { apiKey: null },
    });
    const final = JSON.parse(
      await readFile(join(agent, "models.json"), "utf8"),
    );
    expect(final.providers.fixture.apiKey).toBeUndefined();
    expect(final.providers.fixture.headers).toEqual(
      initialConfig.providers.fixture.headers,
    );
    expect(final.providers.fixture.modelOverrides).toEqual(
      initialConfig.providers.fixture.modelOverrides,
    );
    expect(final.providers.fixture.models).toHaveLength(1);
    expect(await readFile(join(agent, "auth.json"), "utf8")).toBe("{}");
    snapshot = await service.read(cwd, models);
    await service.saveConfig(snapshot.configRevision, {
      kind: "remove-provider",
      id: "fixture",
    });
    expect(
      JSON.parse(await readFile(join(agent, "models.json"), "utf8")),
    ).toEqual({ providers: {} });
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
    const before = await service.read(cwd, models);
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
    expect(JSON.parse(await readFile(settingsTarget, "utf8"))).toEqual({
      ...initialSettings,
      defaultThinkingLevel: "medium",
    });
    const linked = JSON.parse(await readFile(modelsTarget, "utf8"));
    expect(linked.providers.fixture.models[0]).toEqual({
      ...initialConfig.providers.fixture.models[0],
      name: "Linked edit",
    });
    expect(linked.providers.fixture.headers).toEqual(
      initialConfig.providers.fixture.headers,
    );
    const saved = await service.read(cwd, models);
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

  it("recovers abandoned native-compatible locks and returns committed saves after optional worker reads retire", async () => {
    const lock = join(agent, "models.json.lock");
    await mkdir(lock);
    const old = new Date(Date.now() - 20_000);
    await utimes(lock, old, old);
    let before = await service.read(cwd, models);
    await service.saveConfig(before.configRevision, {
      kind: "model",
      provider: "fixture",
      originalId: "first",
      values: { id: "first", name: "Recovered" },
    });
    expect(
      JSON.parse(await readFile(join(agent, "models.json"), "utf8")).providers
        .fixture.models[0].name,
    ).toBe("Recovered");
    let live = true;
    const runtime = {
      sessionCwd: () => (live ? cwd : null),
      snapshot: async () => {
        if (!live) throw new Error("Worker retired");
        return { active: { availableModels: models } };
      },
      refreshModels: async () => {
        throw new Error("Worker retired");
      },
    } as unknown as RuntimeLike;
    const saveConfig = service.saveConfig.bind(service);
    vi.spyOn(service, "saveConfig").mockImplementation(async (...args) => {
      await saveConfig(...args);
      live = false;
    });
    const app = express();
    app.use(express.json());
    registerModelSettingsRoutes(app, {
      runtime,
      modelSettings: service,
      availableModels: async () => [],
    });
    app.use(
      (
        error: Error & { status?: number },
        _request: express.Request,
        response: express.Response,
        _next: express.NextFunction,
      ) => response.status(error.status ?? 500).json({ error: error.message }),
    );
    before = await service.read(cwd, models);
    const saved = await request(app)
      .patch("/api/model-settings/config?sessionId=retiring-session")
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
    live = true;
    const savePreferences = service.savePreferences.bind(service);
    vi.spyOn(service, "savePreferences").mockImplementation(async (...args) => {
      await savePreferences(...args);
      live = false;
    });
    before = await service.read(cwd, models);
    const preferences = await request(app)
      .patch("/api/model-settings?sessionId=retiring-session")
      .send({
        revision: before.settingsRevision,
        patch: { defaultThinkingLevel: "medium" },
      });
    expect(preferences.status).toBe(200);
    expect(preferences.body.saved).toBe(true);
    expect(preferences.body.snapshot.saved.defaultThinkingLevel).toBe("medium");
  });

  it("refuses stale, malformed and native-invalid writes instead of replacing existing data", async () => {
    const before = await service.read(cwd, models);
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
    const malformed = await service.read(cwd, models);
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
    const valid = await service.read(cwd, models);
    await expect(
      service.saveConfig(valid.configRevision, {
        kind: "model",
        provider: "fixture",
        values: { id: "invalid", maxTokens: -1 },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      JSON.parse(await readFile(join(agent, "models.json"), "utf8")),
    ).toEqual(initialConfig);
  });
});
