import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostRestartBackend } from "../../server/host-restart.js";
import type { HerdrEnhancementStatus } from "../../shared/herdr.js";
import { closeHostApiFixture, hostApiFixture } from "./fixtures/host-api.js";

let host: Awaited<ReturnType<typeof hostApiFixture>> | undefined;
afterEach(async () => {
  if (host) await closeHostApiFixture(host);
  host = undefined;
});

async function fixture(
  options: {
    restart?: HostRestartBackend;
    getHerdrStatus?: () => Promise<HerdrEnhancementStatus>;
  } = {},
) {
  host = await hostApiFixture({
    getHerdrStatus: options.getHerdrStatus,
    restartBackend: options.restart,
  });
  return {
    runtime: host.runtime,
    guest: request(host.application.server),
    local: host.localRequest,
  };
}

describe("Host administration API", () => {
  it("authenticates restart, deduplicates preparation, and retains a failed receipt without restarting", async () => {
    const restart = vi.fn(async () => ({ code: 0 }));
    const preparation = Promise.withResolvers<void>();
    const prepare = vi.fn(() => preparation.promise);
    const { runtime, guest, local } = await fixture({
      restart: {
        inspect: async () => ({ host: true, allPi: true, includeHerdr: true }),
        prepare,
        request: restart,
      },
    });
    const reserve = vi.spyOn(runtime, "reserveMaintenanceRestart");
    const path = "/api/host/restart";
    const submit = (intent: object) => local.post(path).send(intent);
    await guest.get(path).expect(401);
    await guest.post(path).send({}).expect(401);
    const observe = () =>
      local.get(path).expect("Cache-Control", "no-store").expect(200);
    const { body: status } = await observe();
    expect(status).toMatchObject({
      allPiAvailable: true,
      allPiIncludesHerdr: true,
    });
    const intent = {
      hostId: status.hostId,
      operationId: randomUUID(),
      scope: "all-pi",
      interruptWork: true,
    };
    await submit(intent).set("Origin", "https://foreign.example").expect(403);
    for (const patch of [
      { scope: "arbitrary-service" },
      { scope: "all" },
      { interruptWork: false },
      { interruptWork: undefined },
    ])
      await submit({ ...intent, ...patch }).expect(400);
    await submit({ ...intent, hostId: randomUUID() }).expect(409);
    expect(prepare).not.toHaveBeenCalled();
    const admitted = await submit(intent).expect(202);
    expect(admitted.body).toMatchObject({
      executor: { kind: "lifecycle", hostId: intent.hostId },
      operationId: intent.operationId,
      command: "restart",
      state: "pending",
      result: { phase: "preparing" },
    });
    await submit(intent).expect(202);
    await submit({ ...intent, scope: "host" }).expect(409);
    const late = await observe();
    expect(late.body.operation).toMatchObject({
      id: intent.operationId,
      scope: "all-pi",
      phase: "preparing",
    });
    preparation.reject(new Error("Synthetic preparation failure"));
    await vi.waitFor(async () => {
      const { body } = await local.get(path).expect(200);
      expect(body.operation).toMatchObject({
        phase: "rejected",
        error: "Synthetic preparation failure",
      });
    });
    expect((await submit(intent).expect(202)).body).toMatchObject({
      state: "rejected",
      result: { phase: "rejected" },
    });
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
      (await local.get("/api/preferences").expect(200)).body.preferences
        .herdrEnabled,
    ).toBe(true);
  });
});
