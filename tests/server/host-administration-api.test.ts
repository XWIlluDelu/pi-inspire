import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostRestartBackend } from "../../server/host-restart.js";
import type { HerdrEnhancementStatus } from "../../shared/herdr.js";
import type { HostRestartRequest } from "../../shared/host-restart.js";
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

async function restartFixture() {
  const restart = vi.fn<HostRestartBackend["request"]>(
    async (_scope, commit) => ({
      code: (await commit()) ? 0 : 1,
    }),
  );
  const prepare = vi.fn<HostRestartBackend["prepare"]>(async () => {});
  const inspect = vi.fn<HostRestartBackend["inspect"]>(async () => ({
    host: true,
    allPi: true,
    includeHerdr: true,
  }));
  const { runtime, guest, local } = await fixture({
    restart: { request: restart, prepare, inspect },
  });
  const path = "/api/host/restart";
  const observe = () =>
    local.get(path).expect("Cache-Control", "no-store").expect(200);
  const status = (await observe()).body;
  const intent = (
    patch: Partial<HostRestartRequest> = {},
  ): HostRestartRequest => ({
    hostId: status.hostId,
    operationId: randomUUID(),
    scope: "host",
    ...patch,
  });
  return {
    runtime,
    guest,
    path,
    status,
    intent,
    inspect,
    prepare,
    restart,
    submit: (value: object) => local.post(path).send(value),
    settle: (expected: object) =>
      vi.waitFor(async () => {
        expect((await observe()).body.operation).toMatchObject(expected);
      }),
  };
}

describe("Host administration API", () => {
  it("authenticates restart, deduplicates preparation, and only drains after a supported retry", async () => {
    const f = await restartFixture();
    const preparation = Promise.withResolvers<void>();
    f.prepare.mockReturnValueOnce(preparation.promise);
    const reserve = vi.spyOn(f.runtime, "reserveMaintenanceRestart");
    const attached = vi.spyOn(f.runtime, "checkAttachedRestartWork");
    await f.guest.get(f.path).expect(401);
    await f.guest.post(f.path).send({}).expect(401);
    expect(f.status).toMatchObject({
      allPiAvailable: true,
      allPiIncludesHerdr: true,
    });
    const intent = f.intent({ scope: "all-pi", interruptWork: true });
    await f.submit(intent).set("Origin", "https://foreign.example").expect(403);
    for (const patch of [
      { scope: "arbitrary-service" },
      { scope: "all" },
      { interruptWork: false },
      { interruptWork: undefined },
    ])
      await f.submit({ ...intent, ...patch }).expect(400);
    await f.submit({ ...intent, hostId: randomUUID() }).expect(409);
    expect(f.prepare).not.toHaveBeenCalled();
    const admitted = await f.submit(intent).expect(202);
    expect(admitted.body).toMatchObject({
      executor: { kind: "lifecycle", hostId: intent.hostId },
      operationId: intent.operationId,
      command: "restart",
      state: "pending",
      result: { phase: "preparing" },
    });
    await f.submit(intent).expect(202);
    await f.submit({ ...intent, scope: "host" }).expect(409);
    await f.submit(f.intent()).expect(409);
    await f.settle({
      id: intent.operationId,
      scope: "all-pi",
      phase: "preparing",
    });
    expect(reserve).not.toHaveBeenCalled();
    preparation.reject(new Error("Synthetic preparation failure"));
    await f.settle({
      phase: "rejected",
      error: "Synthetic preparation failure",
    });
    expect((await f.submit(intent).expect(202)).body).toMatchObject({
      state: "rejected",
      result: { phase: "rejected" },
    });
    f.inspect.mockResolvedValue({ host: true, allPi: false });
    const unsupported = f.intent({ scope: intent.scope, interruptWork: true });
    await f.submit(unsupported).expect(202);
    await f.settle({
      id: unsupported.operationId,
      phase: "rejected",
      error: expect.stringContaining("Linux services"),
    });
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(reserve).not.toHaveBeenCalled();
    expect(f.restart).not.toHaveBeenCalled();

    await f.submit(f.intent()).expect(202);
    await f.settle({ phase: "submitted" });
    expect(reserve).toHaveBeenCalledExactlyOnceWith(false, true);
    expect(attached).toHaveBeenCalledOnce();
    expect(f.restart).toHaveBeenCalledExactlyOnceWith(
      "host",
      expect.any(Function),
    );
  });

  it("requires a fresh interruption grant and validates the real lease before stopping attached work", async () => {
    const f = await restartFixture();
    const stop = vi
      .spyOn(f.runtime, "stopAttachedPiWork")
      .mockRejectedValueOnce(new Error("Could not confirm Stop for session A"));
    const lease = f.runtime.reserveMaintenanceRestart();
    if (lease.kind !== "ready") throw new Error("Expected idle Host");
    await f.submit(f.intent({ interruptWork: true })).expect(202);
    await f.settle({ phase: "rejected", busyReason: "restart-pending" });
    expect(stop).not.toHaveBeenCalled();
    f.runtime.releaseMaintenanceRestart(lease.leaseId);

    const reserve = vi.spyOn(f.runtime, "reserveMaintenanceRestart");
    reserve.mockReturnValueOnce({ kind: "busy", reason: "active-work" });
    const request = f.intent();
    await f.submit(request).expect(202);
    await f.settle({
      id: request.operationId,
      phase: "rejected",
      busyReason: "active-work",
    });
    await f.submit({ ...request, interruptWork: true }).expect(409);
    const anyway = f.intent({ interruptWork: true, skipAttachedStop: true });
    await f.submit(anyway).expect(409);
    await f.submit(f.intent({ interruptWork: true })).expect(202);
    await f.settle({
      phase: "rejected",
      stopUnconfirmed: true,
      error: "Could not confirm Stop for session A",
    });
    expect(f.restart).not.toHaveBeenCalled();
    await f.submit(anyway).expect(202);
    await f.settle({ phase: "submitted" });
    await f.submit({ ...anyway, skipAttachedStop: undefined }).expect(409);
    expect(stop).toHaveBeenCalledOnce();
    expect(f.restart).toHaveBeenCalledOnce();
  });

  it.each([
    "active-work",
    "in-flight-operation",
    "not-issued",
    "failed",
    "lost",
  ] as const)(
    "fences %s at commit or submission and never replays the same receipt",
    async (fault) => {
      const f = await restartFixture();
      const commit = vi.spyOn(f.runtime, "commitMaintenanceRestart");
      const veto = fault === "active-work" || fault === "in-flight-operation";
      if (veto) commit.mockReturnValueOnce({ kind: "skipped", reason: fault });
      else
        f.restart.mockImplementationOnce(async (_scope, admit) => {
          expect(await admit()).toBe(true);
          if (fault === "lost") throw new Error("IPC lost");
          return fault === "not-issued"
            ? { code: 1, issued: false }
            : { code: 1 };
        });
      const uncertain = fault === "failed" || fault === "lost";
      const phase = uncertain ? "unknown" : "rejected";
      const intent = f.intent();
      await f.submit(intent).expect(202);
      await f.settle({
        phase,
        ...(veto
          ? {
              busyReason: fault,
              error: expect.stringContaining("Stop work and restart"),
            }
          : {}),
      });
      expect(f.runtime.reserveMaintenanceRestart().kind).toBe(
        uncertain ? "busy" : "ready",
      );
      if (uncertain) await f.submit(f.intent()).expect(409);
      expect((await f.submit(intent).expect(202)).body.result.phase).toBe(
        phase,
      );
      expect(f.restart).toHaveBeenCalledOnce();
    },
  );

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
