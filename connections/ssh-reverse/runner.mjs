import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ID = "ssh-reverse";
const STATE_VERSION = 1;
const CONFIG_KEYS = new Set([
  "INSPIRE_SSH_TARGET",
  "INSPIRE_SSH_REMOTE_PORT",
  "INSPIRE_SSH_LOCAL_PORT",
  "INSPIRE_SSH_IDENTITY_FILE",
]);

function userDirectory(environment, variable, fallback) {
  return environment[variable] || join(environment.HOME || homedir(), fallback);
}

export function connectionPaths(root, environment = process.env) {
  const configured = environment.INSPIRE_SSH_REVERSE_CONFIG;
  const sourceConfig = join(
    resolve(root),
    ".inspire",
    "connections",
    `${MODULE_ID}.env`,
  );
  const config = configured
    ? resolve(configured)
    : existsSync(join(root, "server", "index.ts"))
      ? sourceConfig
      : join(
          userDirectory(environment, "XDG_CONFIG_HOME", ".config"),
          "inspire",
          "connections",
          `${MODULE_ID}.env`,
        );
  if (configured && !isAbsolute(configured))
    throw new Error("INSPIRE_SSH_REVERSE_CONFIG must be an absolute path");
  const installation = createHash("sha256")
    .update(resolve(root))
    .digest("hex")
    .slice(0, 16);
  const stateDirectory = join(
    userDirectory(environment, "XDG_STATE_HOME", ".local/state"),
    "inspire",
    "connections",
    MODULE_ID,
    installation,
  );
  return {
    config,
    stateDirectory,
    state: join(stateDirectory, "state.json"),
    control: join(stateDirectory, "control"),
    service: join(
      userDirectory(environment, "XDG_CONFIG_HOME", ".config"),
      "systemd",
      "user",
      "inspire-connection-ssh-reverse.service",
    ),
  };
}

