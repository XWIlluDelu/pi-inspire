import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PROMPT_CHARS } from "../../shared/contracts.js";

import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";

describe("typed Host API", () => {
  let temporary: Awaited<ReturnType<typeof hostApiFixture>>["temporary"];
  let application: Awaited<ReturnType<typeof hostApiFixture>>["application"];
  let resources: Awaited<ReturnType<typeof hostApiFixture>>["resources"];
  let runtime: Awaited<ReturnType<typeof hostApiFixture>>["runtime"];
  let attachments: Awaited<ReturnType<typeof hostApiFixture>>["attachments"];
  let shutdown: Awaited<ReturnType<typeof hostApiFixture>>["shutdown"];
  let baseUrl: Awaited<ReturnType<typeof hostApiFixture>>["baseUrl"];
  let api: Awaited<ReturnType<typeof hostApiFixture>>["api"];
  let promptDelivery: Awaited<
    ReturnType<typeof hostApiFixture>
  >["promptDelivery"];
  let fixture: Awaited<ReturnType<typeof hostApiFixture>>;
  beforeEach(async () => {
    fixture = await hostApiFixture();
    ({
      temporary,
      application,
      resources,
      runtime,
      attachments,
      shutdown,
      baseUrl,
      api,
      promptDelivery,
    } = fixture);
  });
  afterEach(async () => closeHostApiFixture(fixture));

  it("accepts an escaped prompt at the character limit", async () => {
    const prompt = vi.spyOn(runtime, "prompt").mockResolvedValue(null);
    const message = "\u0000".repeat(MAX_PROMPT_CHARS);
    await fixture.localRequest
      .post("/api/prompt")
      .send(promptDelivery({ sessionId: "fixture-active", message }))
      .expect(202);
    expect(prompt).toHaveBeenCalledExactlyOnceWith({
      sessionId: "fixture-active",
      message,
    });
  });

  it("sets production HTTP behavior without overriding the user's NODE_ENV", () => {
    expect(application.app.get("env")).toBe("production");
    // Vitest supplies development; production belongs to Express, not its parent environment.
    expect(process.env.NODE_ENV).toBe("development");
  });

  it("loads private tool presentation declarations into authenticated bootstrap", async () => {
    await writeFile(
      join(temporary, "tool-presentations.json"),
      JSON.stringify({
        version: 1,
        rules: {
          "user.example.tool": {
            summary: [{ value: { path: "args.query" } }],
            blocks: [],
          },
        },
        mappings: { example: "user.example.tool" },
        customMessages: {
          review_message: {
            source: "Review",
            title: ["details.sender"],
            body: "details.body",
          },
        },
        thinking: {
          summary: [{ value: { path: "thinking.text", format: "first-line" } }],
          blocks: [{ type: "markdown", source: { path: "thinking.text" } }],
        },
      }),
    );

    const response = await api().expect(200);
    expect(response.body.toolPresentations.mappings).toEqual({
      example: "user.example.tool",
    });
    expect(response.body.toolPresentations.thinking).toMatchObject({
      summary: [{ value: { path: "thinking.text", format: "first-line" } }],
      blocks: [{ type: "markdown" }],
    });
    expect(response.body.toolPresentations.customMessages).toEqual({
      review_message: {
        source: "Review",
        title: ["details.sender"],
        body: "details.body",
      },
    });
    expect(response.body.toolPresentationsWarning).toBeUndefined();
  });

  it("finishes the authenticated shutdown acknowledgement before dispatching teardown", async () => {
    const sequence: string[] = [];
    application.server.prependListener("request", (_request, response) => {
      response.once("finish", () => {
        if (response.statusCode === 202) sequence.push("acknowledged");
      });
    });
    shutdown.mockImplementation(() => {
      sequence.push("shutdown");
    });

    await request(application.server).post("/api/host/shutdown").expect(401);
    expect(shutdown).not.toHaveBeenCalled();
    await fixture.localRequest.post("/api/host/shutdown").expect(202);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    expect(sequence).toEqual(["acknowledged", "shutdown"]);
  });

  it("keeps release update status behind local authentication", async () => {
    await request(application.server).get("/api/update").expect(401);
    const response = await fixture.localRequest.get("/api/update").expect(200);
    expect(response.body).toMatchObject({
      kind: "available",
      update: {
        currentVersion: "0.1.0-test",
        latestVersion: "0.2.0",
        releaseUrl: "https://github.com/example/inspire/releases/tag/v0.2.0",
      },
      updateStatus: {
        inspireUpdateChecking: false,
        availableUpdateIdentity: '[["inspire","0.2.0"]]',
      },
    });
  });

  it("keeps Pi and extension update status behind local authentication", async () => {
    await request(application.server).get("/api/pi-update").expect(401);
    const response = await fixture.localRequest
      .get("/api/pi-update")
      .query({ refresh: "1" })
      .expect(200);
    expect(response.body).toMatchObject({
      currentVersion: "0.80.10",
      pi: {
        kind: "available",
        latestVersion: "0.84.3",
        releaseUrl: "https://pi.dev/changelog",
      },
      extensions: {
        kind: "available",
        updates: [
          {
            displayName: "pi-web-access",
            type: "npm",
          },
        ],
      },
      updateStatus: { piUpdateChecking: false },
    });
  });

  it("generates a resume command for the new folder after the original project moves", async () => {
    const session = await fixture.catalog.get("fixture-active");
    if (!session) throw new Error("Missing fixture session");
    const resume = () =>
      fixture.localRequest
        .get("/api/sessions/resume-command")
        .query({ sessionId: session.id });
    const command = `pi --session '${session.path}'`;
    const changeDirectory =
      process.platform === "win32" ? "Set-Location -LiteralPath" : "cd --";
    await resume().expect(200, {
      command: `${changeDirectory} '${session.cwd}' && ${command}`,
    });

    await rename(session.cwd, join(temporary, "moved-workspace"));

    await resume().expect(200, { command, projectDirectoryMissing: true });
  });

  it("preflights Pi defaults and project files against one canonical prospective workspace", async () => {
    await writeFile(join(temporary, "app.ts"), "export {};\n");

    const defaults = await fixture.localRequest
      .get("/api/models")
      .query({ cwd: join(temporary, ".") })
      .expect(200);
    expect(defaults.body.defaults).toEqual({
      cwd: temporary,
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        reasoning: true,
      },
      thinkingLevel: "high",
    });

    const files = await fixture.localRequest
      .get("/api/new-session/files")
      .query({ cwd: join(temporary, "."), q: "app" })
      .expect(200);
    expect(files.body).toEqual({
      cwd: temporary,
      truncated: false,
      files: [{ path: "app.ts", name: "app.ts" }],
    });

    await fixture.localRequest
      .get("/api/models")
      .query({ cwd: join(temporary, "missing") })
      .expect(400, {
        error: "Project path does not exist",
        code: "PROJECT_DIRECTORY_MISSING",
      });
  });

  it("forwards explicit directory creation only through authenticated new-session requests", async () => {
    const create = vi.spyOn(runtime, "newSession");
    const body = {
      cwd: join(temporary, "new-project"),
      createDirectory: true,
      model: { provider: "anthropic", id: "claude-sonnet-4" },
      thinkingLevel: "high",
    };
    await request(application.server)
      .post("/api/sessions/new")
      .send(body)
      .expect(401);
    expect(create).not.toHaveBeenCalled();
    await fixture.localRequest
      .post("/api/sessions/new")
      .send({ ...body, createDirectory: "true" })
      .expect(400);
    expect(create).not.toHaveBeenCalled();
    await fixture.localRequest.post("/api/sessions/new").send(body).expect(200);
    expect(create).toHaveBeenCalledWith(body.cwd, {
      createDirectory: true,
      model: body.model,
      thinkingLevel: "high",
    });
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
      const snapshot = await originalSnapshot();
      await gate;
      return snapshot;
    });
    vi.spyOn(runtime, "close").mockImplementation(async () => {
      releaseSnapshot();
      await originalClose();
    });
    const active = fixture.localRequest.get("/api/snapshot");
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

  it("lists and opens Pi sessions through the typed API", async () => {
    const sessions = await fixture.localRequest
      .get("/api/sessions?q=formula")
      .expect(200);
    expect(sessions.body.total).toBe(1);
    expect(sessions.body.sessions[0]).toMatchObject({
      id: "fixture-active",
      project: "workspace",
    });
    const page = await fixture.localRequest
      .get("/api/sessions?offset=1&limit=1")
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
      await fixture.localRequest.get(`/api/sessions?${invalid}`).expect(400);
    }

    const opened = await fixture.localRequest
      .post("/api/sessions/open")
      .send({ id: "fixture-active" })
      .expect(200);
    expect(opened.body.active.transcriptPage.messages).toHaveLength(5);
    expect(opened.body.active.model.id).toBe("offline");
  });

  it("authenticates Pending clear, recovery, and exact-text reads without individual management", async () => {
    const clear = vi
      .spyOn(runtime, "clearPending")
      .mockResolvedValue(undefined);
    await request(application.server)
      .post("/api/pending/clear")
      .send({ sessionId: "fixture-active" })
      .expect(401);
    expect(clear).not.toHaveBeenCalled();
    await fixture.localRequest
      .post("/api/pending/clear")
      .send({ sessionId: "fixture-active", expectedRevision: 1 })
      .expect(400);
    expect(clear).not.toHaveBeenCalled();
    await fixture.localRequest
      .post("/api/pending/clear")
      .send({ sessionId: "fixture-active" })
      .expect(200, { ok: true });
    expect(clear).toHaveBeenCalledExactlyOnceWith("fixture-active");
    const recover = vi
      .spyOn(runtime, "recoverPending")
      .mockResolvedValue({ steering: ["complete"], followUp: ["later"] });
    const text = vi
      .spyOn(runtime, "pendingText")
      .mockResolvedValue({ text: "x".repeat(2000) });
    for (const path of ["/api/pending/recover", "/api/pending/text"]) {
      await request(application.server)
        .post(path)
        .send({ sessionId: "fixture-active" })
        .expect(401);
    }
    const recovered = await fixture.localRequest
      .post("/api/pending/recover")
      .send({
        sessionId: "fixture-active",
        operationId: randomUUID(),
        authorityId: application.authorityId,
      })
      .expect(200);
    expect(recovered.body).toEqual({
      steering: ["complete"],
      followUp: ["later"],
    });
    expect(recover).toHaveBeenCalledExactlyOnceWith(
      "fixture-active",
      undefined,
    );
    const copied = await fixture.localRequest
      .post("/api/pending/text")
      .send({
        sessionId: "fixture-active",
        viewId: "view",
        revision: 7,
        itemId: "text-steer-0",
      })
      .expect(200);
    expect(copied.body.text).toHaveLength(2000);
    expect(copied.headers["cache-control"]).toBe("no-store");
    expect(text).toHaveBeenCalledExactlyOnceWith({
      sessionId: "fixture-active",
      viewId: "view",
      revision: 7,
      itemId: "text-steer-0",
    });
    for (const path of ["/api/pending"]) {
      await fixture.localRequest
        .post(path)
        .send({ sessionId: "fixture-active" })
        .expect(404);
    }
  });

  it("dispatches a validated native command only to its authenticated explicit target", async () => {
    await runtime.openSession("fixture-active");
    await runtime.openSession("fixture-history");
    const native = vi.spyOn(runtime, "nativeCommand").mockResolvedValue({
      command: "compact",
      outcome: "completed",
      message: "Compaction completed",
    });

    await request(application.server)
      .post("/api/control/native-command")
      .send({ sessionId: "fixture-active", command: "compact" })
      .expect(401);
    await fixture.localRequest
      .post("/api/control/native-command")
      .send({ sessionId: "fixture-active", command: "unknown" })
      .expect(400);
    expect(native).not.toHaveBeenCalled();

    const command = {
      sessionId: "fixture-active",
      command: "compact",
      argument: "preserve decisions",
    };
    const compacted = await fixture.localRequest
      .post("/api/control/native-command")
      .send(command)
      .expect(200);
    expect(compacted.headers["cache-control"]).toContain("no-store");
    expect(compacted.body).toMatchObject({
      command: "compact",
      outcome: "completed",
    });
    expect(native).toHaveBeenCalledExactlyOnceWith(command);
    expect(runtime.activeSessionId).toBe("fixture-history");
  });

  it.each([
    {
      route: "auto-compaction",
      method: "setAutoCompaction",
      field: "enabled",
      value: false,
      invalid: "false",
      stateKey: "autoCompactionEnabled",
    },
    {
      route: "auto-retry",
      method: "setAutoRetry",
      field: "enabled",
      value: false,
      invalid: "false",
      stateKey: "autoRetryEnabled",
    },
    {
      route: "steering-mode",
      method: "setSteeringMode",
      field: "mode",
      value: "one-at-a-time",
      invalid: "invalid",
      stateKey: "steeringMode",
    },
    {
      route: "follow-up-mode",
      method: "setFollowUpMode",
      field: "mode",
      value: "all",
      invalid: "invalid",
      stateKey: "followUpMode",
    },
  ] as const)(
    "$route changes only the named session's field after authentication and validation",
    async ({ route, method, field, value, invalid, stateKey }) => {
      await runtime.openSession("fixture-active");
      await runtime.openSession("fixture-history");
      const targetBefore = (await runtime.snapshot("fixture-active")).active!
        .runtimeSettings;
      const selectedBefore = (await runtime.snapshot()).active!.runtimeSettings;
      const change = vi.spyOn(runtime, method);
      const path = `/api/control/${route}`;
      const body = { sessionId: "fixture-active", [field]: value };

      await request(application.server).post(path).send(body).expect(401);
      for (const invalidBody of [
        { [field]: value },
        { sessionId: "fixture-active", [field]: invalid },
      ])
        await fixture.localRequest.post(path).send(invalidBody).expect(400);
      expect(change).not.toHaveBeenCalled();

      await fixture.localRequest
        .post(path)
        .send(body)
        .expect(200, { ok: true });
      expect(change).toHaveBeenCalledExactlyOnceWith("fixture-active", value);
      expect(
        (await runtime.snapshot("fixture-active")).active?.runtimeSettings,
      ).toEqual({ ...targetBefore, [stateKey]: value });
      expect((await runtime.snapshot()).active?.runtimeSettings).toEqual(
        selectedBefore,
      );
      expect(runtime.activeSessionId).toBe("fixture-history");
    },
  );

  it("clears host selection when the browser opens New session", async () => {
    await fixture.localRequest
      .post("/api/sessions/open")
      .send({ id: "fixture-active" })
      .expect(200);
    expect(runtime.activeSessionId).toBe("fixture-active");

    const deselected = await fixture.localRequest
      .post("/api/sessions/deselect")
      .expect(200);
    expect(deselected.body).toMatchObject({ active: null, runState: "idle" });
    expect(runtime.activeSessionId).toBeNull();
  });

  it("serves authenticated session-addressed transcript pages", async () => {
    const page = {
      sessionId: "fixture-active",
      revision: 7,
      viewId: "fixture-view-fixture-active",
      composerHistoryVersion: "history-1",
      messages: [{ role: "user", content: "older", timestamp: 1 }],
      hasOlder: false,
      olderCursor: null,
    };
    const activityPage = {
      sessionId: "fixture-active",
      revision: 7,
      viewId: "fixture-view-fixture-active",
      messages: [{ role: "toolResult", content: "deferred", timestamp: 2 }],
      hasMore: false,
      cursor: null,
    };
    const paging = vi.spyOn(runtime, "transcriptPage").mockResolvedValue(page);
    const activityPaging = vi
      .spyOn(runtime, "transcriptActivityPage")
      .mockResolvedValue(activityPage);
    const userTurnIndex = vi
      .spyOn(runtime, "transcriptUserTurns")
      .mockResolvedValue({
        sessionId: "fixture-active",
        revision: 7,
        viewId: "fixture-view-fixture-active",
        total: 1,
        start: 0,
        turns: [
          {
            id: "user-0",
            ordinal: 0,
            snippet: "prompt",
            attachmentCount: 0,
          },
        ],
      });
    const userTurnTranscript = vi
      .spyOn(runtime, "transcriptUserTurn")
      .mockResolvedValue({
        ...page,
        targetMessageId: "user-0",
        rangeStart: 0,
        rangeEnd: 1,
        hasMoreInTurn: false,
        continuationCursor: null,
      });
    const composerHistory = vi
      .spyOn(runtime, "composerHistory")
      .mockResolvedValue({
        sessionId: "fixture-active",
        revision: 7,
        viewId: "fixture-view-fixture-active",
        historyId: "history-7",
        composerHistoryVersion: "history-1",
        total: 1,
        start: 0,
        entries: [{ text: "prompt", images: [], files: [] }],
        nextStart: null,
      });
    await request(application.server)
      .get(
        "/api/transcript/older?sessionId=fixture-active&cursor=opaque-cursor",
      )
      .expect(401);
    const response = await fixture.localRequest
      .get(
        "/api/transcript/older?sessionId=fixture-active&cursor=opaque-cursor",
      )
      .expect(200);
    expect(response.body).toEqual(page);
    expect(paging).toHaveBeenCalledWith("fixture-active", "opaque-cursor");

    await request(application.server)
      .get(
        "/api/transcript/activity?sessionId=fixture-active&cursor=range-cursor",
      )
      .expect(401);
    const activityResponse = await fixture.localRequest
      .get(
        "/api/transcript/activity?sessionId=fixture-active&cursor=range-cursor",
      )
      .expect(200);
    expect(activityResponse.body).toEqual(activityPage);
    expect(activityPaging).toHaveBeenCalledWith(
      "fixture-active",
      "range-cursor",
    );

    await request(application.server)
      .get("/api/transcript/user-turns?sessionId=fixture-active&start=0")
      .expect(401);
    await fixture.localRequest
      .get("/api/transcript/user-turns?sessionId=fixture-active&start=0")
      .expect(200)
      .expect((result) => expect(result.body.turns).toHaveLength(1));
    expect(userTurnIndex).toHaveBeenCalledWith("fixture-active", 0);

    await request(application.server)
      .get("/api/transcript/user-turn?sessionId=fixture-active&id=user-0")
      .expect(401);
    await fixture.localRequest
      .get(
        "/api/transcript/user-turn?sessionId=fixture-active&id=user-0&cursor=turn-cursor",
      )
      .expect(200)
      .expect((result) => expect(result.body.targetMessageId).toBe("user-0"));
    expect(userTurnTranscript).toHaveBeenCalledWith(
      "fixture-active",
      "user-0",
      "turn-cursor",
    );

    await request(application.server)
      .get("/api/composer/history?sessionId=fixture-active&start=0")
      .expect(401);
    await fixture.localRequest
      .get("/api/composer/history?sessionId=fixture-active&start=0")
      .expect(200)
      .expect((result) =>
        expect(result.body.entries).toEqual([
          { text: "prompt", images: [], files: [] },
        ]),
      );
    expect(composerHistory).toHaveBeenCalledWith("fixture-active", 0);
  });

  it("serves complete assistant text only through an authenticated session/branch read", async () => {
    const text = `${"x".repeat(70_000)}THE_END_42`;
    const copy = vi
      .spyOn(runtime, "lastAssistantText")
      .mockResolvedValue({ text });
    const path =
      "/api/transcript/assistant-text?sessionId=fixture-active&viewId=branch-1";
    await request(application.server).get(path).expect(401);
    await fixture.localRequest
      .get(path)
      .expect(200)
      .expect((result) => expect(result.body.text).toBe(text));
    expect(copy).toHaveBeenCalledWith("fixture-active", "branch-1");
    await fixture.localRequest
      .get("/api/transcript/assistant-text?sessionId=fixture-active")
      .expect(400);
  });

  it("serves authenticated, bounded, session-addressed branch operations", async () => {
    const branchTree = {
      sessionId: "fixture-active",
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
      snapshot: await runtime.openSession("fixture-active"),
      editorText: "original",
    });
    const fork = vi.spyOn(runtime, "forkBranch").mockResolvedValue({
      sessionId: "forked",
      snapshot: await runtime.openSession("fixture-active"),
      editorText: "original",
    });
    const sourceSnapshot = await runtime.openSession("fixture-active");
    const clone = vi.spyOn(runtime, "cloneBranch").mockResolvedValue({
      sessionId: "cloned",
      editorText: "",
      snapshot: {
        ...sourceSnapshot,
        active: { ...sourceSnapshot.active!, sessionId: "cloned" },
      },
    });
    const entry = vi.spyOn(runtime, "branchEntry").mockResolvedValue({
      sessionId: "fixture-active",
      revision: 3,
      text: "Complete retained answer",
      totalChars: 24,
      nextOffset: null,
      node: {
        id: "a1",
        parentId: "u1",
        type: "message",
        role: "assistant",
        depth: 1,
        label: "Answer",
        snippet: "Answer",
        timestamp: "2026-08-01",
        active: true,
        leaf: true,
        canSwitch: true,
        canEdit: false,
        canFork: false,
      },
      images: [{ index: 0, mimeType: "image/png" }],
    });
    const image = vi.spyOn(runtime, "branchImage").mockResolvedValue({
      mimeType: "image/png",
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPe8AAAAASUVORK5CYII=",
        "base64",
      ),
    });

    await request(application.server)
      .get("/api/branches/tree?sessionId=fixture-active")
      .expect(401);
    await fixture.localRequest
      .get("/api/branches/tree?sessionId=fixture-active")
      .expect(200)
      .expect((response) => expect(response.body.revision).toBe(3));
    expect(tree).toHaveBeenCalledWith("fixture-active", {});
    await fixture.localRequest
      .get(
        "/api/branches/tree?sessionId=fixture-active&query=retained&before=a1",
      )
      .expect(200);
    expect(tree).toHaveBeenLastCalledWith("fixture-active", {
      query: "retained",
      before: "a1",
    });
    const readQuery =
      "sessionId=fixture-active&targetId=a1&viewId=view-1&offset=0";
    await request(application.server)
      .get(`/api/branches/entry?${readQuery}`)
      .expect(401);
    await request(application.server)
      .get(`/api/branches/image?${readQuery}&index=0`)
      .expect(401);
    expect(entry).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    await fixture.localRequest
      .get(`/api/branches/entry?${readQuery}`)
      .expect(200)
      .expect((response) =>
        expect(response.body.text).toBe("Complete retained answer"),
      );
    expect(entry).toHaveBeenCalledWith({
      sessionId: "fixture-active",
      targetId: "a1",
      viewId: "view-1",
      offset: 0,
    });
    await fixture.localRequest
      .get(`/api/branches/image?${readQuery}&index=0`)
      .expect(200)
      .expect("Content-Type", /image\/png/)
      .expect("Cache-Control", "private, no-store");
    expect(image).toHaveBeenCalledWith(
      {
        sessionId: "fixture-active",
        targetId: "a1",
        viewId: "view-1",
        offset: 0,
      },
      0,
    );
    await fixture.localRequest
      .get(`/api/branches/image?${readQuery}&index=-1`)
      .expect(400);

    await fixture.localRequest
      .post("/api/branches/navigate")
      .send({
        sessionId: "fixture-active",
        revision: 3,
        targetId: "u1",
        mode: "edit",
        rawPath: "/forged",
      })
      .expect(400);
    await fixture.localRequest
      .post("/api/branches/navigate")
      .send({
        sessionId: "fixture-active",
        revision: 3,
        targetId: "u1",
        mode: "edit",
      })
      .expect(200);
    expect(navigate).toHaveBeenCalledWith({
      sessionId: "fixture-active",
      revision: 3,
      targetId: "u1",
      mode: "edit",
    });

    await fixture.localRequest
      .post("/api/branches/fork")
      .send({
        sessionId: "fixture-active",
        viewId: "source-view",
        targetId: "u1",
      })
      .expect(200);
    expect(fork).toHaveBeenCalledWith({
      sessionId: "fixture-active",
      viewId: "source-view",
      targetId: "u1",
    });
    await request(application.server)
      .post("/api/branches/clone")
      .send({
        sessionId: "fixture-active",
        viewId: "source-view",
        targetId: null,
      })
      .expect(401);
    expect(clone).not.toHaveBeenCalled();
    await fixture.localRequest
      .post("/api/branches/clone")
      .send({
        sessionId: "fixture-active",
        viewId: "source-view",
        targetId: null,
        rawPath: "/forged",
      })
      .expect(400);
    await fixture.localRequest
      .post("/api/branches/clone")
      .send({
        sessionId: "fixture-active",
        viewId: "source-view",
        targetId: "a1",
      })
      .expect(200)
      .expect((response) => expect(response.body.editorText).toBe(""));
    expect(clone).toHaveBeenLastCalledWith({
      sessionId: "fixture-active",
      viewId: "source-view",
      targetId: "a1",
    });
    await fixture.localRequest
      .post("/api/branches/clone")
      .send({ sessionId: "fixture-active", viewId: "source-view" })
      .expect(400);
    await fixture.localRequest
      .post("/api/branches/clone")
      .send({
        sessionId: "fixture-active",
        viewId: "source-view",
        targetId: null,
      })
      .expect(200);
    expect(clone).toHaveBeenLastCalledWith({
      sessionId: "fixture-active",
      viewId: "source-view",
      targetId: null,
    });
  });

  it("reports invalid preference fields in bootstrap", async () => {
    await writeFile(
      join(temporary, "preferences.json"),
      JSON.stringify({ theme: "dark", toolVisibility: "invalid" }),
    );
    const { body } = await fixture.localRequest
      .get("/api/bootstrap")
      .expect(200);
    expect(body.preferences).toMatchObject({
      theme: "dark",
      toolVisibility: "dynamic",
    });
    expect(body.preferencesWarning).toMatch(/toolVisibility.*left unchanged/);
  });

  it("invalidates storage discovery only after saved project folders change", async () => {
    const invalidate = vi.spyOn(fixture.catalog, "invalidate");
    await fixture.localRequest
      .patch("/api/preferences")
      .send({ theme: "dark" })
      .expect(200);
    expect(invalidate).not.toHaveBeenCalled();
    for (const field of ["pinnedProjectCwds", "hiddenProjectCwds"]) {
      await fixture.localRequest
        .patch("/api/preferences")
        .send({ [field]: [temporary] })
        .expect(200);
    }
    expect(invalidate).toHaveBeenCalledTimes(2);
    await fixture.localRequest
      .patch("/api/preferences")
      .send({ pinnedProjectCwds: "invalid" })
      .expect(400);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("lists workspace directory levels only inside the project index", async () => {
    const workspace = join(temporary, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "fixture");
    const opened = await fixture.localRequest
      .post("/api/sessions/new")
      .send({ cwd: workspace })
      .expect(200);
    const sessionId = opened.body.active.sessionId as string;
    await fixture.localRequest
      .get(`/api/files/list?sessionId=${sessionId}&dir=..%2Fetc`)
      .expect(400);
    const listed = await fixture.localRequest
      .get(`/api/files/list?sessionId=${sessionId}`)
      .expect(200);
    expect(Array.isArray(listed.body.entries)).toBe(true);
    // The list is session-addressed: an unopened session id cannot borrow
    // the current selection's workspace.
    await fixture.localRequest
      .get("/api/files/list?sessionId=not-open")
      .expect(409);
  });

  it("browses host roots and directories without a session and rejects relative paths", async () => {
    const roots = await fixture.localRequest.get("/api/host/roots").expect(200);
    expect(Array.isArray(roots.body.roots)).toBe(true);
    for (const root of roots.body.roots) {
      expect(root).toEqual({
        name: expect.any(String),
        path: expect.any(String),
      });
    }

    await mkdir(join(temporary, "projects"));
    const listing = await fixture.localRequest
      .get(`/api/host/dirs?path=${encodeURIComponent(temporary)}`)
      .expect(200);
    expect(listing.body.dirs).toEqual(
      expect.arrayContaining([
        { name: "projects", path: join(listing.body.path, "projects") },
      ]),
    );
    expect(listing.body.parent).toBe(dirname(listing.body.path));

    await fixture.localRequest
      .get("/api/host/dirs?path=relative/path")
      .expect(400);
    await fixture.localRequest
      .get(
        `/api/host/dirs?path=${encodeURIComponent(join(temporary, "missing"))}`,
      )
      .expect(404);
  });

  it("requires authentication and an explicit validated flag to reveal hidden host directories", async () => {
    await mkdir(join(temporary, ".hidden-project"));
    const url = `/api/host/dirs?path=${encodeURIComponent(temporary)}`;
    await request(application.server).get(`${url}&showHidden=1`).expect(401);
    for (const suffix of ["", "&showHidden=0"]) {
      const listing = await fixture.localRequest
        .get(`${url}${suffix}`)
        .expect(200);
      expect(
        listing.body.dirs.map((entry: { name: string }) => entry.name),
      ).not.toContain(".hidden-project");
    }
    const listing = await fixture.localRequest
      .get(`${url}&showHidden=1`)
      .expect(200);
    expect(listing.body.dirs).toContainEqual({
      name: ".hidden-project",
      path: join(listing.body.path, ".hidden-project"),
    });
    for (const suffix of [
      "&showHidden=true",
      "&showHidden=false",
      "&showHidden=",
      "&showHidden=1&showHidden=0",
    ]) {
      await fixture.localRequest.get(`${url}${suffix}`).expect(400);
    }
  });

  it("stores curated navigation identities as preferences and returns their summaries by id", async () => {
    // Pins, folder pins, and hidden sessions are navigation metadata: one
    // field-scoped patch, no Pi history touched.
    const curated = await fixture.localRequest
      .patch("/api/preferences")
      .send({
        pinnedSessionIds: ["fixture-active"],
        pinnedProjectCwds: ["/home/demo/project"],
        hiddenSessionIds: ["fixture-older"],
      })
      .expect(200);
    expect(curated.body).toMatchObject({
      pinnedSessionIds: ["fixture-active"],
      pinnedProjectCwds: ["/home/demo/project"],
      hiddenSessionIds: ["fixture-older"],
    });

    const summaries = await fixture.localRequest
      .post("/api/sessions/by-id")
      .send({ ids: ["fixture-active", "missing"] })
      .expect(200);
    expect(summaries.body.sessions).toHaveLength(1);
    expect(summaries.body.sessions[0].id).toBe("fixture-active");

    // A pinned folder is claimed whole, so it hydrates by working directory
    // instead of depending on which of its sessions paged in.
    const folder = await fixture.localRequest
      .post("/api/sessions/by-cwd")
      .send({ cwds: [fixture.cwd, resolve("/nowhere")] })
      .expect(200);
    expect(
      folder.body.sessions.map((session: { cwd: string }) => session.cwd),
    ).toEqual([fixture.cwd]);
    await fixture.localRequest
      .post("/api/sessions/by-cwd")
      .send({ cwds: fixture.cwd })
      .expect(400);

    await fixture.localRequest
      .patch("/api/preferences")
      .send({ pinnedSessionIds: [] })
      .expect(200)
      .expect((response) => {
        expect(response.body.pinnedSessionIds).toEqual([]);
        // A field-scoped patch leaves the other curated lists alone.
        expect(response.body.hiddenSessionIds).toEqual(["fixture-older"]);
      });
  });

  it("refuses missing or unopened write targets instead of falling back to the selected session", async () => {
    await runtime.openSession("fixture-active");
    const before = await runtime.snapshot();
    const prompt = vi.spyOn(runtime, "prompt");
    const abort = vi.spyOn(runtime, "abort");

    await fixture.localRequest
      .post("/api/prompt")
      .send(promptDelivery({ message: "no target" }))
      .expect(400);
    await fixture.localRequest.post("/api/control/abort").send({}).expect(400);
    expect(prompt).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();

    await fixture.localRequest
      .post("/api/prompt")
      .send(promptDelivery({ sessionId: "never-opened", message: "hello" }))
      .expect(409);
    expect(prompt).toHaveBeenCalledExactlyOnceWith({
      sessionId: "never-opened",
      message: "hello",
    });
    expect(runtime.activeSessionId).toBe("fixture-active");
    expect((await runtime.snapshot()).active?.transcriptPage).toEqual(
      before.active?.transcriptPage,
    );
  });

  it("clears one complete Hidden folder without changing unrelated curation", async () => {
    const target = join(temporary, "target");
    const other = join(temporary, "other");
    await request(application.app)
      .patch("/api/preferences")
      .set("authorization", `Bearer ${token}`)
      .send({
        hiddenSessionIds: ["independent", "target-1"],
        hiddenProjectCwds: [target, other],
        pinnedProjectCwds: [target, other],
        navCollapsedGroups: [target, other],
      })
      .expect(200);
    const clear = vi.spyOn(runtime, "clearHiddenSessions").mockResolvedValue({
      deleted: [
        { sessionId: "target-1", disposition: "trashed" },
        { sessionId: "target-2", disposition: "trashed" },
      ],
    });
    const response = await request(application.app)
      .post("/api/sessions/clear-hidden")
      .set("authorization", `Bearer ${token}`)
      .send({ sessionIds: ["target-1", "target-2"], projectCwd: target })
      .expect(200);
    expect(clear).toHaveBeenCalledWith(["target-1", "target-2"], [], [target]);
    expect(response.body.preferences).toMatchObject({
      hiddenSessionIds: ["independent"],
      hiddenProjectCwds: [other],
      pinnedProjectCwds: [other],
      navCollapsedGroups: [other],
    });
  });

  it("refuses a folder that has left Hidden before any deletion", async () => {
    const clear = vi.spyOn(runtime, "clearHiddenSessions");
    const response = await request(application.app)
      .post("/api/sessions/clear-hidden")
      .set("authorization", `Bearer ${token}`)
      .send({
        sessionIds: ["session-1"],
        projectCwd: join(temporary, "visible"),
      })
      .expect(409);
    expect(response.body.code).toBe("HIDDEN_SELECTION_CHANGED");
    expect(clear).not.toHaveBeenCalled();
  });

  it("clears individually hidden sessions and complete Hidden folders in one reviewed batch", async () => {
    const cwd = "/tmp/hidden-folder";
    const deleted = vi.spyOn(runtime, "clearHiddenSessions").mockResolvedValue({
      deleted: [
        { sessionId: "one", disposition: "trashed" },
        { sessionId: "two", disposition: "deleted" },
      ],
    });
    const forget = vi.spyOn(resources, "forgetSession");
    await fixture.localRequest
      .patch("/api/preferences")
      .send({
        pinnedSessionIds: ["one"],
        hiddenSessionIds: ["one"],
        pinnedProjectCwds: [cwd],
        hiddenProjectCwds: [cwd],
        navCollapsedGroups: [cwd],
      })
      .expect(200);

    const response = await fixture.localRequest
      .post("/api/sessions/clear-hidden")
      .send({ sessionIds: ["one", "two"] })
      .expect(200);
    expect(deleted).toHaveBeenCalledWith(["one", "two"], ["one"], [cwd]);
    expect(response.body).toMatchObject({
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
    await fixture.localRequest
      .patch("/api/preferences")
      .send({
        pinnedSessionIds: ["fixture-history"],
        hiddenSessionIds: ["fixture-history"],
      })
      .expect(200);
    const forget = vi.spyOn(resources, "forgetSession");

    await request(application.server)
      .delete("/api/sessions/fixture-history")
      .expect(401);
    const deleted = await fixture.localRequest
      .delete("/api/sessions/fixture-history")
      .expect(200);
    expect(deleted.body).toMatchObject({
      sessionId: "fixture-history",
      disposition: "trashed",
      preferences: { pinnedSessionIds: [], hiddenSessionIds: [] },
    });
    expect(forget).toHaveBeenCalledWith("fixture-history");

    const sessions = await fixture.localRequest
      .get("/api/sessions")
      .expect(200);
    expect(sessions.body.sessions).not.toContainEqual(
      expect.objectContaining({ id: "fixture-history" }),
    );
    await fixture.localRequest
      .delete("/api/sessions/fixture-history")
      .expect(404);
  });
});
