import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** Atomically replace private Host state. Callers own directory preparation,
 * serialization and write ordering; a lease can be rechecked before publication. */
export async function replacePrivateStateFile(
  path: string,
  serialized: string,
  beforeReplace?: () => Promise<void>,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
    await beforeReplace?.();
    await rename(temporary, path);
  } finally {
    // A failed cleanup must not hide the write/authority error or turn an
    // already published state into a reported failure.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
