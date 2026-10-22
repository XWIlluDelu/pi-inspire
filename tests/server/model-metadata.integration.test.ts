import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app.js";
import { AttachmentStore } from "../../server/attachments.js";
import { MockCatalog, MockRuntime } from "../../server/mock.js";
import {
  ModelMetadataCatalog,
  queryModelMetadata,
} from "../../server/model-metadata.js";
import { ModelSettingsService } from "../../server/model-settings.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import { modelWorkflowFixture } from "./fixtures/model-workflow.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("discovers native global/trusted-project registrations and resolves defaults over the same target without a session or model request", async () => {
  const f = await modelWorkflowFixture();
  roots.push(f.root);
  const catalog = new ModelMetadataCatalog();
  const attachments = new AttachmentStore(join(f.root, "uploads"));
  const available = vi.fn(
    async (refresh?: boolean, cwd?: string) =>
      (await catalog.read(cwd ?? f.untrusted, refresh)).models,
  );
  const app = createInspireServer({
    token: "fixture",
    runtime: new MockRuntime(),
    catalog: new MockCatalog(),
    attachments,
    preferences: new PreferencesStore(join(f.root, "preferences.json")),
    resources: new ResourceStore(),
    git: {
      status: async () => ({ kind: "not-repository" }),
      diff: async () => {
        throw new Error("unused");
      },
    },
    version: "fixture",
    piVersion: "1.0.0",
    mock: true,
    modelMetadata: (cwd, refresh) => catalog.read(cwd, refresh),
    availableModels: available,

    modelSettings: new ModelSettingsService(f.agent),
    invalidateModels: () => catalog.invalidate(),
  });
  try {
    const [trusted, untrusted] = await Promise.all([
      catalog.read(f.trusted),
      catalog.read(f.untrusted),
    ]);
    const identities = (value: typeof trusted) =>
      value.models.map((model) => `${model.provider}/${model.id}`);
    for (const value of [trusted, untrusted])
      expect(identities(value)).toEqual(
        expect.arrayContaining([
          "global-native/a",
          "global-legacy/legacy",
          "global-router/auto",
        ]),
      );
    expect(identities(trusted)).toEqual(
      expect.arrayContaining([
        "project-native/a",
        "project-legacy/legacy",
        "project-router/auto",
      ]),
    );
    expect(
      untrusted.models.some((model) => model.provider.startsWith("project-")),
    ).toBe(false);
    expect(trusted.defaults).toMatchObject({
      cwd: f.trusted,
      model: { provider: "project-router", id: "auto", virtual: true },
      thinkingLevel: "low",
    });
    expect(untrusted.defaults).toMatchObject({
      model: { provider: "global-router", id: "auto", virtual: true },
      thinkingLevel: "high",
    });
    expect(untrusted.warning).toContain("not trusted");
    const router = trusted.models.find(
      (model) => model.provider === "project-router",
    )!;
    expect(router.thinkingLevelMap).toMatchObject({
      off: null,
      low: "low",
      medium: null,
      high: "high",
      max: null,
    });
    expect(Object.keys(router).sort()).toEqual([
      "id",
      "name",
      "provider",
      "reasoning",
      "thinkingLevelMap",
      "virtual",
    ]);
    const endpoint = request(app.app);
    const models = await endpoint
      .get("/api/models")
      .query({ cwd: f.trusted })
      .auth("fixture", { type: "bearer" })
      .expect(200);
    expect(models.body.defaults.model.provider).toBe("project-router");
    expect(models.body.virtualModels).toBeUndefined();
    const settings = await endpoint
      .get("/api/model-settings")
      .query({ cwd: f.trusted })
      .auth("fixture", { type: "bearer" })
      .expect(200);
    expect(settings.body.models).toEqual(models.body.models);
    const untrustedSettings = await endpoint
      .get("/api/model-settings")
      .query({ cwd: f.untrusted })
      .auth("fixture", { type: "bearer" })
      .expect(200);
    expect(untrustedSettings.body.effective.defaultModel.provider).toBe(
      "global-router",
    );
    expect(untrustedSettings.body.projectOverrides).toEqual([]);
    expect(await readdir(f.sessions)).toEqual([]);
    expect(await readFile(f.events, "utf8")).not.toMatch(
      /session_start|agent_start|request|route/,
    );

    // External global and project changes refresh all cwd-scoped results, not
    // only the available list while leaving startup defaults on an old snapshot.
    await writeFile(
      join(f.trusted, ".pi/settings.json"),
      JSON.stringify({
        defaultProvider: "project-native",
        defaultModel: "b",
        defaultThinkingLevel: "high",
      }),
    );
    const refreshed = await endpoint
      .get("/api/models")
      .query({ cwd: f.trusted })
      .auth("fixture", { type: "bearer" })
      .expect(200);
    expect(refreshed.body.defaults).toMatchObject({
      model: { provider: "project-native", id: "b" },
      thinkingLevel: "high",
    });
    const nativeDefault = await endpoint
      .get("/api/models")
      .query({ cwd: f.untrusted })
      .auth("fixture", { type: "bearer" })
      .expect(200);
    expect(nativeDefault.body.warning).toContain("not trusted");

    // Parent saved trust applies to a nested prospective cwd.
    const nested = join(f.trusted, "nested");
    await mkdir(join(nested, ".pi"), { recursive: true });
    await writeFile(
      join(nested, ".pi/settings.json"),
      JSON.stringify({ defaultProvider: "global-native", defaultModel: "b" }),
    );
    expect((await catalog.read(nested)).defaults.model?.id).toBe("b");

    // A broken unrelated factory does not hide the models Pi can still load.
    const broken = join(f.agent, "broken.ts");
    await writeFile(
      broken,
      'export default () => { throw new Error("PRIVATE EXTENSION DETAIL"); };',
    );
    const settingsPath = join(f.agent, "settings.json");
    const settingsState = JSON.parse(await readFile(settingsPath, "utf8"));
    await writeFile(
      settingsPath,
      JSON.stringify({
        ...settingsState,
        extensions: [...settingsState.extensions, broken],
      }),
    );
    catalog.invalidate();
    available.mockClear();
    available.mockImplementation(() => new Promise(() => {}));
    const bootstrap = await endpoint
      .get("/api/bootstrap")
      .auth("fixture", { type: "bearer" })
      .expect(200);
    expect(bootstrap.body).toMatchObject({
      availableModels: [],
      snapshot: { runState: "idle" },
    });
    expect(available).not.toHaveBeenCalled();
    const partial = await endpoint
      .get("/api/models")
      .query({ cwd: f.trusted })
      .auth("fixture", { type: "bearer" })
      .expect(200);
    expect(partial.body.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "global-native", id: "a" }),
        expect.objectContaining({ provider: "project-native", id: "a" }),
      ]),
    );
    expect(partial.body.defaults.model.provider).toBe("project-native");
    expect(partial.body.warning).toContain("Some Pi extensions could not load");
    expect(JSON.stringify(partial.body)).not.toContain(
      "PRIVATE EXTENSION DETAIL",
    );
    available.mockImplementation(
      async (refresh, cwd) =>
        (await catalog.read(cwd ?? f.untrusted, refresh)).models,
    );
    const current = await endpoint
      .get("/api/model-settings")
      .query({ cwd: f.trusted })
      .auth("fixture", { type: "bearer" })
      .expect(200);
    const saved = await endpoint
      .patch("/api/model-settings/config")
      .query({ cwd: f.trusted })
      .auth("fixture", { type: "bearer" })
      .send({
        revision: current.body.configRevision,
        edit: {
          kind: "model",
          provider: "global-native",
          values: { id: "a", name: "Still editable" },
        },
      })
      .expect(200);
    expect(saved.body.saved).toBe(true);
    expect(saved.body.snapshot.providers).toContainEqual(
      expect.objectContaining({
        id: "global-native",
        models: [expect.objectContaining({ id: "a", name: "Still editable" })],
      }),
    );
    expect(await readdir(f.sessions)).toEqual([]);
    expect(await readFile(f.events, "utf8")).not.toMatch(
      /session_start|agent_start|request|route/,
    );
  } finally {
    await app.close();
    await attachments.close();
  }
  // This scenario performs several independently bounded (15s) native queries,
  // including invalidation and cold startup in multiple project directories.
}, 120_000);

