import { acquireFileLock } from "./file-lock.mjs";
import { replacePrivateStateFile } from "./replace-private-state-file.mjs";

export { replacePrivateStateFile };

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
