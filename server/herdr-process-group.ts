import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  type FileHandle,
  open,
  readFile,
  stat,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { PiRpcStopDiagnostic } from "./pi-rpc-transport.js";

export interface HerdrProcessIdentity {
  pid: number;
  birth: string;
  boot: string;
}

export interface HerdrWorkerScope {
  path: string;
  device: string;
  inode: string;
}

export interface HerdrProcessGroup extends HerdrProcessIdentity {
  // Absent only on leases from before scope-based tool ownership.
  scope?: HerdrWorkerScope;
}

/** Probe the same user-manager operation used by pane launch. No privileged
 * daemon, delegated hierarchy, resource policy, or direct-backend dependency.
 */
export async function assertHerdrWorkerScopesAvailable(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await promisify(execFile)(
      "systemd-run",
      [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--",
        process.execPath,
        "-e",
        `const fs = require('node:fs');
try {
  const path = /^0::(.+)$/m.exec(fs.readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
  if (!path) throw new Error('cgroup v2 is unavailable');
  fs.accessSync('/sys/fs/cgroup' + path + '/cgroup.kill', fs.constants.W_OK);
} catch (error) {
  process.stderr.write(error.message + '\\n');
  process.exitCode = 1;
}`,
      ],
      { env, timeout: 5_000, maxBuffer: 16_384 },
    );
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    const reason =
      failure.code === "ENOENT"
        ? "systemd-run was not found on PATH"
        : failure.stderr?.trim().split("\n")[0]?.slice(0, 300) ||
          "the scope probe did not complete";
    throw new Error(
      `Herdr worker scopes are unavailable: ${reason}. A running systemd user manager and writable cgroup v2 with cgroup.kill are required`,
    );
  }
}

interface LinuxProcess {
  group: number;
  birth: string;
  state: string;
}

