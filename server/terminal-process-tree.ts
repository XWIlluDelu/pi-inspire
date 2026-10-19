import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { processStartIdentity } from "./instance-state.mjs";

interface TerminalProcessIdentity {
  pid: number;
  birth: string;
}
interface ProcessInfo extends TerminalProcessIdentity {
  parent: number;
  state: string;
}
export interface TerminalTreeInspector {
  identity(pid: number, signal?: AbortSignal): Promise<string | null>;
  descendants(pid: number): Promise<TerminalProcessIdentity[]>;
  identities?(pids: number[]): Promise<Map<number, string>>;
  signal(pid: number, signal: NodeJS.Signals): void;
}

function missing(error: unknown): boolean {
  return ["ENOENT", "ESRCH"].includes(
    (error as NodeJS.ErrnoException).code ?? "",
  );
}
function live(info: ProcessInfo): boolean {
  return !["Z", "X"].includes(info.state[0]!);
}

async function linuxProcess(pid: number): Promise<ProcessInfo | null> {
  try {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    const closing = source.lastIndexOf(")");
    const fields = source
      .slice(closing + 2)
      .trim()
      .split(/\s+/u);
    if (
      closing < 0 ||
      !/^\d+$/u.test(fields[19] ?? "") ||
      !/^\d+$/u.test(fields[1] ?? "")
    )
      throw new Error("Unable to inspect terminal process identity");
    return {
      pid,
      parent: Number(fields[1]),
      birth: fields[19]!,
      state: fields[0]!,
    };
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function linuxProcesses(pids: number[]): Promise<ProcessInfo[]> {
  const result: ProcessInfo[] = [];
  const deadline = Date.now() + 1_000;
  // Bound concurrent file reads and total inspection work, not N native
  // subprocess deadlines. An incomplete snapshot rejects instead of declaring
  // missing rows retired.
  for (let offset = 0; offset < pids.length; offset += 64) {
    if (Date.now() >= deadline)
      throw new Error("Terminal process inspection timed out");
    const chunk = await Promise.all(
      pids.slice(offset, offset + 64).map(linuxProcess),
    );
    for (const info of chunk) if (info) result.push(info);
  }
  return result;
}

async function processTable(): Promise<ProcessInfo[]> {
  const { stdout } = await promisify(execFile)(
    "/bin/ps",
    ["-A", "-o", "pid=,ppid=,stat=,lstart="],
    {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    },
  );
  const records: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    records.push({
      pid: Number(match[1]),
      parent: Number(match[2]),
      state: match[3]!,
      birth: "darwin:" + match[4],
    });
  }
  if (records.length === 0)
    throw new Error("Unable to read terminal process table");
  return records;
}

function descendants(root: number, records: ProcessInfo[]): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const record of records)
    children.set(record.parent, [
      ...(children.get(record.parent) ?? []),
      record,
    ]);
  const visited = new Set([root]);
  const result: ProcessInfo[] = [];
  const visit = (parent: number) => {
    for (const record of children.get(parent) ?? []) {
      if (visited.has(record.pid)) continue;
      visited.add(record.pid);
      visit(record.pid);
      if (live(record)) result.push(record);
    }
  };
  visit(root);
  return result;
}

export const terminalTreeInspector: TerminalTreeInspector = {
  async identity(pid, signal) {
    try {
      const birth = await processStartIdentity(pid, signal);
      if (process.platform === "linux") {
        const info = await linuxProcess(pid);
        return info && live(info) && info.birth === birth ? birth : null;
      }
      return birth;
    } catch (error) {
      if (missing(error)) return null;
      if (process.platform === "darwin") {
        try {
          process.kill(pid, 0);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === "ESRCH") return null;
        }
      }
      throw error;
    }
  },
  async descendants(rootPid) {
    const candidates = descendants(rootPid, await processTable());
    // Linux ps has only second-resolution lstart. Rebuild ancestry from /proc
    // records containing parent and birth together: a PID recycled after ps
    // must not inherit the old process's parent relationship.
    return process.platform === "linux"
      ? descendants(
          rootPid,
          await linuxProcesses(candidates.map(({ pid }) => pid)),
        )
      : candidates;
  },
  async identities(pids) {
    const records =
      process.platform === "linux"
        ? await linuxProcesses(pids)
        : await processTable();
    const requested = new Set(pids);
    return new Map(
      records
        .filter((info) => requested.has(info.pid) && live(info))
        .map((info) => [info.pid, info.birth]),
    );
  },
  signal(pid, signal) {
    process.kill(pid, signal);
  },
};

