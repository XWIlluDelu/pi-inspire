import { readdir, readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { PiRpcStopDiagnostic } from "./pi-rpc-transport.js";

export interface HerdrProcessIdentity {
  pid: number;
  birth: string;
  boot: string;
}

export type HerdrProcessGroup = HerdrProcessIdentity;

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

export async function assertHerdrBridgeGroup(): Promise<void> {
  if (
    process.platform !== "linux" ||
    (await inspectProcess(process.pid))?.group !== process.pid
  )
    throw new Error(
      "The Herdr bridge must own an isolated Linux process group",
    );
}

/** Verify the exact executable invocation before a private launch grant can
 * turn this group into a Pi writer. A PID supplied by a socket is not authority.
 */
export async function captureHerdrProcessGroup(
  pid: number,
  entryPath: string,
  launchPath: string,
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
  return { pid, birth: info.birth, boot };
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

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function hasLiveGroupMember(pid: number): Promise<boolean> {
  if (!groupExists(pid)) return false;
  // An orphan can remain a zombie until its reaper runs. Zombies cannot write;
  // neither a reusable PID nor a pending reaping obligation is a live writer.
  const entries = await readdir("/proc");
  for (const name of entries) {
    if (!/^\d+$/u.test(name)) continue;
    const info = await inspectProcess(Number(name));
    if (info?.group === pid && info.state !== "Z" && info.state !== "X")
      return true;
  }
  return false;
}

/** Linux reserves a process-group ID until its last member is gone. A
 * different boot or a reused leader PID therefore proves this old group ended.
 * Otherwise retain its fence until no member can execute, even if the bridge
 * died before it could report its Pi child's PID.
 */
export async function stopHerdrProcessGroup(
  group: HerdrProcessGroup,
  graceful: boolean,
  diagnostic: PiRpcStopDiagnostic,
): Promise<void> {
  if ((await bootIdentity()) !== group.boot) return;
  const stillOwned = async () => {
    const leader = await inspectProcess(group.pid);
    return !leader || leader.birth === group.birth;
  };
  const stillLive = async () =>
    (await stillOwned()) && (await hasLiveGroupMember(group.pid));
  if (!(await stillLive())) return;

  const signal = async (name: NodeJS.Signals) => {
    if (!(await stillOwned())) return;
    diagnostic("worker_stop_signal", { signal: name, groupPid: group.pid });
    try {
      process.kill(-group.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const started = Date.now();
  if (graceful) {
    await signal("SIGTERM");
    while (Date.now() - started < 1_500) {
      if (!(await stillLive())) return;
      await delay(50);
    }
  }
  await signal("SIGKILL");
  let nextWarning = Date.now() + 2_500;
  while (await stillLive()) {
    if (Date.now() >= nextWarning) {
      diagnostic("worker_stop_overdue", {
        groupPid: group.pid,
        elapsedMs: Date.now() - started,
      });
      nextWarning = Date.now() + 2_500;
    }
    await delay(50);
  }
}