function port(value, name) {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a TCP port`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535)
    throw new Error(`${name} must be a TCP port`);
  return parsed;
}

export function parseSshReverseConfig(text) {
  const values = new Map();
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match)
      throw new Error(`Invalid SSH reverse configuration line ${index + 1}`);
    const [, key, value] = match;
    if (!CONFIG_KEYS.has(key) || values.has(key))
      throw new Error(`Invalid SSH reverse configuration key ${key}`);
    if (value.includes("\0") || /[\r\n]/u.test(value))
      throw new Error(`Invalid SSH reverse configuration value for ${key}`);
    values.set(key, value);
  }
  const target = values.get("INSPIRE_SSH_TARGET") || "";
  if (!target || /^-/u.test(target) || /\s/u.test(target))
    throw new Error("INSPIRE_SSH_TARGET must be one SSH host or user@host target");
  const remotePort = port(
    values.get("INSPIRE_SSH_REMOTE_PORT") || "",
    "INSPIRE_SSH_REMOTE_PORT",
  );
  const localPort = port(
    values.get("INSPIRE_SSH_LOCAL_PORT") || "4587",
    "INSPIRE_SSH_LOCAL_PORT",
  );
  const identityFile = values.get("INSPIRE_SSH_IDENTITY_FILE") || undefined;
  if (identityFile && !isAbsolute(identityFile))
    throw new Error("INSPIRE_SSH_IDENTITY_FILE must be an absolute path");
  return { target, remotePort, localPort, identityFile };
}

async function requirePrivateFile(path, label) {
  const details = await stat(path).catch(() => null);
  if (!details?.isFile()) throw new Error(`${label} does not exist or is not a file`);
  if (typeof process.getuid === "function" && details.uid !== process.getuid())
    throw new Error(`${label} is not owned by the current user`);
  if ((details.mode & 0o077) !== 0)
    throw new Error(`${label} must not be accessible by other users`);
}

async function readConfig(paths) {
  await requirePrivateFile(paths.config, "SSH reverse configuration");
  const config = parseSshReverseConfig(await readFile(paths.config, "utf8"));
  if (config.identityFile)
    await requirePrivateFile(config.identityFile, "INSPIRE_SSH_IDENTITY_FILE");
  return config;
}

export function sshCommandArguments(
  config,
  { controlPath, background = false } = {},
) {
  const arguments_ = [
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "TCPKeepAlive=yes",
    "-o",
    "RequestTTY=no",
    "-o",
    "StrictHostKeyChecking=yes",
  ];
  if (controlPath) arguments_.push("-M", "-S", controlPath);
  if (background) arguments_.push("-f");
  if (config.identityFile)
    arguments_.push(
      "-i",
      config.identityFile,
      "-o",
      "IdentitiesOnly=yes",
    );
  arguments_.push(
    "-R",
    `127.0.0.1:${config.remotePort}:127.0.0.1:${config.localPort}`,
    config.target,
  );
  return arguments_;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writePrivateFile(path, content, mode = 0o600) {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validState(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.version === STATE_VERSION &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.processStartTime === "string" &&
      value.processStartTime.length > 0 &&
      typeof value.root === "string" &&
      typeof value.target === "string" &&
      typeof value.controlPath === "string",
  );
}

async function readState(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return validState(value) ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

async function processStartIdentity(pid) {
  if (process.platform !== "linux") return `pid:${pid}`;
  const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
  const closing = processStat.lastIndexOf(")");
  if (closing < 0) throw new Error("Unable to read process identity");
  const fields = processStat.slice(closing + 2).trim().split(/\s+/u);
  const startTime = fields[19];
  if (!startTime) throw new Error("Unable to read process identity");
  return startTime;
}

async function verifyOwnedTunnel(state) {
  if (process.platform !== "linux") return false;
  try {
    process.kill(state.pid, 0);
    const [details, cwd, commandLine, identity] = await Promise.all([
      stat(`/proc/${state.pid}`),
      readlink(`/proc/${state.pid}/cwd`),
      readFile(`/proc/${state.pid}/cmdline`, "utf8"),
      processStartIdentity(state.pid),
    ]);
    return (
      details.uid === process.getuid() &&
      cwd === state.root &&
      identity === state.processStartTime &&
      commandLine.includes("ssh") &&
      commandLine.includes(state.controlPath)
    );
  } catch {
    return false;
  }
}

function run(command, arguments_, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, arguments_, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
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

async function controlCheck(state) {
  const result = await run("ssh", [
    "-S",
    state.controlPath,
    "-O",
    "check",
    "-o",
    "BatchMode=yes",
    state.target,
  ]);
  const match = /pid=(\d+)/u.exec(`${result.stdout}\n${result.stderr}`);
  return result.code === 0 && match ? Number(match[1]) : null;
}

async function listenerReachable(portValue) {
  return new Promise((resolveReachable) => {
    const socket = createConnection({ host: "127.0.0.1", port: portValue });
    const done = (reachable) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveReachable(reachable);
    };
    socket.setTimeout(750, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function commandDetail(result) {
  const detail = result.stderr.trim().split("\n").at(-1);
  return detail ? ` (${detail})` : "";
}

async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return false;
}

async function initialize(root) {
  const paths = connectionPaths(root);
  try {
    await stat(paths.config);
    throw new Error(`SSH reverse configuration already exists at ${paths.config}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writePrivateFile(
    paths.config,
    [
      "# One SSH target or user@host. SSH config aliases are supported.",
      "INSPIRE_SSH_TARGET=",
      "# The server-side loopback listener for this connection.",
      "INSPIRE_SSH_REMOTE_PORT=14587",
      "# Optional. Defaults to the local INSΠRE host port 4587.",
      "# INSPIRE_SSH_LOCAL_PORT=4587",
      "# Optional. Omit to use your normal SSH config, agent, and default keys.",
      "# INSPIRE_SSH_IDENTITY_FILE=/absolute/path/to/private-key",
      "",
    ].join("\n"),
  );
  console.log(`Created ${paths.config}. Edit it, then run the start command.`);
}

