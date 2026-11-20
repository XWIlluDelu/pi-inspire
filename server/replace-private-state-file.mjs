import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** Callers own directory preparation, serialization and write ordering. */
export async function replacePrivateStateFile(
  path,
  serialized,
  { beforeReplace, flush } = {},
) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: "wx", flush });
    await beforeReplace?.(temporary);
    await rename(temporary, path);
  } finally {
    // Cleanup cannot hide the error or undo an already published result.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
