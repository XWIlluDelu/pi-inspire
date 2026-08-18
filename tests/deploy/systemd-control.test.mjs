import { describe, expect, it } from "vitest";
import {
  hostServicePath,
  inspectHostService,
} from "../../deploy/systemd/control.mjs";

const root = "/workspace/inspire";
const environment = {
  HOME: "/home/tester",
  XDG_CONFIG_HOME: "/home/tester/.config",
};

function show(properties) {
  return async () => ({
    code: 0,
    stdout: `${Object.entries(properties)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    stderr: "",
  });
}

function managedProperties(overrides = {}) {
  return {
    LoadState: "loaded",
    FragmentPath: hostServicePath(environment),
    WorkingDirectory: root,
    ExecStart: `{ path=${root}/inspire ; argv[]=${root}/inspire ; }`,
    UnitFileState: "enabled",
    ActiveState: "active",
    SubState: "running",
    ...overrides,
  };
}

describe("host systemd control", () => {
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
