import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  type HostRestartBackend,
  HostRestartController,
} from "../../server/host-restart.js";
import type {
  MaintenanceRestartDecision,
  MaintenanceRestartTransition,
} from "../../server/runtime.js";

function fixture(
  overrides: Partial<HostRestartBackend> = {},
  canPreserveWorkers?: () => boolean,
) {
  const runtime = {
    reserveMaintenanceRestart: vi.fn<
      (interruptWork?: boolean) => MaintenanceRestartDecision
    >(() => ({
      kind: "ready",
      leaseId: "lease",
      expiresAt: Date.now() + 30_000,
    })),
    commitMaintenanceRestart: vi.fn<() => MaintenanceRestartTransition>(() => ({
      kind: "committed" as const,
      leaseId: "lease",
    })),
    releaseMaintenanceRestart: vi.fn(() => ({ kind: "released" as const })),
    checkAttachedRestartWork: vi.fn(async () => null),
    stopAttachedPiWork: vi.fn(async () => {}),
  };
  const backend: HostRestartBackend = {
    inspect: vi.fn(async () => ({ host: true, all: true })),
    prepare: vi.fn(async () => {}),
    request: vi.fn(async (_all, commit) =>
      (await commit()) ? { code: 0 } : { code: 1, issued: false },
    ),
    ...overrides,
  };
  const controller = new HostRestartController(
    runtime,
    backend,
    canPreserveWorkers,
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
  it.each(["host", "all", "host-only"] as const)(
    "%s restart sends no command to taken-over Pi before submission",
    async (scope) => {
      const f = fixture();
      const preserveWork = scope === "host-only";
      f.controller.start({
        hostId: (await f.controller.status()).hostId,
        operationId: randomUUID(),
        scope,
      });
      await vi.waitFor(async () =>
        expect((await f.controller.status()).operation?.phase).toBe(
          "submitted",
        ),
      );
      expect(f.runtime.reserveMaintenanceRestart).toHaveBeenCalledWith(
        false,
        !preserveWork,
        preserveWork,
      );
      expect(f.runtime.stopAttachedPiWork).not.toHaveBeenCalled();
      expect(f.runtime.checkAttachedRestartWork).toHaveBeenCalledTimes(
        preserveWork ? 0 : 1,
      );
      expect(f.backend.request).toHaveBeenCalledWith(
        scope === "all",
        expect.any(Function),
      );
    },
  );

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

  it("refuses browser preservation when enhanced Pi must release ownership before shutdown", async () => {
    const f = fixture({}, () => false);
    f.controller.start({ ...(await intent(f.controller)), scope: "host-only" });
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation).toMatchObject({
        phase: "rejected",
        error: expect.stringContaining("inspire restart --host-only"),
      }),
    );
    expect(f.runtime.commitMaintenanceRestart).not.toHaveBeenCalled();
    expect(f.runtime.releaseMaintenanceRestart).toHaveBeenCalledExactlyOnceWith(
      "lease",
    );
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
    expect(f.runtime.stopAttachedPiWork).not.toHaveBeenCalled();
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
    expect(f.runtime.reserveMaintenanceRestart).toHaveBeenCalledWith(
      true,
      true,
      false,
    );
    expect(f.runtime.stopAttachedPiWork).toHaveBeenCalledOnce();
    expect(f.runtime.commitMaintenanceRestart).toHaveBeenCalledWith("lease");
    expect(f.backend.prepare).toHaveBeenCalledTimes(2);
    expect(f.backend.request).toHaveBeenCalledOnce();
    expect(() =>
      f.controller.start({ ...forced, interruptWork: undefined }),
    ).toThrow("does not match");
  });

  it("reports an unconfirmed Stop before allowing Restart anyway", async () => {
    const f = fixture();
    const request = {
      ...(await intent(f.controller)),
      interruptWork: true as const,
    };
    const anyway = {
      ...request,
      operationId: randomUUID(),
      skipAttachedStop: true as const,
    };
    expect(() => f.controller.start(anyway)).toThrow(
      "Review the unconfirmed Stop",
    );
    f.runtime.stopAttachedPiWork.mockRejectedValueOnce(
      new Error("Could not confirm Stop for session A."),
    );
    f.controller.start(request);
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation).toMatchObject({
        phase: "rejected",
        stopUnconfirmed: true,
        error: "Could not confirm Stop for session A.",
      }),
    );
    expect(f.backend.request).not.toHaveBeenCalled();
    expect(f.runtime.releaseMaintenanceRestart).toHaveBeenCalledWith("lease");
    f.controller.start(anyway);
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation?.phase).toBe("submitted"),
    );
    expect(f.backend.request).toHaveBeenCalledOnce();
    expect(f.runtime.stopAttachedPiWork).toHaveBeenCalledOnce();
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
    const f = fixture({
      inspect: vi.fn(async () => ({ host: false, all: false })),
    });
    expect((await f.controller.status()).available).toBe(false);
    f.controller.start(await intent(f.controller));
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation?.phase).toBe("rejected"),
    );
    expect(f.backend.prepare).not.toHaveBeenCalled();
  });

  it("reports scopes separately and rejects unsupported full restart before preparation", async () => {
    const f = fixture({
      inspect: vi.fn(async () => ({ host: true, all: false })),
    });
    expect(await f.controller.status()).toMatchObject({
      available: true,
      allAvailable: false,
      allReason: expect.stringContaining("Linux systemd"),
    });
    f.controller.start(await intent(f.controller));
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation).toMatchObject({
        phase: "rejected",
        error: expect.stringContaining("Restart all requires"),
      }),
    );
    expect(f.backend.prepare).not.toHaveBeenCalled();
    expect(f.runtime.reserveMaintenanceRestart).not.toHaveBeenCalled();
    f.controller.start({ ...(await intent(f.controller)), scope: "host" });
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation?.phase).toBe("submitted"),
    );
  });

  it("releases only after proven non-issuance", async () => {
    const f = fixture({
      request: vi.fn(async (_all, commit) => {
        await commit();
        return { issued: false, code: 1 };
      }),
    });
    f.controller.start(await intent(f.controller));
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation?.phase).toBe("rejected"),
    );
    expect(f.runtime.releaseMaintenanceRestart).toHaveBeenCalledWith("lease");
  });

  it.each(["active-work", "in-flight-operation"] as const)(
    "reports a %s veto at final submission as a workload refusal",
    async (reason) => {
      const f = fixture();
      f.runtime.commitMaintenanceRestart.mockReturnValue({
        kind: "skipped",
        reason,
      });
      f.controller.start(await intent(f.controller));
      await vi.waitFor(async () =>
        expect((await f.controller.status()).operation).toMatchObject({
          phase: "rejected",
          busyReason: reason,
          error: expect.stringContaining("Stop work and restart"),
        }),
      );
      expect(
        f.runtime.releaseMaintenanceRestart,
      ).toHaveBeenCalledExactlyOnceWith("lease");
    },
  );

  it.each(["exit-error", "lost-result"])(
    "retains committed drain and prohibits replay after %s",
    async (mode) => {
      const f = fixture({
        request: vi.fn(async (_all, commit) => {
          await commit();
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
