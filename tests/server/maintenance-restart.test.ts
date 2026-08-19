import { describe, expect, it, vi } from "vitest";
import { nullDiagnosticLogger } from "../../server/diagnostics.js";
import {
  MaintenanceRestartController,
  type InspireSourceIdentity,
  type MaintenanceRestartOutcome,
} from "../../server/maintenance-restart.js";
import type { RuntimeLike } from "../../server/runtime.js";

function controller(options: {
  piVersion?: string;
  runningSource?: InspireSourceIdentity;
  inspectedPiVersion?: string;
  inspectedSource?: InspireSourceIdentity;
  reserve?: () =>
    | { kind: "ready"; expiresAt: number }
    | { kind: "busy"; reason: "active-work" | "in-flight-operation" };
}) {
  const reserve = vi.fn(
    options.reserve ?? (() => ({ kind: "ready" as const, expiresAt: 123_456 })),
  );
  const runtime = {
    reserveMaintenanceRestart: reserve,
  } as unknown as RuntimeLike;
  return {
    reserve,
    subject: new MaintenanceRestartController({
      runtime,
      root: "/workspace/inspire",
      piVersion: options.piVersion ?? "0.84.2",
      runningSource: options.runningSource ?? {
        kind: "source",
        revision: "old-revision",
      },
      diagnostics: nullDiagnosticLogger(),
      inspectPiVersion: async () => options.inspectedPiVersion ?? "0.84.2",
      inspectSource: async () =>
        options.inspectedSource ?? {
          kind: "source",
          revision: "old-revision",
        },
    }),
  };
}

describe("idle maintenance restart", () => {
  it("does nothing when neither installed identity changed", async () => {
    const { subject, reserve } = controller({});

    await expect(subject.reserve()).resolves.toEqual({
      kind: "skipped",
      reason: "no-update",
    } satisfies MaintenanceRestartOutcome);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("requires the runtime's final idle fence after detecting updates", async () => {
    const { subject, reserve } = controller({
      inspectedPiVersion: "0.85.0",
      inspectedSource: { kind: "source", revision: "new-revision" },
    });

    await expect(subject.reserve()).resolves.toEqual({
      kind: "ready",
      expiresAt: 123_456,
      updates: ["pi", "inspire"],
    } satisfies MaintenanceRestartOutcome);
    expect(reserve).toHaveBeenCalledOnce();
  });

  it("never applies a dirty source checkout automatically", async () => {
    const { subject, reserve } = controller({
      inspectedPiVersion: "0.85.0",
      inspectedSource: { kind: "source", revision: null },
    });

    await expect(subject.reserve()).resolves.toEqual({
      kind: "skipped",
      reason: "inspire-source-not-clean",
    } satisfies MaintenanceRestartOutcome);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("never restarts when the host itself began from a dirty source tree", async () => {
    const { subject, reserve } = controller({
      runningSource: { kind: "source", revision: null },
      inspectedPiVersion: "0.85.0",
    });

    await expect(subject.reserve()).resolves.toEqual({
      kind: "skipped",
      reason: "inspire-source-not-clean",
    } satisfies MaintenanceRestartOutcome);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("detects a new installed package version", async () => {
    const { subject, reserve } = controller({
      runningSource: { kind: "package", version: "0.1.0" },
      inspectedSource: { kind: "package", version: "0.2.0" },
    });

    await expect(subject.reserve()).resolves.toEqual({
      kind: "ready",
      expiresAt: 123_456,
      updates: ["inspire"],
    } satisfies MaintenanceRestartOutcome);
    expect(reserve).toHaveBeenCalledOnce();
  });

  it("leaves a busy runtime untouched", async () => {
    const { subject, reserve } = controller({
      inspectedPiVersion: "0.85.0",
      reserve: () => ({ kind: "busy", reason: "active-work" }),
    });

    await expect(subject.reserve()).resolves.toEqual({
      kind: "skipped",
      reason: "active-work",
    } satisfies MaintenanceRestartOutcome);
    expect(reserve).toHaveBeenCalledOnce();
  });
});
