import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app.js";
import { AttachmentStore } from "../../server/attachments.js";
import { GitInspectionService } from "../../server/git-inspection.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { createPiSessionDirectoryResolver } from "../../server/pi-session-directory.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import { RuntimeController } from "../../server/runtime.js";
import {
  createHostSessionCatalog,
  SessionCatalog,
} from "../../server/session-catalog.js";

import {
  startOfflineModel,
  writeOfflineModels,
} from "./fixtures/offline-model.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-project-discovery-")),
  );
  roots.push(root);
  const startup = join(root, "startup");
  const project = join(root, "never-pinned");
  const agent = join(root, "agent");
  await Promise.all([startup, project, agent].map((path) => mkdir(path)));
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
  return {
    root,
    startup,
    project,
    agent,
    preferencesPath: join(root, "config", "preferences.json"),
  };
}

function host(
  startup: string,
  preferencesPath: string,
  attachments: AttachmentStore,
) {
  // Same catalog/preferences/runtime composition as server/index.ts; neither
  // curation nor a test provider supplies the new session's project directory.
  const preferences = new PreferencesStore(preferencesPath);
  const catalog = createHostSessionCatalog(startup, preferences);
  const runtime = new RuntimeController(catalog, attachments, {
    createProcess: (options) =>
      new PiRpcProcess({
        ...options,
        args: [
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          ...(options.args ?? []),
        ],
        env: { ...options.env, PI_OFFLINE: "1" },
      }),
  });
  const application = createInspireServer({
    token: "test",
    runtime,
    catalog,
    preferences,
    attachments,
    resources: new ResourceStore(),
    git: new GitInspectionService(),
    version: "test",
    piVersion: "test",
  });
  return { application, runtime, catalog, preferences };
}

const api = (application: ReturnType<typeof createInspireServer>) => ({
  newSession: (cwd: string) =>
    request(application.server)
      .post("/api/sessions/new")
      .set("Authorization", "Bearer test")
      .send({ cwd, model: { provider: "fixture", id: "offline" } }),
  curate: (body: object) =>
    request(application.server)
      .patch("/api/preferences")
      .set("Authorization", "Bearer test")
      .send(body),
});

