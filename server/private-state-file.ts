import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { acquireFileLock } from "./file-lock.mjs";

export async function editPrivateStateJson<T>(
  path: string,
  label: string,
  edit: (publish: (value: unknown) => Promise<void>) => Promise<T>,
): Promise<T> {
  const lease = await acquireFileLock(`${path}.flock`, { label });
  try {
    await lease.assertOwned();
    return await edit((value) =>
      replacePrivateStateFile(path, `${JSON.stringify(value, null, 2)}\n`, {
        beforeReplace: lease.assertOwned,
      }),
    );
  } finally {
    await lease.release();
  }
}

/** Atomically replace private Host state. Callers own directory preparation,
 * serialization and write ordering; a lease can be rechecked before publication. */
export async function replacePrivateStateFile(
  path: string,
  serialized: string,
  {
    beforeReplace,
    flush,
  }: {
    beforeReplace?: (candidatePath: string) => void | Promise<void>;
    flush?: boolean;
  } = {},
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: "wx", flush });
    await beforeReplace?.(temporary);
    await rename(temporary, path);
  } finally {
    // A failed cleanup must not hide the write/authority error or turn an
    // already published state into a reported failure.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
