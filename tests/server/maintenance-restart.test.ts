import { describe, expect, it, vi } from "vitest";
import { nullDiagnosticLogger } from "../../server/diagnostics.js";
import {
  type InspireSourceIdentity,
  MaintenanceRestartController,
} from "../../server/maintenance-restart.js";

function controller(options: {
  runningSource?: InspireSourceIdentity;
  inspectedPiVersion?: string;
  inspectedSource?: InspireSourceIdentity;
  reserve?: () =>
    | { kind: "ready"; leaseId: string; expiresAt: number }
    | { kind: "busy"; reason: "active-work" | "in-flight-operation" };
}) {
  const reserve = vi.fn(
    options.reserve ??
      (() => ({
        kind: "ready" as const,
        leaseId: "a".repeat(43),
        expiresAt: 123_456,
      })),
  );
  return {
    reserve,
    subject: new MaintenanceRestartController({
      runtime: {
        reserveMaintenanceRestart: reserve,
        commitMaintenanceRestart: (leaseId) => ({ kind: "committed", leaseId }),
        releaseMaintenanceRestart: () => ({ kind: "released" }),
      },
      root: "/workspace/inspire",
      piVersion: "0.84.2",
      runningSource: options.runningSource ?? {
        kind: "source",
        revision: "old-revision",
      },
      diagnostics: nullDiagnosticLogger(),
      inspectPiVersion: async () => options.inspectedPiVersion ?? "0.84.2",
      inspectSource: async () =>
        options.inspectedSource ?? { kind: "source", revision: "old-revision" },
    }),
  };
}

describe("idle maintenance restart", () => {
  const unknown = { kind: "unknown" } as const;
  const dirty = { kind: "source", revision: null } as const;
  it.each([
    [
      "running identity unavailable",
      { runningSource: unknown },
      "inspire-identity-unavailable",
    ],
    [
      "installed identity unavailable",
      { inspectedSource: unknown },
      "inspire-identity-unavailable",
    ],
    [
      "running checkout dirty",
      { runningSource: dirty },
      "inspire-source-not-clean",
    ],
    [
      "installed checkout dirty",
      { inspectedSource: dirty },
      "inspire-source-not-clean",
    ],
    ["neither identity changed", { inspectedPiVersion: "0.84.2" }, "no-update"],
  ] as const)(
    "skips without reserving the runtime when %s",
    async (_case, options, reason) => {
      const { subject, reserve } = controller({
        inspectedPiVersion: "0.85.0",
        ...options,
      });
      await expect(subject.reserve()).resolves.toEqual({
        kind: "skipped",
        reason,
      });
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      source: "source checkout",
      options: {
        inspectedPiVersion: "0.85.0",
        inspectedSource: { kind: "source", revision: "new-revision" },
      },
      updates: ["pi", "inspire"],
    },
    {
      source: "installed package",
      options: {
        runningSource: { kind: "package", version: "0.1.0" },
        inspectedSource: { kind: "package", version: "0.2.0" },
      },
      updates: ["inspire"],
    },
  ] as const)(
    "acquires an idle lease after updating the $source",
    async ({ options, updates }) => {
      const { subject, reserve } = controller(options);
      await expect(subject.reserve()).resolves.toEqual({
        kind: "ready",
        leaseId: "a".repeat(43),
        expiresAt: 123_456,
        updates,
      });
      expect(reserve).toHaveBeenCalledOnce();
    },
  );

  it("leaves a busy runtime untouched", async () => {
    const { subject, reserve } = controller({
      inspectedPiVersion: "0.85.0",
      reserve: () => ({ kind: "busy", reason: "active-work" }),
    });

    await expect(subject.reserve()).resolves.toEqual({
      kind: "skipped",
      reason: "active-work",
    });
    expect(reserve).toHaveBeenCalledOnce();
  });
});
