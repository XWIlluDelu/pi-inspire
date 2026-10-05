import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
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

    // A broken startup factory cannot block pairing/read-only bootstrap, but
    // explicit catalog/default queries must fail rather than return emptiness.
    const broken = join(f.agent, "broken.ts");
    await writeFile(
      broken,
      'export default () => { throw new Error("broken startup factory"); };',
    );
    const settingsPath = join(f.agent, "settings.json");
    const settingsState = JSON.parse(await readFile(settingsPath, "utf8"));
    await writeFile(
      settingsPath,
      JSON.stringify({ ...settingsState, extensions: [broken] }),
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
    await endpoint
      .get("/api/models")
      .query({ cwd: f.trusted })
      .auth("fixture", { type: "bearer" })
      .expect(500);
  } finally {
    await app.close();
    await attachments.close();
  }
}, 30_000);

it.each([false, true])(
  "retires factory descendants when a metadata query fails=%s",
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
      if (fail)
        await expect(queryModelMetadata(f.untrusted)).rejects.toThrow(
          "could not load",
        );
      else await queryModelMetadata(f.untrusted);
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
