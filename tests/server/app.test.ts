import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeHostApiFixture, hostApiFixture } from "./fixtures/host-api.js";
import { deferredSignal } from "./fixtures/runtime.js";

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

  it("publishes local presentation and preference state without changing the caller environment", async () => {
    expect(application.app.get("env")).toBe("production");
    expect(process.env.NODE_ENV).toBe(callerNodeEnv);
    await Promise.all([
      writeFile(
        join(temporary, "preferences.json"),
        JSON.stringify({ theme: "dark", toolVisibility: "invalid" }),
      ),
      writeFile(
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
        }),
      ),
    ]);
    const { body } = await local.get("/api/bootstrap").expect(200);
    expect(body).toMatchObject({
      preferences: { theme: "dark", toolVisibility: "dynamic" },
      preferencesWarning: expect.stringMatching(
        /toolVisibility.*left unchanged/u,
      ),
      toolPresentations: { mappings: { example: "user.example.tool" } },
    });
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

  it("preserves the resume command when the original project moves", async () => {
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

  it("uses one canonical project for preflight and addressed file listing", async () => {
    const cwd = join(temporary, "new-project");
    await mkdir(cwd);
    await writeFile(join(cwd, "README.md"), "fixture");
    const path = cwd + "/.";
    const models = (cwd: string) => local.get("/api/models").query({ cwd });
    expect((await models(path).expect(200)).body.defaults).toMatchObject({
      cwd,
      model: { id: "claude-sonnet-4" },
      thinkingLevel: "high",
    });
    await models(join(cwd, "missing"))
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe("PROJECT_DIRECTORY_MISSING");
      });
    await local
      .get("/api/new-session/files")
      .query({ cwd: path, q: "README" })
      .expect(200, {
        cwd,
        truncated: false,
        files: [{ path: "README.md", name: "README.md" }],
      });
    const create = (value: object) =>
      local.post("/api/sessions/new").send(value);
    await create({ cwd, createDirectory: "true" }).expect(400);
    const { body } = await create({ cwd, createDirectory: true }).expect(200);
    const list = (query: object) => local.get("/api/files/list").query(query);
    const sessionId = body.active.sessionId;
    expect((await list({ sessionId }).expect(200)).body.entries).toContainEqual(
      {
        name: "README.md",
        type: "file",
      },
    );
    await list({ sessionId, dir: "../etc" }).expect(400);
    await list({ sessionId: "not-open" }).expect(409);
  });

  it("stops accepting work before runtime teardown and drains an active request without deadlock", async () => {
    const originalSnapshot = runtime.snapshot.bind(runtime);
    const originalClose = runtime.close.bind(runtime);
    const started = deferredSignal();
    const gate = deferredSignal();
    vi.spyOn(runtime, "snapshot").mockImplementation(async (sessionId) => {
      started.resolve();
      const snapshot = await originalSnapshot(sessionId);
      await gate.promise;
      return snapshot;
    });
    vi.spyOn(runtime, "close").mockImplementation(async () => {
      gate.resolve();
      await originalClose();
    });
    const active = local
      .get("/api/snapshot?detail=")
      .then((response) => response.status);
    await started.promise;
    const closing = application.close();
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    expect(application.server.listening).toBe(false);
    await expect(fixture.fetchHost("/api/health")).rejects.toThrow();
    await expect(active).resolves.toBe(200);
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

  it("authenticates and validates native commands before dispatch", async () => {
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
    const post = (client: typeof local | typeof guest, value: object) =>
      client.post("/api/control/native-command").send(value);
    await post(guest, command).expect(401);
    await post(local, { ...command, command: "unknown" }).expect(400);
    expect(native).not.toHaveBeenCalled();
    await post(local, command)
      .expect("Cache-Control", "no-store")
      .expect(200, compacted);
    expect(native).toHaveBeenCalledExactlyOnceWith(command);
  });

  it("changes native settings on their addressed Pi while another session is selected", async () => {
    const sessionId = "fixture-active";
    const selected = "fixture-history";
    for (const id of [sessionId, selected]) {
      await runtime.openSession(id);
      await runtime.setSteeringMode(id, "one-at-a-time");
    }
    const settings = async (id: string) =>
      (await runtime.snapshot(id)).active?.runtimeSettings;
    const before = await vi.waitFor(async () => {
      const state = await settings(selected);
      expect(state).toBeDefined();
      expect(await settings(sessionId)).toBeDefined();
      return state;
    });
    const post = (name: string, body: object) =>
      local.post(`/api/control/${name}`).send(body);
    await post("auto-compaction", { sessionId, enabled: "true" }).expect(400);
    await post("steering-mode", { mode: "all" }).expect(400);
    for (const [path, value] of [
      ["auto-compaction", { enabled: true }],
      ["auto-retry", { enabled: true }],
      ["steering-mode", { mode: "all" }],
      ["follow-up-mode", { mode: "all" }],
    ] as const)
      await post(path, { sessionId, ...value }).expect(200, { ok: true });
    await vi.waitFor(async () =>
      expect(await settings(sessionId)).toMatchObject({
        autoCompactionEnabled: true,
        autoRetryEnabled: true,
        steeringMode: "all",
        followUpMode: "all",
      }),
    );
    expect(await settings(selected)).toEqual(before);
    expect(runtime.startupSessionHint).toBe(selected);
  });

  it("reads and clones an addressed session while another session is selected", async () => {
    const sessionId = "fixture-active";
    const { active } = await runtime.openSession(sessionId);
    await runtime.openSession("fixture-history");
    const viewId = active!.transcriptPage.viewId;
    const address = { sessionId, viewId };
    const firstPrompt =
      "Show me a formula-rich example and inspect the analysis steps.";
    const history = (query: object) =>
      local.get("/api/history").query({ ...address, ...query });
    await guest
      .get("/api/history")
      .query({ ...address, kind: "page" })
      .expect(401);
    const read = vi.spyOn(runtime, "sessionHistory");
    await local
      .get("/api/history")
      .query({ sessionId, kind: "page" })
      .expect(400);
    await history({ kind: "page", offset: 5 }).expect(400);
    expect(read).not.toHaveBeenCalled();
    const { body: page } = await history({ kind: "page" }).expect(200);
    const user = page.messages.find(
      (message: { role?: string }) => message.role === "user",
    );
    expect(user?.content).toBe(firstPrompt);
    const entry = { kind: "entry", targetId: user.__inspireEntryId };
    expect((await history(entry).expect(200)).body.text).toBe(firstPrompt);
    const composer = (await history({ kind: "composer" }).expect(200)).body;
    expect(composer.entries[0].text).toBe(firstPrompt);
    await history({ ...entry, viewId: "old-branch" }).expect(409);
    await history({ kind: "page", cursor: "turn+cursor=" }).expect(400);
    expect(read).toHaveBeenCalledWith(
      sessionId,
      viewId,
      expect.objectContaining({ kind: "page", cursor: "turn+cursor=" }),
    );
    await local
      .get("/api/transcript/assistant-text")
      .query(address)
      .expect(200, {
        text: "Tightened the window normalization.",
      });
    const { body: clone } = await local
      .post("/api/branches/clone")
      .send({ ...address, targetId: null })
      .expect(200);
    expect(clone.sessionId).not.toBe(sessionId);
    expect((await fixture.catalog.get(clone.sessionId))?.cwd).toBe(active!.cwd);
    expect(clone.editorText).toBe("");
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

  it("lists host directories with an explicit hidden filter before a session opens", async () => {
    const visible = { name: "projects", path: join(temporary, "projects") };
    const hidden = {
      name: ".hidden-project",
      path: join(temporary, ".hidden-project"),
    };
    await Promise.all([mkdir(visible.path), mkdir(hidden.path)]);
    const url = `/api/host/dirs?path=${encodeURIComponent(temporary)}`;
    await local.get("/api/host/roots").expect(200);
    await guest.get(url).expect(401);
    const listing = (await local.get(url).expect(200)).body;
    expect(listing).toMatchObject({
      path: temporary,
      parent: dirname(temporary),
    });
    expect(listing.dirs).toContainEqual(visible);
    expect(listing.dirs).not.toContainEqual(hidden);
    expect((await local.get(`${url}&showHidden=0`).expect(200)).body).toEqual(
      listing,
    );
    expect(
      (await local.get(`${url}&showHidden=1`).expect(200)).body.dirs,
    ).toEqual(expect.arrayContaining([visible, hidden]));
    for (const value of ["true", "false", "", "1&showHidden=0"])
      await local.get(`${url}&showHidden=${value}`).expect(400);
    await local
      .get("/api/host/dirs")
      .query({ path: "relative/path" })
      .expect(400);
    await local
      .get("/api/host/dirs")
      .query({ path: join(temporary, "missing") })
      .expect(404);
  });

  it("hydrates curated sessions and directories independently of catalog paging", async () => {
    const list = (query: string) => local.get(`/api/sessions?${query}`);
    const { body: filtered } = await list("q=formula").expect(200);
    expect(filtered.sessions).toMatchObject([
      { id: "fixture-active", project: "workspace" },
    ]);
    const { body: page } = await list("offset=1&limit=1").expect(200);
    expect(page).toMatchObject({ offset: 1, limit: 1, total: 2 });
    expect(page.sessions).toHaveLength(1);
    for (const invalid of [
      "limit=101",
      "offset=-1",
      "offset=1.5",
      "offset=9007199254740992",
    ])
      await list(invalid).expect(400);

    const patch = (value: object) =>
      local.patch("/api/preferences").send(value).expect(200);
    const curation = {
      pinnedSessionIds: ["fixture-active"],
      pinnedProjectCwds: [fixture.cwd],
      hiddenSessionIds: ["fixture-history"],
    };
    const { body: before } = await patch(curation);
    const { body: byId } = await local
      .post("/api/sessions/by-id")
      .send({ ids: ["fixture-active", "missing"] })
      .expect(200);
    const byCwd = (cwds: unknown) =>
      local.post("/api/sessions/by-cwd").send({ cwds });
    const { body: byFolder } = await byCwd([
      fixture.cwd,
      resolve("/nowhere"),
    ]).expect(200);
    expect(byId.sessions.map((item: { id: string }) => item.id)).toEqual([
      "fixture-active",
    ]);
    expect(byFolder.sessions).toEqual(byId.sessions);
    await byCwd(fixture.cwd).expect(400);
    const { body: after } = await patch({ pinnedSessionIds: [] });
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.preferences).toMatchObject({
      ...curation,
      pinnedSessionIds: [],
    });
  });

  it("clears a reviewed Hidden folder and then the remaining Hidden catalog", async () => {
    const ids = ["fixture-active", "fixture-history"];
    const [folder, other] = await Promise.all(
      ids.map(async (id) => (await fixture.catalog.get(id))!.cwd),
    );
    const outside = join(temporary, "visible");
    const submit = (sessionIds: string[], projectCwd?: string) =>
      local
        .post("/api/sessions/delete")
        .send({ scope: "hidden", sessionIds, projectCwd });
    await local
      .patch("/api/preferences")
      .send({
        pinnedSessionIds: [...ids, "unrelated"],
        hiddenSessionIds: [ids[1]],
        hiddenProjectCwds: [folder, other],
        pinnedProjectCwds: [folder, other, outside],
        navCollapsedGroups: [folder, other, outside],
      })
      .expect(200);
    await submit(ids.slice(0, 1), outside)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe("HIDDEN_SELECTION_CHANGED");
      });
    const afterFolder = (await submit(ids.slice(0, 1), folder).expect(200))
      .body;
    expect(afterFolder).toMatchObject({
      deleted: [{ sessionId: ids[0], disposition: "trashed" }],
      navigation: {
        kind: "confirmed",
        preferences: {
          pinnedSessionIds: [ids[1], "unrelated"],
          hiddenSessionIds: [ids[1]],
          hiddenProjectCwds: [other],
          pinnedProjectCwds: [other, outside],
          navCollapsedGroups: [other, outside],
        },
      },
    });
    const afterAll = (await submit(ids.slice(1)).expect(200)).body;
    expect(afterAll).toMatchObject({
      deleted: [{ sessionId: ids[1], disposition: "trashed" }],
      navigation: {
        kind: "confirmed",
        preferences: {
          pinnedSessionIds: ["unrelated"],
          hiddenSessionIds: [],
          hiddenProjectCwds: [],
          pinnedProjectCwds: [outside],
          navCollapsedGroups: [outside],
        },
      },
    });
    expect(
      (await local.get("/api/sessions").expect(200)).body.sessions,
    ).toEqual([]);
  });

  it("deletes a deselected session and removes its navigation identities", async () => {
    await local
      .post("/api/sessions/open")
      .send({ id: "fixture-history" })
      .expect(200);
    expect(runtime.startupSessionHint).toBe("fixture-history");
    const deselected = await local.post("/api/sessions/deselect").expect(200);
    expect(deselected.body).toMatchObject({ active: null });
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
