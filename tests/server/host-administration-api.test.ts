import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app.js";
import {
  type HostRestartBackend,
  HostRestartController,
} from "../../server/host-restart.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import type { HerdrEnhancementStatus } from "../../shared/herdr.js";
import { hostServices } from "../fixtures/host-services.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  options: {
    restart?: HostRestartBackend;
    getHerdrStatus?: () => Promise<HerdrEnhancementStatus>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "inspire-host-admin-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const services = hostServices(directory);
  const application = createInspireServer({
    ...services,
    token: "fixture-token",
    preferences: new PreferencesStore(join(directory, "preferences.json")),
    resources: new ResourceStore(),
    git: {
      status: async () => ({ kind: "not-repository" }),
      diff: async () => {
        throw new Error("Git is outside this fixture");
      },
    },
    version: "test",
    piVersion: "test",
    hostRestart: options.restart
      ? new HostRestartController(services.runtime, options.restart)
      : undefined,
    getHerdrStatus: options.getHerdrStatus,
  });
  cleanup.push(() => application.close());
  return {
    runtime: services.runtime,
    guest: request(application.app),
    local: request
      .agent(application.app)
      .set("Authorization", "Bearer fixture-token"),
  };
}

describe("Host administration API", () => {
  it("authenticates restart, deduplicates preparation, and retains a failed receipt without restarting", async () => {
    const restart = vi.fn(async () => ({ code: 0 }));
    let rejectPreparation!: (error: Error) => void;
    const prepare = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPreparation = reject;
        }),
    );
    const { runtime, guest, local } = await fixture({
      restart: {
        inspect: async () => ({ host: true, all: true }),
        prepare,
        request: restart,
      },
    });
    const reserve = vi.spyOn(runtime, "reserveMaintenanceRestart");
    const path = "/api/host/restart";
    const submit = (intent: object) => local.post(path).send(intent);
    await guest.get(path).expect(401);
    await guest.post(path).send({}).expect(401);
    const status = await local
      .get(path)
      .expect("Cache-Control", "no-store")
      .expect(200);
    const intent = {
      hostId: status.body.hostId,
      operationId: randomUUID(),
      scope: "all",
      interruptWork: true,
    };
    await submit(intent).set("Origin", "https://foreign.example").expect(403);
    await submit({ ...intent, scope: "arbitrary-service" }).expect(400);
    await submit({ ...intent, interruptWork: false }).expect(400);
    await submit({ ...intent, hostId: randomUUID() }).expect(409);
    await submit(intent).expect(202);
    await submit(intent).expect(202);
    await submit({ ...intent, scope: "host" }).expect(409);
    await submit({ ...intent, interruptWork: undefined }).expect(409);
    const late = await local.get(path).expect(200);
    expect(late.body.operation).toMatchObject({
      id: intent.operationId,
      scope: "all",
      phase: "preparing",
    });
    rejectPreparation(new Error("Synthetic preparation failure"));
    await vi.waitFor(async () => {
      const { body } = await local.get(path).expect(200);
      expect(body.operation).toMatchObject({
        phase: "rejected",
        error: "Synthetic preparation failure",
      });
    });
    expect((await submit(intent).expect(202)).body.phase).toBe("rejected");
    expect(prepare).toHaveBeenCalledOnce();
    expect(reserve).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("authenticates Herdr status and reports missing integration as unavailable", async () => {
    const { guest, local } = await fixture();
    await guest.get("/api/host/herdr").expect(401);
    const response = await local
      .get("/api/host/herdr")
      .expect("Cache-Control", "no-store")
      .expect(503);
    expect(response.body.error).toMatch(/status is unavailable/);
  });

  it("keeps effective Herdr status separate from the saved next-start preference", async () => {
    const status: HerdrEnhancementStatus = {
      enabled: false,
      ready: true,
      supported: true,
      installed: true,
      running: false,
      compatible: true,
      version: "0.9.1",
    };
    const { local } = await fixture({ getHerdrStatus: async () => status });
    const before = await local
      .get("/api/host/herdr")
      .expect("Cache-Control", "no-store")
      .expect(200);
    expect(before.body).toEqual(status);
    await local
      .patch("/api/preferences")
      .send({ herdrEnabled: true })
      .expect(200);
    expect((await local.get("/api/host/herdr").expect(200)).body.enabled).toBe(
      false,
    );
    expect(
      (await local.get("/api/preferences").expect(200)).body.herdrEnabled,
    ).toBe(true);
  });
});
