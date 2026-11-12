import { execFile as execFileCallback } from "node:child_process";
import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  instanceIdentity,
  requestInstanceControl,
  supportsInstanceControl,
} from "./instance-control.mjs";
import { windowsPowerShellCommand } from "./platform-environment.mjs";

const execFile = promisify(execFileCallback);
export const INSTANCE_STATE_VERSION = 1;

function displayHost(host) {
  return host === "::1" ? "[::1]" : host;
}

export function instanceUrl(state) {
  return `http://${displayHost(state.host)}:${state.port}/`;
}

/** A pairing transfer, not a reusable token in process arguments/navigation.
 * Readiness itself remains read-only and does not allocate transfer grants. */
export async function instanceLaunchUrl(state, origin = new URL(instanceUrl(state)).origin) {
  // A locally owned development proxy has its own browser origin. The Host
  // authenticates this request before minting a grant for that exact origin.
  const result = await requestInstanceControl(state, "launch-url",
    origin === new URL(instanceUrl(state)).origin ? {} : { origin });
  if (typeof result?.url !== "string") return null;
  try {
    const url = new URL(result.url);
    if (
      url.origin !== origin ||
      url.pathname !== "/" ||
      url.search ||
      url.username ||
      url.password ||
      !/^#inspire-bootstrap=[A-Za-z0-9_-]{43}$/u.test(url.hash)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
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
      (value.systemdInvocationId === undefined ||
        (typeof value.systemdInvocationId === "string" &&
          /^[a-f0-9]{32}$/u.test(value.systemdInvocationId))),
  );
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

async function writePrivateJson(path, state) {
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

export async function writeInstanceState(path, state) {
  if (!validState(state) || !supportsInstanceControl(state))
    throw new Error("Invalid Inspire instance state");
  await writePrivateJson(path, state);
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
    state.startedAt === owner.startedAt
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

// A local mailbox is independent of HTTP and never sends the Host token.
// The MAC binds every request/result to one exact process incarnation.
const SHUTDOWN_DOMAIN = "inspire:local-host-shutdown:v1";
const MAX_CONTROL_BYTES = 2_048;

const shutdownTarget = instanceIdentity;
const shutdownNonce = /^[0-9a-f-]{36}$/u;

function controlMac(state, payload) {
  return createHmac("sha256", state.token)
    .update(SHUTDOWN_DOMAIN)
    .update("\0")
    .update(JSON.stringify(payload))
    .digest();
}

async function writeControl(path, state, payload) {
  await writePrivateJson(path, {
    ...payload,
    signature: controlMac(state, payload).toString("base64url"),
  });
}

async function readControl(path, state, kind, allowExpired = false) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CONTROL_BYTES) return null;
    const buffer = Buffer.alloc(MAX_CONTROL_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        used,
        buffer.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_CONTROL_BYTES) return null;
    const value = JSON.parse(buffer.subarray(0, used).toString("utf8"));
    if (
      !value ||
      value.version !== 1 ||
      value.kind !== kind ||
      value.target !== shutdownTarget(state) ||
      typeof value.signature !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.signature)
    )
      return null;
    let payload;
    if (kind === "request") {
      if (
        typeof value.nonce !== "string" ||
        !shutdownNonce.test(value.nonce) ||
        (value.scope !== undefined && value.scope !== "host-only") ||
        !Number.isSafeInteger(value.expiresAt) ||
        (!allowExpired &&
          (value.expiresAt < Date.now() ||
            value.expiresAt > Date.now() + 60_000))
      )
        return null;
      payload = {
        version: 1,
        kind,
        target: value.target,
        nonce: value.nonce,
        expiresAt: value.expiresAt,
        ...(value.scope === undefined ? {} : { scope: value.scope }),
      };
    } else {
      if (
        typeof value.clean !== "boolean" ||
        (value.requestNonce !== undefined &&
          (typeof value.requestNonce !== "string" ||
            !shutdownNonce.test(value.requestNonce)))
      )
        return null;
      payload = {
        version: 1,
        kind,
        target: value.target,
        clean: value.clean,
        ...(value.requestNonce === undefined
          ? {}
          : { requestNonce: value.requestNonce }),
      };
    }
    if (
      !timingSafeEqual(
        controlMac(state, payload),
        Buffer.from(value.signature, "base64url"),
      )
    )
      return null;
    return payload;
  } catch {
    // Missing, malformed, untrusted or inaccessible mailboxes grant no action.
    return null;
  } finally {
    await handle?.close();
  }
}

