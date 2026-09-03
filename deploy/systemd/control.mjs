import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_SERVICE_NAME = "inspire-host.service";
const TERMINAL_SERVICE_NAME = "inspire-terminal.service";
const IDLE_MAINTENANCE_TIMER_NAME =
  "inspire-idle-maintenance-restart.timer";

function transientTerminalServiceName(root) {
  const key = createHash("sha256")
    .update(resolve(root))
    .update("\0")
    .update("127.0.0.1")
    .update("\0")
    .update("4587")
    .digest("hex")
    .slice(0, 12);
  return `inspire-terminal-${key}.service`;
}

function configHome(environment = process.env) {
  return environment.XDG_CONFIG_HOME || join(environment.HOME || homedir(), ".config");
}

export function hostServicePath(environment = process.env) {
  return join(configHome(environment), "systemd", "user", HOST_SERVICE_NAME);
}

export function terminalServicePath(environment = process.env) {
  return join(configHome(environment), "systemd", "user", TERMINAL_SERVICE_NAME);
}

function runSystemctl(arguments_, environment = process.env) {
  return new Promise((resolveRun) => {
    const child = spawn("systemctl", arguments_, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", (error) =>
      resolveRun({ code: 1, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.once("exit", (code) =>
      resolveRun({ code: code ?? 1, stdout, stderr }),
    );
  });
}

function properties(text) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .flatMap((line) => {
        const separator = line.indexOf("=");
        return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
      }),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function expectedExecStart(value, launcher) {
  const escaped = escapeRegExp(launcher);
  const boundary = "(?:\\s|;|\\})";
  return (
    new RegExp(`(?:^|\\s)path=${escaped}${boundary}`, "u").test(value) &&
    new RegExp(`(?:^|\\s)argv\\[\\]=${escaped}${boundary}`, "u").test(value)
  );
}

function expectedReadyHook(value, launcher) {
  const escaped = escapeRegExp(launcher);
  const boundary = "(?:\\s|;|\\})";
  return (
    new RegExp(`(?:^|\\s)path=${escaped}${boundary}`, "u").test(value) &&
    new RegExp(
      `(?:^|\\s)argv\\[\\]=${escaped}\\s+wait-ready${boundary}`,
      "u",
    ).test(value)
  );
}

function expectedTerminalStart(value, launcher, root) {
  const escapedLauncher = escapeRegExp(launcher);
  const escapedRoot = escapeRegExp(root);
  const boundary = "(?:\\s|;|\\})";
  return (
    new RegExp(`(?:^|\\s)path=${escapedLauncher}${boundary}`, "u").test(
      value,
    ) &&
    new RegExp(
      `(?:^|\\s)argv\\[\\]=${escapedLauncher}\\s+terminal-daemon\\s+--root\\s+${escapedRoot}\\s+--host\\s+127\\.0\\.0\\.1\\s+--port\\s+4587${boundary}`,
      "u",
    ).test(value)
  );
}

function commandDetail(result) {
  return `${result.stderr}${result.stdout}`.trim();
}

/**
 * A generic user-unit name is shared by installations, so a launcher may
 * delegate only when systemd proves the unit is this exact checkout's unit.
 */
export async function inspectHostService(
  root,
  { environment = process.env, run = runSystemctl } = {},
) {
  const expectedRoot = resolve(root);
  const result = await run(
    [
      "--user",
      "show",
      HOST_SERVICE_NAME,
      "--property=LoadState",
      "--property=FragmentPath",
      "--property=WorkingDirectory",
      "--property=ExecStart",
      "--property=ExecStartPost",
      "--property=Wants",
      "--property=UnitFileState",
      "--property=ActiveState",
      "--property=SubState",
    ],
    environment,
  );
  if (result.code !== 0) {
    if (/not[ -]found|not loaded/iu.test(commandDetail(result))) return { kind: "absent" };
    return { kind: "unavailable", detail: commandDetail(result) };
  }
  const value = properties(result.stdout);
  if (value.LoadState !== "loaded") return { kind: "absent" };

  const launcher = join(expectedRoot, "inspire");
  if (
    value.FragmentPath !== hostServicePath(environment) ||
    value.WorkingDirectory !== expectedRoot ||
    !expectedExecStart(value.ExecStart ?? "", launcher)
  ) {
    return { kind: "foreign", fragmentPath: value.FragmentPath || undefined };
  }
  if (
    !expectedReadyHook(value.ExecStartPost ?? "", launcher) ||
    !(value.Wants ?? "").split(/\s+/u).includes(TERMINAL_SERVICE_NAME)
  ) {
    return { kind: "outdated" };
  }

  const terminalResult = await run(
    [
      "--user",
      "show",
      TERMINAL_SERVICE_NAME,
      "--property=LoadState",
      "--property=FragmentPath",
      "--property=WorkingDirectory",
      "--property=ExecStart",
    ],
    environment,
  );
  if (terminalResult.code !== 0) {
    if (/not[ -]found|not loaded/iu.test(commandDetail(terminalResult)))
      return { kind: "outdated" };
    return { kind: "unavailable", detail: commandDetail(terminalResult) };
  }
  const terminal = properties(terminalResult.stdout);
  if (
    terminal.LoadState !== "loaded" ||
    terminal.FragmentPath !== terminalServicePath(environment) ||
    terminal.WorkingDirectory !== expectedRoot ||
    !expectedTerminalStart(terminal.ExecStart ?? "", launcher, expectedRoot)
  ) {
    return { kind: "outdated" };
  }
  return {
    kind: "managed",
    activeState: value.ActiveState || "unknown",
    subState: value.SubState || "unknown",
    unitFileState: value.UnitFileState || "unknown",
  };
}

function stateDescription(service) {
  return service.activeState === "active" ? "running" : service.activeState;
}

function serviceStatusLine(service) {
  return `INSΠRE system service is ${stateDescription(service)} (${service.unitFileState}).`;
}

async function manageHostService(root, action, options) {
  const service = await inspectHostService(root, options);
  if (service.kind !== "managed") return service;

  const commands = {
    start: [
      ["start", TERMINAL_SERVICE_NAME],
      ["start", HOST_SERVICE_NAME],
    ],
    stop: [
      ["stop", HOST_SERVICE_NAME],
      ["stop", TERMINAL_SERVICE_NAME],
    ],
    restart: [["restart", HOST_SERVICE_NAME]],
    enable: [
      ["enable", "--now", TERMINAL_SERVICE_NAME],
      ["enable", "--now", HOST_SERVICE_NAME],
      ["enable", "--now", IDLE_MAINTENANCE_TIMER_NAME],
    ],
    disable: [
      ["disable", "--now", IDLE_MAINTENANCE_TIMER_NAME],
      ["disable", "--now", HOST_SERVICE_NAME],
      ["disable", "--now", TERMINAL_SERVICE_NAME],
    ],
  };
  const commandsForAction = commands[action];
  if (!commandsForAction)
    throw new Error(`Unsupported host-service action: ${action}`);

  // Hosts started before the persistent unit was installed may have launched
  // an installation-scoped transient daemon. Explicit service lifecycle
  // commands retire it so the named unit can own the same private IPC socket.
  if (["start", "stop", "enable", "disable"].includes(action))
    await (options?.run ?? runSystemctl)(
      ["--user", "stop", transientTerminalServiceName(root)],
      options?.environment,
    );

  for (const arguments_ of commandsForAction) {
    const result = await (options?.run ?? runSystemctl)(
      ["--user", ...arguments_],
      options?.environment,
    );
    if (result.code !== 0)
      return { kind: "control-failed", action, detail: commandDetail(result) };
  }
  const settled = await inspectHostService(root, options);
  if (settled.kind !== "managed") return settled;
  const expectedActive = action === "stop" || action === "disable" ? false : true;
  if ((settled.activeState === "active") !== expectedActive) {
    return { kind: "control-failed", action, detail: serviceStatusLine(settled) };
  }
  return { kind: "controlled", action, service: settled };
}

function unavailableMessage(service) {
  return service.detail
    ? `Unable to contact the user systemd manager: ${service.detail}`
    : "Unable to contact the user systemd manager.";
}

function foreignMessage(service) {
  return service.fragmentPath
    ? `The ${HOST_SERVICE_NAME} unit belongs to another INSΠRE checkout: ${service.fragmentPath}`
    : `The ${HOST_SERVICE_NAME} unit belongs to another INSΠRE checkout.`;
}

function outdatedMessage() {
  return `The ${HOST_SERVICE_NAME} unit is outdated. Reinstall it with: ./inspire service install-host`;
}

function usage() {
  console.error(
    "Use: systemd control --root <path> [status|start|stop|restart|enable|disable]",
  );
}

async function main() {
  const [flag, root, action = "status"] = process.argv.slice(2);
  if (flag !== "--root" || !root || process.argv.length > 5) {
    usage();
    process.exitCode = 64;
    return;
  }

  if (action === "status") {
    const service = await inspectHostService(root);
    if (service.kind === "absent") {
      process.exitCode = 3;
      return;
    }
    if (service.kind === "foreign") {
      console.error(foreignMessage(service));
      process.exitCode = 4;
      return;
    }
    if (service.kind === "outdated") {
      console.error(outdatedMessage());
      process.exitCode = 4;
      return;
    }
    if (service.kind === "unavailable") {
      console.error(unavailableMessage(service));
      process.exitCode = 4;
      return;
    }
    console.log(serviceStatusLine(service));
    if (service.activeState !== "active") process.exitCode = 5;
    return;
  }

  if (!new Set(["start", "stop", "restart", "enable", "disable"]).has(action)) {
    usage();
    process.exitCode = 64;
    return;
  }

  const result = await manageHostService(root, action);
  if (result.kind === "absent") {
    console.error(`No ${HOST_SERVICE_NAME} unit is installed for this checkout.`);
    process.exitCode = 3;
    return;
  }
  if (result.kind === "foreign") {
    console.error(foreignMessage(result));
    process.exitCode = 4;
    return;
  }
  if (result.kind === "outdated") {
    console.error(outdatedMessage());
    process.exitCode = 4;
    return;
  }
  if (result.kind === "unavailable") {
    console.error(unavailableMessage(result));
    process.exitCode = 4;
    return;
  }
  if (result.kind === "control-failed") {
    console.error(
      result.detail || `Unable to ${result.action} the INSΠRE system service.`,
    );
    process.exitCode = 1;
    return;
  }

  const verbs = {
    start: "Started",
    stop: "Stopped",
    restart: "Restarted",
    enable: "Enabled and started (with daily idle maintenance)",
    disable: "Disabled and stopped (with daily idle maintenance)",
  };
  console.log(`${verbs[action]} INSΠRE system service.`);
  console.log(serviceStatusLine(result.service));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
