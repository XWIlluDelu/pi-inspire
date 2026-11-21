import { hostServicePath } from "../../deploy/systemd/control.mjs";

export const root = "/workspace/inspire";
export const environment = {
  HOME: "/home/tester",
  XDG_CONFIG_HOME: "/home/tester/.config",
  XDG_RUNTIME_DIR: "/run/tester",
};

export const invocationId = "a".repeat(32);

export function show(hostProperties) {
  return async () => ({
    code: 0,
    stdout: `${Object.entries(hostProperties)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    stderr: "",
  });
}

export function managedProperties(overrides = {}) {
  return {
    LoadState: "loaded",
    FragmentPath: hostServicePath(environment),
    WorkingDirectory: root,
    ExecStart: `{ path=${root}/inspire ; argv[]=${root}/inspire ; }`,
    ExecStartPost: `{ path=${root}/inspire ; argv[]=${root}/inspire wait-ready ; }`,
    Wants: "network-online.target",
    After: "network-online.target",
    UnitFileState: "enabled",
    ActiveState: "active",
    SubState: "running",
    InvocationID: invocationId,
    ...overrides,
  };
}
