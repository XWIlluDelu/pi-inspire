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
import {
  type ModelMetadata,
  ModelMetadataCatalog,
} from "../../server/model-metadata.js";
import { ModelSettingsService } from "../../server/model-settings.js";
import { ProjectTrustStore } from "../../server/pi-runtime.js";
import type { ModelOption } from "../../shared/contracts.js";
import type { ModelConfigEdit } from "../../shared/model-settings.js";
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
let workspace: Awaited<ReturnType<typeof nativePiWorkspace>>;
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
  workspace = await nativePiWorkspace(
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
it("commits a session edit while an old workspace catalog query is pending", async () => {
  const previous = Promise.withResolvers<ModelMetadata>();
  const privateDetail = "PRIVATE CATALOG DETAIL";
  const catalog = new ModelMetadataCatalog(
    vi
      .fn()
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce(metadata(cwd, [models[1]!]))
      .mockRejectedValueOnce(new Error(privateDetail)),
  );
  const pending = catalog.read(cwd);
  host = await configurationHost(workspace, {
    modelSettings: service,
    modelMetadata: (cwd, refresh) => catalog.read(cwd, refresh),
    invalidateModels: () => catalog.invalidate(),
  });
  const { localRequest: http, runtime, sessionId } = host;
  const read = (query: {
    sessionId?: string;
    cwd?: string;
    refresh?: string;
  }) => http.get("/api/model-settings").query(query);
  const owner = { sessionId, cwd: root };
  const before = (await read(owner).expect(200)).body;
  const replace = {
    revision: before.configRevision,
    edit: {
      kind: "provider",
      id: "fixture",
      values: { apiKey: null },
    },
  };
  const path = join(agent, "models.json");
  const original = await readFile(path, "utf8");
  await http
    .patch("/api/model-settings/config")
    .query({ sessionId: "closed", cwd })
    .send(replace)
    .expect(409);
  expect(await readFile(path, "utf8")).toBe(original);

  const refresh = vi
    .spyOn(runtime, "refreshModels")
    .mockImplementationOnce(async (id) => {
      expect(id).toBe(sessionId);
      await runtime.close();
      throw new Error(privateDetail);
    });
  const response = await http
    .patch("/api/model-settings/config")
    .query(owner)
    .send(replace)
    .expect(200);
  expect(response.body).toMatchObject({
    saved: true,
    snapshot: {
      models: [],
      modelDiscoveryFailed: true,
      modelsWarning: expect.stringMatching(/still editable/),
      providers: [
        expect.objectContaining({ id: "fixture", apiKeyConfigured: false }),
      ],
    },
  });
  expect(JSON.stringify(response.body)).not.toContain(privateDetail);
  expect(response.body.snapshot.configRevision).not.toBe(before.configRevision);
  expect(refresh).toHaveBeenCalledExactlyOnceWith(sessionId);
  const changed = (await readJson(path)).providers.fixture;
  const { apiKey: _secret, ...remaining } = initialConfig.providers.fixture;
  expect(changed).toEqual(remaining);
  expect(await readFile(join(agent, "auth.json"), "utf8")).toBe("{}");

  previous.resolve(metadata(cwd, models));
  await pending;
  expect(catalog.peek(cwd)).toBeUndefined();
  expect((await read({ cwd }).expect(200)).body.models).toEqual([models[1]]);
  const degraded = (await read({ cwd, refresh: "1" }).expect(200)).body;
  expect(degraded).toMatchObject({
    configRevision: response.body.snapshot.configRevision,
    models: [],
    modelDiscoveryFailed: true,
    modelsWarning: response.body.snapshot.modelsWarning,
  });
  expect(JSON.stringify(degraded)).not.toContain(privateDetail);
}, 45_000);

describe("native configuration round trips", () => {
  it("keeps global preferences independent of project precedence, malformed settings and a missing workspace", async () => {
    new ProjectTrustStore(agent).set(cwd, true);
    const project = join(cwd, ".pi", "settings.json");
    await writeFile(
      project,
      '{"defaultThinkingLevel":"low","enabledModels":["fixture/first"]}',
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
    const invalid = "{broken project settings";
    await writeFile(project, invalid);
    const degraded = await snapshot();
    expect(degraded.settingsError).toBeUndefined();
    expect(degraded.projectSettingsError).toMatch(/Project settings/);
    expect(degraded.effective).toEqual(after.saved);
    await service.savePreferences(degraded.settingsRevision, {
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledModels: [],
    });
    expect(await readJson(join(agent, "settings.json"))).toEqual({
      modelThinkingLevels: initialSettings.modelThinkingLevels,
      compaction: initialSettings.compaction,
      customExtensionSetting: initialSettings.customExtensionSetting,
    });
    expect(await readFile(project, "utf8")).toBe(invalid);
    await rm(cwd, { recursive: true });
    const readback = await snapshot();
    expect(readback.saved).toEqual({
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledModels: [],
    });
    expect(readback.effective).toEqual(readback.saved);
  }, 15_000);

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

  it("edits a linked JSONC declaration without rewriting separate native preferences or secrets", async () => {
    const modelsTarget = join(root, "managed-models.json");
    const settingsPath = join(agent, "settings.json");
    const modelsPath = join(agent, "models.json");
    const settings = `\uFEFF${JSON.stringify(initialSettings)}`;
    await writeFile(settingsPath, settings);
    await writeFile(
      modelsTarget,
      `\uFEFF// Managed provider configuration\n${JSON.stringify(initialConfig)}`,
    );
    await rm(modelsPath);
    await symlink(modelsTarget, modelsPath);
    const before = await snapshot();
    expect(before.settingsError).toBeUndefined();
    expect(before.configError).toBeUndefined();
    expect(before.providers[0]).toMatchObject({ apiKeyConfigured: true });
    for (const secret of ["stored-config-secret", "never-project-this"])
      expect(JSON.stringify(before)).not.toContain(secret);
    await service.saveConfig(cwd, before.configRevision, {
      kind: "model",
      provider: "fixture",
      originalId: "first",
      values: { id: "first", name: "Linked edit" },
    });
    expect((await lstat(modelsPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(settingsPath, "utf8")).toBe(settings);
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
  }, 45_000);

  it("keeps preferences editable when declarations cannot be read and rejects duplicate models", async () => {
    const file = join(agent, "models.json");
    await writeFile(file, "{broken");
    const malformed = await snapshot();
    expect(malformed.configError).toMatch(/invalid/);
    await rm(file);
    await mkdir(file);
    const unreadable = await snapshot();
    expect(unreadable.configError).toMatch(/could not be read/);
    await service.savePreferences(unreadable.settingsRevision, {
      defaultModel: null,
    });
    await rm(file, { recursive: true });
    await writeFile(file, JSON.stringify(initialConfig));
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
    expect(await readJson(file)).toEqual(initialConfig);
  }, 45_000);
});