/** A live, startup-birth-bound PTY authorizes discovery. After its exit only
 * retained descendant identities remain authority, never the old root/PGID.
 * These live OS observations are not atomic kernel handles or a fork sandbox.
 */
export class TerminalProcessTree {
  private readonly rootBirth: Promise<string | null>;
  private readonly known = new Map<number, TerminalProcessIdentity>();
  private readonly unverified = new Map<number, TerminalProcessIdentity>();
  private discoveryFailed = false;

  constructor(
    private readonly rootPid: number,
    private readonly exited: () => boolean,
    private readonly inspector: TerminalTreeInspector = terminalTreeInspector,
  ) {
    this.rootBirth = inspector.identity(rootPid);
    void this.rootBirth.catch(() => {});
  }

  private async discover(): Promise<void> {
    if (this.exited()) return;
    const expected = await this.rootBirth;
    if (this.exited()) return;
    if (
      expected === null ||
      (await this.inspector.identity(this.rootPid)) !== expected
    )
      return;
    const captured = await this.inspector.descendants(this.rootPid);
    // A concurrent exit/replacement cannot authorize newly observed children.
    // Keep them as observation-only blockers until they retire, rather than
    // either signalling unproven PIDs or falsely claiming complete cleanup.
    const authorized =
      !this.exited() &&
      (await this.inspector.identity(this.rootPid)) === expected &&
      !this.exited();
    if (authorized) this.discoveryFailed = false;
    for (const identity of captured) {
      if (authorized) {
        this.known.set(identity.pid, identity);
        this.unverified.delete(identity.pid);
      } else this.unverified.set(identity.pid, identity);
    }
  }

  async signal(signal: NodeJS.Signals): Promise<void> {
    try {
      await this.discover();
    } catch (error) {
      this.discoveryFailed = true;
      throw error;
    }
    await this.signalKnown(signal);
    if (this.exited()) return;
    const expected = await this.rootBirth;
    if (
      expected === null ||
      (await this.inspector.identity(this.rootPid)) !== expected ||
      this.exited()
    )
      return;
    try {
      this.inspector.signal(-this.rootPid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      if (
        !this.exited() &&
        (await this.inspector.identity(this.rootPid)) === expected &&
        !this.exited()
      )
        this.inspector.signal(this.rootPid, signal);
    }
  }

  private current(pids: number[]): Promise<Map<number, string>> {
    if (pids.length === 0) return Promise.resolve(new Map());
    if (this.inspector.identities) return this.inspector.identities(pids);
    return Promise.all(
      pids.map(
        async (pid) => [pid, await this.inspector.identity(pid)] as const,
      ),
    ).then(
      (entries) =>
        new Map(
          entries.filter(
            (entry): entry is readonly [number, string] => entry[1] !== null,
          ),
        ),
    );
  }

  private async signalKnown(signal: NodeJS.Signals): Promise<void> {
    const current = await this.current([...this.known.keys()]);
    for (const identity of this.known.values()) {
      if (current.get(identity.pid) !== identity.birth) {
        this.known.delete(identity.pid);
        continue;
      }
      try {
        this.inspector.signal(identity.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        this.known.delete(identity.pid);
      }
    }
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.discoveryFailed)
      throw new Error(
        "Terminal descendant discovery was incomplete; cleanup cannot be confirmed",
      );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await this.current([
        ...this.known.keys(),
        ...this.unverified.keys(),
      ]);
      for (const group of [this.known, this.unverified])
        for (const identity of group.values())
          if (current.get(identity.pid) !== identity.birth)
            group.delete(identity.pid);
      if (this.known.size === 0 && this.unverified.size === 0) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(25, remaining));
    }
  }
}
