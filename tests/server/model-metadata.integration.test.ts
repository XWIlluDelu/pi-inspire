import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app.js";
import { AttachmentStore } from "../../server/attachments.js";
import {
  ModelMetadataCatalog,
  queryModelMetadata,
} from "../../server/model-metadata.js";
import { ModelSettingsService } from "../../server/model-settings.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import { hostServices } from "../fixtures/host-services.js";
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
  for (const [base, scope] of [
    [f.agent, "global"],
    [join(f.trusted, ".pi"), "project"],
  ] as const) {
    await mkdir(join(base, "prompts"), { recursive: true });
    await writeFile(
      join(base, "prompts", `${scope}-review.md`),
      `---\ndescription: ${scope} review prompt\n---\nReview $@`,
    );
    await mkdir(join(base, "skills", `${scope}-review`), { recursive: true });
    await writeFile(
      join(base, "skills", `${scope}-review`, "SKILL.md"),
      `---\nname: ${scope}-review\ndescription: ${scope} review skill\n---\nReview the requested changes.`,
    );
  }
  const catalog = new ModelMetadataCatalog();
  const attachments = new AttachmentStore(join(f.root, "uploads"));
  const readMetadata = vi.fn((cwd: string, refresh?: boolean) =>
    catalog.read(cwd, refresh),
  );
  const app = createInspireServer({
    token: "fixture",
    ...hostServices(f.root, { attachments }),
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
    modelMetadata: readMetadata,
    modelSettings: new ModelSettingsService(f.agent),
    invalidateModels: () => catalog.invalidate(),
  });
  try {
    const endpoint = request.agent(app.app).auth("fixture", { type: "bearer" });
    const modelsAt = (cwd: string) =>
      endpoint.get("/api/models").query({ cwd }).expect(200);
    const settingsAt = (cwd: string) =>
      endpoint.get("/api/model-settings").query({ cwd }).expect(200);

    const bootstrap = await endpoint.get("/api/bootstrap").expect(200);
    expect(bootstrap.body).toMatchObject({
      availableModels: [],
      snapshot: { runState: "idle" },
    });
    expect(readMetadata).not.toHaveBeenCalled();

    const [{ body: trusted }, { body: untrusted }] = await Promise.all([
      modelsAt(f.trusted),
      modelsAt(f.untrusted),
    ]);
    const identities = (models: { provider: string; id: string }[]) =>
      models.map(({ provider, id }) => `${provider}/${id}`);
    const globalIds = [
      "global-native/a",
      "global-legacy/legacy",
      "global-router/auto",
    ];
    expect(identities(trusted.models)).toEqual(
      expect.arrayContaining([
        ...globalIds,
        "project-native/a",
        "project-legacy/legacy",
        "project-router/auto",
      ]),
    );
    expect(identities(untrusted.models)).toEqual(
      expect.arrayContaining(globalIds),
    );
    expect(
      identities(untrusted.models).filter((id) => id.startsWith("project-")),
    ).toEqual([]);
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
    expect(
      trusted.models.find(
        ({ provider }: { provider: string }) => provider === "project-router",
      ),
    ).toMatchObject({
      thinkingLevelMap: { off: null, low: "low", high: "high", max: null },
    });
    expect(trusted.virtualModels).toBeUndefined();
    expect(trusted.commands.map(({ name }: { name: string }) => name)).toEqual(
      expect.arrayContaining([
        "global-mode",
        "project-mode",
        "shared-mode:1",
        "shared-mode:2",
      ]),
    );
    expect(untrusted.commands).not.toContainEqual(
      expect.objectContaining({ name: "project-mode" }),
    );
    for (const scope of ["global", "project"]) {
      expect(trusted.commands).toContainEqual(
        expect.objectContaining({
          name: `${scope}-review`,
          source: "prompt",
        }),
      );
      expect(trusted.commands).toContainEqual(
        expect.objectContaining({
          name: `skill:${scope}-review`,
          source: "skill",
        }),
      );
    }
    expect((await settingsAt(f.trusted)).body.models).toEqual(trusted.models);
    expect((await settingsAt(f.untrusted)).body).toMatchObject({
      effective: { defaultModel: { provider: "global-router" } },
      projectOverrides: [],
    });

    await writeFile(
      join(f.trusted, ".pi/settings.json"),
      JSON.stringify({
        defaultProvider: "project-native",
        defaultModel: "b",
        defaultThinkingLevel: "high",
      }),
    );
    expect((await modelsAt(f.trusted)).body.defaults).toMatchObject({
      model: { provider: "project-native", id: "b" },
      thinkingLevel: "high",
    });
    const nested = join(f.trusted, "nested");
    await mkdir(join(nested, ".pi"), { recursive: true });
    await writeFile(
      join(nested, ".pi/settings.json"),
      JSON.stringify({ defaultProvider: "global-native", defaultModel: "b" }),
    );
    expect((await catalog.read(nested)).defaults.model?.id).toBe("b");

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
    const { body: partial } = await modelsAt(f.trusted);
    expect(identities(partial.models)).toEqual(
      expect.arrayContaining(["global-native/a", "project-native/a"]),
    );
    expect(partial.warning).toContain("Some Pi extensions could not load");
    expect(JSON.stringify(partial)).not.toContain("PRIVATE EXTENSION DETAIL");
    const current = await settingsAt(f.trusted);
    const saved = await endpoint
      .patch("/api/model-settings/config")
      .query({ cwd: f.trusted })
      .send({
        revision: current.body.configRevision,
        edit: {
          kind: "model",
          provider: "global-native",
          values: { id: "a", name: "Still editable" },
        },
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      saved: true,
      snapshot: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: "global-native",
            models: [
              expect.objectContaining({ id: "a", name: "Still editable" }),
            ],
          }),
        ]),
      },
    });
    expect(await readdir(f.sessions)).toEqual([]);
    expect(await readFile(f.events, "utf8")).not.toMatch(
      /session_start|agent_start|request|route/,
    );
  } finally {
    await app.close();
    await attachments.close();
  }
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

it("retires an extension factory's descendants even if it fails", async () => {
  const f = await modelWorkflowFixture();
  roots.push(f.root);
  const extension = join(f.agent, "descendant.ts");
  const pidFile = join(f.root, "descendant.pid");
  await writeFile(
    extension,
    `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
    export default () => { const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"});
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); throw new Error("fixture failure"); };`,
  );
  await writeFile(
    join(f.agent, "settings.json"),
    JSON.stringify({ extensions: [extension], defaultProjectTrust: "never" }),
  );
  let pid: number | undefined;
  try {
    const metadata = await queryModelMetadata(f.untrusted);
    expect(metadata.warning).toContain("Some Pi extensions could not load");
    pid = Number(await readFile(pidFile, "utf8"));
    await vi.waitFor(async () => {
      try {
        process.kill(pid!, 0);
        if (process.platform === "linux")
          expect(await readFile(`/proc/${pid}/stat`, "utf8")).toMatch(/\) Z /);
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
}, 10_000);