export async function requestInstanceShutdown(path, state, timeoutMs = 15_000, scope) {
  if (scope !== undefined && scope !== "host-only")
    throw new Error("The Host does not support this shutdown scope.");
  const nonce = randomUUID();
  await writeControl(path + ".shutdown-request", state, {
    version: 1,
    kind: "request",
    target: shutdownTarget(state),
    nonce,
    expiresAt: Date.now() + Math.min(timeoutMs, 60_000),
    ...(scope === undefined ? {} : { scope }),
  });
  return nonce;
}

function writeShutdownResult(path, state, clean, requestNonce) {
  return writeControl(path + ".shutdown-result", state, {
    version: 1,
    kind: "result",
    target: shutdownTarget(state),
    clean,
    ...(requestNonce === undefined ? {} : { requestNonce }),
  });
}

/** Called only after application/worker cleanup, before state removal and exit.
 * A signed failure must not authorize a replacement even if the Host exits. */
export async function completeInstanceShutdown(path, state, clean, requestNonce) {
  await writeShutdownResult(path, state, clean, requestNonce);
  // This incarnation still owns the launcher lease; no successor can have
  // published a request yet. Leave unknown/foreign files alone.
  if (await readControl(path + ".shutdown-request", state, "request", true))
    await rm(path + ".shutdown-request", { force: true }).catch(() => {});
}

/** The same Host remains live and may receive a fresh request. Leave the
 * request mailbox untouched so a concurrent writer cannot lose its request. */
export function refuseInstanceShutdown(path, state, requestNonce) {
  return writeShutdownResult(path, state, false, requestNonce);
}

export async function instanceShutdownRequested(path, state) {
  return Boolean(
    await readControl(path + ".shutdown-request", state, "request"),
  );
}

export function watchInstanceShutdown(path, state, onShutdown) {
  let closed = false;
  let pending = false;
  let lastRequestNonce;
  const poll = async () => {
    if (closed || pending) return;
    pending = true;
    try {
      const request = await readControl(path + ".shutdown-request", state, "request");
      if (request && request.nonce !== lastRequestNonce) {
        if (closed) return;
        lastRequestNonce = request.nonce;
        if ((await onShutdown(request)) !== false) {
          closed = true;
          clearInterval(timer);
        }
      }
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => void poll().catch(() => {}), 250);
  // This is a managed owner, not an idle background check: retain a route to
  // cooperative cleanup if the HTTP listener closes unexpectedly.
  void poll().catch(() => {});
  return () => {
    closed = true;
    clearInterval(timer);
  };
}

async function darwinProcessStartIdentity(pid, signal) {
  const { stdout } = await execFile(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart="],
    {
      encoding: "utf8",
      timeout: 1_500,
      signal,
      maxBuffer: 4_096,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    },
  );
  const value = stdout.trim();
  if (!value) throw new Error(`Unable to read process start time for ${pid}`);
  return `darwin:${value}`;
}

async function windowsProcessStartIdentity(pid, signal) {
  const command = windowsPowerShellCommand();
  const { stdout } = await execFile(
    command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      // The framework API avoids module discovery/autoload for a metadata probe.
      `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`,
    ],
    // Keep native identity work bounded independently of HTTP readiness.
    {
      encoding: "utf8",
      timeout: 10_000,
      signal,
      maxBuffer: 4_096,
      windowsHide: true,
    },
  ).catch((error) => {
    if (error?.code === "ENOENT")
      throw new Error(
        "PowerShell 7 is required on Windows. Install PowerShell 7 and make pwsh available on PATH.",
        { cause: error },
      );
    throw error;
  });
  const value = stdout.trim();
  if (!/^\d+$/u.test(value))
    throw new Error(`Unable to read process start time for ${pid}`);
  return `win32:${value}`;
}

/** A PID alone is reusable. Record an OS process-birth identity wherever the
 * host exposes one, and retain a conservative PID identity on other systems. */
