import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  HostRestartController,
  type HostRestartBackend,
} from "../../server/host-restart.js";
import type {
  MaintenanceRestartDecision,
  RuntimeLike,
} from "../../server/runtime.js";

function fixture(overrides: Partial<HostRestartBackend> = {}) {
  const runtime = {
    reserveMaintenanceRestart: vi.fn<
      (interruptWork?: boolean) => MaintenanceRestartDecision
    >(() => ({
      kind: "ready",
      leaseId: "lease",
      expiresAt: Date.now() + 30_000,
    })),
    commitMaintenanceRestart: vi.fn(() => ({
      kind: "committed",
      leaseId: "lease",
    })),
    releaseMaintenanceRestart: vi.fn(() => ({ kind: "released" })),
  };
  const backend: HostRestartBackend = {
    inspect: vi.fn(async () => true),
    prepare: vi.fn(async () => {}),
    request: vi.fn(async (_all, commit) =>
      commit() ? { code: 0 } : { code: 1, issued: false },
    ),
    ...overrides,
  };
  const controller = new HostRestartController(
    runtime as unknown as RuntimeLike,
    backend,
  );
  return { controller, runtime, backend };
}
async function intent(controller: HostRestartController) {
  return {
    hostId: (await controller.status()).hostId,
    operationId: randomUUID(),
    scope: "all" as const,
  };
}

describe("manual Host restart ownership", () => {
  it("prepares before acquiring idle authority and deduplicates requests from any observer", async () => {
    let ready!: () => void;
    const f = fixture({
      prepare: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            ready = resolve;
          }),
      ),
    });
    const request = await intent(f.controller);
    expect(f.controller.start(request).phase).toBe("preparing");
    await vi.waitFor(() => expect(f.backend.prepare).toHaveBeenCalledOnce());
    expect(f.runtime.reserveMaintenanceRestart).not.toHaveBeenCalled();
    expect(f.controller.start(request).id).toBe(request.operationId);
    expect(() =>
      f.controller.start({ ...request, operationId: randomUUID() }),
    ).toThrow("already pending");
    ready();
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation?.phase).toBe("submitted"),
    );
    expect(f.backend.request).toHaveBeenCalledOnce();
    expect(f.runtime.commitMaintenanceRestart).toHaveBeenCalledWith("lease");
    expect(f.runtime.releaseMaintenanceRestart).not.toHaveBeenCalled();
  });

  it("rejects foreign Host and changed-scope identities before preparation", async () => {
    const f = fixture();
    const request = await intent(f.controller);
    expect(() =>
      f.controller.start({ ...request, hostId: randomUUID() }),
    ).toThrow("Host changed");
    f.controller.start(request);
    expect(() => f.controller.start({ ...request, scope: "host" })).toThrow(
      "does not match",
    );
  });

  it("keeps the old Host running when preparation fails, retaining the rejected receipt", async () => {
    const f = fixture({
      prepare: vi.fn(async () => {
        throw new Error("Build failed");
      }),
    });
    const request = await intent(f.controller);
    f.controller.start(request);
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation).toMatchObject({
        phase: "rejected",
        error: "Build failed",
      }),
    );
    expect(f.runtime.reserveMaintenanceRestart).not.toHaveBeenCalled();
    expect(f.backend.request).not.toHaveBeenCalled();
    expect(f.controller.start(request).phase).toBe("rejected");
    expect(f.backend.prepare).toHaveBeenCalledOnce();
  });

  it("refuses ordinary busy restart, then explicitly authorizes interruption after fresh preparation", async () => {
    const f = fixture();
    f.runtime.reserveMaintenanceRestart.mockImplementation((interruptWork) =>
      interruptWork
        ? { kind: "ready", leaseId: "lease", expiresAt: Date.now() + 30_000 }
        : { kind: "busy", reason: "active-work" },
    );
    const safe = await intent(f.controller);
    f.controller.start(safe);
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation).toMatchObject({
        phase: "rejected",
        busyReason: "active-work",
      }),
    );
    expect(f.backend.request).not.toHaveBeenCalled();
    expect(() => f.controller.start({ ...safe, interruptWork: true })).toThrow(
      "does not match",
    );
    const forced = {
      ...safe,
      operationId: randomUUID(),
      interruptWork: true as const,
    };
    f.controller.start(forced);
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation?.phase).toBe("submitted"),
    );
    expect(f.runtime.reserveMaintenanceRestart).toHaveBeenCalledWith(true);
    expect(f.runtime.commitMaintenanceRestart).toHaveBeenCalledWith("lease");
    expect(f.backend.prepare).toHaveBeenCalledTimes(2);
    expect(f.backend.request).toHaveBeenCalledOnce();
    expect(() =>
      f.controller.start({ ...forced, interruptWork: undefined }),
    ).toThrow("does not match");
  });

  it("does not interrupt on failed forced preparation or when another restart lease exists", async () => {
    const f = fixture({
      prepare: vi.fn(async () => {
        throw new Error("Build failed");
      }),
    });
    f.controller.start({
      ...(await intent(f.controller)),
      interruptWork: true,
    });
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation?.phase).toBe("rejected"),
    );
    expect(f.runtime.reserveMaintenanceRestart).not.toHaveBeenCalled();
    expect(f.backend.request).not.toHaveBeenCalled();

    const occupied = fixture();
    occupied.runtime.reserveMaintenanceRestart.mockReturnValue({
      kind: "busy",
      reason: "restart-pending",
    });
    occupied.controller.start({
      ...(await intent(occupied.controller)),
      interruptWork: true,
    });
    await vi.waitFor(async () =>
      expect((await occupied.controller.status()).operation).toMatchObject({
        phase: "rejected",
        busyReason: "restart-pending",
      }),
    );
    expect(occupied.backend.request).not.toHaveBeenCalled();
  });

  it("does not prepare or restart unsupported services", async () => {
    const f = fixture({ inspect: vi.fn(async () => false) });
    expect((await f.controller.status()).available).toBe(false);
    f.controller.start(await intent(f.controller));
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation?.phase).toBe("rejected"),
    );
    expect(f.backend.prepare).not.toHaveBeenCalled();
  });

  it("releases only after proven non-issuance", async () => {
    const f = fixture({
      request: vi.fn(async (_all, commit) => {
        commit();
        return { issued: false, code: 1 };
      }),
    });
    f.controller.start(await intent(f.controller));
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation?.phase).toBe("rejected"),
    );
    expect(f.runtime.releaseMaintenanceRestart).toHaveBeenCalledWith("lease");
  });

  it.each(["exit-error", "lost-result"])(
    "retains committed drain and prohibits replay after %s",
    async (mode) => {
      const f = fixture({
        request: vi.fn(async (_all, commit) => {
          commit();
          if (mode === "lost-result") throw new Error("IPC lost");
          return { code: 1 };
        }),
      });
      const request = await intent(f.controller);
      f.controller.start(request);
      await vi.waitFor(async () =>
        expect((await f.controller.status()).operation?.phase).toBe("unknown"),
      );
      expect(f.runtime.releaseMaintenanceRestart).not.toHaveBeenCalled();
      expect(f.controller.start(request).phase).toBe("unknown");
      expect(f.backend.request).toHaveBeenCalledOnce();
      expect(() =>
        f.controller.start({ ...request, operationId: randomUUID() }),
      ).toThrow("already pending");
    },
  );
});