it("validates model edits over extension providers in the selected trusted workspace and explicit agent directory", async () => {
  const f = await modelWorkflowFixture();
  roots.push(f.root);
  const service = new ModelSettingsService(f.agent);
  const path = join(f.agent, "models.json");
  await writeFile(
    path,
    JSON.stringify({
      providers: {
        "global-native": { models: [{ id: "a", name: "Native override" }] },
        "global-legacy": {
          modelOverrides: { legacy: { name: "Legacy override" } },
        },
        "project-native": { models: [{ id: "a", name: "Project override" }] },
      },
    }),
  );
  // An explicit configuration authority must not inherit a different Host agent dir.
  vi.stubEnv("PI_CODING_AGENT_DIR", join(f.root, "other-agent"));
  const revision = async () =>
    (await service.read(f.trusted, [])).configRevision;
  await service.saveConfig(f.trusted, await revision(), {
    kind: "provider",
    id: "anthropic",
    values: { baseUrl: "https://proxy.example.invalid" },
  });
  await service.saveConfig(f.trusted, await revision(), {
    kind: "model",
    provider: "global-native",
    originalId: "a",
    values: { id: "a", name: "Edited native model" },
  });
  const saved = await readFile(path, "utf8");
  expect(JSON.parse(saved).providers["global-native"].models).toEqual([
    { id: "a", name: "Edited native model" },
  ]);
  await expect(
    service.saveConfig(f.untrusted, await revision(), {
      kind: "provider",
      id: "anthropic",
      values: { baseUrl: "https://other.example.invalid" },
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(await readFile(path, "utf8")).toBe(saved);
  vi.stubEnv("PI_CODING_AGENT_DIR", f.agent);
  const metadata = await queryModelMetadata(f.trusted);
  expect(metadata.models).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: "global-native",
        id: "a",
        name: "Edited native model",
      }),
      expect.objectContaining({ provider: "global-legacy", id: "legacy" }),
      expect.objectContaining({
        provider: "project-native",
        id: "a",
        name: "Project override",
      }),
    ]),
  );
  expect(await readdir(f.sessions)).toEqual([]);
  expect(await readFile(f.events, "utf8")).not.toMatch(
    /session_start|agent_start|request|route/,
  );
}, 30_000);

it.each([false, true])(
  "retires factory descendants after discovery (factory throws=%s)",
  async (fail) => {
    const f = await modelWorkflowFixture();
    roots.push(f.root);
    const extension = join(f.agent, "descendant.ts");
    const pidFile = join(f.root, "descendant.pid");
    await writeFile(
      extension,
      `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
    export default () => { const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"});
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); ${fail ? 'throw new Error("fixture failure")' : ""} };`,
    );
    await writeFile(
      join(f.agent, "settings.json"),
      JSON.stringify({ extensions: [extension], defaultProjectTrust: "never" }),
    );
    let pid: number | undefined;
    try {
      const metadata = await queryModelMetadata(f.untrusted);
      if (fail)
        expect(metadata.warning).toContain("Some Pi extensions could not load");
      pid = Number(await readFile(pidFile, "utf8"));
      await vi.waitFor(async () => {
        try {
          process.kill(pid!, 0);
          if (process.platform === "linux")
            expect(await readFile(`/proc/${pid}/stat`, "utf8")).toMatch(
              /\) Z /,
            );
          else throw new Error("Factory descendant is still running");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      });
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already retired by query cleanup. */
        }
      }
    }
  },
  10_000,
);
