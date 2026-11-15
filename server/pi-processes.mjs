import { open, readdir, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const PI_TITLES = new Set(["pi", "pi-rpc"]);
const EXITED_STATES = new Set(["Z", "X", "x"]);

export function supportsGlobalPiStop(platform = process.platform) {
  // ps start timestamps on other platforms do not provide Linux's birth ticks.
  return platform === "linux";
}

function disappeared(error) {
  return error?.code === "ENOENT" || error?.code === "ESRCH";
}

function parseStat(value, pid) {
  const opening = value.indexOf("(");
  const closing = value.lastIndexOf(")");
  const fields = value.slice(closing + 2).trim().split(/\s+/);
  if (
    opening < 0 ||
    closing <= opening ||
    Number(value.slice(0, opening).trim()) !== pid ||
    !/^[0-9]+$/.test(fields[19] ?? "") ||
    !/^[0-9]+$/.test(fields[1] ?? "") ||
    !/^[A-Za-z]$/.test(fields[0] ?? "")
  )
    throw new Error(`Invalid /proc stat for PID ${pid}`);
  return {
    pid,
    parentPid: Number(fields[1]),
    title: value.slice(opening + 1, closing),
    startTime: fields[19],
    state: fields[0],
  };
}

async function withLinuxProcess(pid, inspect) {
  let directory;
  try {
    directory = await open(`/proc/${pid}`, "r");
    // Keep both the process files and their ownership anchored to one proc
    // directory, even if its numeric PID is recycled during these reads.
    return await inspect(directory, `/proc/self/fd/${directory.fd}`);
  } catch (error) {
    if (disappeared(error)) return null;
    throw error;
  } finally {
    await directory?.close();
  }
}

/** Native operations are separate so callers can scope enumeration to owned
 * disposable children in tests. Never invoke default global stop in a test. */
export function createLinuxPiProcessAdapter() {
  if (!supportsGlobalPiStop() || typeof process.getuid !== "function")
    throw new Error("Global Pi termination is supported only on Linux");
  const uid = process.getuid();
  return {
    uid,
    async enumerate() {
      return (await readdir("/proc"))
        .filter((name) => /^[1-9][0-9]*$/.test(name))
        .map(Number);
    },
    async inspect(pid) {
      return withLinuxProcess(pid, async (directory, path) => {
        if ((await directory.stat()).uid !== uid) return null;
        const identity = parseStat(await readFile(`${path}/stat`, "utf8"), pid);
        const status = await readFile(`${path}/status`, "utf8");
        const owners = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
        if (!owners) throw new Error(`Invalid /proc owner for PID ${pid}`);
        // Refuse elevated or credential-changing processes, even for root.
        if (!owners.slice(1).every((owner) => Number(owner) === uid)) return null;
        let inHerdr = false;
        if (PI_TITLES.has(identity.title) && !EXITED_STATES.has(identity.state)) {
          // Herdr supplies both pane and socket markers to terminal children;
          // the enhanced runner explicitly propagates them to its nested Pi.
          // Read only target environments and never expose their contents.
          let environment;
          try {
            environment = (await readFile(`${path}/environ`, "utf8")).split("\0");
          } catch (error) {
            if (error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
            // Linux can deny environ before stat reaches an exited state.
            // Observe briefly on the same proc directory. A live process
            // whose scope cannot be read must still fail closed.
            for (const delay of [0, 10, 20, 30]) {
              if (delay) await sleep(delay);
              const current = parseStat(await readFile(`${path}/stat`, "utf8"), pid);
              if (EXITED_STATES.has(current.state))
                return { ...current, uid, inHerdr };
            }
            throw error;
          }
          inHerdr =
            environment.some((entry) => /^HERDR_PANE_ID=.+$/s.test(entry)) &&
            environment.some((entry) => /^HERDR_SOCKET_PATH=.+$/s.test(entry));
        }
        return { ...identity, uid, inHerdr };
      });
    },
    signal(pid, signal) {
      process.kill(pid, signal);
    },
    sleep,
  };
}

function isTarget(identity, uid, includeHerdr) {
  return (
    identity !== null &&
    identity.uid === uid &&
    PI_TITLES.has(identity.title) &&
    (includeHerdr || !identity.inHerdr) &&
    !EXITED_STATES.has(identity.state)
  );
}

function validateBirthIdentity(identity, pid) {
  if (
    identity !== null &&
    (identity.pid !== pid ||
      !Number.isSafeInteger(identity.uid) ||
      identity.uid < 0 ||
      typeof identity.startTime !== "string" ||
      !identity.startTime ||
      typeof identity.title !== "string" ||
      typeof identity.state !== "string" ||
      identity.state.length !== 1)
  )
    throw new Error(`Invalid process identity for PID ${pid}`);
  return identity;
}

function validateIdentity(identity, pid) {
  validateBirthIdentity(identity, pid);
  if (identity !== null && typeof identity.inHerdr !== "boolean")
    throw new Error(`Invalid process identity for PID ${pid}`);
  return identity;
}

const EXTERNAL_PI_RESTART =
  "Run inspire restart --all outside Pi, from an OS terminal.";

/** Verify the caller does not descend from a Pi that global cleanup could end.
 * No enumeration, environment reads, or signals occur. Follow foreign-owned
 * ancestors too: a sudo/su wrapper must not conceal a current-user Pi.
 */
export async function assertExternalPiRestartCaller(options = {}) {
  const platform = options.platform ?? process.platform;
  if (!supportsGlobalPiStop(platform))
    throw new Error(`Pi restart caller verification is unsupported on ${platform}`);
  const adapter = options.adapter ?? {
    uid: process.getuid(),
    inspect: (pid) => withLinuxProcess(pid, async (directory, path) => ({
      ...parseStat(await readFile(`${path}/stat`, "utf8"), pid),
      uid: (await directory.stat()).uid,
    })),
  };
  const callerPid = options.pid ?? process.pid;
  if (
    !Number.isSafeInteger(callerPid) ||
    callerPid <= 0 ||
    !Number.isSafeInteger(adapter.uid) ||
    adapter.uid < 0 ||
    typeof adapter.inspect !== "function"
  )
    throw new Error("Pi restart caller verification requires a complete ancestry adapter and a valid PID");
  const inspect = async (pid) => {
    let identity;
    try {
      identity = await adapter.inspect(pid);
    } catch (error) {
      throw new Error(`Cannot inspect restart caller ancestry at PID ${pid}. ${EXTERNAL_PI_RESTART}`, { cause: error });
    }
    try {
      validateBirthIdentity(identity, pid);
    } catch (error) {
      throw new Error(`Cannot verify restart caller ancestry at PID ${pid}. ${EXTERNAL_PI_RESTART}`, { cause: error });
    }
    if (
      identity === null ||
      !Number.isSafeInteger(identity.parentPid) ||
      identity.parentPid < 0 ||
      EXITED_STATES.has(identity.state)
    )
      throw new Error(`Cannot verify restart caller ancestry at PID ${pid}. ${EXTERNAL_PI_RESTART}`);
    return identity;
  };
  const seen = new Set();
  let current = await inspect(callerPid);
  while (true) {
    if (seen.has(current.pid) || seen.size >= 1_024)
      throw new Error(`Invalid restart caller ancestry. ${EXTERNAL_PI_RESTART}`);
    seen.add(current.pid);
    if (current.uid === adapter.uid && PI_TITLES.has(current.title))
      throw new Error(EXTERNAL_PI_RESTART);
    if (current.parentPid === 0) return;

    const parent = await inspect(current.parentPid);
    const checked = await inspect(current.pid);
    if (
      checked.startTime !== current.startTime ||
      checked.uid !== current.uid ||
      checked.parentPid !== current.parentPid ||
      checked.title !== current.title
    )
      throw new Error(`Restart caller ancestry changed during verification. ${EXTERNAL_PI_RESTART}`);
    current = parent;
  }
}

function duration(value, fallback, name, allowZero = true) {
  const result = value ?? fallback;
  if (
    !Number.isFinite(result) ||
    result < (allowZero ? 0 : 1) ||
    result > 60_000
  )
    throw new Error(`Invalid ${name}; expected ${allowZero ? "0" : "1"}–60000 ms`);
  return result;
}

/** Snapshot current-user Pi processes, TERM, wait, KILL survivors, verify exit.
 * Only exact Pi titles are targeted: no command-line substring, process-group,
 * or descendant-tree signalling that could kill shells, Herdr, or the Host.
 * Nested Pi processes are included independently by the global snapshot.
 */
export async function stopAllPiProcesses(options = {}) {
  const platform = options.platform ?? process.platform;
  if (!supportsGlobalPiStop(platform))
    throw new Error(`Global Pi termination is unsupported on ${platform}`);
  const includeHerdr = options.includeHerdr ?? false;
  if (typeof includeHerdr !== "boolean")
    throw new Error("includeHerdr must be a boolean");
  const adapter = options.adapter ?? createLinuxPiProcessAdapter();
  if (
    !Number.isSafeInteger(adapter.uid) ||
    adapter.uid < 0 ||
    !["enumerate", "inspect", "signal", "sleep"].every(
      (key) => typeof adapter[key] === "function",
    )
  )
    throw new Error("Global Pi termination requires a complete process adapter");
  const graceMs = duration(options.graceMs, 5_000, "graceMs");
  const killWaitMs = duration(options.killWaitMs, 1_000, "killWaitMs");
  const pollMs = duration(options.pollMs, 50, "pollMs", false);
  const inspect = async (pid) => {
    try {
      return validateIdentity(await adapter.inspect(pid), pid);
    } catch (error) {
      if (disappeared(error)) return null;
      throw error;
    }
  };

  // Finish discovery before issuing any destructive operation. Discovery or
  // ownership/identity access errors must not masquerade as an empty snapshot.
  const targets = new Map();
  for (const pid of await adapter.enumerate()) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error(`Invalid enumerated PID: ${pid}`);
    if (targets.has(pid)) continue;
    const identity = await inspect(pid);
    if (isTarget(identity, adapter.uid, includeHerdr)) targets.set(pid, { ...identity });
  }

  const errors = [];
  const failedPids = new Set();
  const failure = (pid, action, error) => {
    failedPids.add(pid);
    errors.push(
      new Error(`PID ${pid}: ${action}: ${error.message ?? error}`, {
        cause: error,
      }),
    );
    targets.delete(pid);
  };
  const remains = async (pid, original) => {
    const current = await inspect(pid);
    return (
      isTarget(current, adapter.uid, includeHerdr) &&
      current.startTime === original.startTime
    );
  };
  const signal = async (name) => {
    for (const [pid, original] of targets) {
      try {
        // Re-read birth, ownership and title immediately before each signal.
        if (!(await remains(pid, original))) {
          targets.delete(pid);
          continue;
        }
        await adapter.signal(pid, name);
      } catch (error) {
        if (error?.code === "ESRCH") targets.delete(pid);
        else failure(pid, name, error);
      }
    }
  };
  const wait = async (timeoutMs) => {
    const started = performance.now();
    let waited = 0;
    while (targets.size) {
      for (const [pid, original] of targets) {
        try {
          if (!(await remains(pid, original))) targets.delete(pid);
        } catch (error) {
          failure(pid, "cannot verify exit", error);
        }
      }
      const remaining = timeoutMs - Math.max(waited, performance.now() - started);
      if (!targets.size || remaining <= 0) return;
      const interval = Math.min(pollMs, remaining);
      await adapter.sleep(interval);
      waited += interval;
    }
  };

  await signal("SIGTERM");
  await wait(graceMs);
  await signal("SIGKILL");
  await wait(killWaitMs);
  for (const pid of targets.keys()) {
    failedPids.add(pid);
    errors.push(new Error(`PID ${pid}: still running after SIGKILL`));
  }
  // Discovery is a snapshot, not permission to chase newly spawned processes.
  // A fresh scan verifies the global result without signalling new identities.
  try {
    for (const pid of await adapter.enumerate()) {
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error(`Invalid enumerated PID: ${pid}`);
      const current = await inspect(pid);
      if (isTarget(current, adapter.uid, includeHerdr) && !failedPids.has(pid))
        errors.push(
          new Error(`PID ${pid}: new Pi process remains after termination`),
        );
    }
  } catch (error) {
    errors.push(
      new Error(`Cannot verify global Pi exit: ${error.message ?? error}`, {
        cause: error,
      }),
    );
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `Failed to stop all Pi processes: ${errors.map((error) => error.message).join("; ")}`,
    );
}
