import { describe, expect, it } from "vitest";
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
};

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

  it("distinguishes an absent unit from an unavailable user manager", async () => {
    await expect(
      inspectHostService(root, {
        environment,
        run: show({ LoadState: "not-found" }),
      }),
    ).resolves.toEqual({ kind: "absent" });

    await expect(
      inspectHostService(root, {
        environment,
        run: async () => ({
          code: 1,
          stdout: "",
          stderr: "Failed to connect to bus",
        }),
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      detail: "Failed to connect to bus",
    });
  });
});
