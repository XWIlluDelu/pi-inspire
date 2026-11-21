import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const support = existsSync(new URL("../../server/process-tree.mjs", import.meta.url))
  ? "../../server/"
  : "../../build/server/";
const [{ runChild }, { submitRestart }] = await Promise.all(
  ["process-tree.mjs", "restart-submission.mjs"].map((module) =>
    import(new URL(support + module, import.meta.url).href),
  ),
);

const HOST_SERVICE_NAME = "inspire-host.service";
const IDLE_MAINTENANCE_TIMER_NAME = "inspire-idle-maintenance-restart.timer";

function configHome(environment = process.env) {
  return (
    environment.XDG_CONFIG_HOME ||
    join(environment.HOME || homedir(), ".config")
  );
}

export function hostServicePath(environment = process.env) {
  return join(configHome(environment), "systemd", "user", HOST_SERVICE_NAME);
}

export function runSystemctl(arguments_, environment = process.env) {
  return runChild("systemctl", arguments_, { env: environment });
}

function properties(text) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .flatMap((line) => {
        const separator = line.indexOf("=");
        return separator < 0
          ? []
          : [[line.slice(0, separator), line.slice(separator + 1)]];
      }),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function expectedCommand(value, launcher, ...args) {
  const path = escapeRegExp(launcher);
  const command = [launcher, ...args].map(escapeRegExp).join("\\s+");
  const boundary = "(?:\\s|;|\\})";
  return (
    new RegExp(`(?:^|\\s)path=${path}${boundary}`, "u").test(value) &&
    new RegExp(`(?:^|\\s)argv\\[\\]=${command}\\s*(?:;|\\}|$)`, "u").test(value)
  );
}

function commandDetail(result) {
  return `${result.stderr}${result.stdout}`.trim();
}