async function serviceActive() {
  return (
    (await run("systemctl", [
      "--user",
      "is-active",
      "--quiet",
      "inspire-connection-ssh-reverse.service",
    ])).code === 0
  );
}

async function serviceInstalled(paths) {
  return Boolean(await stat(paths.service).catch(() => null));
}

async function start(root) {
  const paths = connectionPaths(root);
  if (await serviceActive()) {
    console.log("SSH reverse connection is running as a user service.");
    return;
  }
  if (await serviceInstalled(paths)) {
    const result = await run("systemctl", [
      "--user",
      "start",
      "inspire-connection-ssh-reverse.service",
    ]);
    if (result.code !== 0)
      throw new Error(`Unable to start SSH reverse service${commandDetail(result)}`);
    console.log("Started SSH reverse connection service.");
    return;
  }
  const config = await readConfig(paths);
  if (!(await listenerReachable(config.localPort))) {
    throw new Error(
      `INSΠRE is not listening on 127.0.0.1:${config.localPort}; start the host before this connection`,
    );
  }
  const previous = await readState(paths.state);
  if (previous && (await verifyOwnedTunnel(previous))) {
    const pid = await controlCheck(previous);
    if (pid === previous.pid) {
      console.log("SSH reverse connection is already running.");
      return;
    }
  }
  await rm(paths.state, { force: true });
  await ensurePrivateDirectory(paths.stateDirectory);
  await rm(paths.control, { force: true });
  const result = await run(
    "ssh",
    sshCommandArguments(config, {
      controlPath: paths.control,
      background: true,
    }),
    { cwd: root },
  );
  if (result.code !== 0)
    throw new Error(`Unable to start SSH reverse connection${commandDetail(result)}`);
  const state = {
    version: STATE_VERSION,
    pid: 0,
    processStartTime: "",
    root: resolve(root),
    target: config.target,
    controlPath: paths.control,
  };
  const pid = await controlCheck(state);
  if (!pid) {
    await rm(paths.control, { force: true });
    throw new Error("SSH reverse connection did not publish its control socket");
  }
  state.pid = pid;
  state.processStartTime = await processStartIdentity(pid);
  if (!(await verifyOwnedTunnel(state))) {
    await run("ssh", ["-S", paths.control, "-O", "exit", config.target]);
    throw new Error("SSH reverse connection identity could not be verified");
  }
  await writePrivateFile(paths.state, `${JSON.stringify(state)}\n`);
  console.log("SSH reverse connection is running.");
}

async function stop(root) {
  const paths = connectionPaths(root);
  if (await serviceActive()) {
    const result = await run("systemctl", [
      "--user",
      "stop",
      "inspire-connection-ssh-reverse.service",
    ]);
    if (result.code !== 0)
      throw new Error(`Unable to stop SSH reverse service${commandDetail(result)}`);
    console.log("Stopped SSH reverse connection service.");
    return;
  }
  const state = await readState(paths.state);
  if (!state) {
    console.log("SSH reverse connection is not running.");
    return;
  }
  if (!(await verifyOwnedTunnel(state))) {
    await rm(paths.state, { force: true });
    console.log("Removed stale SSH reverse connection state without stopping a process.");
    return;
  }
  const exited = await run("ssh", [
    "-S",
    state.controlPath,
    "-O",
    "exit",
    "-o",
    "BatchMode=yes",
    state.target,
  ]);
  if (exited.code !== 0) {
    process.kill(state.pid, "SIGTERM");
  }
  if (!(await waitForExit(state.pid)))
    throw new Error("SSH reverse connection did not stop");
  await Promise.all([
    rm(paths.state, { force: true }),
    rm(paths.control, { force: true }),
  ]);
  console.log("Stopped SSH reverse connection.");
}

