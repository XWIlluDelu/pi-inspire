import { describe, expect, it, vi } from "vitest";
import {
  hostServicePath,
  inspectHostService,
  terminalServicePath,
  manageHostService,
  inspectBrowserRestart,
  requestBrowserRestart,
} from "../../deploy/systemd/control.mjs";
import { systemdEscape } from "../../deploy/systemd/install.mjs";

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
  it("escapes non-ASCII paths as UTF-8 bytes in unit arguments", () => {
    expect(systemdEscape("/tmp/测试 path")).toBe(
      "/tmp/\\xe6\\xb5\\x8b\\xe8\\xaf\\x95\\x20path",
    );
  });

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

  it("keeps ordinary restart terminal-free and submits full restart as one ordered transaction", async () => {
    for (const action of ["restart", "restart-all"]) {
      const calls = [];
      const run = async (args) => {
        calls.push(args);
        return show(managedProperties())(args);
      };
      expect(
        (await manageHostService(root, action, { environment, run })).kind,
      ).toBe("controlled");
      expect(calls.filter((args) => args[1] !== "show")).toEqual([
        [
          "--user",
          "restart",
          ...(action === "restart-all" ? ["inspire-terminal.service"] : []),
          "inspire-host.service",
        ],
      ]);
    }
  });

  it("starts or enables the Host without stopping an existing transient terminal owner", async () => {
    for (const action of ["start", "enable"]) {
      const calls = [];
      const run = async (args) => {
        calls.push(args);
        return show(managedProperties())(args);
      };
      expect(
        (await manageHostService(root, action, { environment, run })).kind,
      ).toBe("controlled");
      const controls = calls.filter((args) => args[1] !== "show");
      expect(controls).toEqual(
        action === "start"
          ? [["--user", "start", "inspire-host.service"]]
          : [
              ["--user", "enable", "inspire-terminal.service"],
              ["--user", "enable", "--now", "inspire-host.service"],
            ],
      );
      expect(controls.some((args) => args.includes("stop"))).toBe(false);
    }
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
    expect(calls.every((args) => args[1] === "show")).toBe(true);
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
        expect(calls.at(-1)).toContain("--property=InvocationID");
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
      await requestBrowserRestart(root, false, () => false, options),
    ).toMatchObject({ issued: false });
    expect(calls.every((args) => args[1] === "show")).toBe(true);
  });

  it("uses authoritative unit absence without offline filesystem checks", async () => {
    const inspectPath = vi.fn();
    await expect(
      inspectHostService(root, {
        environment,
        run: show({ LoadState: "not-found" }),
        inspectPath,
      }),
    ).resolves.toEqual({ kind: "absent" });
    expect(inspectPath).not.toHaveBeenCalled();
  });

  it.each(["spawn systemctl ENOENT", "Failed to connect to bus"])(
    "permits direct mode after %s only when no service authority remains",
    async (stderr) => {
      await expect(
        inspectHostService(root, {
          environment,
          run: async () => ({ code: 1, stdout: "", stderr }),
          inspectPath: missingPath,
        }),
      ).resolves.toEqual({ kind: "absent" });
    },
  );

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

  it.each(["masked", "error", "bad-setting", ""])(
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
    const inspectPath = vi.fn(missingPath);
    await expect(
      inspectHostService(root, {
        environment,
        run: show(
          managedProperties({
            FragmentPath: "/usr/lib/systemd/user/inspire-host.service",
          }),
        ),
        inspectPath,
      }),
    ).resolves.toMatchObject({ kind: "foreign" });
    expect(inspectPath).not.toHaveBeenCalled();
  });
});
