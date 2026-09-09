import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app.js";
import { HostRestartController } from "../../server/host-restart.js";
import { MockRuntime, MockCatalog } from "../../server/mock.js";
import { AttachmentStore } from "../../server/attachments.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("authenticated page restart API", () => {
  it("authenticates both routes, rejects stale/malformed scope, and exposes one preparation to late observers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-restart-api-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const runtime = new MockRuntime();
    let rejectPreparation!: (error: Error) => void;
    const prepare = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPreparation = reject;
        }),
    );
    const dispatch = vi.fn(async () => ({ code: 0 }));
    const controller = new HostRestartController(runtime, {
      inspect: async () => true,
      prepare,
      request: dispatch,
    });
    const application = createInspireServer({
      token: "fixture-token",
      runtime,
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(directory, "uploads")),
      preferences: new PreferencesStore(join(directory, "preferences.json")),
      resources: new ResourceStore(),
      git: {
        status: async () => ({ kind: "not-repository" }),
        diff: async () => {
          throw new Error("unused");
        },
      },
      mock: true,
      version: "test",
      piVersion: "test",
      hostRestart: controller,
    });
    cleanup.push(() => application.close());
    const api = request(application.app);
    await api.get("/api/host/restart").expect(401);
    await api.post("/api/host/restart").send({}).expect(401);
    const status = await api
      .get("/api/host/restart")
      .set("Authorization", "Bearer fixture-token")
      .expect(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    const intent = {
      hostId: status.body.hostId,
      operationId: randomUUID(),
      scope: "all",
    };
    await api
      .post("/api/host/restart")
      .set("Authorization", "Bearer fixture-token")
      .set("Origin", "https://foreign.example")
      .send(intent)
      .expect(403);
    await api
      .post("/api/host/restart")
      .set("Authorization", "Bearer fixture-token")
      .send({ ...intent, scope: "arbitrary-service" })
      .expect(400);
    await api
      .post("/api/host/restart")
      .set("Authorization", "Bearer fixture-token")
      .send({ ...intent, hostId: randomUUID() })
      .expect(409);
    await api
      .post("/api/host/restart")
      .set("Authorization", "Bearer fixture-token")
      .send(intent)
      .expect(202);
    await api
      .post("/api/host/restart")
      .set("Authorization", "Bearer fixture-token")
      .send(intent)
      .expect(202);
    expect(prepare).toHaveBeenCalledOnce();
    const late = await api
      .get("/api/host/restart")
      .set("Authorization", "Bearer fixture-token")
      .expect(200);
    expect(late.body.operation).toMatchObject({
      id: intent.operationId,
      scope: "all",
      phase: "preparing",
    });
    rejectPreparation(new Error("Synthetic preparation failure"));
    await vi.waitFor(async () =>
      expect((await controller.status()).operation?.phase).toBe("rejected"),
    );
    const rejected = await api
      .post("/api/host/restart")
      .set("Authorization", "Bearer fixture-token")
      .send(intent)
      .expect(202);
    expect(rejected.body.phase).toBe("rejected");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