async function status(root) {
  const paths = connectionPaths(root);
  let config;
  try {
    config = await readConfig(paths);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const state = await readState(paths.state);
  const interactiveTunnel =
    state && (await verifyOwnedTunnel(state)) && (await controlCheck(state)) === state.pid;
  const serviceTunnel = await serviceActive();
  const tunnelRunning = interactiveTunnel || serviceTunnel;
  const hostRunning = await listenerReachable(config.localPort);
  console.log(`INSΠRE loopback listener: ${hostRunning ? "reachable" : "unreachable"}.`);
  console.log(
    `SSH reverse connection: ${
      serviceTunnel ? "running as a user service" : tunnelRunning ? "running" : "not running"
    }.`,
  );
  if (!hostRunning || !tunnelRunning) process.exitCode = 1;
}

async function restart(root) {
  const paths = connectionPaths(root);
  if ((await serviceActive()) || (await serviceInstalled(paths))) {
    const result = await run("systemctl", [
      "--user",
      "restart",
      "inspire-connection-ssh-reverse.service",
    ]);
    if (result.code !== 0)
      throw new Error(`Unable to restart SSH reverse service${commandDetail(result)}`);
    console.log("Restarted SSH reverse connection service.");
    return;
  }
  await stop(root);
  await start(root);
}

async function supervise(root) {
  const paths = connectionPaths(root);
  const config = await readConfig(paths);
  await ensurePrivateDirectory(paths.stateDirectory);
  const child = spawn("ssh", sshCommandArguments(config), {
    cwd: root,
    stdio: "inherit",
  });
  let stopping = false;
  const stopChild = () => {
    stopping = true;
    child.kill("SIGTERM");
  };
  process.once("SIGTERM", stopChild);
  process.once("SIGINT", stopChild);
  const code = await new Promise((resolveChild, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) =>
      resolveChild(exitCode ?? (signal ? 1 : 0)),
    );
  }).finally(() => {
    process.off("SIGTERM", stopChild);
    process.off("SIGINT", stopChild);
  });
  process.exitCode = stopping ? 0 : code || 1;
}

function systemdEscape(value) {
  return value.replace(/[^A-Za-z0-9_@%+=:,./-]/gu, (character) =>
    `\\x${character.codePointAt(0).toString(16).padStart(2, "0")}`,
  );
}

async function installService(root) {
  const paths = connectionPaths(root);
  await readConfig(paths);
  const template = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "systemd", "inspire-connection-ssh-reverse.service.in"),
    "utf8",
  );
  const rendered = template
    .replaceAll("@NODE@", systemdEscape(process.execPath))
    .replaceAll("@RUNNER@", systemdEscape(fileURLToPath(import.meta.url)))
    .replaceAll("@ROOT@", systemdEscape(resolve(root)));
  await writePrivateFile(paths.service, rendered, 0o644);
  const reloaded = await run("systemctl", ["--user", "daemon-reload"]);
  if (reloaded.code !== 0)
    throw new Error(`Installed ${paths.service}, but systemd could not reload${commandDetail(reloaded)}`);
  console.log(`Installed ${paths.service}.`);
  console.log(
    "Enable it with: systemctl --user enable --now inspire-connection-ssh-reverse.service",
  );
}

function usage() {
  console.error(
    "Use: ssh-reverse runner --root <path> [init|start|stop|status|restart|supervise|install-service]",
  );
}

async function main() {
  const [flag, root, action = "start"] = process.argv.slice(2);
  if (flag !== "--root" || !root || process.argv.length > 5) {
    usage();
    process.exitCode = 64;
    return;
  }
  switch (action) {
    case "init":
      await initialize(root);
      return;
    case "start":
      await start(root);
      return;
    case "stop":
      await stop(root);
      return;
    case "status":
      await status(root);
      return;
    case "restart":
      await restart(root);
      return;
    case "supervise":
      await supervise(root);
      return;
    case "install-service":
      await installService(root);
      return;
    default:
      usage();
      process.exitCode = 64;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
