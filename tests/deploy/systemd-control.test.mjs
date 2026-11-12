import { describe, expect, it } from "vitest";
import {
  hostServicePath,
  inspectBrowserRestart,
  inspectHostService,
  manageHostService,
  requestBrowserRestart,
  terminalServicePath,
} from "../../deploy/systemd/control.mjs";

const root = "/workspace/inspire";
const environment = {
  HOME: "/home/tester",
  XDG_CONFIG_HOME: "/home/tester/.config",
  XDG_RUNTIME_DIR: "/run/tester",
};

const missingPath = async () => {
  throw Object.assign(new Error("absent"), { code: "ENOENT" });
};
const unavailableManager = async () => ({
  code: 1,
  stdout: "",
  stderr: "Failed to connect to bus",
});

function show(
  hostProperties,
  terminalProperties = managedTerminalProperties(),
) {
  return async (arguments_) => {
    const selected = arguments_.includes("inspire-terminal.service")
      ? terminalProperties
      : hostProperties;
    return {
      code: 0,
      stdout: `${Object.entries(selected)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
      stderr: "",
    };
  };
}

function managedProperties(overrides = {}) {
  return {
    LoadState: "loaded",
    FragmentPath: hostServicePath(environment),
    WorkingDirectory: root,
    ExecStart: `{ path=${root}/inspire ; argv[]=${root}/inspire ; }`,
    ExecStartPost: `{ path=${root}/inspire ; argv[]=${root}/inspire wait-ready ; }`,
    Wants: "network-online.target inspire-terminal.service",
    After: "network-online.target inspire-terminal.service",
    UnitFileState: "enabled",
    ActiveState: "active",
    SubState: "running",
    ...overrides,
  };
}

function managedTerminalProperties(overrides = {}) {
  return {
    LoadState: "loaded",
    FragmentPath: terminalServicePath(environment),
    WorkingDirectory: root,
    ExecStart: `{ path=${root}/inspire ; argv[]=${root}/inspire terminal-daemon --root ${root} --host 127.0.0.1 --port 4587 ; }`,
    ...overrides,
  };
}

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

  it("fences browser restart to the current invocation and commits after inspections", async () => {
    const invocationId = "a".repeat(32);
    const calls = [];
    const run = async (args) => {
      calls.push(args);
      if (args.includes("--property=InvocationID"))
        return {
          code: 0,
          stdout: `InvocationID=${invocationId}\nActiveState=active`,
          stderr: "",
        };
      return show(managedProperties())(args);
    };
    const options = { environment, run, invocationId };
    expect(
      await inspectBrowserRestart(root, {
        ...options,
        invocationId: "b".repeat(32),
      }),
    ).toEqual({ kind: "invocation-changed" });
    calls.length = 0;
    const result = await requestBrowserRestart(
      root,
      true,
      () => {
        expect(
          calls.some((args) => args.includes("--property=InvocationID")),
        ).toBe(true);
        return true;
      },
      options,
    );
    expect(result.code).toBe(0);
    expect(calls.at(-1)).toEqual([
      "--user",
      "--no-block",
      "restart",
      "inspire-terminal.service",
      "inspire-host.service",
    ]);
    calls.length = 0;
    expect(
      await requestBrowserRestart(root, false, async () => false, options),
    ).toMatchObject({ issued: false });
    expect(calls.some((args) => args.includes("restart"))).toBe(false);
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
