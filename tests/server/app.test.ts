import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";

describe("Host HTTP workflows", () => {
  type Fixture = Awaited<ReturnType<typeof hostApiFixture>>;
  const callerNodeEnv = process.env.NODE_ENV;
  let temporary: Fixture["temporary"];
  let application: Fixture["application"];
  let resources: Fixture["resources"];
  let runtime: Fixture["runtime"];
  let local: Fixture["localRequest"];
  let guest: ReturnType<typeof request>;
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await hostApiFixture();
    ({
      temporary,
      application,
      resources,
      runtime,
      localRequest: local,
    } = fixture);
    guest = request(application.server);
  });
  afterEach(async () => closeHostApiFixture(fixture));

  it("sets production HTTP behavior without overriding the user's NODE_ENV", () => {
    expect(application.app.get("env")).toBe("production");
    expect(process.env.NODE_ENV).toBe(callerNodeEnv);
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

    const response = await local.get("/api/bootstrap").expect(200);
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

  it("requires local authentication for Inspire, Pi, and extension update status", async () => {
    for (const path of ["/api/update", "/api/pi-update"]) {
      await guest.get(path).expect(401);
    }
    const inspire = await local.get("/api/update").expect(200);
    expect(inspire.body).toMatchObject({
      kind: "available",
      update: { latestVersion: "0.2.0" },
      updateStatus: { availableUpdateIdentity: '[["inspire","0.2.0"]]' },
    });
    const pi = await local
      .get("/api/pi-update")
      .query({ refresh: "1" })
      .expect(200);
    expect(pi.body).toMatchObject({
      pi: { kind: "available", latestVersion: "0.84.3" },
      extensions: {
        kind: "available",
        updates: [{ displayName: "pi-web-access" }],
      },
    });
  });

  it("generates a resume command for the new folder after the original project moves", async () => {
    const session = await fixture.catalog.get("fixture-active");
    if (!session) throw new Error("Missing fixture session");
    const resume = () =>
      local
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

    const defaults = await local
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

    const files = await local
      .get("/api/new-session/files")
      .query({ cwd: join(temporary, "."), q: "app" })
      .expect(200);
    expect(files.body).toEqual({
      cwd: temporary,
      truncated: false,
      files: [{ path: "app.ts", name: "app.ts" }],
    });

    await local
      .get("/api/models")
      .query({ cwd: join(temporary, "missing") })
      .expect(400, {
        error: "Project path does not exist",
        code: "PROJECT_DIRECTORY_MISSING",
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
    vi.spyOn(runtime, "snapshot").mockImplementation(async (sessionId) => {
      snapshotStarted();
      const snapshot = await originalSnapshot(sessionId);
      await gate;
      return snapshot;
    });
    vi.spyOn(runtime, "close").mockImplementation(async () => {
      releaseSnapshot();
      await originalClose();
    });
    const active = local.get("/api/snapshot?detail=");
    const activeResult = active.then((response) => response.status);
    await started;
    const closing = application.close();
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    expect(application.server.listening).toBe(false);
    await expect(
      fetch(`${fixture.baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toThrow();
    await expect(activeResult).resolves.toBe(200);
    await expect(closing).resolves.toBeUndefined();
  });

  it("cleans attachment storage and resource anchors even when runtime teardown fails", async () => {
    const attachmentClose = vi.spyOn(fixture.attachments, "close");
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
    const sessions = await local.get("/api/sessions?q=formula").expect(200);
    expect(sessions.body.total).toBe(1);
    expect(sessions.body.sessions[0]).toMatchObject({
      id: "fixture-active",
      project: "workspace",
    });
    const page = await local.get("/api/sessions?offset=1&limit=1").expect(200);
    expect(page.body).toMatchObject({ offset: 1, limit: 1, total: 2 });
    expect(page.body.sessions).toHaveLength(1);
    for (const invalid of [
      "limit=not-a-number",
      "limit=101",
      "offset=-1",
      "offset=1.5",
      "offset=9007199254740992",
    ]) {
      await local.get(`/api/sessions?${invalid}`).expect(400);
    }

    const opened = await local
      .post("/api/sessions/open")
      .send({ id: "fixture-active" })
      .expect(200);
    expect(opened.body.active.transcriptPage.messages).toHaveLength(5);
    expect(opened.body.active.model.id).toBe("offline");
  });

  it("admits typed body routes after authentication and validates before dispatch", async () => {
    const sessionId = "fixture-active";
    const command = {
      sessionId,
      command: "compact",
      argument: "preserve decisions",
    };
    const compacted = {
      command: "compact",
      outcome: "completed",
      message: "Compaction completed",
    } as const;
    const native = vi
      .spyOn(runtime, "nativeCommand")
      .mockResolvedValue(compacted);
    const clear = vi
      .spyOn(runtime, "clearPending")
      .mockResolvedValue(undefined);
    const pendingItem = {
      sessionId,
      viewId: "view",
      revision: 7,
      itemId: "text-steer-0",
    };
    const pendingText = { text: "x".repeat(2000) };
    const read = vi
      .spyOn(runtime, "pendingText")
      .mockResolvedValue(pendingText);
    const cwd = join(temporary, "new-project");
    const snapshot = await runtime.snapshot(null);
    const create = vi.spyOn(runtime, "newSession").mockResolvedValue(snapshot);
    for (const { path, body, invalid, handler, args, response } of [
      {
        path: "/api/control/native-command",
        body: command,
        invalid: { ...command, command: "unknown" },
        handler: native,
        args: [command],
        response: compacted,
      },
      {
        path: "/api/pending/clear",
        body: { sessionId },
        invalid: { sessionId, expectedRevision: 1 },
        handler: clear,
        args: [sessionId],
        response: { ok: true },
      },
      {
        path: "/api/pending/text",
        body: pendingItem,
        invalid: { ...pendingItem, revision: -1 },
        handler: read,
        args: [pendingItem],
        response: pendingText,
      },
      {
        path: "/api/sessions/new",
        body: { cwd, createDirectory: true },
        invalid: { cwd, createDirectory: "true" },
        handler: create,
        args: [cwd, { createDirectory: true }],
        response: snapshot,
      },
    ]) {
      await guest.post(path).send(body).expect(401);
      await local.post(path).send(invalid).expect(400);
      expect(handler).not.toHaveBeenCalled();
      await local
        .post(path)
        .send(body)
        .expect("Cache-Control", "no-store")
        .expect(200, response);
      expect(handler).toHaveBeenCalledExactlyOnceWith(...args);
    }
  });

  it("applies native settings to the addressed session after authentication and validation", async () => {
    const sessionId = "fixture-active";
    await runtime.openSession(sessionId);
    await runtime.openSession("fixture-history");
    await runtime.setSteeringMode(sessionId, "one-at-a-time");
    await runtime.setSteeringMode("fixture-history", "one-at-a-time");
    const targetSettings = async () =>
      (await runtime.snapshot(sessionId)).active?.runtimeSettings;
    const selectedSettings = async () =>
      (await runtime.snapshot("fixture-history")).active?.runtimeSettings;
    const selectedBefore = await vi.waitFor(async () => {
      const settings = await selectedSettings();
      expect(settings).toBeDefined();
      expect(await targetSettings()).toBeDefined();
      return settings;
    });
    for (const [route, field, stateKey, value, invalid] of [
      ["auto-compaction", "enabled", "autoCompactionEnabled", true, "true"],
      ["auto-retry", "enabled", "autoRetryEnabled", true, "true"],
      ["steering-mode", "mode", "steeringMode", "all", "invalid"],
      ["follow-up-mode", "mode", "followUpMode", "all", "invalid"],
    ] as const) {
      const path = `/api/control/${route}`;
      const body = { sessionId, [field]: value };
      const before = await targetSettings();
      expect(before?.[stateKey], route).not.toBe(value);

      await guest.post(path).send(body).expect(401);
      for (const invalidBody of [
        { [field]: value },
        { sessionId, [field]: invalid },
      ])
        await local.post(path).send(invalidBody).expect(400);
      expect(await targetSettings(), route).toEqual(before);
      await local.post(path).send(body).expect(200, { ok: true });
      expect(await targetSettings(), route).toEqual({
        ...before,
        [stateKey]: value,
      });
      expect(await selectedSettings()).toEqual(selectedBefore);
      expect(runtime.startupSessionHint).toBe("fixture-history");
    }
  });

  it("validates and forwards an addressed history cursor", async () => {
    const address = { sessionId: "fixture-active", viewId: "branch-1" };
    const query = {
      kind: "page",
      entryId: "user-0",
      cursor: "turn+cursor=",
    } as const;
    const response = {
      ...address,
      messages: [],
      revision: 1,
      incarnation: "source",
      leafId: "leaf",
      firstTurn: 1,
      lastTurn: 1,
      totalTurns: 1,
      earlier: null,
      later: null,
    };
    const read = vi
      .spyOn(runtime, "sessionHistory")
      .mockResolvedValue(response);
    const url = "/api/history";
    await guest
      .get(url)
      .query({ ...address, ...query })
      .expect(401);
    for (const invalid of [
      { ...query, sessionId: address.sessionId },
      { ...address, ...query, offset: 5 },
    ])
      await local.get(url).query(invalid).expect(400);
    await local
      .get(url)
      .query({ ...address, ...query })
      .expect(200, response);
    expect(read).toHaveBeenCalledExactlyOnceWith(
      address.sessionId,
      address.viewId,
      query,
    );
  });

  it("reads and clones an addressed session while another session is selected", async () => {
    const sessionId = "fixture-active";
    const { active } = await runtime.openSession(sessionId);
    await runtime.openSession("fixture-history");
    const viewId = active!.transcriptPage.viewId;
    const firstPrompt =
      "Show me a formula-rich example and inspect the analysis steps.";
    for (const [kind, content] of [
      [
        "page",
        {
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "user", content: firstPrompt }),
          ]),
        },
      ],
      [
        "composer",
        { entries: [expect.objectContaining({ text: firstPrompt })] },
      ],
    ] as const) {
      const query = { sessionId, viewId, kind };
      const result = await local.get("/api/history").query(query).expect(200);
      expect(result.body).toMatchObject({ sessionId, viewId, ...content });
      await local
        .get("/api/history")
        .query({ ...query, viewId: "old-branch" })
        .expect(409);
    }
    const copy = "/api/transcript/assistant-text";
    await guest.get(copy).query({ sessionId, viewId }).expect(401);
    await local.get(copy).query({ sessionId }).expect(400);
    await local.get(copy).query({ sessionId, viewId }).expect(200, {
      text: "Tightened the window normalization.",
    });

    const page = await local
      .get("/api/history")
      .query({ sessionId, viewId, kind: "page" })
      .expect(200);
    const target = page.body.messages.find(
      (message: { role?: string }) => message.role === "user",
    )?.__inspireEntryId;
    const routes = { sessionId, viewId, kind: "routes", parentId: "" };
    await local
      .get("/api/history")
      .query({ ...routes, viewId: "old-branch" })
      .expect(409);
    await local.get("/api/history").query(routes).expect(200);
    expect(target).toBeDefined();
    const entry = { sessionId, viewId, kind: "entry", targetId: target };
    const read = await local.get("/api/history").query(entry).expect(200);
    expect(read.body.text).toBe(firstPrompt);
    await local
      .get("/api/history")
      .query({ ...entry, viewId: "old-branch" })
      .expect(409);

    const clone = { sessionId, viewId, targetId: null };
    await guest.post("/api/branches/clone").send(clone).expect(401);
    await local
      .post("/api/branches/clone")
      .send({ sessionId, viewId })
      .expect(400);
    const result = await local
      .post("/api/branches/clone")
      .send(clone)
      .expect(200);
    expect(result.body.sessionId).not.toBe(sessionId);
    const saved = await fixture.catalog.get(result.body.sessionId);
    expect(saved?.cwd).toBe(active!.cwd);
    expect(result.body.editorText).toBe("");
    expect(runtime.startupSessionHint).toBe("fixture-history");
  });

  it("rejects untrusted branch mutation fields and serves authenticated image bytes privately", async () => {
    const address = { sessionId: "fixture-active", targetId: "entry-3" };
    const view = { ...address, viewId: "source-view" };
    const imageQuery = { ...view, index: 0 };
    const image = vi.spyOn(runtime, "branchImage").mockResolvedValue({
      mimeType: "image/png",
      data: Buffer.from("saved image bytes"),
    });
    await guest.get("/api/branches/image").query(imageQuery).expect(401);
    await local
      .get("/api/branches/image")
      .query({ ...view, index: -1 })
      .expect(400);
    expect(image).not.toHaveBeenCalled();
    const response = await local
      .get("/api/branches/image")
      .query(imageQuery)
      .expect(200)
      .expect("Content-Type", "image/png")
      .expect("Cache-Control", "private, no-store");
    expect(image).toHaveBeenCalledExactlyOnceWith(view, 0);
    expect(response.body).toEqual(Buffer.from("saved image bytes"));

    for (const [operation, body] of [
      ["navigate", { ...address, revision: 3, mode: "edit" }],
      ["fork", view],
      ["clone", { ...view, targetId: null }],
    ] as const) {
      await local
        .post(`/api/branches/${operation}`)
        .send({ ...body, rawPath: "/forged" })
        .expect(400);
    }
  });

  it("reports invalid preference fields in bootstrap", async () => {
    await writeFile(
      join(temporary, "preferences.json"),
      JSON.stringify({ theme: "dark", toolVisibility: "invalid" }),
    );
    const { body } = await local.get("/api/bootstrap").expect(200);
    expect(body.preferences).toMatchObject({
      theme: "dark",
      toolVisibility: "dynamic",
    });
    expect(body.preferencesWarning).toMatch(/toolVisibility.*left unchanged/);
  });

  it("lists workspace directory levels only inside the project index", async () => {
    const workspace = join(temporary, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "fixture");
    const opened = await local
      .post("/api/sessions/new")
      .send({ cwd: workspace })
      .expect(200);
    const sessionId = opened.body.active.sessionId as string;
    await local
      .get(`/api/files/list?sessionId=${sessionId}&dir=..%2Fetc`)
      .expect(400);
    const listed = await local
      .get(`/api/files/list?sessionId=${sessionId}`)
      .expect(200);
    expect(listed.body.entries).toContainEqual({
      name: "README.md",
      type: "file",
    });
    // The list is session-addressed: an unopened session id cannot borrow
    // the current selection's workspace.
    await local.get("/api/files/list?sessionId=not-open").expect(409);
  });

  it("browses host directories without a session and reveals hidden folders on request", async () => {
    await mkdir(join(temporary, "projects"));
    await mkdir(join(temporary, ".hidden-project"));
    const url = `/api/host/dirs?path=${encodeURIComponent(temporary)}`;
    const visible = { name: "projects", path: join(temporary, "projects") };
    const hidden = {
      name: ".hidden-project",
      path: join(temporary, ".hidden-project"),
    };

    await local.get("/api/host/roots").expect(200);
    await guest.get(`${url}&showHidden=1`).expect(401);
    for (const suffix of ["", "&showHidden=0"]) {
      const listing = await local.get(`${url}${suffix}`).expect(200);
      expect(listing.body).toMatchObject({
        path: temporary,
        parent: dirname(temporary),
      });
      expect(listing.body.dirs).toContainEqual(visible);
      expect(listing.body.dirs).not.toContainEqual(hidden);
    }
    const listing = await local.get(`${url}&showHidden=1`).expect(200);
    expect(listing.body.dirs).toEqual(
      expect.arrayContaining([visible, hidden]),
    );
    for (const suffix of [
      "&showHidden=true",
      "&showHidden=false",
      "&showHidden=",
      "&showHidden=1&showHidden=0",
    ]) {
      await local.get(`${url}${suffix}`).expect(400);
    }
    await local
      .get("/api/host/dirs")
      .query({ path: "relative/path" })
      .expect(400);
    await local
      .get("/api/host/dirs")
      .query({ path: join(temporary, "missing") })
      .expect(404);
  });

  it("stores curated navigation identities as preferences and returns their summaries by id", async () => {
    // Pins, folder pins, and hidden sessions are navigation metadata: one
    // field-scoped patch, no Pi history touched.
    const curated = await local
      .patch("/api/preferences")
      .send({
        pinnedSessionIds: ["fixture-active"],
        pinnedProjectCwds: ["/home/demo/project"],
        hiddenSessionIds: ["fixture-older"],
      })
      .expect(200);
    expect(curated.body.preferences).toMatchObject({
      pinnedSessionIds: ["fixture-active"],
      pinnedProjectCwds: ["/home/demo/project"],
      hiddenSessionIds: ["fixture-older"],
    });

    const summaries = await local
      .post("/api/sessions/by-id")
      .send({ ids: ["fixture-active", "missing"] })
      .expect(200);
    expect(summaries.body.sessions).toHaveLength(1);
    expect(summaries.body.sessions[0].id).toBe("fixture-active");

    // A pinned folder is claimed whole, so it hydrates by working directory
    // instead of depending on which of its sessions paged in.
    const folder = await local
      .post("/api/sessions/by-cwd")
      .send({ cwds: [fixture.cwd, resolve("/nowhere")] })
      .expect(200);
    expect(
      folder.body.sessions.map((session: { cwd: string }) => session.cwd),
    ).toEqual([fixture.cwd]);
    await local
      .post("/api/sessions/by-cwd")
      .send({ cwds: fixture.cwd })
      .expect(400);

    await local
      .patch("/api/preferences")
      .send({ pinnedSessionIds: [] })
      .expect(200)
      .expect((response) => {
        expect(response.body.revision).toBeGreaterThan(curated.body.revision);
        expect(response.body.preferences.pinnedSessionIds).toEqual([]);
        // A field-scoped patch leaves the other curated lists alone.
        expect(response.body.preferences.hiddenSessionIds).toEqual([
          "fixture-older",
        ]);
      });
  });

  it.each(["folder", "all"] as const)(
    "clears reviewed Hidden %s and retains unrelated navigation curation",
    async (scope) => {
      const target = join(temporary, "target");
      const other = join(temporary, "other");
      const outside = join(temporary, "visible");
      const sessionIds = ["folder-entry", "individual-entry"];
      const hiddenSessions = ["individual-entry"];
      const hiddenFolders = [target, other];
      await local
        .patch("/api/preferences")
        .send({
          pinnedSessionIds: [...sessionIds, "unrelated"],
          hiddenSessionIds: hiddenSessions,
          hiddenProjectCwds: hiddenFolders,
          pinnedProjectCwds: [...hiddenFolders, outside],
          navCollapsedGroups: [...hiddenFolders, outside],
        })
        .expect(200);

      const ids = scope === "folder" ? sessionIds.slice(0, 1) : sessionIds;
      const deleted = ids.map((sessionId) => ({
        sessionId,
        disposition:
          sessionId === "folder-entry"
            ? ("trashed" as const)
            : ("deleted" as const),
      }));
      const clear = vi
        .spyOn(runtime, "deleteSessions")
        .mockResolvedValue({ deleted });
      const forget = vi.spyOn(resources, "forgetSession");
      const submit = (projectCwd?: string) =>
        local
          .post("/api/sessions/delete")
          .send({ scope: "hidden", sessionIds: ids, projectCwd });

      await submit(outside)
        .expect(409)
        .expect(({ body }) => {
          expect(body.code).toBe("HIDDEN_SELECTION_CHANGED");
        });
      expect(clear).not.toHaveBeenCalled();

      const remainingFolders = scope === "folder" ? [other] : [];
      const response = await submit(
        scope === "folder" ? target : undefined,
      ).expect(200);
      expect(clear).toHaveBeenCalledExactlyOnceWith(
        {
          scope: "hidden",
          sessionIds: ids,
          projectCwd: scope === "folder" ? target : undefined,
        },
        expect.objectContaining({
          hiddenSessionIds: scope === "folder" ? [] : hiddenSessions,
          hiddenProjectCwds: scope === "folder" ? [target] : hiddenFolders,
        }),
      );
      expect(response.body).toMatchObject({
        deleted,
        navigation: {
          kind: "confirmed",
          preferences: {
            pinnedSessionIds:
              scope === "folder"
                ? ["individual-entry", "unrelated"]
                : ["unrelated"],
            hiddenSessionIds: scope === "folder" ? hiddenSessions : [],
            hiddenProjectCwds: remainingFolders,
            pinnedProjectCwds: [...remainingFolders, outside],
            navCollapsedGroups: [...remainingFolders, outside],
          },
        },
      });
      expect(forget.mock.calls).toEqual(ids.map((id) => [id]));
    },
  );

  it("deletes a deselected session and removes its navigation identities", async () => {
    await local
      .post("/api/sessions/open")
      .send({ id: "fixture-history" })
      .expect(200);
    expect(runtime.startupSessionHint).toBe("fixture-history");
    const deselected = await local.post("/api/sessions/deselect").expect(200);
    expect(deselected.body).toMatchObject({ active: null, runState: "idle" });
    expect(runtime.startupSessionHint).toBeNull();
    const before = await local
      .patch("/api/preferences")
      .send({
        pinnedSessionIds: ["fixture-history"],
        hiddenSessionIds: ["fixture-history"],
      })
      .expect(200);
    const forget = vi.spyOn(resources, "forgetSession");

    const request = { scope: "session", sessionId: "fixture-history" };
    await guest.post("/api/sessions/delete").send(request).expect(401);
    await local
      .post("/api/sessions/delete")
      .send({ ...request, sessionId: "fixture-active" })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe("HIDDEN_SELECTION_CHANGED"));
    const { body: deleted } = await local
      .post("/api/sessions/delete")
      .send(request)
      .expect(200);
    const { body: bootstrap } = await local.get("/api/bootstrap").expect(200);
    expect(bootstrap.preferenceRevision).toBeGreaterThan(
      deleted.navigation.revision,
    );
    expect(deleted.navigation.revision).toBeGreaterThan(before.body.revision);
    expect(bootstrap.preferences).toEqual(deleted.navigation.preferences);
    expect(deleted).toMatchObject({
      deleted: [{ sessionId: "fixture-history", disposition: "trashed" }],
      navigation: {
        kind: "confirmed",
        authorityId: bootstrap.authorityId,
        preferences: { pinnedSessionIds: [], hiddenSessionIds: [] },
      },
    });
    expect(forget).toHaveBeenCalledWith("fixture-history");

    const sessions = await local.get("/api/sessions").expect(200);
    expect(sessions.body.sessions).not.toContainEqual(
      expect.objectContaining({ id: "fixture-history" }),
    );
    await local.post("/api/sessions/delete").send(request).expect(404);
  });
});
