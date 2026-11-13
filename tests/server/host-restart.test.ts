import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type HostRestartBackend,
  HostRestartController,
} from "../../server/host-restart.js";
import { systemdRestartBackend } from "../../server/host-restart-systemd.js";
import type {
  MaintenanceRestartDecision,
  MaintenanceRestartTransition,
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
    commitMaintenanceRestart: vi.fn<() => MaintenanceRestartTransition>(() => ({
      kind: "committed" as const,
      leaseId: "lease",
    })),
    releaseMaintenanceRestart: vi.fn(() => ({ kind: "released" as const })),
    checkAttachedRestartWork: vi.fn(async () => null),
    stopAttachedPiWork: vi.fn(async () => {}),
  };
  const backend: HostRestartBackend = {
    inspect: vi.fn(async () => ({ host: true, allPi: true })),
    prepare: vi.fn(async () => {}),
    request: vi.fn(async (_all, commit) =>
      (await commit()) ? { code: 0 } : { code: 1, issued: false },
    ),
    ...overrides,
  };
  const controller = new HostRestartController(runtime, backend);
  return { controller, runtime, backend };
}
async function intent(controller: HostRestartController) {
  return {
    hostId: (await controller.status()).hostId,
    operationId: randomUUID(),
    scope: "host" as const,
  };
}

describe("manual Host restart ownership", () => {
  it.each(["host", "all-pi"] as const)(
    "checks the scope's authority before submitting %s",
    async (scope) => {
      const { controller, runtime, backend } = fixture();
      const request = { ...(await intent(controller)), scope };
      const global = scope === "all-pi";
      if (global)
        expect(() => controller.start(request)).toThrow(
          "Confirm closing all Pi",
        );
      controller.start(global ? { ...request, interruptWork: true } : request);
      await vi.waitFor(async () =>
        expect((await controller.status()).operation?.phase).toBe("submitted"),
      );
      expect(runtime.reserveMaintenanceRestart).toHaveBeenCalledWith(
        global,
        true,
      );
      expect(runtime.stopAttachedPiWork).not.toHaveBeenCalled();
      expect(runtime.checkAttachedRestartWork).toHaveBeenCalledTimes(
        global ? 0 : 1,
      );
      expect(backend.request).toHaveBeenCalledWith(scope, expect.any(Function));
    },
  );

  it("finishes preparation before acquiring idle authority and excludes other operations", async () => {
    const ready = Promise.withResolvers<void>();
    const f = fixture({ prepare: vi.fn(() => ready.promise) });
    const request = await intent(f.controller);
    expect(f.controller.start(request).phase).toBe("preparing");
    await vi.waitFor(() => expect(f.backend.prepare).toHaveBeenCalledOnce());
    expect(f.runtime.reserveMaintenanceRestart).not.toHaveBeenCalled();
    expect(() =>
      f.controller.start({ ...request, operationId: randomUUID() }),
    ).toThrow("already pending");
    ready.resolve();
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation?.phase).toBe("submitted"),
    );
    expect(f.backend.request).toHaveBeenCalledOnce();
    expect(f.runtime.commitMaintenanceRestart).toHaveBeenCalledWith("lease");
    expect(f.runtime.releaseMaintenanceRestart).not.toHaveBeenCalled();
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

  it("does not interrupt when another restart owns the lease", async () => {
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

  it("reports scopes separately and rejects unsupported full restart before preparation", async () => {
    const f = fixture({
      inspect: vi.fn(async () => ({ host: true, allPi: false })),
    });
    expect(await f.controller.status()).toMatchObject({
      available: true,
      allPiAvailable: false,
      allPiReason: expect.stringContaining("Linux services"),
    });
    f.controller.start({
      ...(await intent(f.controller)),
      scope: "all-pi",
      interruptWork: true,
    });
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

  it.each([
    ["proven non-issuance", "rejected"],
    ["exit-error", "unknown"],
    ["lost-result", "unknown"],
  ] as const)("publishes %s as %s without replay", async (mode, phase) => {
    const f = fixture({
      request: vi.fn(async (_scope, commit) => {
        expect(await commit()).toBe(true);
        if (mode === "lost-result") throw new Error("IPC lost");
        return mode === "proven non-issuance"
          ? { code: 1, issued: false }
          : { code: 1 };
      }),
    });
    const request = await intent(f.controller);
    f.controller.start(request);
    await vi.waitFor(async () =>
      expect((await f.controller.status()).operation?.phase).toBe(phase),
    );
    if (phase === "rejected")
      expect(
        f.runtime.releaseMaintenanceRestart,
      ).toHaveBeenCalledExactlyOnceWith("lease");
    else {
      expect(f.runtime.releaseMaintenanceRestart).not.toHaveBeenCalled();
      expect(() =>
        f.controller.start({ ...request, operationId: randomUUID() }),
      ).toThrow("already pending");
    }
    expect(f.controller.start(request).phase).toBe(phase);
    expect(f.backend.request).toHaveBeenCalledOnce();
  });
});

it("captures an isolated restart preflight failure and allows a corrected retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspire-preflight-probe-"));
  const launcher = join(root, "inspire.mjs");
  try {
    const backend = systemdRestartBackend(root, false);
    expect(await backend.inspect()).toMatchObject({
      host: false,
      allPi: false,
    });
    await expect(
      backend.request("host", () => {
        throw new Error("must not commit");
      }),
    ).resolves.toEqual({ issued: false, code: 1 });

    await writeFile(
      launcher,
      `
      console.error("x".repeat(10000));
      console.error("\x1b[31mSynthetic missing runtime module\x1b[0m");
      process.exitCode = 1;
    `,
    );
    const failure = await backend.prepare().catch((error: unknown) => error);
    if (!(failure instanceof Error))
      throw new Error("Preparation unexpectedly passed");
    expect(failure.message).toContain("Synthetic missing runtime module");
    expect(failure.message.length).toBeLessThan(4100);
    expect(failure.message).not.toContain("\u001b");

    await writeFile(
      launcher,
      'if (process.argv[2] !== "prepare-restart") process.exit(1);',
    );
    await expect(backend.prepare()).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
