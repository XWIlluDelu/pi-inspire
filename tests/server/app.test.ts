import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AttachmentStore } from "../../server/attachments.js";
import {
  ACCESS_COOKIE,
  createInspireServer,
  MAX_JOINING_EVENT_BYTES,
} from "../../server/app.js";
import type { GitInspectionLike } from "../../server/git-inspection.js";
import { MockCatalog, MockRuntime } from "../../server/mock.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import { MAX_ATTACHMENT_FILE_BYTES } from "../../shared/contracts.js";

const token = "test-local-token";

describe("local host API", () => {
  let temporary: string;
  let application: ReturnType<typeof createInspireServer>;
  let resources: ResourceStore;
  let runtime: MockRuntime;
  let attachments: AttachmentStore;
  let git: GitInspectionLike;
  let baseUrl: string;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "inspire-test-"));
    resources = new ResourceStore();
    runtime = new MockRuntime();
    git = {
      status: vi.fn(async () => ({ kind: "not-repository" as const })),
      diff: vi.fn(async (_cwd, pathId, side) => ({
        kind: "empty" as const,
        path: {
          id: pathId,
          display: "file.txt",
          utf8Path: "file.txt",
          workspacePath: "file.txt",
        },
        side,
        reason: "no-changes" as const,
      })),
    };
    attachments = new AttachmentStore(join(temporary, "uploads"));
    application = createInspireServer({
      token,
      runtime,
      catalog: new MockCatalog(),
      attachments,
      preferences: new PreferencesStore(join(temporary, "preferences.json")),
      resources,
      git,
      mock: true,
      version: "0.1.0-test",
      piVersion: "0.80.10",
      availableModels: async () => [
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          reasoning: true,
        },
      ],
      newSessionDefaults: async (cwd) => ({
        cwd,
        model: {
          provider: "anthropic",
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          reasoning: true,
        },
        thinkingLevel: "high",
      }),
      distDir: join(temporary, "missing-dist"),
    });
    await new Promise<void>((resolve) =>
      application.server.listen(0, "127.0.0.1", resolve),
    );
    const address = application.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await application.close();
    await rm(temporary, { recursive: true, force: true });
  });

  const api = () =>
    request(application.server)
      .get("/api/bootstrap")
      .set("Authorization", `Bearer ${token}`);

  it("keeps maintenance restart coordination behind local authentication", async () => {
    await request(application.server)
      .post("/api/maintenance/restart")
      .expect(401);
    await request(application.server)
      .post("/api/maintenance/restart")
      .set("Authorization", `Bearer ${token}`)
      .expect(200, { kind: "skipped", reason: "runtime-unsupported" });
  });

  it("preflights Pi defaults and project files against one canonical prospective workspace", async () => {
    await writeFile(join(temporary, "app.ts"), "export {};\n");

    const defaults = await request(application.server)
      .get("/api/new-session/defaults")
      .query({ cwd: join(temporary, ".") })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(defaults.body).toEqual({
      cwd: temporary,
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        reasoning: true,
      },
      thinkingLevel: "high",
    });

    const files = await request(application.server)
      .get("/api/new-session/files")
      .query({ cwd: join(temporary, "."), q: "app" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(files.body).toEqual({
      cwd: temporary,
      files: [{ path: "app.ts", name: "app.ts" }],
    });

    await request(application.server)
      .get("/api/new-session/defaults")
      .query({ cwd: join(temporary, "missing") })
      .set("Authorization", `Bearer ${token}`)
      .expect(400, { error: "Project path does not exist" });
  });

  it("stops accepting work before runtime teardown and drains an active request without deadlock", async () => {
    const originalSnapshot = runtime.snapshot.bind(runtime);
    const originalClose = runtime.close.bind(runtime);
    let snapshotStarted!: () => void;
    let releaseSnapshot!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      snapshotStarted = resolveStarted;
    });
    const gate = new Promise<void>((resolveSnapshot) => {
      releaseSnapshot = resolveSnapshot;
    });
    vi.spyOn(runtime, "snapshot").mockImplementation(async () => {
      snapshotStarted();
      await gate;
      return originalSnapshot();
    });
    vi.spyOn(runtime, "close").mockImplementation(async () => {
      releaseSnapshot();
      await originalClose();
    });
    const active = request(application.server)
      .get("/api/snapshot")
      .set("Authorization", `Bearer ${token}`);
    const activeResult = active.then((response) => response.status);
    await started;
    const closing = application.close();
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    expect(application.server.listening).toBe(false);
    await expect(
      fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toThrow();
    await expect(activeResult).resolves.toBe(200);
    await expect(closing).resolves.toBeUndefined();
  });

  it("cleans attachment storage and resource anchors even when runtime teardown fails", async () => {
    const attachmentClose = vi.spyOn(attachments, "close");
    const resourceClose = vi.spyOn(resources, "close");
    const runtimeClose = vi
      .spyOn(runtime, "close")
      .mockRejectedValueOnce(new Error("runtime teardown failed"));
    await expect(application.close()).rejects.toThrow(
      /runtime teardown failed/,
    );
    expect(resourceClose).toHaveBeenCalledOnce();
    expect(attachmentClose).toHaveBeenCalledOnce();
    runtimeClose.mockRestore();
  });

  it("requires the launch token and rejects foreign origins", async () => {
    await request(application.server).get("/api/bootstrap").expect(401);
    await api().set("Origin", "https://example.invalid").expect(403);
    await request(application.server)
      .post("/api/auth/pair")
      .set("Origin", "https://example.invalid")
      .send({ token })
      .expect(403);
    const health = await request(application.server)
      .get("/api/health")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(health.body).toEqual({ appName: "inspire", mock: true });
    const response = await api().expect(200);
    expect(response.body).toMatchObject({
      appName: "inspire",
      mock: true,
      piVersion: "0.80.10",
      availableModels: [
        { provider: "anthropic", id: "claude-sonnet-4", reasoning: true },
      ],
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    // Remote images are barred so untrusted transcript content cannot fire
    // network requests just by rendering.
    expect(response.headers["content-security-policy"]).toContain(
      "img-src 'self' data: blob:",
    );
    expect(response.headers["content-security-policy"]).not.toMatch(
      /img-src[^;]*https:/,
    );
  });

  it("pairs a browser once with an HttpOnly same-site cookie for HTTP and WebSocket access", async () => {
    const agent = request.agent(application.server);
    await agent
      .post("/api/auth/pair")
      .set("Origin", baseUrl)
      .send({ token: "wrong" })
      .expect(401);
    const paired = await agent
      .post("/api/auth/pair")
      .set("Origin", baseUrl)
      .send({ token })
      .expect(204);
    const setCookie = paired.headers["set-cookie"] as unknown as string[];
    expect(setCookie[0]).toContain(`${ACCESS_COOKIE}=`);
    expect(setCookie[0]).toContain("HttpOnly");
    expect(setCookie[0]).toContain("SameSite=Strict");
    expect(setCookie[0]).toContain("Path=/");
    await agent.get("/api/bootstrap").expect(200);

    const cookie = setCookie[0]!.split(";", 1)[0]!;
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/events`, {
      headers: { Cookie: cookie },
      origin: baseUrl,
    });
    try {
      const firstFrame = await new Promise<Record<string, unknown>>(
        (resolveFrame, reject) => {
          socket.once("message", (data) =>
            resolveFrame(
              JSON.parse(data.toString()) as Record<string, unknown>,
            ),
          );
          socket.once("error", reject);
        },
      );
      expect(firstFrame.type).toBe("snapshot");
    } finally {
      socket.close();
    }
  });

  it("sets a Secure pairing cookie through a trusted loopback HTTPS proxy", async () => {
    const proxied = createInspireServer({
      token,
      runtime: new MockRuntime(),
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(temporary, "proxy-uploads")),
      preferences: new PreferencesStore(
        join(temporary, "proxy-preferences.json"),
      ),
      resources: new ResourceStore(),
      git,
      mock: true,
      version: "0.1.0-test",
      piVersion: "0.80.10",
    });
    await new Promise<void>((resolve) =>
      proxied.server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const paired = await request(proxied.server)
        .post("/api/auth/pair")
        .set("Host", "inspire.example.test")
        .set("Origin", "https://inspire.example.test")
        .set("X-Forwarded-Proto", "https")
        .send({ token })
        .expect(204);
      expect(String(paired.headers["set-cookie"])).toContain("Secure");
    } finally {
      await proxied.close();
    }
  });

  it("caches hashed assets immutably but revalidates unhashed dist files", async () => {
    const dist = await mkdtemp(join(tmpdir(), "inspire-dist-"));
    await mkdir(join(dist, "assets"));
    await writeFile(
      join(dist, "assets", "index-abc123.js"),
      "console.log(1)\n",
    );
    await writeFile(join(dist, "theme-init.js"), "/* theme */\n");
    await writeFile(
      join(dist, "index.html"),
      "<!doctype html><title>INSΠRE</title>",
    );
    const served = createInspireServer({
      token,
      runtime: new MockRuntime(),
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(dist, "uploads")),
      preferences: new PreferencesStore(join(dist, "preferences.json")),
      resources: new ResourceStore(),
      git,
      mock: true,
      version: "0.1.0-test",
      piVersion: "0.80.10",
      distDir: dist,
    });
    await new Promise<void>((resolve) =>
      served.server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const hashed = await request(served.server)
        .get("/assets/index-abc123.js")
        .expect(200);
      expect(hashed.headers["cache-control"]).toContain("immutable");
      expect(hashed.headers["cache-control"]).toContain("max-age=31536000");
      // Unhashed root script must revalidate, never inherit the 1y policy.
      const theme = await request(served.server)
        .get("/theme-init.js")
        .expect(200);
      expect(theme.headers["cache-control"]).not.toContain("immutable");
      expect(theme.headers["cache-control"]).toContain("max-age=0");
      // The SPA shell is always revalidated so a new bundle hash is picked up.
      const shell = await request(served.server)
        .get("/some/deep/route")
        .expect(200);
      expect(shell.headers["cache-control"]).toBe("no-cache");

      const browser = request.agent(served.server);
      const launch = await browser
        .get(`/?token=${encodeURIComponent(token)}`)
        .redirects(0)
        .expect(303);
      expect(launch.headers.location).toBe("/");
      expect(String(launch.headers["set-cookie"])).toContain(
        `${ACCESS_COOKIE}=`,
      );
      await browser.get("/api/bootstrap").expect(200);
    } finally {
      await served.close();
      await rm(dist, { recursive: true, force: true });
    }
  });

  it("keeps direct token URLs local and rejects them through forwarded HTTPS", async () => {
    const dist = await mkdtemp(join(tmpdir(), "inspire-relay-dist-"));
    await writeFile(
      join(dist, "index.html"),
      "<!doctype html><title>INSΠRE</title>",
    );
    const relay = createInspireServer({
      token,
      runtime: new MockRuntime(),
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(dist, "uploads")),
      preferences: new PreferencesStore(join(dist, "preferences.json")),
      resources: new ResourceStore(),
      git,
      mock: true,
      version: "0.1.0-test",
      piVersion: "0.80.10",
      distDir: dist,
    });
    await new Promise<void>((resolve) =>
      relay.server.listen(0, "127.0.0.1", resolve),
    );
    const address = relay.server.address() as AddressInfo;
    const forwardedOrigin = `https://127.0.0.1:${address.port}`;
    try {
      const direct = request.agent(relay.server);
      const directLaunch = await direct
        .get(`/?token=${encodeURIComponent(token)}`)
        .redirects(0)
        .expect(303);
      expect(directLaunch.headers.location).toBe("/");
      expect(String(directLaunch.headers["set-cookie"])).toContain(
        `${ACCESS_COOKIE}=`,
      );
      expect(String(directLaunch.headers["set-cookie"])).not.toContain(
        "Secure",
      );
      await direct.get("/api/bootstrap").expect(200);

      const forwardedLaunch = await request(relay.server)
        .get(`/?token=${encodeURIComponent(token)}`)
        .set("X-Forwarded-Proto", "https")
        .redirects(0)
        .expect(303);
      expect(forwardedLaunch.headers.location).toBe("/");
      expect(String(forwardedLaunch.headers["set-cookie"])).not.toContain(
        `${ACCESS_COOKIE}=`,
      );

      const paired = await request(relay.server)
        .post("/api/auth/pair")
        .set("Origin", forwardedOrigin)
        .set("X-Forwarded-Proto", "https")
        .send({ token })
        .expect(204);
      const cookie = String(paired.headers["set-cookie"]).split(";", 1)[0]!;
      expect(String(paired.headers["set-cookie"])).toContain("Secure");

      const rejected = new WebSocket(
        `ws://127.0.0.1:${address.port}/events?token=${encodeURIComponent(token)}`,
        {
          headers: { "X-Forwarded-Proto": "https" },
          origin: forwardedOrigin,
        },
      );
      await new Promise<void>((resolveRejected, rejectRejected) => {
        rejected.once("open", () =>
          rejectRejected(new Error("forwarded query-token socket opened")),
        );
        rejected.once("close", () => resolveRejected());
        rejected.once("error", () => resolveRejected());
      });

      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/events`, {
        headers: { Cookie: cookie, "X-Forwarded-Proto": "https" },
        origin: forwardedOrigin,
      });
      try {
        const firstFrame = await new Promise<Record<string, unknown>>(
          (resolveFrame, rejectFrame) => {
            socket.once("message", (data) =>
              resolveFrame(
                JSON.parse(data.toString()) as Record<string, unknown>,
              ),
            );
            socket.once("error", rejectFrame);
          },
        );
        expect(firstFrame.type).toBe("snapshot");
      } finally {
        socket.close();
      }
    } finally {
      await relay.close();
      await rm(dist, { recursive: true, force: true });
    }
  });

  it("lists and opens Pi sessions through the typed API", async () => {
    const sessions = await request(application.server)
      .get("/api/sessions?q=formula")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(sessions.body.total).toBe(1);
    expect(sessions.body.sessions[0]).toMatchObject({
      id: "mock-active",
      project: "research",
    });
    const page = await request(application.server)
      .get("/api/sessions?offset=1&limit=1")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(page.body).toMatchObject({ offset: 1, limit: 1, total: 2 });
    expect(page.body.sessions).toHaveLength(1);
    for (const invalid of [
      "limit=not-a-number",
      "limit=101",
      "offset=-1",
      "offset=1.5",
      "offset=9007199254740992",
    ]) {
      await request(application.server)
        .get(`/api/sessions?${invalid}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    }

    const opened = await request(application.server)
      .post("/api/sessions/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "mock-active" })
      .expect(200);
    expect(opened.body.active.messages).toHaveLength(5);
    expect(opened.body.active.model.id).toBe("kimi-k3");
  });

  it("clears host selection when the browser opens New session", async () => {
    await request(application.server)
      .post("/api/sessions/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "mock-active" })
      .expect(200);
    expect(runtime.activeSessionId).toBe("mock-active");

    const deselected = await request(application.server)
      .post("/api/sessions/deselect")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(deselected.body).toMatchObject({ active: null, runState: "idle" });
    expect(runtime.activeSessionId).toBeNull();
  });

  it("creates a session with an explicitly selected model and thinking level", async () => {
    const created = await request(application.server)
      .post("/api/sessions/new")
      .set("Authorization", `Bearer ${token}`)
      .send({
        cwd: temporary,
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
      })
      .expect(200);
    expect(created.body.active).toMatchObject({
      cwd: temporary,
      model: { provider: "anthropic", id: "claude-sonnet-4" },
      thinkingLevel: "high",
    });

    await request(application.server)
      .post("/api/sessions/new")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwd: temporary, thinkingLevel: "unbounded" })
      .expect(400);
  });

  it("serves authenticated session-addressed older transcript pages", async () => {
    const page = {
      sessionId: "mock-active",
      revision: 7,
      viewId: "mock-view-mock-active",
      messages: [{ role: "user", content: "older", timestamp: 1 }],
      hasOlder: false,
      olderCursor: null,
    };
    const paging = vi.spyOn(runtime, "transcriptPage").mockResolvedValue(page);
    await request(application.server)
      .get("/api/transcript/older?sessionId=mock-active&cursor=opaque-cursor")
      .expect(401);
    const response = await request(application.server)
      .get("/api/transcript/older?sessionId=mock-active&cursor=opaque-cursor")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual(page);
    expect(paging).toHaveBeenCalledWith("mock-active", "opaque-cursor");
  });

  it("serves authenticated, bounded, session-addressed branch operations", async () => {
    const branchTree = {
      sessionId: "mock-active",
      revision: 3,
      incarnation: "inc",
      durableLeafId: "a1",
      effectiveLeafId: "a1",
      activePath: ["u1", "a1"],
      nodes: [],
      truncated: false,
      health: { status: "ok" as const },
    };
    const tree = vi.spyOn(runtime, "branchTree").mockResolvedValue(branchTree);
    const navigate = vi.spyOn(runtime, "navigateBranch").mockResolvedValue({
      snapshot: await runtime.openSession("mock-active"),
      editorText: "original",
    });
    const fork = vi.spyOn(runtime, "forkBranch").mockResolvedValue({
      sessionId: "forked",
      snapshot: await runtime.openSession("mock-active"),
      editorText: "original",
    });

    await request(application.server)
      .get("/api/branches/tree?sessionId=mock-active")
      .expect(401);
    await request(application.server)
      .get("/api/branches/tree?sessionId=mock-active")
      .set("Authorization", `Bearer ${token}`)
      .expect(200)
      .expect((response) => expect(response.body.revision).toBe(3));
    expect(tree).toHaveBeenCalledWith("mock-active");

    await request(application.server)
      .post("/api/branches/navigate")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId: "mock-active",
        revision: 3,
        targetId: "u1",
        mode: "edit",
        rawPath: "/forged",
      })
      .expect(400);
    await request(application.server)
      .post("/api/branches/navigate")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId: "mock-active",
        revision: 3,
        targetId: "u1",
        mode: "edit",
      })
      .expect(200);
    expect(navigate).toHaveBeenCalledWith({
      sessionId: "mock-active",
      revision: 3,
      targetId: "u1",
      mode: "edit",
    });

    await request(application.server)
      .post("/api/branches/fork")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId: "mock-active", revision: 3, targetId: "u1" })
      .expect(200);
    expect(fork).toHaveBeenCalledWith({
      sessionId: "mock-active",
      revision: 3,
      targetId: "u1",
    });
  });

  it("reports invalid preference fields without changing the saved file", async () => {
    const path = join(temporary, "preferences.json");
    const raw = JSON.stringify({
      theme: "dark",
      launch: "continue",
      toolVisibility: "invalid",
      pinnedSessionIds: ["session-a"],
    });
    await writeFile(path, raw);

    const response = await request(application.server)
      .get("/api/bootstrap")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(response.body.preferences).toMatchObject({
      theme: "dark",
      launch: "continue",
      toolVisibility: "dynamic",
      pinnedSessionIds: ["session-a"],
    });
    expect(response.body.preferencesWarning).toMatch(
      /toolVisibility.*left unchanged/,
    );
    await request(application.server)
      .patch("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ projectDisplay: "path" })
      .expect(409);
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  it("persists field-scoped preference patches without losing concurrent fields", async () => {
    await request(application.server)
      .patch("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ theme: "dark" })
      .expect(200)
      .expect((response) => expect(response.body.theme).toBe("dark"));
    // Two patches racing on different fields must both survive.
    const racing = await Promise.all([
      request(application.server)
        .patch("/api/preferences")
        .set("Authorization", `Bearer ${token}`)
        .send({ toolVisibility: "hidden" }),
      request(application.server)
        .patch("/api/preferences")
        .set("Authorization", `Bearer ${token}`)
        .send({ navCollapsedGroups: ["/home/demo/older"] }),
    ]);
    expect(racing.map((response) => response.status)).toEqual([200, 200]);
    await request(application.server)
      .patch("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ theme: "sepia" })
      .expect(400);
    await request(application.server)
      .patch("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({
        recentModelIds: Array.from({ length: 9 }, (_, index) => ({
          provider: "p",
          id: `m${index}`,
        })),
      })
      .expect(400);
    const stored = await request(application.server)
      .get("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(stored.body).toEqual({
      theme: "dark",
      palette: "amber",
      launch: "welcome",
      thinkingVisibility: "dynamic",
      toolVisibility: "hidden",
      assistantRoundDisplay: "divider",
      projectDisplay: "folder",
      completionAttention: "off",
      recentModelIds: [],
      pinnedSessionIds: [],
      pinnedProjectCwds: [],
      hiddenProjectCwds: [],
      hiddenSessionIds: [],
      navCollapsedGroups: ["/home/demo/older"],
    });
  });

  it("keeps unpatched defaulted fields intact across field-scoped patches", async () => {
    // Start from non-default values for every field the schema defaults:
    // a later patch must not resurrect those defaults over stored state.
    await request(application.server)
      .patch("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({
        projectDisplay: "path",
        pinnedSessionIds: ["session-a"],
        navCollapsedGroups: ["/project/a"],
      })
      .expect(200);
    await request(application.server)
      .patch("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ theme: "dark" })
      .expect(200);
    const stored = await request(application.server)
      .get("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(stored.body).toMatchObject({
      theme: "dark",
      projectDisplay: "path",
      pinnedSessionIds: ["session-a"],
      navCollapsedGroups: ["/project/a"],
    });
  });

  it("defaults missing card-density fields to Dynamic", async () => {
    await writeFile(
      join(temporary, "preferences.json"),
      JSON.stringify({ theme: "light", launch: "welcome" }),
    );
    const response = await request(application.server)
      .get("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(response.body).toMatchObject({
      thinkingVisibility: "dynamic",
      toolVisibility: "dynamic",
    });
  });

  it("migrates existing preferences by supplying navigation defaults", async () => {
    const legacy = {
      theme: "light",
      launch: "welcome",
      thinkingVisibility: "collapsed",
      toolVisibility: "expanded",
    };
    await writeFile(
      join(temporary, "preferences.json"),
      JSON.stringify(legacy),
    );
    const response = await request(application.server)
      .get("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual({
      ...legacy,
      palette: "amber",
      assistantRoundDisplay: "divider",
      projectDisplay: "folder",
      completionAttention: "off",
      recentModelIds: [],
      pinnedSessionIds: [],
      pinnedProjectCwds: [],
      hiddenProjectCwds: [],
      hiddenSessionIds: [],
      navCollapsedGroups: [],
    });
  });

  it("lists workspace directory levels only inside the project index", async () => {
    await request(application.server)
      .post("/api/sessions/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "mock-active" })
      .expect(200);
    await request(application.server)
      .get("/api/files/list?sessionId=mock-active&dir=..%2Fetc")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
    const listed = await request(application.server)
      .get("/api/files/list?sessionId=mock-active")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(listed.body.entries)).toBe(true);
    // The list is session-addressed: an unopened session id cannot borrow
    // the current selection's workspace.
    await request(application.server)
      .get("/api/files/list?sessionId=not-open")
      .set("Authorization", `Bearer ${token}`)
      .expect(409);
  });

  it("serves only authenticated session-addressed Git status and diff inspection", async () => {
    await request(application.server)
      .get("/api/git/status?sessionId=mock-active")
      .expect(401);
    await request(application.server)
      .get("/api/git/status?sessionId=not-open")
      .set("Authorization", `Bearer ${token}`)
      .expect(409);
    await request(application.server)
      .post("/api/sessions/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "mock-active" })
      .expect(200);
    const status = await request(application.server)
      .get("/api/git/status?sessionId=mock-active")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(status.body).toEqual({ kind: "not-repository" });
    expect(git.status).toHaveBeenCalledWith(
      "/home/demo/research",
      expect.any(AbortSignal),
    );

    await request(application.server)
      .post("/api/git/diff")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId: "mock-active",
        pathId: "not base64!",
        side: "unstaged",
      })
      .expect(400);
    await request(application.server)
      .post("/api/git/diff")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId: "mock-active",
        pathId: "ZmlsZS50eHQ",
        side: "working",
      })
      .expect(400);
    const diff = await request(application.server)
      .post("/api/git/diff")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId: "mock-active",
        pathId: "ZmlsZS50eHQ",
        side: "unstaged",
      })
      .expect(200);
    expect(diff.body).toMatchObject({ kind: "empty", side: "unstaged" });
    expect(git.diff).toHaveBeenCalledWith(
      "/home/demo/research",
      "ZmlsZS50eHQ",
      "unstaged",
      expect.any(AbortSignal),
    );

    for (const route of [
      "add",
      "commit",
      "restore",
      "checkout",
      "history",
      "blame",
      "push",
    ]) {
      await request(application.server)
        .post(`/api/git/${route}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ sessionId: "mock-active" })
        .expect(404);
    }
  });

  it("browses host roots and directories without a session and rejects relative paths", async () => {
    const roots = await request(application.server)
      .get("/api/host/roots")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(roots.body.roots)).toBe(true);
    for (const root of roots.body.roots) {
      expect(root).toEqual({
        name: expect.any(String),
        path: expect.any(String),
      });
    }

    await mkdir(join(temporary, "projects"));
    const listing = await request(application.server)
      .get(`/api/host/dirs?path=${encodeURIComponent(temporary)}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(listing.body.dirs).toEqual(
      expect.arrayContaining([
        { name: "projects", path: join(listing.body.path, "projects") },
      ]),
    );
    expect(listing.body.parent).toBe(dirname(listing.body.path));

    await request(application.server)
      .get("/api/host/dirs?path=relative/path")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
    await request(application.server)
      .get(
        `/api/host/dirs?path=${encodeURIComponent(join(temporary, "missing"))}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });

  it("stores curated navigation identities as preferences and returns their summaries by id", async () => {
    // Pins, folder pins, and hidden sessions are navigation metadata: one
    // field-scoped patch, no Pi history touched.
    const curated = await request(application.server)
      .patch("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pinnedSessionIds: ["mock-active"],
        pinnedProjectCwds: ["/home/demo/project"],
        hiddenSessionIds: ["mock-older"],
      })
      .expect(200);
    expect(curated.body).toMatchObject({
      pinnedSessionIds: ["mock-active"],
      pinnedProjectCwds: ["/home/demo/project"],
      hiddenSessionIds: ["mock-older"],
    });

    const summaries = await request(application.server)
      .post("/api/sessions/by-id")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: ["mock-active", "missing"] })
      .expect(200);
    expect(summaries.body.sessions).toHaveLength(1);
    expect(summaries.body.sessions[0].id).toBe("mock-active");

    // A pinned folder is claimed whole, so it hydrates by working directory
    // instead of depending on which of its sessions paged in.
    const folder = await request(application.server)
      .post("/api/sessions/by-cwd")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwds: ["/home/demo/research", "/nowhere"] })
      .expect(200);
    expect(
      folder.body.sessions.map((session: { cwd: string }) => session.cwd),
    ).toEqual(["/home/demo/research"]);
    await request(application.server)
      .post("/api/sessions/by-cwd")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwds: "/home/demo/research" })
      .expect(400);

    await request(application.server)
      .patch("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ pinnedSessionIds: [] })
      .expect(200)
      .expect((response) => {
        expect(response.body.pinnedSessionIds).toEqual([]);
        // A field-scoped patch leaves the other curated lists alone.
        expect(response.body.hiddenSessionIds).toEqual(["mock-older"]);
      });
  });

  it("delivers the snapshot before any live event on a new socket", async () => {
    let releaseSnapshot!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseSnapshot = resolveGate;
    });
    class GatedRuntime extends MockRuntime {
      override async snapshot() {
        await gate;
        return super.snapshot();
      }
    }
    const runtime = new GatedRuntime();
    const gatedApp = createInspireServer({
      token,
      runtime,
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(temporary, "uploads-gated")),
      preferences: new PreferencesStore(
        join(temporary, "preferences-gated.json"),
      ),
      resources: new ResourceStore(),
      git,
      mock: true,
      version: "0.1.0-test",
      piVersion: "0.80.10",
      distDir: join(temporary, "missing-dist"),
    });
    await new Promise<void>((resolve) =>
      gatedApp.server.listen(0, "127.0.0.1", resolve),
    );
    const address = gatedApp.server.address() as AddressInfo;
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/events?token=${token}`,
    );
    const frames: Array<Record<string, unknown>> = [];
    socket.on("message", (data) =>
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });

      // A live event lands while the snapshot is still loading; it must not
      // overtake the snapshot frame.
      runtime.emit("event", {
        type: "message_update",
        sessionId: "mock-active",
      });
      releaseSnapshot();

      await new Promise<void>((resolve, reject) => {
        let poll: ReturnType<typeof setInterval>;
        const timeout = setTimeout(() => {
          clearInterval(poll);
          reject(new Error("socket frames did not arrive"));
        }, 2_000);
        poll = setInterval(() => {
          if (frames.length < 2) return;
          clearInterval(poll);
          clearTimeout(timeout);
          resolve();
        }, 10);
      });
      expect(frames[0]?.type).toBe("snapshot");
      expect(frames[1]?.type).toBe("message_update");
    } finally {
      releaseSnapshot();
      socket.close();
      await gatedApp.close();
    }
  });

  it("keeps joined sockets observable and terminates clients that stop answering pings", async () => {
    const heartbeatApp = createInspireServer({
      token,
      runtime: new MockRuntime(),
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(temporary, "uploads-heartbeat")),
      preferences: new PreferencesStore(
        join(temporary, "preferences-heartbeat.json"),
      ),
      resources: new ResourceStore(),
      git,
      mock: true,
      version: "0.1.0-test",
      piVersion: "0.80.10",
      distDir: join(temporary, "missing-dist"),
      websocketHeartbeatIntervalMs: 20,
    });
    await new Promise<void>((resolve) =>
      heartbeatApp.server.listen(0, "127.0.0.1", resolve),
    );
    const address = heartbeatApp.server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}/events?token=${token}`;
    const responsive = new WebSocket(url);
    try {
      const ping = new Promise<void>((resolve) =>
        responsive.once("ping", resolve),
      );
      const heartbeat = new Promise<void>((resolve, reject) => {
        responsive.on("message", (data) => {
          try {
            const frame = JSON.parse(data.toString()) as { type?: unknown };
            if (frame.type === "heartbeat") resolve();
          } catch (error) {
            reject(error);
          }
        });
        responsive.once("error", reject);
      });
      await Promise.race([
        Promise.all([ping, heartbeat]),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("heartbeat was not observed")),
            1_000,
          ),
        ),
      ]);
      responsive.close();

      const unresponsive = new WebSocket(url, { autoPong: false });
      const closed = new Promise<number>((resolve, reject) => {
        unresponsive.once("close", resolve);
        unresponsive.once("error", () => undefined);
        setTimeout(
          () => reject(new Error("unresponsive socket remained open")),
          1_000,
        );
      });
      expect(await closed).toBe(1006);
    } finally {
      responsive.close();
      await heartbeatApp.close();
    }
  });

  it("closes a joining socket whose pre-snapshot event backlog exceeds the bound", async () => {
    let releaseSnapshot!: () => void;
    const gate = new Promise<void>(
      (resolveGate) => (releaseSnapshot = resolveGate),
    );
    class GatedRuntime extends MockRuntime {
      override async snapshot() {
        await gate;
        return super.snapshot();
      }
    }
    const runtime = new GatedRuntime();
    const gatedApp = createInspireServer({
      token,
      runtime,
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(temporary, "uploads-backlog")),
      preferences: new PreferencesStore(
        join(temporary, "preferences-backlog.json"),
      ),
      resources: new ResourceStore(),
      git,
      mock: true,
      version: "0.1.0-test",
      piVersion: "0.80.10",
      distDir: join(temporary, "missing-dist"),
    });
    await new Promise<void>((resolve) =>
      gatedApp.server.listen(0, "127.0.0.1", resolve),
    );
    const address = gatedApp.server.address() as AddressInfo;
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/events?token=${token}`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const closed = new Promise<number>((resolve) =>
        socket.once("close", resolve),
      );
      const payload = "x".repeat(64 * 1024);
      for (
        let sent = 0;
        sent <= MAX_JOINING_EVENT_BYTES;
        sent += payload.length
      ) {
        runtime.emit("event", { type: "message_update", payload });
      }
      expect(await closed).toBe(1013);
    } finally {
      releaseSnapshot();
      socket.close();
      await gatedApp.close();
    }
  });

  it("rejects session-scoped writes that do not name their session", async () => {
    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "no target" })
      .expect(400);
    await request(application.server)
      .post("/api/control/abort")
      .set("Authorization", `Bearer ${token}`)
      .send({})
      .expect(400);
    // An addressed write to a session the host has not opened is refused,
    // never redirected to the current selection.
    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId: "never-opened", message: "hello" })
      .expect(409);
  });

  it("serves transcript-referenced and workspace-indexed files, nothing else", async () => {
    await writeFile(join(temporary, "preview.md"), "# Host preview\n");
    await writeFile(join(temporary, "notes.txt"), "workspace note\n");
    await mkdir(join(temporary, "node_modules"));
    await writeFile(
      join(temporary, "node_modules", "mentioned.txt"),
      "vendored but cited\n",
    );
    await writeFile(
      join(temporary, "node_modules", "hidden.txt"),
      "vendored\n",
    );
    const opened = await request(application.server)
      .post("/api/sessions/new")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwd: temporary })
      .expect(200);
    const sessionId = opened.body.active.sessionId as string;
    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId,
        message:
          "Open [the preview](preview.md), [the vendored note](node_modules/mentioned.txt), and `missing.md`.",
      })
      .expect(202);

    const listed = await request(application.server)
      .post("/api/resources/list")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId })
      .expect(200);
    expect(listed.body).toMatchObject({ sessionId });
    expect(listed.body.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reference: "preview.md" }),
        expect.objectContaining({ reference: "node_modules/mentioned.txt" }),
        expect.objectContaining({ reference: "missing.md" }),
      ]),
    );

    const probed = await request(application.server)
      .post("/api/resources/probe")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId,
        references: ["preview.md", "missing.md", "node_modules/hidden.txt"],
      })
      .expect(200);
    expect(probed.body).toMatchObject({
      sessionId,
      revision: expect.any(Number),
      results: [
        { reference: "preview.md", availability: "available" },
        { reference: "missing.md", availability: "missing" },
        { reference: "node_modules/hidden.txt", availability: "unavailable" },
      ],
    });

    const resolved = await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "preview.md" })
      .expect(200);
    expect(resolved.body).toMatchObject({
      name: "preview.md",
      kind: "markdown",
    });

    const content = await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(content.text).toBe("# Host preview\n");
    expect(content.headers["accept-ranges"]).toBe("bytes");

    // A head-slice Range (how the client caps text previews) yields 206.
    const ranged = await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .set("Range", "bytes=0-5")
      .expect(206);
    expect(ranged.headers["content-range"]).toBe("bytes 0-5/15");
    expect(ranged.text).toBe("# Host");
    // Invalid ranges must not fall back to serving the complete file.
    await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .set("Range", "bytes=999-1000")
      .expect(416);

    // Indexed workspace files preview without a transcript mention — the
    // explorer's click path.
    await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "notes.txt" })
      .expect(200);
    // A transcript mention still reaches files the index ignores.
    await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "node_modules/mentioned.txt" })
      .expect(200);
    // Existing inside the cwd is not enough: neither indexed nor mentioned.
    await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "node_modules/hidden.txt" })
      .expect(403);
    await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "unmentioned.txt" })
      .expect(403);

    // A handle resolved here must stop serving once another session is the
    // visible one, even though the handle itself is still alive.
    await request(application.server)
      .post("/api/sessions/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "mock-active" })
      .expect(200);
    await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .expect(409);
  });

  it("uses the current resource size after resolve when a file grows or shrinks", async () => {
    const resourcePath = join(temporary, "changing.md");
    await writeFile(resourcePath, "old\n");
    const opened = await request(application.server)
      .post("/api/sessions/new")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwd: temporary })
      .expect(200);
    const sessionId = opened.body.active.sessionId as string;
    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, message: "Open [changing](changing.md)." })
      .expect(202);
    const resolved = await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "changing.md" })
      .expect(200);
    expect(resolved.body.size).toBe(4);

    const grown = "grown-content\n";
    await writeFile(resourcePath, grown);
    const grownResponse = await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .set("Range", "bytes=0-262143")
      .expect(206);
    expect(grownResponse.headers["content-range"]).toBe(
      `bytes 0-${grown.length - 1}/${grown.length}`,
    );
    expect(grownResponse.text).toBe(grown);

    const shrunk = "new\n";
    await writeFile(resourcePath, shrunk);
    const shrunkResponse = await request(application.server)
      .get(
        `/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      )
      .set("Authorization", `Bearer ${token}`)
      .set("Range", "bytes=0-262143")
      .expect(206);
    expect(shrunkResponse.headers["content-range"]).toBe(
      `bytes 0-${shrunk.length - 1}/${shrunk.length}`,
    );
    expect(shrunkResponse.text).toBe(shrunk);
  });

  it("closes an opened file when the client aborts during authorization", async () => {
    await writeFile(join(temporary, "slow.md"), "slow preview\n");
    const openedSession = await request(application.server)
      .post("/api/sessions/new")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwd: temporary })
      .expect(200);
    const sessionId = openedSession.body.active.sessionId as string;
    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, message: "Open [slow](slow.md)." })
      .expect(202);
    const resolved = await request(application.server)
      .post("/api/resources/resolve")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId, reference: "slow.md" })
      .expect(200);

    let releaseOpen!: () => void;
    const gate = new Promise<void>(
      (resolveGate) => (releaseOpen = resolveGate),
    );
    let opened!: () => void;
    const openedHandle = new Promise<void>(
      (resolveOpened) => (opened = resolveOpened),
    );
    let handle:
      | Awaited<ReturnType<ResourceStore["openForServing"]>>["handle"]
      | null = null;
    const openForServing = resources.openForServing.bind(resources);
    resources.openForServing = async (resource) => {
      const result = await openForServing(resource);
      handle = result.handle;
      opened();
      await gate;
      return result;
    };

    const controller = new AbortController();
    const fetching = fetch(
      `${baseUrl}/api/resources/${resolved.body.id}/content?sessionId=${encodeURIComponent(sessionId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    ).catch((error: Error) => error);
    await openedHandle;
    controller.abort();
    const failure = await fetching;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("AbortError");
    releaseOpen();

    await vi.waitFor(async () => {
      await expect(handle!.stat()).rejects.toMatchObject({ code: "EBADF" });
    });
  });

  it("honors byte ranges for embedded resources as well as filesystem files", async () => {
    const sessionId = "embedded-session";
    class EmbeddedRuntime extends MockRuntime {
      override get activeSessionId(): string {
        return sessionId;
      }
      override async resourceContext(requestedSessionId: string) {
        if (requestedSessionId !== sessionId)
          throw Object.assign(new Error("Wrong session"), { status: 409 });
        return {
          sessionId,
          viewId: "embedded-view",
          cwd: temporary,
          messages: [
            {
              role: "toolResult",
              content: [
                {
                  type: "image",
                  data: Buffer.from("image-bytes").toString("base64"),
                  mimeType: "image/png",
                },
              ],
            },
          ],
        };
      }
    }
    const served = createInspireServer({
      token,
      runtime: new EmbeddedRuntime(),
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(temporary, "embedded-uploads")),
      preferences: new PreferencesStore(
        join(temporary, "embedded-preferences.json"),
      ),
      resources: new ResourceStore(),
      git,
      mock: true,
      version: "0.1.0-test",
      piVersion: "0.80.10",
      distDir: join(temporary, "missing-embedded-dist"),
    });
    await new Promise<void>((resolve) =>
      served.server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const resolved = await request(served.server)
        .post("/api/resources/resolve")
        .set("Authorization", `Bearer ${token}`)
        .send({ sessionId, reference: "pi-embedded://0/0" })
        .expect(200);
      const ranged = await request(served.server)
        .get(
          `/api/resources/${resolved.body.id}/content?sessionId=${sessionId}`,
        )
        .set("Authorization", `Bearer ${token}`)
        .set("Range", "bytes=0-4")
        .expect(206);
      expect(ranged.headers["content-range"]).toBe("bytes 0-4/11");
      expect(Buffer.from(ranged.body).toString()).toBe("image");
    } finally {
      await served.close();
    }
  });

  it("deletes withdrawn attachments from the host cache", async () => {
    const uploaded = await request(application.server)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", Buffer.from("draft"), {
        filename: "draft.txt",
        contentType: "text/plain",
      })
      .expect(200);
    const id = uploaded.body.attachments[0].id as string;
    await request(application.server)
      .delete(`/api/attachments/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200, { ok: true });
    // Idempotent: a second delete of the same id still succeeds.
    await request(application.server)
      .delete(`/api/attachments/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200, { ok: true });
    await request(application.server)
      .delete("/api/attachments/not-a-uuid")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
  });

  it("rejects multipart batches at the aggregate streaming budget and removes partial files", async () => {
    await request(application.server)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES), {
        filename: "one.bin",
      })
      .attach("files", Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES), {
        filename: "two.bin",
      })
      .attach("files", Buffer.alloc(1), { filename: "overflow.bin" })
      .expect(413);
    expect(await readdir(join(temporary, "uploads"))).toEqual([]);
  }, 15_000);

  it("accepts bounded attachments and streams prompt events over an authenticated socket", async () => {
    await request(application.server)
      .post("/api/sessions/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ id: "mock-active" })
      .expect(200);

    const uploaded = await request(application.server)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .attach("files", Buffer.from("research notes"), {
        filename: "notes.txt",
        contentType: "text/plain",
      })
      .expect(200);
    expect(uploaded.body.attachments[0]).toMatchObject({
      fileName: "notes.txt",
      kind: "file",
      size: 14,
    });
    expect(uploaded.body.attachments[0]).not.toHaveProperty("path");
    const storedFiles = await readdir(join(temporary, "uploads"));
    expect(storedFiles).toHaveLength(1);
    expect(
      (await stat(join(temporary, "uploads", storedFiles[0]!))).mode & 0o777,
    ).toBe(0o600);

    const events: Array<Record<string, unknown>> = [];
    const socket = new WebSocket(
      `${baseUrl.replace("http", "ws")}/events?token=${token}`,
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.on("message", (data) =>
      events.push(JSON.parse(data.toString()) as Record<string, unknown>),
    );

    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId: "mock-active",
        message: "Integrate this note",
        attachmentIds: [uploaded.body.attachments[0].id],
      })
      .expect(202, { accepted: true });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("mock stream did not settle")),
        2_000,
      );
      const poll = setInterval(() => {
        if (!events.some((event) => event.type === "agent_settled")) return;
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }, 10);
    });
    expect(events.some((event) => event.type === "message_update")).toBe(true);
    socket.close();
  });

  it("deletes a complete Hidden folder and clears its curation only after the committed batch", async () => {
    const cwd = "/tmp/hidden-folder";
    const deleted = vi
      .spyOn(runtime, "deleteHiddenFolderSessions")
      .mockResolvedValue({
        cwd,
        deleted: [
          { sessionId: "one", disposition: "trashed" },
          { sessionId: "two", disposition: "deleted" },
        ],
      });
    const forget = vi.spyOn(resources, "forgetSession");
    await request(application.server)
      .patch("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pinnedSessionIds: ["one"],
        hiddenSessionIds: ["two"],
        pinnedProjectCwds: [cwd],
        hiddenProjectCwds: [cwd],
        navCollapsedGroups: [cwd],
      })
      .expect(200);

    const response = await request(application.server)
      .post("/api/sessions/delete-hidden-folder")
      .set("Authorization", `Bearer ${token}`)
      .send({ cwd, sessionIds: ["one", "two"] })
      .expect(200);
    expect(deleted).toHaveBeenCalledWith(cwd, ["one", "two"]);
    expect(response.body).toMatchObject({
      cwd,
      deleted: [
        { sessionId: "one", disposition: "trashed" },
        { sessionId: "two", disposition: "deleted" },
      ],
      preferences: {
        pinnedSessionIds: [],
        hiddenSessionIds: [],
        pinnedProjectCwds: [],
        hiddenProjectCwds: [],
        navCollapsedGroups: [],
      },
    });
    expect(forget).toHaveBeenCalledWith("one");
    expect(forget).toHaveBeenCalledWith("two");
  });

  it("deletes an unselected session and atomically removes its navigation identities", async () => {
    await request(application.server)
      .patch("/api/preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({
        pinnedSessionIds: ["mock-history"],
        hiddenSessionIds: ["mock-history"],
      })
      .expect(200);
    const forget = vi.spyOn(resources, "forgetSession");

    await request(application.server)
      .delete("/api/sessions/mock-history")
      .expect(401);
    const deleted = await request(application.server)
      .delete("/api/sessions/mock-history")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(deleted.body).toMatchObject({
      sessionId: "mock-history",
      disposition: "trashed",
      preferences: { pinnedSessionIds: [], hiddenSessionIds: [] },
    });
    expect(forget).toHaveBeenCalledWith("mock-history");

    const sessions = await request(application.server)
      .get("/api/sessions")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(sessions.body.sessions).not.toContainEqual(
      expect.objectContaining({ id: "mock-history" }),
    );
    await request(application.server)
      .delete("/api/sessions/mock-history")
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });
});
