import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { HerdrWorkerPane } from "./herdr-client.js";
import {
  captureHerdrHostIdentity,
  type HerdrProcessGroup,
  type HerdrProcessIdentity,
} from "./herdr-process-group.js";

const processIdentitySchema = z
  .object({
    pid: z.number().int().min(2).max(2_147_483_647),
    birth: z.string().regex(/^\d+$/u),
    boot: z.string().uuid(),
  })
  .strict();
const leaseIdSchema = z.string().uuid();
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
    group: processIdentitySchema.nullable(),
  })
  .strict();

export type HerdrWorkerLease = z.infer<typeof leaseSchema>;

/** Launch ownership only, never a session store. Publishing the process-group
 * identity precedes the bridge's permission to spawn a Pi writer, so a new Host
 * can fence an old writer even when no ready response ever arrived.
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

  private async write(lease: HerdrWorkerLease): Promise<void> {
    leaseSchema.parse(lease);
    const target = join(this.directory, `${lease.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(lease)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
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