async function inspectProcess(pid: number): Promise<LinuxProcess | null> {
  try {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    const closing = source.lastIndexOf(")");
    const fields = source
      .slice(closing + 2)
      .trim()
      .split(/\s+/u);
    if (closing < 0 || !fields[19] || !/^\d+$/u.test(fields[2] ?? ""))
      throw new Error("Unable to inspect the Herdr worker process");
    return { group: Number(fields[2]), birth: fields[19], state: fields[0]! };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function bootIdentity(): Promise<string> {
  if (process.platform !== "linux")
    throw new Error("Herdr worker ownership currently requires Linux");
  return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

export async function captureHerdrHostIdentity(): Promise<HerdrProcessIdentity> {
  const [boot, info] = await Promise.all([
    bootIdentity(),
    inspectProcess(process.pid),
  ]);
  if (!info) throw new Error("Unable to identify the Host process");
  return { pid: process.pid, birth: info.birth, boot };
}

export async function herdrProcessIsLive(
  identity: HerdrProcessIdentity,
): Promise<boolean> {
  if (identity.boot !== (await bootIdentity())) return false;
  const info = await inspectProcess(identity.pid);
  return (
    !!info && info.birth === identity.birth && !["Z", "X"].includes(info.state)
  );
}

export async function captureHerdrBridgeGroup(): Promise<HerdrProcessGroup> {
  const identity = await captureHerdrHostIdentity();
  if ((await inspectProcess(process.pid))?.group !== process.pid)
    throw new Error(
      "The Herdr bridge must own an isolated Linux process group",
    );
  return { ...identity, scope: await captureWorkerScope(process.pid) };
}

async function captureWorkerScope(
  pid: number,
  expectedName?: string,
): Promise<HerdrWorkerScope> {
  // Unlike a PGID, this kernel membership survives Pi's detached Bash groups,
  // setsid(), and either Pi or its bridge dying before cleanup.
  const cgroup = await readFile(`/proc/${pid}/cgroup`, "utf8");
  const path = /^0::(\/[^\n]*)$/mu.exec(cgroup)?.[1];
  if (
    !path ||
    !/\/inspire-pi-[a-f0-9-]{36}\.scope$/u.test(path) ||
    (expectedName && !path.endsWith(`/${expectedName}`))
  )
    throw new Error("The Herdr bridge did not enter its owned systemd scope");
  const directory = await open(
    `/sys/fs/cgroup${path}`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await directory.stat({ bigint: true });
    await access(`/proc/self/fd/${directory.fd}/cgroup.kill`, constants.W_OK);
    return {
      path: `/sys/fs/cgroup${path}`,
      device: String(info.dev),
      inode: String(info.ino),
    };
  } catch (error) {
    throw new Error(
      "Herdr workers require a writable cgroup v2 scope with cgroup.kill support",
      { cause: error },
    );
  } finally {
    await directory.close();
  }
}

/** Verify the exact executable invocation before a private launch grant can
 * turn this group into a Pi writer. A PID supplied by a socket is not authority.
 */
export async function captureHerdrProcessGroup(
  pid: number,
  entryPath: string,
  launchPath: string,
  scopeName: string,
): Promise<HerdrProcessGroup> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
    throw new Error("Invalid Herdr worker process identity");
  const [boot, info, owner, command] = await Promise.all([
    bootIdentity(),
    inspectProcess(pid),
    stat(`/proc/${pid}`),
    readFile(`/proc/${pid}/cmdline`, "utf8"),
  ]);
  const args = command.split("\0");
  if (
    !info ||
    info.group !== pid ||
    info.state === "Z" ||
    owner.uid !== process.getuid!() ||
    !args.includes(entryPath) ||
    !args.includes(launchPath)
  )
    throw new Error("The Herdr bridge does not own the expected worker group");
  return {
    pid,
    birth: info.birth,
    boot,
    scope: await captureWorkerScope(pid, scopeName),
  };
}

export async function assertHerdrGroupMember(
  group: HerdrProcessGroup,
  pid: number,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === group.pid)
    throw new Error("Invalid Pi worker process identity");
  const info = await inspectProcess(pid);
  if (!info || info.group !== group.pid || info.state === "Z")
    throw new Error("Pi did not start in its owned Herdr worker group");
}

async function openOwnedScope(
  scope: HerdrWorkerScope,
): Promise<FileHandle | null> {
  let directory: FileHandle;
  try {
    directory = await open(
      scope.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await directory.stat({ bigint: true });
    if (String(info.dev) === scope.device && String(info.ino) === scope.inode)
      return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
  await directory.close();
  return null;
}

async function scopePopulated(directory: FileHandle): Promise<boolean> {
  try {
    const events = await readFile(
      `/proc/self/fd/${directory.fd}/cgroup.events`,
      "utf8",
    );
    const populated = /^populated ([01])$/mu.exec(events)?.[1];
    if (populated === undefined)
      throw new Error("Unable to inspect Herdr worker scope");
    return populated === "1";
  } catch (error) {
    // A cgroup can only be removed after its last process has left.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Stop one kernel-owned worker tree, including detached tools. The directory
 * FD binds cleanup to the recorded cgroup incarnation; path reuse cannot aim a
 * kill at a new scope. Socket/Pi/bridge exit never substitutes for populated=0.
 */
export async function stopHerdrProcessGroup(
  group: HerdrProcessGroup,
  graceful: boolean,
  diagnostic: PiRpcStopDiagnostic,
): Promise<void> {
  if ((await bootIdentity()) !== group.boot) return;
  if (!group.scope)
    throw Object.assign(
      new Error(
        "This legacy Herdr worker has no retained tool scope; detached tool exit cannot be verified",
      ),
      { code: "HERDR_LEGACY_WORKER_LEASE" },
    );
  const directory = await openOwnedScope(group.scope);
  if (!directory) return;
  const started = Date.now();
  try {
    if (!(await scopePopulated(directory))) return;
    if (graceful) {
      const leader = await inspectProcess(group.pid);
      if (leader?.birth === group.birth && leader.group === group.pid) {
        diagnostic("worker_stop_signal", {
          signal: "SIGTERM",
          groupPid: group.pid,
        });
        try {
          process.kill(-group.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        while (Date.now() - started < 1_500) {
          if (!(await scopePopulated(directory))) return;
          await delay(50);
        }
      }
    }
    diagnostic("worker_stop_signal", {
      signal: "SIGKILL",
      groupPid: group.pid,
    });
    try {
      const killer = await open(
        `/proc/self/fd/${directory.fd}/cgroup.kill`,
        "w",
      );
      try {
        // Kernel-recursive and fork-race-safe: no user-space /proc tree scan.
        await killer.write("1");
      } finally {
        await killer.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let nextWarning = Date.now() + 2_500;
    while (await scopePopulated(directory)) {
      if (Date.now() >= nextWarning) {
        diagnostic("worker_stop_overdue", {
          groupPid: group.pid,
          elapsedMs: Date.now() - started,
        });
        nextWarning = Date.now() + 2_500;
      }
      await delay(50);
    }
  } finally {
    await directory.close();
  }
}
