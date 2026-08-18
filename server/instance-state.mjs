import { createServer } from "node:net";
import { mkdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    return validState(value) ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

export async function writeInstanceState(path, state) {
  if (!validState(state)) throw new Error("Invalid Inspire instance state");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeInstanceState(path, pid) {
  const state = await readState(path);
  if (state?.pid === pid) await rm(path, { force: true });
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

export async function processStartIdentity(pid) {
  if (process.platform !== "linux") return `pid:${pid}`;
  const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
  const closing = processStat.lastIndexOf(")");
  if (closing < 0) throw new Error(`Unable to read process identity for ${pid}`);
  const fields = processStat.slice(closing + 2).trim().split(/\s+/);
  const startTime = fields[19];
  if (!startTime) throw new Error(`Unable to read process start time for ${pid}`);
  return startTime;
}

async function processAlive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
      const closing = processStat.lastIndexOf(")");
      if (closing >= 0 && processStat.slice(closing + 2, closing + 3) === "Z") return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function verifyManagedProcess(state, processMarker = "server/index.ts") {
  if (!(await processAlive(state.pid))) return false;
  if (process.platform !== "linux") return false;
  try {
    const [workingDirectory, commandLine, processInfo, processStartTime] = await Promise.all([
      readlink(`/proc/${state.pid}/cwd`),
      readFile(`/proc/${state.pid}/cmdline`, "utf8"),
      stat(`/proc/${state.pid}`),
      processStartIdentity(state.pid),
    ]);
    const ownUid = typeof process.getuid === "function" ? process.getuid() : processInfo.uid;
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

function expectedState(state, expected) {
  return state.root === expected.root && state.host === expected.host && state.port === expected.port;
}

export async function inspectInstance(path, expected, options = {}) {
  const state = await readState(path);
  if (!state) return { kind: "absent" };
  if (!expectedState(state, expected)) return { kind: "stale" };
  if (!(await verifyManagedProcess(state, options.processMarker))) return { kind: "stale" };
  if (!modeMatches(state, expected)) return { kind: "mode-conflict", state };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.healthTimeoutMs ?? 1_500);
  try {
    const response = await fetch(`http://${displayHost(state.host)}:${state.port}/api/health`, {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: controller.signal,
    });
    if (!response.ok) return { kind: "unavailable", state };
    const body = await response.json();
    if (body?.appName !== "inspire" || body?.mock !== state.mock) return { kind: "unavailable", state };
    return { kind: "healthy", state, url: instanceUrl(state) };
  } catch {
    return { kind: "unavailable", state };
  } finally {
    clearTimeout(timeout);
  }
}

export async function stopManagedInstance(path, expected, options = {}) {
  const state = await readState(path);
  if (!state) return { kind: "absent" };
  if (!expectedState(state, expected) || !(await verifyManagedProcess(state, options.processMarker))) {
    await rm(path, { force: true });
    return { kind: "stale" };
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    return { kind: "unavailable", state };
  }
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    if (!(await processAlive(state.pid))) {
      await removeInstanceState(path, state.pid);
      return { kind: "stopped", state };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { kind: "timeout", state };
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
  const processMarker = fileURLToPath(import.meta.url).includes("/build/server/")
    ? "build/server/index.js"
    : "server/index.ts";

  if (command === "inspect") {
    const result = await inspectInstance(path, expected, { processMarker });
    if (result.kind === "healthy") {
      console.log(result.url);
      return;
    }
    if (result.kind === "stale") await rm(path, { force: true });
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
