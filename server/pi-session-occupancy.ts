import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type PiActivityRecord,
  piActivityDirectory,
  piActivityProcessIdentity,
} from "../docs/examples/session-activity.js";
import { isPiActivityRecord } from "./pi-session-activity.js";
import { requestError } from "./request-error.js";

const REPORT_NAME = /^[1-9]\d*-[0-9a-f-]{36}\.json$/u;
interface Holder {
  record: PiActivityRecord;
  identity?: string;
  retained?: boolean;
  persistedBinding?: string;
}

/** Only a binding change needs another durable presence write, not a heartbeat. */
function bindingIdentity(holder: Holder): string {
  return JSON.stringify([
    holder.record.pid,
    holder.identity,
    holder.record.sessionId,
    holder.record.sessionFile,
  ]);
}

/** Presence vetoes a new local writer; it never authorizes control of another Pi.
 * Unlike busy indicators, an observed holder does not expire with its heartbeat. */
export class PiSessionOccupancy {
  private readonly holders = new Map<string, Holder>();
  private checking: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory = piActivityDirectory(),
    private readonly processIdentity = piActivityProcessIdentity,
  ) {}

  private get retainedDirectory(): string {
    return join(this.directory, "presence");
  }

  private async readReports(directory: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
    }
    if (directory === this.retainedDirectory)
      for (const holder of this.holders.values())
        holder.persistedBinding = undefined;
    // Keep an already observed holder on missing, unreadable or malformed reports.
    // A completed producer rebind or confirmed process retirement clears it.
    await Promise.all(
      names
        .filter((name) => REPORT_NAME.test(name))
        .map(async (name) => {
          try {
            const path = join(directory, name);
            const info = await lstat(path);
            if (!info.isFile() || info.size > 16_384) return;
            const record: unknown = JSON.parse(await readFile(path, "utf8"));
            if (
              !isPiActivityRecord(record) ||
              !name.startsWith(`${record.pid}-`)
            )
              return;
            const previous = this.holders.get(name);
            const holder: Holder = {
              record,
              identity: record.processIdentity ?? previous?.identity,
              retained:
                previous?.retained || directory === this.retainedDirectory,
              persistedBinding: previous?.persistedBinding,
            };
            if (directory === this.retainedDirectory)
              holder.persistedBinding = bindingIdentity(holder);
            this.holders.set(name, holder);
          } catch {
            /* retain prior evidence */
          }
        }),
    );
  }

  private async retain(name: string, holder: Holder): Promise<void> {
    const binding = bindingIdentity(holder);
    if (holder.persistedBinding === binding) return;
    await mkdir(this.retainedDirectory, { recursive: true, mode: 0o700 });
    const target = join(this.retainedDirectory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({ ...holder.record, processIdentity: holder.identity }),
        { mode: 0o600 },
      );
      await rename(temporary, target);
      holder.retained = true;
      holder.persistedBinding = binding;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Capture a reporter instance while it still names the connected session.
   * A later binding from that same producer can retire control of the old file. */
  async observeBinding(
    pid: number,
    sessionId: string,
    sessionFile: string,
  ): Promise<
    | ((target: { kind: "id" | "path"; value: string }) => Promise<boolean>)
    | undefined
  > {
    const observe = this.checking.then(async () => {
      await this.readReports(this.retainedDirectory);
      await this.readReports(this.directory);
      const identity = await this.processIdentity(pid);
      const path = await realpath(sessionFile);
      const names: string[] = [];
      for (const [name, holder] of this.holders) {
        const record = holder.record;
        if (
          record.pid !== pid ||
          record.processIdentity !== identity ||
          record.sessionId !== sessionId
        )
          continue;
        if (
          (await realpath(record.sessionFile).catch(() =>
            resolve(record.sessionFile),
          )) !== path
        )
          continue;
        holder.identity = identity;
        await this.retain(name, holder);
        names.push(name);
      }
      if (!names.length) return undefined;
      return async (target: {
        kind: "id" | "path";
        value: string;
      }): Promise<boolean> => {
        const check = this.checking.then(async () => {
          await this.readReports(this.directory);
          if ((await this.processIdentity(pid)) !== identity) return false;
          const rebound: Array<[string, Holder]> = [];
          for (const name of names) {
            const holder = this.holders.get(name);
            const record = holder?.record;
            if (
              !record ||
              record.pid !== pid ||
              record.processIdentity !== identity ||
              record.sessionId === sessionId
            )
              return false;
            const nextPath = await realpath(record.sessionFile).catch(() =>
              resolve(record.sessionFile),
            );
            if (
              nextPath === path ||
              (target.kind === "id"
                ? record.sessionId !== target.value
                : nextPath !==
                  (await realpath(target.value).catch(() =>
                    resolve(target.value),
                  )))
            )
              return false;
            rebound.push([name, holder!]);
          }
          for (const [name, holder] of rebound) await this.retain(name, holder);
          return true;
        });
        this.checking = check.then(
          () => {},
          () => {},
        );
        return check.catch(() => false);
      };
    });
    this.checking = observe.then(
      () => {},
      () => {},
    );
    return observe.catch(() => undefined);
  }

  async assertWritable(sessionId: string, sessionFile: string): Promise<void> {
    // Different session gates share this report map and retained cache. Commit
    // one observation before another can supersede its producer binding.
    const checking = this.checking.then(() =>
      this.checkWritable(sessionId, sessionFile),
    );
    this.checking = checking.catch(() => {});
    try {
      await checking;
    } catch (error) {
      if ((error as { status?: number }).status === 409) throw error;
      throw requestError("External Pi presence could not be verified.", 409, {
        code: "SESSION_OWNER_UNAVAILABLE",
      });
    }
  }

  private async checkWritable(
    sessionId: string,
    sessionFile: string,
  ): Promise<void> {
    try {
      // Read retained fences first. Only a valid current source record may
      // replace one; report disappearance cannot release it on Host restart.
      await this.readReports(this.retainedDirectory);
      await this.readReports(this.directory);
    } catch {
      throw requestError("External Pi presence could not be checked.", 409, {
        code: "SESSION_OWNER_UNAVAILABLE",
      });
    }
    const target = await realpath(sessionFile);
    const matching = await Promise.all(
      [...this.holders].map(async ([name, holder]) => {
        const record = holder.record;
        // Neither the current activity-stop hint nor a legacy released flag
        // proves shutdown handlers and pending persistence have finished.
        try {
          process.kill(record.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            this.holders.delete(name);
            await rm(join(this.retainedDirectory, name), { force: true });
            return false;
          }
        }
        if (record.sessionId !== sessionId) {
          if (holder.retained) await this.retain(name, holder);
          return false;
        }
        const path = await realpath(record.sessionFile).catch(() =>
          resolve(record.sessionFile),
        );
        if (path !== target) {
          if (holder.retained) await this.retain(name, holder);
          return false;
        }
        try {
          const identity = await this.processIdentity(record.pid);
          if (holder.identity && holder.identity !== identity) {
            this.holders.delete(name);
            await rm(join(this.retainedDirectory, name), { force: true });
            return false;
          }
          holder.identity = identity;
        } catch (error) {
          // ENOENT may mean a missing native metadata executable, not a dead Pi.
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            this.holders.delete(name);
            await rm(join(this.retainedDirectory, name), { force: true });
            return false;
          }
          // A live process with unqueryable birth metadata is still not available.
        }
        await this.retain(name, holder);
        return true;
      }),
    );
    if (matching.some(Boolean))
      throw requestError(
        "This session is open in another Pi. History remains read-only until that Pi releases the session.",
        409,
        { code: "EXTERNAL_PI_WRITER_ACTIVE" },
      );
  }
}