describe("Host project discovery continuity", () => {
  it("rediscovers a never-pinned native session after Host reconstruction and curation changes", async () => {
    const { root, startup, project, agent, preferencesPath } = await fixture();
    await mkdir(join(project, ".pi"));
    await writeFile(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ sessionDir: "sessions" }),
    );
    // A loopback model makes stock Pi materialize its own new JSONL without
    // credentials, external requests, or an Inspire-selected --session-dir.
    const model = await startOfflineModel({ reply: "offline answer" });
    const reconstruct = () =>
      host(
        startup,
        preferencesPath,
        new AttachmentStore(join(root, "uploads")),
      );
    let current = reconstruct();
    try {
      await writeOfflineModels(agent, model.baseUrl, "fixture", [
        { id: "offline", name: "Offline", maxTokens: 256 },
      ]);
      const created = await api(current.application)
        .newSession(project)
        .expect(200);
      const id = created.body.active.sessionId as string;
      expect((await current.preferences.read()).pinnedProjectCwds).toEqual([]);
      expect(await current.preferences.projectDirectories.read()).toContain(
        project,
      );
      await current.runtime.prompt({
        sessionId: id,
        message: "first message",
      });
      await vi.waitFor(
        async () => {
          expect(
            await readFile(created.body.active.sessionFile, "utf8"),
          ).toContain("offline answer");
          expect((await current.runtime.snapshot()).runState).toBe("idle");
        },
        { timeout: 10_000 },
      );
      await current.application.close();
      current = reconstruct();
      expect(
        (await current.catalog.list()).sessions.map((row) => row.id),
      ).toEqual([id]);
      const opened = await current.runtime.openSession(id);
      expect(opened.active?.sessionId).toBe(id);
      await current.runtime.prompt({
        sessionId: id,
        message: "continue after reconstruction",
      });
      await vi.waitFor(
        async () => {
          expect(
            await readFile(created.body.active.sessionFile, "utf8"),
          ).toContain("continue after reconstruction");
          expect((await current.runtime.snapshot()).runState).toBe("idle");
        },
        { timeout: 10_000 },
      );
      // Exercise the actual preference route, including clearing both kinds
      // of folder curation. Neither transition removes storage knowledge.
      await api(current.application)
        .curate({ pinnedProjectCwds: [project] })
        .expect(200);
      await api(current.application)
        .curate({ pinnedProjectCwds: [], hiddenProjectCwds: [project] })
        .expect(200);
      await api(current.application)
        .curate({ hiddenProjectCwds: [] })
        .expect(200);
      await current.application.close();
      current = reconstruct();
      expect(
        (await current.catalog.list()).sessions.map((row) => row.id),
      ).toEqual([id]);
      // Remember only cwd: a current override must not scan old session paths.
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "replacement");
      expect(await current.catalog.refresh(true)).toEqual([]);
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
      expect(
        (await current.catalog.refresh(true)).map((row) => row.id),
      ).toEqual([id]);
      // Removing the file/root must not resurrect a cached session on restart.
      await rm(join(project, "sessions"), { recursive: true });
      expect(await current.catalog.refresh(true)).toEqual([]);
      await current.application.close();
      current = reconstruct();
      expect(await current.catalog.refresh()).toEqual([]);
      expect(await current.preferences.projectDirectories.read()).toContain(
        project,
      );
    } finally {
      await current.application.close();
      await model.close();
    }
  }, 30_000);

  it("finds a session written by external Pi under an inherited relative storage path", async () => {
    const { root, project, agent } = await fixture();
    await mkdir(join(project, ".pi"));
    await writeFile(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ sessionDir: "project-sessions" }),
    );
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({ sessionDir: "global-sessions" }),
    );
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "external-sessions");
    const source = join(root, "source.jsonl");
    const timestamp = "2026-01-01T00:00:00Z";
    await writeFile(
      source,
      [
        {
          type: "session",
          version: 3,
          id: "55555555-5555-4555-8555-555555555555",
          cwd: project,
          timestamp,
        },
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: "External Pi session",
            timestamp: 1,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const rpc = new PiRpcProcess({
      cwd: project,
      args: [
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--fork",
        source,
      ],
      env: { PI_OFFLINE: "1" },
    });
    let state: { sessionId: string; sessionFile: string };
    await rpc.start();
    try {
      state = await rpc.request({ type: "get_state" });
    } finally {
      await rpc.stop();
    }
    const file = resolve(project, state.sessionFile);
    const expected = join(project, "external-sessions");
    expect(dirname(file)).toBe(expected);
    expect(await createPiSessionDirectoryResolver()(project)).toBe(expected);
    expect(await readFile(file, "utf8")).toContain("External Pi session");
    const catalog = new SessionCatalog(project);
    expect((await catalog.list()).sessions.map(({ id }) => id)).toEqual([
      state.sessionId,
    ]);
    expect(await catalog.get(state.sessionId)).toMatchObject({
      path: file,
      cwd: project,
    });
  }, 30_000);

  it("remembers the cwd of an opened existing session without pinning it", async () => {
    const { root, startup, project, agent, preferencesPath } = await fixture();
    const storage = join(agent, "sessions", "--existing--");
    await mkdir(storage, { recursive: true });
    await writeFile(
      join(storage, "existing.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "existing", cwd: project, timestamp: new Date().toISOString() })}\n`,
    );
    const current = host(
      startup,
      preferencesPath,
      new AttachmentStore(join(root, "uploads")),
    );
    try {
      await request(current.application.server)
        .post("/api/sessions/open")
        .set("Authorization", "Bearer test")
        .send({ id: "existing" })
        .expect(200);
      await vi.waitFor(async () =>
        expect(
          await new PreferencesStore(preferencesPath).projectDirectories.read(),
        ).toContain(project),
      );
      expect((await current.preferences.read()).pinnedProjectCwds).toEqual([]);
    } finally {
      await current.application.close();
    }
  });

  it("remembers an uncertain start without making the index a launch gate", async () => {
    const { root, startup, project, preferencesPath } = await fixture();
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "sessions");
    const preferences = new PreferencesStore(preferencesPath);
    const catalog = createHostSessionCatalog(startup, preferences);
    const attachments = new AttachmentStore(join(root, "uploads"));
    const create = vi.fn((options) => {
      const rpc = new PiRpcProcess(options);
      vi.spyOn(rpc, "start").mockImplementation(async () => {
        await mkdir(join(project, "sessions"), { recursive: true });
        await writeFile(
          join(project, "sessions", "uncertain.jsonl"),
          `${JSON.stringify({ type: "session", version: 3, id: "uncertain", cwd: project, timestamp: new Date().toISOString() })}\n`,
        );
        throw new Error("startup response lost");
      });
      return rpc;
    });
    const runtime = new RuntimeController(catalog, attachments, {
      createProcess: create,
    });
    try {
      await expect(runtime.newSession(project)).rejects.toThrow(
        "startup response lost",
      );
      await vi.waitFor(async () =>
        expect(
          await new PreferencesStore(preferencesPath).projectDirectories.read(),
        ).toContain(project),
      );
      expect(
        (
          await createHostSessionCatalog(
            startup,
            new PreferencesStore(preferencesPath),
          ).list()
        ).sessions.map((row) => row.id),
      ).toEqual(["uncertain"]);
      await writeFile(preferences.projectDirectories.path, "invalid json");
      await expect(runtime.newSession(project)).rejects.toThrow(
        "startup response lost",
      );
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.close();
      await attachments.close();
    }
  });
});