async function mayHaveHostService(environment, inspectPath) {
  // Custom manager lookup/bus settings cannot be reconstructed offline.
  if (environment.SYSTEMD_UNIT_PATH) return true;
  const runtimeDirectories = [
    environment.XDG_RUNTIME_DIR,
    typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : null,
  ].filter(Boolean);
  if (
    environment.DBUS_SESSION_BUS_ADDRESS &&
    !runtimeDirectories.some(
      (directory) =>
        environment.DBUS_SESSION_BUS_ADDRESS === `unix:path=${directory}/bus`,
    )
  )
    return true;
  const directories = [
    join(configHome(environment), "systemd/user.control"),
    join(configHome(environment), "systemd/user"),
    ...(environment.XDG_CONFIG_DIRS || "/etc/xdg")
      .split(":")
      .map((directory) => join(directory, "systemd/user")),
    "/etc/systemd/user",
    ...runtimeDirectories.flatMap((directory) =>
      [
        "user.control",
        "transient",
        "generator.early",
        "user",
        "generator",
        "generator.late",
      ].map((name) => join(directory, "systemd", name)),
    ),
    "/run/systemd/user",
    join(
      environment.XDG_DATA_HOME ||
        join(environment.HOME || homedir(), ".local/share"),
      "systemd/user",
    ),
    ...(environment.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
      .split(":")
      .map((directory) => join(directory, "systemd/user")),
    "/usr/local/lib/systemd/user",
    "/usr/lib/systemd/user",
    "/lib/systemd/user",
  ];
  if ([...runtimeDirectories, ...directories].some((path) => !isAbsolute(path)))
    return true;
  for (const path of [
    // A live manager can retain a loaded unit after its file has disappeared.
    ...runtimeDirectories.map((directory) => join(directory, "systemd/private")),
    ...directories.map((directory) => join(directory, HOST_SERVICE_NAME)),
  ]) {
    try {
      await inspectPath(path);
      return true; // Includes masked units and dangling symlinks.
    } catch (error) {
      if (error.code !== "ENOENT") return true;
    }
  }
  return false;
}

function controlUnit({ environment = process.env, run = runSystemctl } = {}, ...args) {
  return run(["--user", ...args], environment);
}

function showUnit(unit, fields, options) {
  return controlUnit(options, "show", unit, ...fields.map((field) => `--property=${field}`));
}

function restartCommand(detached = false) {
  return [
    ...(detached ? ["--no-block"] : []),
    "restart",
    HOST_SERVICE_NAME,
  ];
}

/** A generic user-unit name is shared by installations. Require its checkout
 * and installed Host command before delegating to systemd. */
export async function inspectHostService(root, options = {}) {
  const { environment = process.env, inspectPath = lstat } = options;
  const expectedRoot = resolve(root);
  const result = await showUnit(HOST_SERVICE_NAME, [
    "LoadState", "FragmentPath", "WorkingDirectory", "ExecStart", "ExecStartPost",
    "UnitFileState", "ActiveState", "SubState", "InvocationID",
  ], options);
  if (result.code !== 0) {
    if (
      /Unit inspire-host\.service (?:could not be found|not found|not loaded)/iu.test(
        commandDetail(result),
      )
    )
      return { kind: "absent" };
    if (!(await mayHaveHostService(environment, inspectPath)))
      return { kind: "absent" };
    return { kind: "unavailable", detail: commandDetail(result) };
  }
  const value = properties(result.stdout);
  if (value.LoadState === "not-found") return { kind: "absent" };
  if (value.LoadState !== "loaded")
    return {
      kind: "unavailable",
      detail: `Unit load state: ${value.LoadState || "unknown"}`,
    };

  const launcher = join(expectedRoot, "inspire");
  if (
    value.FragmentPath !== hostServicePath(environment) ||
    value.WorkingDirectory !== expectedRoot ||
    !expectedCommand(value.ExecStart ?? "", launcher)
  ) {
    return { kind: "foreign", fragmentPath: value.FragmentPath || undefined };
  }
  if (!expectedCommand(value.ExecStartPost ?? "", launcher, "wait-ready")) {
    return { kind: "outdated" };
  }
  return {
    kind: "managed",
    activeState: value.ActiveState || "unknown",
    subState: value.SubState || "unknown",
    unitFileState: value.UnitFileState || "unknown",
    invocationId: value.InvocationID || null,
  };
}

function serviceStatusLine(service) {
  const state = service.activeState === "active" ? "running" : service.activeState;
  return `INSΠRE system service is ${state} (${service.unitFileState}).`;
}

export async function manageHostService(root, action, options = {}) {
  const service = await inspectHostService(root, options);
  if (service.kind !== "managed") return service;
  if (options.target && (
    options.target.invocationId !== service.invocationId ||
    options.target.activeState !== service.activeState
  )) return { kind: "invocation-changed" };
  const restart = action === "restart";
  const commands = {
    start: [["start", HOST_SERVICE_NAME]],
    stop: [["stop", HOST_SERVICE_NAME]],
    enable: [["enable", "--now", HOST_SERVICE_NAME]],
    disable: [
      ["disable", "--now", IDLE_MAINTENANCE_TIMER_NAME],
      ["disable", "--now", HOST_SERVICE_NAME],
    ],
  };
  const commandsForAction = restart ? [restartCommand()] : commands[action];
  if (!commandsForAction)
    throw new Error(`Unsupported host-service action: ${action}`);

  for (const arguments_ of commandsForAction) {
    const result = await controlUnit(options, ...arguments_);
    if (result.code !== 0)
      return { kind: "control-failed", action, detail: commandDetail(result) };
  }
  const settled = await inspectHostService(root, options);
  if (settled.kind !== "managed")
    return { kind: "control-failed", action, detail: "The service could not be verified after the command." };
  const expectedActive =
    action === "stop" || action === "disable" ? false : true;
  if (
    (expectedActive
      ? settled.activeState !== "active"
      : !["inactive", "failed"].includes(settled.activeState)) ||
    (restart &&
      !(/^[a-f0-9]{32}$/u.test(settled.invocationId ?? "") &&
        settled.invocationId !== service.invocationId))
  ) {
    return {
      kind: "control-failed",
      action,
      detail: serviceStatusLine(settled),
    };
  }
  return { kind: "controlled", action, service: settled };
}

/** Browser and maintenance plans address the same active service incarnation. */
export async function inspectRestartTarget(root, invocationId, options) {
  if (!/^[a-f0-9]{32}$/u.test(invocationId ?? ""))
    return { kind: "unsupported" };
  const service = await inspectHostService(root, options);
  if (service.kind !== "managed") return service;
  return service.invocationId === invocationId && service.activeState === "active"
    ? service
    : { kind: "invocation-changed" };
}

async function currentInvocation(invocationId, options) {
  const result = await showUnit(HOST_SERVICE_NAME, ["InvocationID", "ActiveState"], options);
  if (result.code !== 0) return false;
  const { InvocationID, ActiveState } = properties(result.stdout);
  return InvocationID === invocationId && ActiveState === "active";
}

export function submitSystemdRestart(
  root,
  { invocationId, commit, beforeRestart, detached = false },
  options = {},
) {
  return submitRestart(async () => {
    const target = await inspectRestartTarget(root, invocationId, options);
    if (target.kind !== "managed") return target.kind;
    if (!(await commit())) return "commit-not-authorized";
    if (!(await currentInvocation(invocationId, options)))
      return "invocation-changed";
    if (beforeRestart) {
      await beforeRestart();
      if (!(await currentInvocation(invocationId, options)))
        return "invocation-changed";
    }
  }, async () => {
    const result = await controlUnit(options, ...restartCommand(detached));
    return result.issued === false ? false : result.code === 0 ? true : undefined;
  });
}

export function reportHostService(result, action) {
  switch (result.kind) {
    case "managed":
      console.log(serviceStatusLine(result));
      return result.activeState === "active" ? 0 : 5;
    case "controlled": {
      const messages = {
        start: "Started INSΠRE system service.",
        stop: "Stopped INSΠRE system service.",
        restart: "Restarted INSΠRE Host.",
        enable: "Enabled and started INSΠRE system service.",
        disable: "Disabled and stopped INSΠRE system service.",
      };
      console.log(messages[action]);
      console.log(serviceStatusLine(result.service));
      return 0;
    }
    case "absent":
      if (action !== "status") console.error(`No ${HOST_SERVICE_NAME} unit is installed for this checkout.`);
      return 3;
    case "control-failed":
      console.error(result.detail || `Unable to ${action} the INSΠRE system service.`);
      return 1;
    case "foreign":
      console.error(`The ${HOST_SERVICE_NAME} unit belongs to another INSΠRE checkout${result.fragmentPath ? `: ${result.fragmentPath}` : "."}`);
      return 4;
    case "outdated":
      console.error(`The ${HOST_SERVICE_NAME} unit is outdated. Reinstall it with: ./inspire service install-host`);
      return 4;
    case "invocation-changed":
      console.error("The installed Host invocation changed. Inspect the service before retrying.");
      return 4;
    default:
      console.error(`Unable to contact the user systemd manager${result.detail ? `: ${result.detail}` : "."}`);
      return 4;
  }
}