async function queryProcessStartIdentity(pid, signal) {
  if (process.platform === "linux") {
    const processStat = await readFile(`/proc/${pid}/stat`, {
      encoding: "utf8",
      signal,
    });
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
  if (process.platform === "darwin")
    return darwinProcessStartIdentity(pid, signal);
  if (process.platform === "win32")
    return windowsProcessStartIdentity(pid, signal);
  return `pid:${pid}`;
}

let ownStartIdentity;

/** This process cannot recycle its own birth identity during its lifetime.
 * Share the expensive native lookup across startup/leases; foreign PIDs must
 * always be queried afresh, and a failed self lookup remains retryable.
 * A caller may cancel its own foreign-PID query, never the shared self cache.
 */
export async function processStartIdentity(pid, signal) {
  if (pid !== process.pid) return queryProcessStartIdentity(pid, signal);
  ownStartIdentity ??= queryProcessStartIdentity(pid).catch((error) => {
    ownStartIdentity = undefined;
    throw error;
  });
  return ownStartIdentity;
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

async function instanceProcessMayBeLive(state) {
  if (!(await processAlive(state.pid))) return false;
  try {
    return (await processStartIdentity(state.pid)) === state.processStartTime;
  } catch {
    return true;
  }
}

async function sameRoot(left, right) {
  if (left === right) return true;
  try {
    const [physicalLeft, physicalRight] = await Promise.all([
      realpath(left),
      realpath(right),
    ]);
    if (physicalLeft === physicalRight) return true;
    if (physicalLeft.toLowerCase() !== physicalRight.toLowerCase()) return false;
    // Case-insensitivity belongs to the actual volume/directory, not the OS.
    // A live directory identity verifies spelling aliases without conflating
    // distinct roots on Windows per-directory case-sensitive filesystems.
    const [leftInfo, rightInfo] = await Promise.all([
      stat(physicalLeft, { bigint: true }),
      stat(physicalRight, { bigint: true }),
    ]);
    return (
      leftInfo.isDirectory() &&
      rightInfo.isDirectory() &&
      leftInfo.ino !== 0n &&
      leftInfo.ino === rightInfo.ino &&
      leftInfo.dev === rightInfo.dev
    );
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

export async function inspectInstance(path, expected, options = {}) {
  const state = await readState(path);
  if (!state) return { kind: "absent" };
  if (!(await expectedState(state, expected))) return { kind: "stale" };

  if (!(await processAlive(state.pid))) return { kind: "stale" };
  const readiness = await requestInstanceControl(
    state,
    "readiness",
    {},
    options.healthTimeoutMs ?? 1_500,
  );
  if (readiness?.appName === "inspire") {
    return { kind: "healthy", state, url: instanceUrl(state) };
  }

  return (await instanceProcessMayBeLive(state))
    ? { kind: "unavailable" }
    : { kind: "stale" };
}

async function waitForProcessExit(path, state, timeoutMs, requestNonce) {
  const deadline = Date.now() + timeoutMs;
  let nextIdentityCheck = 0;
  while (Date.now() < deadline) {
    // State/socket disappearance is not proof that this process has exited.
    if (!(await processAlive(state.pid))) {
      await removeInstanceState(path, state);
      return "exited";
    }
    if (Date.now() >= nextIdentityCheck) {
      nextIdentityCheck = Date.now() + 500;
      try {
        if (
          (await processStartIdentity(state.pid)) !== state.processStartTime
        ) {
          await removeInstanceState(path, state);
          return "exited";
        }
      } catch {
        // An inaccessible process identity is not proof of exit. Continue to
        // wait for the PID or its exact process-birth identity to disappear.
      }
    }
    if (requestNonce) {
      const result = await readControl(path + ".shutdown-result", state, "result");
      if (result?.requestNonce === requestNonce && !result.clean)
        return "failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "timeout";
}

export async function stopManagedInstance(path, expected, options = {}) {
  const state = await readState(path);
  if (!state) return { kind: "absent" };
  if (!(await expectedState(state, expected))) return { kind: "stale" };

  const scoped = options.scopedOwner;
  if (
    scoped &&
    (instanceIdentity(state) !== instanceIdentity(scoped) ||
      state.token !== scoped.token)
  )
    return { kind: "unavailable" };

  if (!(await instanceProcessMayBeLive(state))) {
    await removeInstanceState(path, state);
    return { kind: "stale" };
  }
  if (!supportsInstanceControl(state)) return { kind: "unavailable" };

  const timeoutMs = options.timeoutMs ?? 15_000;
  const requestNonce = await requestInstanceShutdown(
    path,
    state,
    timeoutMs,
    scoped ? "host-only" : undefined,
  );
  const exit = await waitForProcessExit(
    path,
    state,
    timeoutMs,
    scoped ? requestNonce : undefined,
  );
  if (exit === "failed") return { kind: "cleanup-failed", state };
  if (exit === "timeout") return { kind: "timeout", state };
  const result = await readControl(path + ".shutdown-result", state, "result");
  if (!result || (scoped && result.requestNonce !== requestNonce))
    return { kind: "unavailable" };
  return { kind: result.clean ? "stopped" : "cleanup-failed", state };
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
