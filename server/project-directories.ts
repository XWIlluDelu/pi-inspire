import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { editPrivateStateJson } from "./private-state-file.js";

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
    await editPrivateStateJson(
      this.path,
      "known project directories",
      async (publish) => {
        // Concurrent Hosts can add directories between the first read and the lock.
        const current = await this.read();
        const merged = [...new Set([...current, ...additions])];
        if (merged.length === current.length) return;
        await publish(merged);
      },
    );
  }
}
