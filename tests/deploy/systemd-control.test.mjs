import { describe, expect, it, vi } from "vitest";
import {
  hostServicePath,
  inspectHostService,
  inspectRestartTarget,
  manageHostService,
  submitSystemdRestart,
} from "../../deploy/systemd/control.mjs";
import { runIdleMaintenanceRestart } from "../../deploy/systemd/idle-maintenance-restart.mjs";
import { RuntimeController } from "../../server/runtime.js";

import {
  environment,
  invocationId,
  managedProperties,
  managedTerminalProperties,
  root,
  show,
} from "./systemd-fixture.mjs";

const missingPath = async () => {
  throw Object.assign(new Error("absent"), { code: "ENOENT" });
};
const unavailableManager = async () => ({
  code: 1,
  stdout: "",
  stderr: "Failed to connect to bus",
});

describe.runIf(process.platform !== "win32")("host systemd control", () => {
  it.each([
    [
      "matching",
      {},
      {},
      {
        kind: "managed",
        activeState: "active",
        subState: "running",
        unitFileState: "enabled",
        invocationId,
      },
    ],
    [
      "foreign checkout",
      { WorkingDirectory: "/workspace/other" },
      {},
      { kind: "foreign" },
    ],
    [
      "missing terminal requirement",
      { Wants: "network-online.target" },
      {},
      { kind: "outdated" },
    ],
    [
      "foreign terminal",
      {},
      { WorkingDirectory: "/workspace/other" },
      { kind: "outdated" },
    ],
  ])(
    "recognizes service authority: %s",
    async (_case, host, terminal, expected) => {
      await expect(
        inspectHostService(root, {
          environment,
          run: show(
            managedProperties(host),
            managedTerminalProperties(terminal),
          ),
        }),
      ).resolves.toMatchObject(expected);
    },
  );

  it("refuses full restart without verified terminal-before-Host ordering", async () => {
    const calls = [];
    const run = async (args) => {
      calls.push(args);
      return show(managedProperties({ After: "" }))(args);
    };
    expect(
      (await manageHostService(root, "restart-all", { environment, run })).kind,
    ).toBe("outdated");
    expect(calls.some((args) => args.includes("restart"))).toBe(false);
  });

  it("fences both phases to the captured invocation and uses one ordered restart", async () => {
    let active = invocationId;
    const run = vi.fn(async (args) =>
      show(managedProperties({ InvocationID: active }))(args),
    );
    const options = { environment, run };
    const plan = {
      invocationId,
      terminals: true,
      detached: true,
      commit: vi.fn(async () => {
        expect(run.mock.calls.at(-1)?.[0]).toContain(
          "inspire-terminal.service",
        );
        return true;
      }),
    };
    await expect(
      inspectRestartTarget(root, "b".repeat(32), options),
    ).resolves.toEqual({
      kind: "invocation-changed",
    });
    await expect(submitSystemdRestart(root, plan, options)).resolves.toEqual({
      kind: "issued",
    });
    expect(run.mock.calls.at(-1)?.[0]).toEqual([
      "--user",
      "--no-block",
      "restart",
      "inspire-terminal.service",
      "inspire-host.service",
    ]);

    run.mockClear();
    await expect(
      submitSystemdRestart(
        root,
        {
          ...plan,
          beforeRestart: async () => {
            active = "b".repeat(32);
          },
        },
        options,
      ),
    ).resolves.toEqual({ kind: "not-issued", reason: "invocation-changed" });
    expect(run.mock.calls.some(([args]) => args.includes("restart"))).toBe(
      false,
    );
  });

  it("honors the manager's unit absence even when a unit file remains on disk", async () => {
    await expect(
      inspectHostService(root, {
        environment,
        run: show({ LoadState: "not-found" }),
        inspectPath: async (path) =>
          path === hostServicePath(environment) ? {} : missingPath(),
      }),
    ).resolves.toEqual({ kind: "absent" });
  });

  it("permits direct mode only when no offline service authority remains", async () => {
    const run = unavailableManager;
    await expect(
      inspectHostService(root, { environment, run, inspectPath: missingPath }),
    ).resolves.toEqual({ kind: "absent" });
    for (const present of [
      "/home/tester/.config/systemd/user/inspire-host.service",
      "/usr/lib/systemd/user/inspire-host.service",
      "/run/tester/systemd/transient/inspire-host.service",
      `/run/user/${process.getuid?.()}/systemd/private`,
    ]) {
      await expect(
        inspectHostService(root, {
          environment,
          run,
          inspectPath: async (path) => (path === present ? {} : missingPath()),
        }),
        present,
      ).resolves.toEqual({
        kind: "unavailable",
        detail: "Failed to connect to bus",
      });
    }
    for (const variable of ["SYSTEMD_UNIT_PATH", "DBUS_SESSION_BUS_ADDRESS"]) {
      await expect(
        inspectHostService(root, {
          environment: {
            ...environment,
            [variable]:
              variable === "SYSTEMD_UNIT_PATH"
                ? "/custom/units"
                : "unix:path=/custom/bus",
          },
          run,
          inspectPath: missingPath,
        }),
        variable,
      ).resolves.toMatchObject({ kind: "unavailable" });
    }
    await expect(
      inspectHostService(root, {
        environment,
        run,
        inspectPath: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it.each(["masked", ""])(
    "does not treat the installed %s load state as absent",
    async (LoadState) => {
      await expect(
        inspectHostService(root, {
          environment,
          run: show({ LoadState }),
          inspectPath: missingPath,
        }),
      ).resolves.toMatchObject({ kind: "unavailable" });
    },
  );

  it("keeps a loaded foreign unit authoritative even with no remaining file", async () => {
    await expect(
      inspectHostService(root, {
        environment,
        run: show(
          managedProperties({
            FragmentPath: "/usr/lib/systemd/user/inspire-host.service",
          }),
        ),
        inspectPath: missingPath,
      }),
    ).resolves.toMatchObject({ kind: "foreign" });
  });
});

const owner = { systemdInvocationId: invocationId };
const inspect = show(managedProperties());
const denied = { kind: "skipped", reason: "commit-not-authorized" };
const uncertain = {
  kind: "recovery-required",
  reason: "restart-outcome-unknown",
};

describe.runIf(process.platform !== "win32")("idle maintenance restart", () => {
  it.each([
    null,
    { kind: "ready", expiresAt: 30_000 },
    { kind: "skipped", reason: "busy" },
  ])("does not inspect a unit without a prepared lease (%#)", async (lease) => {
    const run = vi.fn();
    const request = vi.fn(async () => lease);
    await expect(
      runIdleMaintenanceRestart(owner, root, { environment, run, request }),
    ).resolves.toEqual({
      kind: "skipped",
      reason: "not-prepared",
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(owner);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { boundary: "lost commit response", commit: "lost", result: denied },
    { boundary: "wrong commit identity", commit: "foreign", result: denied },
    {
      boundary: "lost release response",
      commit: "lost",
      loseRelease: true,
      result: { kind: "recovery-required", reason: "release-unconfirmed" },
    },
    {
      boundary: "proven non-issuance",
      issue: "not-issued",
      result: { kind: "skipped", reason: "restart-not-issued" },
    },
    { boundary: "failed submission", issue: "error", result: uncertain },
    { boundary: "lost systemctl reply", issue: "lost", result: uncertain },
    {
      boundary: "issued restart",
      issue: "issued",
      result: { kind: "restarted" },
    },
  ])(
    "keeps the runtime lease and dispatch consistent through $boundary",
    async ({ commit, loseRelease, issue, result }) => {
      vi.useFakeTimers();
      const runtime = new RuntimeController({}, {});
      try {
        const run = vi.fn(async (args) => {
          if (!args.includes("restart")) return inspect(args);
          expect(args).toEqual(["--user", "restart", "inspire-host.service"]);
          vi.advanceTimersByTime(60_000);
          await expect(runtime.newSession(root)).rejects.toMatchObject({
            status: 503,
          });
          if (issue === "lost") throw new Error("Systemd response lost");
          if (issue === "not-issued") return { code: 1, issued: false };
          return { code: issue === "issued" ? 0 : 1 };
        });
        let leaseId;
        const request = vi.fn(async (state, action, id) => {
          expect(state).toBe(owner);
          if (!action) {
            const lease = runtime.reserveMaintenanceRestart();
            leaseId = lease.leaseId;
            return lease;
          }
          expect(id).toBe(leaseId);
          if (action === "release")
            return loseRelease ? null : runtime.releaseMaintenanceRestart(id);
          const response = runtime.commitMaintenanceRestart(id);
          if (commit === "lost") return null;
          if (commit === "foreign")
            return { ...response, leaseId: "b".repeat(43) };
          return response;
        });
        await expect(
          runIdleMaintenanceRestart(owner, root, { environment, run, request }),
        ).resolves.toEqual(result);
        expect(
          run.mock.calls.filter(([args]) => args.includes("restart")),
        ).toHaveLength(issue ? 1 : 0);
        const releases = result.kind === "skipped" || loseRelease;
        expect(request.mock.calls.map(([, action]) => action)).toEqual([
          undefined,
          "commit",
          ...(releases ? ["release"] : []),
        ]);
        expect(runtime.reserveMaintenanceRestart().kind).toBe(
          result.kind === "skipped" ? "ready" : "busy",
        );
      } finally {
        await runtime.close();
        vi.useRealTimers();
      }
    },
  );
});
