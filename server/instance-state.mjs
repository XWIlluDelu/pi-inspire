import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
export const INSTANCE_STATE_VERSION = 1;

function displayHost(host) {
  return host === "::1" ? "[::1]" : host;
}

export function instanceUrl(state) {
  return `http://${displayHost(state.host)}:${state.port}/?token=${encodeURIComponent(state.token)}`;
}

function validState(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.schemaVersion === INSTANCE_STATE_VERSION &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.root === "string" &&
      typeof value.host === "string" &&
      Number.isInteger(value.port) &&
      value.port > 0 &&
      value.port <= 65_535 &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      typeof value.startedAt === "string" &&
      typeof value.processStartTime === "string" &&
      value.processStartTime.length > 0 &&
      typeof value.mock === "boolean",
  );
}

function modeMatches(state, expected) {
  return expected.mock === undefined || state.mock === expected.mock;
}

async function readState(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!validState(value))
      throw new Error(`Invalid Inspire instance state: ${path}`);
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeInstanceState(path, state) {
  if (!validState(state)) throw new Error("Invalid Inspire instance state");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeInstanceState(path, owner) {
  const state = await readState(path);
  if (
    state?.pid === owner.pid &&
    state.processStartTime === owner.processStartTime &&
    state.token === owner.token &&
    state.root === owner.root &&
    state.host === owner.host &&
    state.port === owner.port &&
    state.startedAt === owner.startedAt &&
    state.mock === owner.mock
  )
    await rm(path, { force: true });
}

export async function consumeStopRequest(path) {
  try {
    await rm(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function darwinProcessStartIdentity(pid) {
  const { stdout } = await execFile(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart="],
    {
      encoding: "utf8",
      timeout: 1_500,
      maxBuffer: 4_096,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    },
  );
  const value = stdout.trim();
  if (!value) throw new Error(`Unable to read process start time for ${pid}`);
  return `darwin:${value}`;
}

async function windowsProcessStartIdentity(pid) {
  const command = process.env.SystemRoot
    ? join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
  const { stdout } = await execFile(
    command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ],
    // A cold Windows PowerShell process can take several seconds to start on
    // hosted runners. This probe is part of startup authority, not a health
    // request, so avoid killing a valid identity check at the old 2s boundary.
    { encoding: "utf8", timeout: 10_000, maxBuffer: 4_096 },
  );
  const value = stdout.trim();
  if (!/^\d+$/u.test(value))
    throw new Error(`Unable to read process start time for ${pid}`);
  return `win32:${value}`;
}

/** A PID alone is reusable. Record an OS process-birth identity wherever the
 * host exposes one, and retain a conservative PID identity on other systems. */
export async function processStartIdentity(pid) {
  if (process.platform === "linux") {
    const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closing = processStat.lastIndexOf(")");
    if (closing < 0)
      throw new Error(`Unable to read process identity for ${pid}`);
    const fields = processStat.slice(closing + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime)
      throw new Error(`Unable to read process start time for ${pid}`);
    // Preserve the identity format published by existing Linux installations.
    return startTime;
  }
  if (process.platform === "darwin") return darwinProcessStartIdentity(pid);
  if (process.platform === "win32") return windowsProcessStartIdentity(pid);
  return `pid:${pid}`;
}

async function processAlive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
      const closing = processStat.lastIndexOf(")");
      if (
        closing >= 0 &&
        processStat.slice(closing + 2, closing + 3) === "Z"
      )
        return false;
    }
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Exact process inspection is the authority for signal fallback. Normal
 * cross-platform lifecycle uses authenticated HTTP, so unsupported systems
 * fail closed instead of killing a merely matching PID. */
async function verifyManagedProcess(
  state,
  processMarker = "server/index.ts",
) {
  if (!(await processAlive(state.pid))) return false;
  if (process.platform !== "linux") return false;
  try {
    const [workingDirectory, commandLine, processInfo, processStartTime] =
      await Promise.all([
        readlink(`/proc/${state.pid}/cwd`),
        readFile(`/proc/${state.pid}/cmdline`, "utf8"),
        stat(`/proc/${state.pid}`),
        processStartIdentity(state.pid),
      ]);
    const ownUid =
      typeof process.getuid === "function" ? process.getuid() : processInfo.uid;
    return (
      processInfo.uid === ownUid &&
      workingDirectory === state.root &&
      processStartTime === state.processStartTime &&
      commandLine.includes(processMarker)
    );
  } catch {
    return false;
  }
}

function comparablePath(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function sameRoot(left, right) {
  if (comparablePath(left) === comparablePath(right)) return true;
  try {
    const [physicalLeft, physicalRight] = await Promise.all([
      realpath(left),
      realpath(right),
    ]);
    return comparablePath(physicalLeft) === comparablePath(physicalRight);
  } catch {
    return false;
  }
}

async function expectedState(state, expected) {
  return (
    state.host === expected.host &&
    state.port === expected.port &&
    (await sameRoot(state.root, expected.root))
  );
}

async function authenticatedHealth(state, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(
      `http://${displayHost(state.host)}:${state.port}/api/health`,
      {
        headers: { Authorization: `Bearer ${state.token}` },
        signal: controller.signal,
      },
    );
    if (!response.ok) return false;
    const body = await response.json();
    return body?.appName === "inspire" && body?.mock === state.mock;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function inspectInstance(path, expected, options = {}) {
  const state = await readState(path);
  if (!state) return { kind: "absent" };
  if (!(await expectedState(state, expected))) return { kind: "stale" };

  if (await authenticatedHealth(state, options.healthTimeoutMs ?? 1_500)) {
    if (!modeMatches(state, expected)) return { kind: "mode-conflict", state };
    return { kind: "healthy", state, url: instanceUrl(state) };
  }

  if (!(await processAlive(state.pid))) return { kind: "stale" };
  try {
    if ((await processStartIdentity(state.pid)) !== state.processStartTime)
      return { kind: "stale" };
  } catch {
    return { kind: "unavailable", state };
  }
  if (
    process.platform === "linux" &&
    !(await verifyManagedProcess(state, options.processMarker))
  )
    return { kind: "stale" };
  return { kind: "unavailable", state };
}

async function requestAuthenticatedShutdown(state, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(
      `http://${displayHost(state.host)}:${state.port}/api/host/shutdown`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${state.token}` },
        signal: controller.signal,
      },
    );
    return response.status === 202 || response.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForProcessExit(path, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let nextIdentityCheck = 0;
  while (Date.now() < deadline) {
    const published = await readState(path);
    if (!published || published.pid !== state.pid) return true;
    if (!(await processAlive(state.pid))) {
      await removeInstanceState(path, state);
      return true;
    }
    if (Date.now() >= nextIdentityCheck) {
      nextIdentityCheck = Date.now() + 500;
      try {
        if (
          (await processStartIdentity(state.pid)) !== state.processStartTime
        ) {
          await removeInstanceState(path, state);
          return true;
        }
      } catch {
        // An inaccessible process identity is not proof of exit. Continue to
        // wait for either the state file or the PID to disappear.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function stopManagedInstance(path, expected, options = {}) {
  const state = await readState(path);
  if (!state) return { kind: "absent" };
  if (!(await expectedState(state, expected))) return { kind: "stale" };

  const healthTimeoutMs = options.healthTimeoutMs ?? 1_500;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (
    (await authenticatedHealth(state, healthTimeoutMs)) &&
    (await requestAuthenticatedShutdown(state, healthTimeoutMs))
  ) {
    return (await waitForProcessExit(path, state, timeoutMs))
      ? { kind: "stopped", state }
      : { kind: "timeout", state };
  }

  if (!(await processAlive(state.pid))) {
    await removeInstanceState(path, state);
    return { kind: "stale" };
  }
  try {
    if ((await processStartIdentity(state.pid)) !== state.processStartTime) {
      await removeInstanceState(path, state);
      return { kind: "stale" };
    }
  } catch {
    return { kind: "unavailable", state };
  }
  if (!(await verifyManagedProcess(state, options.processMarker))) {
    return { kind: "unavailable", state };
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    return { kind: "unavailable", state };
  }
  return (await waitForProcessExit(path, state, timeoutMs))
    ? { kind: "stopped", state }
    : { kind: "timeout", state };
}

export async function portAvailable(host, port) {
  return new Promise((resolvePort) => {
    const probe = createServer();
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePort(available);
    };
    const timeout = setTimeout(() => {
      probe.close();
      finish(false);
    }, 1_500);
    probe.unref();
    probe.on("connection", (socket) => socket.destroy());
    probe.once("error", () => finish(false));
    probe.listen(port, host, () => probe.close(() => finish(true)));
  });
}

async function cli() {
  const [command, path, root, host, portText, mockText] = process.argv.slice(2);
  if (!command || !path || !root || !host || !portText) process.exit(64);
  const port = Number.parseInt(portText, 10);
  const expected = {
    root,
    host,
    port,
    mock: mockText === undefined ? undefined : mockText === "1",
  };
  const processMarker = fileURLToPath(import.meta.url).includes(
    `${join("build", "server")}`,
  )
    ? "build/server/index.js"
    : "server/index.ts";

  if (command === "inspect") {
    const result = await inspectInstance(path, expected, { processMarker });
    if (result.kind === "healthy") {
      console.log(result.url);
      return;
    }
    // Inspect is observational. A launcher that owns the instance lock may
    // replace a stale publication; this standalone probe must not race it.
    if (result.kind === "unavailable") process.exitCode = 4;
    else if (result.kind === "mode-conflict") process.exitCode = 5;
    else process.exitCode = 3;
    return;
  }
  if (command === "stop") {
    const result = await stopManagedInstance(path, expected, { processMarker });
    if (result.kind === "stopped") {
      console.log(`Stopped INSΠRE process ${result.state.pid}.`);
      return;
    }
    if (result.kind === "timeout") process.exitCode = 6;
    else if (result.kind === "unavailable") process.exitCode = 4;
    else process.exitCode = 3;
    return;
  }
  if (command === "port") {
    process.exitCode = (await portAvailable(host, port)) ? 0 : 7;
    return;
  }
  process.exitCode = 64;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await cli();
}
