import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { HerdrWorkerPane } from "./herdr-client.js";
import {
  captureHerdrHostIdentity,
  herdrProcessIsLive,
  type HerdrProcessGroup,
  type HerdrProcessIdentity,
} from "./herdr-process-group.js";
import { replacePrivateStateFile } from "./private-state-file.js";

const processIdentitySchema = z
  .object({
    pid: z.number().int().min(2).max(2_147_483_647),
    birth: z.string().regex(/^\d+$/u),
    boot: z.string().uuid(),
  })
  .strict();
const leaseIdSchema = z.string().uuid();
export const herdrReleaseBindingSchema = z
  .object({
    directory: z.string().refine(isAbsolute),
    owner: processIdentitySchema,
    leaseId: leaseIdSchema,
  })
  .strict();
const releaseRecordSchema = z
  .object({
    version: z.literal(1),
    owner: processIdentitySchema,
    workers: z
      .array(
        z
          .object({ leaseId: leaseIdSchema, bridge: processIdentitySchema })
          .strict(),
      )
      .max(4_096),
  })
  .strict();
type ReleaseRecord = z.infer<typeof releaseRecordSchema>;
type ReleaseBinding = z.infer<typeof herdrReleaseBindingSchema>;

function sameProcess(
  a: HerdrProcessIdentity,
  b: HerdrProcessIdentity,
): boolean {
  return a.pid === b.pid && a.boot === b.boot && a.birth === b.birth;
}

function releaseName(owner: HerdrProcessIdentity): string {
  return `${owner.boot}-${owner.pid}-${owner.birth}.released`;
}

async function readRelease(path: string): Promise<ReleaseRecord | null> {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 1024 * 1024
    )
      throw new Error("Invalid Herdr worker release record");
    return releaseRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function herdrWorkerWasReleased(
  binding: ReleaseBinding,
  bridge: HerdrProcessIdentity,
): Promise<boolean> {
  const record = await readRelease(
    join(binding.directory, releaseName(binding.owner)),
  );
  return (
    record !== null &&
    sameProcess(record.owner, binding.owner) &&
    record.workers.some(
      ({ leaseId, bridge: recorded }) =>
        leaseId === binding.leaseId && sameProcess(recorded, bridge),
    )
  );
}
const leaseSchema = z
  .object({
    version: z.literal(1),
    id: leaseIdSchema,
    owner: processIdentitySchema,
    cwd: z.string().refine(isAbsolute),
    pane: z
      .object({
        serverId: z.string().min(1).max(256),
        paneId: z.string().min(1).max(256),
        workspaceId: z.string().min(1).max(256),
        tabId: z.string().min(1).max(256),
      })
      .strict(),
    launchDirectory: z
      .string()
      .refine(
        (value) =>
          isAbsolute(value) &&
          resolve(value) === value &&
          /^inspire-herdr-[A-Za-z0-9]{6}$/u.test(basename(value)),
      ),
    group: processIdentitySchema
      .extend({
        scope: z
          .object({
            path: z
              .string()
              .refine(
                (value) =>
                  value.startsWith("/sys/fs/cgroup/") &&
                  resolve(value) === value &&
                  /^inspire-pi-[a-f0-9-]{36}\.scope$/u.test(basename(value)),
              ),
            device: z.string().regex(/^\d+$/u),
            inode: z.string().regex(/^\d+$/u),
          })
          .strict()
          .optional(),
      })
      .nullable(),
  })
  .strict();

export type HerdrWorkerLease = z.infer<typeof leaseSchema>;

/** Launch ownership only, never a session store. Publishing the group and kernel
 * scope identity precedes permission to spawn Pi, so recovery owns detached
 * tools even when their Pi parent died before cleanup.
 */
export class HerdrWorkerRegistry {
  private owner: Promise<HerdrProcessIdentity> | null = null;

  constructor(readonly directory: string) {}

