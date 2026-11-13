import { describe, expect, it, vi } from "vitest";
import {
  hostServicePath,
  inspectHostService,
  inspectRestartTarget,
  manageHostService,
  submitSystemdRestart,
} from "../../deploy/systemd/control.mjs";

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
  it("recognizes only the matching checkout unit", async () => {
    await expect(
      inspectHostService(root, {
        environment,
        run: show(managedProperties()),
      }),
    ).resolves.toEqual({
      kind: "managed",
      activeState: "active",
      subState: "running",
      unitFileState: "enabled",
      invocationId,
    });

    await expect(
      inspectHostService(root, {
        environment,
        run: show(managedProperties({ WorkingDirectory: "/workspace/other" })),
      }),
    ).resolves.toMatchObject({ kind: "foreign" });

    await expect(
      inspectHostService(root, {
        environment,
        run: show(managedProperties({ Wants: "network-online.target" })),
      }),
    ).resolves.toEqual({ kind: "outdated" });

    await expect(
      inspectHostService(root, {
        environment,
        run: show(
          managedProperties(),
          managedTerminalProperties({ WorkingDirectory: "/workspace/other" }),
        ),
      }),
    ).resolves.toEqual({ kind: "outdated" });
  });

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

  it.each([
    [async () => ({ code: 1, issued: false }), "not-issued"],
    [async () => ({ code: 1 }), "unconfirmed"],
    [
      async () => {
        throw new Error("lost systemctl");
      },
      "unconfirmed",
    ],
  ])(
    "preserves issuance evidence for either restart caller (%#)",
    async (issue, kind) => {
      const run = (args) =>
        args.includes("restart") ? issue() : show(managedProperties())(args);
      await expect(
        submitSystemdRestart(
          root,
          { invocationId, commit: () => true },
          {
            environment,
            run,
          },
        ),
      ).resolves.toMatchObject({ kind });
    },
  );

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

  it("permits direct mode with an unavailable manager when no service authority remains", async () => {
    await expect(
      inspectHostService(root, {
        environment,
        run: unavailableManager,
        inspectPath: missingPath,
      }),
    ).resolves.toEqual({ kind: "absent" });
  });

  it.each([
    "/home/tester/.config/systemd/user/inspire-host.service",
    "/usr/lib/systemd/user/inspire-host.service",
    "/run/tester/systemd/transient/inspire-host.service",
    `/run/user/${process.getuid?.()}/systemd/private`,
  ])("keeps offline authority at %s closed", async (present) => {
    await expect(
      inspectHostService(root, {
        environment,
        run: unavailableManager,
        inspectPath: async (path) => (path === present ? {} : missingPath()),
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      detail: "Failed to connect to bus",
    });
  });

  it("keeps inaccessible unit paths and custom manager locations unknown", async () => {
    for (const options of [
      {
        inspectPath: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      },
      { environment: { ...environment, SYSTEMD_UNIT_PATH: "/custom/units" } },
      {
        environment: {
          ...environment,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus",
        },
      },
    ]) {
      await expect(
        inspectHostService(root, {
          environment,
          run: unavailableManager,
          inspectPath: missingPath,
          ...options,
        }),
      ).resolves.toMatchObject({ kind: "unavailable" });
    }
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
