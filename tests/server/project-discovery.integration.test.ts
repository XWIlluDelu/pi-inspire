import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app.js";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { GitInspectionService } from "../../server/git-inspection.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import { RuntimeController } from "../../server/runtime.js";
import { createHostSessionCatalog } from "../../server/session-catalog.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inspire-project-discovery-"));
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
  const runtime = new RuntimeController(
    catalog,
    attachments,
    (options) =>
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
  );
  const application = createInspireServer({
    token: "test",
    runtime,
    catalog,
    preferences,
    attachments,
    resources: new ResourceStore(),
    git: new GitInspectionService(),
    mock: false,
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
  it.each(["relative-env", "local-setting", "global-relative-setting"])(
    "reconstructs a never-pinned new project using %s, independently of Pin/Hidden",
    async (selection) => {
      const { root, startup, project, agent, preferencesPath } =
        await fixture();
      if (selection === "relative-env")
        vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "sessions");
      else {
        const settingsRoot =
          selection === "local-setting" ? join(project, ".pi") : agent;
        await mkdir(settingsRoot, { recursive: true });
        await writeFile(
          join(settingsRoot, "settings.json"),
          JSON.stringify({ sessionDir: "sessions" }),
        );
      }
      // A loopback model makes stock Pi materialize its own new JSONL without
      // credentials, external requests, or an Inspire-selected --session-dir.
      const model = createServer(async (req, response) => {
        for await (const _chunk of req) {
          /* consume request */
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [delta, finish_reason] of [
          [{ role: "assistant", content: "offline answer" }, null],
          [{}, "stop"],
        ]) {
          response.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "offline", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      });
      await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
      await writeFile(
        join(agent, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
              api: "openai-completions",
              apiKey: "fixture-placeholder",
              models: [
                {
                  id: "offline",
                  name: "Offline",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 8192,
                  maxTokens: 256,
                },
              ],
            },
          },
        }),
      );
      const attachments = new AttachmentStore(join(root, "uploads"));
      let current = host(startup, preferencesPath, attachments);
      try {
        const created = await api(current.application)
          .newSession(project)
          .expect(200);
        const id = created.body.active.sessionId as string;
        expect((await current.preferences.read()).pinnedProjectCwds).toEqual(
          [],
        );
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
        current = host(startup, preferencesPath, attachments);
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
        current = host(startup, preferencesPath, attachments);
        expect(
          (await current.catalog.list()).sessions.map((row) => row.id),
        ).toEqual([id]);
        // Remember only cwd: a current override must not scan old session paths.
        vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "replacement");
        expect(await current.catalog.refresh(true)).toEqual([]);
        vi.stubEnv(
          "PI_CODING_AGENT_SESSION_DIR",
          selection === "relative-env" ? "sessions" : undefined,
        );
        expect(
          (await current.catalog.refresh(true)).map((row) => row.id),
        ).toEqual([id]);
        // Removing the file/root must not resurrect a cached session on restart.
        await rm(join(project, "sessions"), { recursive: true });
        expect(await current.catalog.refresh(true)).toEqual([]);
        await current.application.close();
        current = host(startup, preferencesPath, attachments);
        expect(await current.catalog.refresh()).toEqual([]);
        expect(await current.preferences.projectDirectories.read()).toContain(
          project,
        );
      } finally {
        await current.application.close();
        await attachments.close();
        await new Promise<void>((done, reject) =>
          model.close((error) => (error ? reject(error) : done())),
        );
      }
    },
    30_000,
  );

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
      expect(
        await new PreferencesStore(preferencesPath).projectDirectories.read(),
      ).toContain(project);
      expect((await current.preferences.read()).pinnedProjectCwds).toEqual([]);
    } finally {
      await current.application.close();
    }
  });

  it("saves the cwd before a failed/uncertain worker start and blocks creation if saving fails", async () => {
    const { root, startup, project, preferencesPath } = await fixture();
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "sessions");
    const preferences = new PreferencesStore(preferencesPath);
    const catalog = createHostSessionCatalog(startup, preferences);
    const attachments = new AttachmentStore(join(root, "uploads"));
    const create = vi.fn((options) => {
      const rpc = new PiRpcProcess(options);
      vi.spyOn(rpc, "start").mockImplementation(async () => {
        expect(
          await new PreferencesStore(preferencesPath).projectDirectories.read(),
        ).toContain(project);
        await mkdir(join(project, "sessions"));
        await writeFile(
          join(project, "sessions", "uncertain.jsonl"),
          `${JSON.stringify({ type: "session", version: 3, id: "uncertain", cwd: project, timestamp: new Date().toISOString() })}\n`,
        );
        throw new Error("startup response lost");
      });
      return rpc;
    });
    const runtime = new RuntimeController(catalog, attachments, create);
    try {
      await expect(runtime.newSession(project)).rejects.toThrow(
        "startup response lost",
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
      await expect(runtime.newSession(project)).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
      await attachments.close();
    }
  });
});