  private async assertPrivateDirectory(): Promise<void> {
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error(
        "Herdr worker ownership directory must be private to this user",
      );
  }

  async create(
    cwd: string,
    pane: HerdrWorkerPane,
    launchDirectory: string,
  ): Promise<HerdrWorkerLease> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.assertPrivateDirectory();
    const lease: HerdrWorkerLease = {
      version: 1,
      id: randomUUID(),
      owner: await (this.owner ??= captureHerdrHostIdentity()),
      cwd,
      pane,
      launchDirectory,
      group: null,
    };
    await this.write(lease);
    return lease;
  }

  async grant(
    lease: HerdrWorkerLease,
    group: HerdrProcessGroup,
  ): Promise<HerdrWorkerLease> {
    const granted = { ...lease, group };
    await this.write(granted);
    return granted;
  }

  /** A single publication transfers all selected workers, including when the
   * Host exits before their sockets observe the disconnect. */
  async release(
    leases: readonly HerdrWorkerLease[],
    verify?: () => void,
  ): Promise<void> {
    if (!leases.length) return;
    await this.assertPrivateDirectory();
    const owner = await (this.owner ??= captureHerdrHostIdentity());
    const workers = leases.map(({ id, owner: leaseOwner, group }) => {
      if (!group || !sameProcess(owner, leaseOwner))
        throw new Error("Cannot release an unverified Herdr worker");
      const { pid, birth, boot } = group;
      return { leaseId: id, bridge: { pid, birth, boot } };
    });
    const record = releaseRecordSchema.parse({ version: 1, owner, workers });
    await replacePrivateStateFile(
      join(this.directory, releaseName(owner)),
      `${JSON.stringify(record)}\n`,
      { beforeReplace: verify },
    );
  }

  wasReleased(lease: HerdrWorkerLease): Promise<boolean> {
    if (!lease.group) return Promise.resolve(false);
    return herdrWorkerWasReleased(
      {
        directory: this.directory,
        owner: lease.owner,
        leaseId: lease.id,
      },
      lease.group,
    );
  }

  async pruneReleases(): Promise<void> {
    const names = await readdir(this.directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const name of names.filter((name) => name.endsWith(".released"))) {
      const path = join(this.directory, name);
      const record = await readRelease(path);
      if (!record || releaseName(record.owner) !== name) continue;
      // Bridges may read the release after the new Host starts. A retained
      // lease also needs this proof even after its bridge has exited.
      if (await herdrProcessIsLive(record.owner)) continue;
      const needed = await Promise.all(
        record.workers.map(
          async ({ leaseId, bridge }) =>
            (await herdrProcessIsLive(bridge)) ||
            (await lstat(join(this.directory, `${leaseId}.json`)).then(
              () => true,
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return false;
                throw error;
              },
            )),
        ),
      );
      if (!needed.some(Boolean)) await rm(path, { force: true });
    }
  }

  private async write(lease: HerdrWorkerLease): Promise<void> {
    leaseSchema.parse(lease);
    const target = join(this.directory, `${lease.id}.json`);
    await replacePrivateStateFile(target, `${JSON.stringify(lease)}\n`);
  }

  async list(): Promise<HerdrWorkerLease[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    await this.assertPrivateDirectory();
    const leases: HerdrWorkerLease[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = leaseIdSchema.parse(name.slice(0, -5));
      const path = join(this.directory, name);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.uid !== process.getuid!() ||
        (info.mode & 0o077) !== 0 ||
        info.size > 16_384
      )
        throw new Error("Invalid Herdr worker ownership record");
      const lease = leaseSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (lease.id !== id)
        throw new Error("Herdr worker ownership identity mismatch");
      leases.push(lease);
    }
    return leases;
  }

  async remove(lease: HerdrWorkerLease): Promise<void> {
    leaseSchema.parse(lease);
    await rm(join(this.directory, `${lease.id}.json`), { force: true });
    await rm(lease.launchDirectory, { recursive: true, force: true });
  }
}
