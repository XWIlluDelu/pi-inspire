import { expect, it, vi } from "vitest";
import { nullDiagnosticLogger } from "../../server/diagnostics.js";
import {
  type InspireSourceIdentity,
  MaintenanceRestartController,
} from "../../server/maintenance-restart.js";

const source = { kind: "source", revision: "old" } as const;
const lease = {
  kind: "ready",
  leaseId: "a".repeat(43),
  expiresAt: 123_456,
} as const;
const unknown = { kind: "unknown" } as const;
const dirty = { kind: "source", revision: null } as const;
function controller({
  runningSource = source,
  current = source,
  piUpdated = false,
  busy = false,
}: {
  runningSource?: InspireSourceIdentity;
  current?: InspireSourceIdentity;
  piUpdated?: boolean;
  busy?: boolean;
} = {}) {
  const reserve = vi.fn(() =>
    busy ? ({ kind: "busy", reason: "active-work" } as const) : lease,
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
      piVersion: "1.5.0",
      runningSource,
      diagnostics: nullDiagnosticLogger(),
      inspectPiVersion: async () => (piUpdated ? "1.5.1" : "1.5.0"),
      inspectSource: async () => current,
    }),
  };
}

it.each([
  [{ runningSource: unknown, piUpdated: true }, "inspire-identity-unavailable"],
  [{ current: unknown, piUpdated: true }, "inspire-identity-unavailable"],
  [{ runningSource: dirty, piUpdated: true }, "inspire-source-not-clean"],
  [{ current: dirty, piUpdated: true }, "inspire-source-not-clean"],
  [{}, "no-update"],
] as const)(
  "skips %j before requesting a runtime lease",
  async (options, reason) => {
    const { subject, reserve } = controller(options);
    await expect(subject.reserve()).resolves.toEqual({
      kind: "skipped",
      reason,
    });
    expect(reserve).not.toHaveBeenCalled();
  },
);

it.each([
  [
    { current: { kind: "source", revision: "new" }, piUpdated: true },
    ["pi", "inspire"],
  ],
  [
    {
      runningSource: { kind: "package", version: "0.1.0" },
      current: { kind: "package", version: "0.2.0" },
    },
    ["inspire"],
  ],
] as const)(
  "attributes installed changes to the proper authority (%#)",
  async (options, updates) => {
    await expect(controller(options).subject.reserve()).resolves.toEqual({
      ...lease,
      updates,
    });
  },
);

it("does not acquire a lease for an active runtime even when Pi changed", async () => {
  await expect(
    controller({ piUpdated: true, busy: true }).subject.reserve(),
  ).resolves.toEqual({ kind: "skipped", reason: "active-work" });
});
