import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HostRestartBackend,
  HostRestartController,
} from "../../server/host-restart.js";
import { systemdRestartBackend } from "../../server/host-restart-systemd.js";
import type { HostRestartRequest } from "../../shared/host-restart.js";
import {
  disposeRuntimeFixture,
  initializeRuntimeFixture,
  schedulingRuntime,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

async function fixture(overrides: Partial<HostRestartBackend> = {}) {
  const { runtime } = schedulingRuntime({ sessions: [] });
  const reserve = vi.spyOn(runtime, "reserveMaintenanceRestart");
  const commit = vi.spyOn(runtime, "commitMaintenanceRestart");
  const release = vi.spyOn(runtime, "releaseMaintenanceRestart");
  const stopAttached = vi.spyOn(runtime, "stopAttachedPiWork");
  const attachedWork = vi.spyOn(runtime, "checkAttachedRestartWork");
  const backend: HostRestartBackend = {
    inspect: vi.fn(async () => ({ host: true, allPi: true })),
    prepare: vi.fn(async () => {}),
    request: vi.fn(async (_scope, commit) => ({
      code: (await commit()) ? 0 : 1,
    })),
    ...overrides,
  };
  const controller = new HostRestartController(runtime, backend);
  const { hostId } = await controller.status();
  const intent = (
    options: Partial<HostRestartRequest> = {},
  ): HostRestartRequest => ({
    hostId,
    operationId: randomUUID(),
    scope: "host",
    ...options,
  });
  const observe = async (fields: object) =>
    vi.waitFor(async () =>
      expect((await controller.status()).operation).toMatchObject(fields),
    );
  return {
    controller,
    runtime,
    reserve,
    commit,
    release,
    stopAttached,
    attachedWork,
    backend,
    intent,
    observe,
  };
}

describe("manual Host restart ownership", () => {
  it.each(["host", "all-pi"] as const)(
    "checks %s scope before preparing and acquiring the restart lease",
    async (scope) => {
      const prepared = Promise.withResolvers<void>();
      const f = await fixture({ prepare: vi.fn(() => prepared.promise) });
      const request = f.intent({ scope });
      const global = scope === "all-pi";
      if (global) {
        expect(() => f.controller.start(request)).toThrow(
          "Confirm closing all Pi",
        );
        request.interruptWork = true;
      }
      expect(f.controller.start(request).phase).toBe("preparing");
      await vi.waitFor(() => expect(f.backend.prepare).toHaveBeenCalledOnce());
      expect(f.reserve).not.toHaveBeenCalled();
      expect(() => f.controller.start(f.intent())).toThrow("already pending");
      prepared.resolve();
      await f.observe({ phase: "submitted" });
      expect(f.reserve).toHaveBeenCalledExactlyOnceWith(global, true);
      expect(f.attachedWork).toHaveBeenCalledTimes(global ? 0 : 1);
      expect(f.stopAttached).not.toHaveBeenCalled();
      expect(f.backend.request).toHaveBeenCalledExactlyOnceWith(
        scope,
        expect.any(Function),
      );
      expect(f.release).not.toHaveBeenCalled();
    },
  );

  it("requires a fresh grant after a busy or unconfirmed Stop result", async () => {
    const f = await fixture();
    f.reserve.mockReturnValueOnce({ kind: "busy", reason: "active-work" });
    const original = f.intent();
    f.controller.start(original);
    await f.observe({ phase: "rejected", busyReason: "active-work" });
    expect(f.backend.request).not.toHaveBeenCalled();
    expect(() =>
      f.controller.start({ ...original, interruptWork: true }),
    ).toThrow("does not match");

    const forced = f.intent({ interruptWork: true });
    const anyway = f.intent({ interruptWork: true, skipAttachedStop: true });
    expect(() => f.controller.start(anyway)).toThrow(
      "Review the unconfirmed Stop",
    );
    f.stopAttached.mockRejectedValueOnce(
      new Error("Could not confirm Stop for session A."),
    );
    f.controller.start(forced);
    await f.observe({
      phase: "rejected",
      stopUnconfirmed: true,
      error: "Could not confirm Stop for session A.",
    });
    expect(f.backend.request).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    f.controller.start(anyway);
    await f.observe({ phase: "submitted" });
    expect(f.backend.prepare).toHaveBeenCalledTimes(3);
    expect(f.backend.request).toHaveBeenCalledOnce();
    expect(f.stopAttached).toHaveBeenCalledOnce();
    expect(() =>
      f.controller.start({ ...anyway, skipAttachedStop: undefined }),
    ).toThrow("does not match");
  });

  it("cannot interrupt work while another restart holds the actual lease", async () => {
    const f = await fixture();
    expect(f.runtime.reserveMaintenanceRestart().kind).toBe("ready");
    f.controller.start(f.intent({ interruptWork: true }));
    await f.observe({ phase: "rejected", busyReason: "restart-pending" });
    expect(f.stopAttached).not.toHaveBeenCalled();
    expect(f.backend.request).not.toHaveBeenCalled();
  });

  it("rejects unsupported full restart before preparation", async () => {
    const f = await fixture({
      inspect: async () => ({ host: true, allPi: false }),
    });
    expect(await f.controller.status()).toMatchObject({
      available: true,
      allPiAvailable: false,
      allPiReason: expect.stringContaining("Linux services"),
    });
    f.controller.start(f.intent({ scope: "all-pi", interruptWork: true }));
    await f.observe({ phase: "rejected" });
    expect(f.backend.prepare).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    f.controller.start(f.intent());
    await f.observe({ phase: "submitted" });
  });

  it.each(["active-work", "in-flight-operation"] as const)(
    "reports a %s veto at commit",
    async (reason) => {
      const f = await fixture();
      f.commit.mockReturnValueOnce({ kind: "skipped", reason });
      f.controller.start(f.intent());
      await f.observe({
        phase: "rejected",
        busyReason: reason,
        error: expect.stringContaining("Stop work and restart"),
      });
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.runtime.reserveMaintenanceRestart().kind).toBe("ready");
    },
  );

  it.each([
    ["proved no issuance", "rejected"],
    ["failed after commit", "unknown"],
    ["lost reply", "unknown"],
  ] as const)("reports %s as %s without replay", async (mode, phase) => {
    const f = await fixture({
      request: vi.fn(async (_scope, commit) => {
        expect(await commit()).toBe(true);
        if (mode === "lost reply") throw new Error("IPC lost");
        return mode === "proved no issuance"
          ? { code: 1, issued: false }
          : { code: 1 };
      }),
    });
    const request = f.intent();
    f.controller.start(request);
    await f.observe({ phase });
    expect(f.release).toHaveBeenCalledTimes(phase === "rejected" ? 1 : 0);
    expect(f.runtime.reserveMaintenanceRestart().kind).toBe(
      phase === "rejected" ? "ready" : "busy",
    );
    if (phase === "unknown")
      expect(() => f.controller.start(f.intent())).toThrow("already pending");
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
