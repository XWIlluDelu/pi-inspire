import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
    await guest.get("/api/update?kind=inspire").expect(401);
    await local.get("/api/update?kind=tools").expect(400);
    const inspire = await local.get("/api/update?kind=inspire").expect(200);
    expect(inspire.body).toMatchObject({
      inspireUpdateCheck: {
        kind: "available",
        update: { latestVersion: "0.2.0" },
      },
      availableUpdateIdentity: '[["inspire","0.2.0"]]',
    });
    const pi = await local.get("/api/update?kind=pi&refresh=1").expect(200);
    expect(pi.body.piUpdateCheck).toMatchObject({
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

  it("checks auth and validates addressed input before domain dispatch", async () => {
    const native = vi.spyOn(runtime, "nativeCommand");
    const history = vi.spyOn(runtime, "sessionHistory");
    const branchImage = vi.spyOn(runtime, "branchImage");
    const address = { sessionId: "fixture-active", viewId: "view" };
    const image = { ...address, targetId: "entry", index: 0 };
    await guest
      .post("/api/control/native-command")
      .send({ sessionId: address.sessionId, command: "compact" })
      .expect(401);
    await guest.get("/api/branches/image").query(image).expect(401);
    await local.post("/api/control/native-command")
      .send({ sessionId: address.sessionId, command: "unknown" })
      .expect(400);
    await local
      .get("/api/history")
      .query({ sessionId: address.sessionId, kind: "page" })
      .expect(400);
    await local
      .get("/api/branches/image")
      .query({ ...image, index: -1 })
      .expect(400);
    for (const spy of [native, history, branchImage])
      expect(spy).not.toHaveBeenCalled();

    const bytes = Buffer.from("saved image bytes");
    branchImage.mockResolvedValue({ mimeType: "image/png", data: bytes });
    await local
      .get("/api/branches/image")
      .query(image)
      .expect("Content-Type", "image/png")
      .expect("Cache-Control", "private, no-store")
      .expect(200, bytes);
    expect(branchImage).toHaveBeenCalledExactlyOnceWith(
      { ...address, targetId: "entry" },
      0,
    );
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
