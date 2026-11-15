import {
  hostServicePath,
  terminalServicePath,
} from "../../deploy/systemd/control.mjs";

export const root = "/workspace/inspire";
export const environment = {
  HOME: "/home/tester",
  XDG_CONFIG_HOME: "/home/tester/.config",
  XDG_RUNTIME_DIR: "/run/tester",
};

export const invocationId = "a".repeat(32);

export function show(
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

export function managedProperties(overrides = {}) {
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
    InvocationID: invocationId,
    ...overrides,
  };
}

export function managedTerminalProperties(overrides = {}) {
  return {
    LoadState: "loaded",
    FragmentPath: terminalServicePath(environment),
    WorkingDirectory: root,
    ExecStart: `{ path=${root}/inspire ; argv[]=${root}/inspire terminal-daemon --root ${root} --host 127.0.0.1 --port 4587 ; }`,
    ...overrides,
  };
}
