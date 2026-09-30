import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { acquireFileLock } from "./file-lock.mjs";

const directoriesSchema = z.array(z.string().min(1).refine(isAbsolute));

/** Non-authoritative discovery hints, not session paths or navigation state.
 * Keep missing projects: their storage may be external or temporarily offline. */
export class ProjectDirectoryStore {
  constructor(readonly path: string) {}

  async read(): Promise<string[]> {
    try {
      return directoriesSchema.parse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async remember(cwds: readonly string[]): Promise<void> {
    const additions = [...new Set(cwds.map((cwd) => resolve(cwd)))];
    if (additions.length === 0) return;
    const known = await this.read();
    if (additions.every((cwd) => known.includes(cwd))) return;
    const lease = await acquireFileLock(`${this.path}.flock`, {
      label: "known project directories",
    });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await lease.assertOwned();
      // Re-read under the shared file lock so concurrent Hosts retain both sets.
      const current = await this.read();
      const merged = [...new Set([...current, ...additions])];
      if (merged.length === current.length) return;
      await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await lease.assertOwned();
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      await lease.release();
    }
  }
}
