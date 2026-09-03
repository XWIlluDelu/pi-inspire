import { describe, expect, it } from "vitest";
import {
  hostServicePath,
  inspectHostService,
  terminalServicePath,
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
