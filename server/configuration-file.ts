import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { requestError } from "./request-error.js";

/** A readback failure after publication leaves the save committed. */
export async function savedConfiguration<T>(
  read: () => Promise<T>,
  warning: string,
): Promise<{ saved: true; snapshot: T } | { saved: true; warning: string }> {
  try {
    return { saved: true, snapshot: await read() };
  } catch {
    return { saved: true, warning };
  }
}

export async function readConfigurationText(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw requestError("Pi configuration could not be read", 409);
  }
}

async function parentAt(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw requestError("Pi configuration directory is unavailable", 409);
    return join(await parentAt(dirname(path)), basename(path));
  }
}

/** Resolve existing and dangling links without creating files or replacing links. */
export async function configurationFileTarget(
  path: string,
  seen = new Set<string>(),
): Promise<string> {
  const absolute = resolve(path);
  if (seen.has(absolute))
    throw requestError("Pi configuration has a circular link", 409);
  seen.add(absolute);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw requestError("Pi configuration path is unavailable", 409);
  }
  try {
    return await configurationFileTarget(
      resolve(dirname(absolute), await readlink(absolute)),
      seen,
    );
  } catch (error) {
    if (
      !["ENOENT", "EINVAL"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
  return join(await parentAt(dirname(absolute)), basename(absolute));
}

/** The caller resolved the parent and target before locking. A regular final
 * component has just the target authority: native realpath may canonicalize
 * its case/spelling without introducing another file. Symlinks still need
 * both lexical and target locks; missing files retain their creation authority.
 * Callers must recheck the target and revision before publishing.
 */
async function configurationEditLockPaths(
  lexical: string,
  target: string,
): Promise<string[]> {
  const details = await lstat(lexical).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return [...new Set(details?.isFile() ? [target] : [lexical, target])].sort();
}

interface ConfigurationAuthority {
  path: string;
  /** Services retain project containment and other scope-specific authority. */
  resolveTarget?: () => Promise<string>;
}
interface ConfigurationEdit extends ConfigurationAuthority {
  expectedRevision: string;
  revision(source: string | undefined, target: string): string;
  /** Related files whose namespace participates in this edit. */
  alsoLock?: ConfigurationAuthority[];
}

/** One native-compatible lock/revision/publication boundary for Pi file editors.
 * Parsing, field merging and native validation belong to the calling service. */
export async function editConfigurationFile(
  edit: ConfigurationEdit,
  transform: (source: string | undefined) => Promise<string>,
): Promise<void> {
  const authorities = await Promise.all(
    [edit, ...(edit.alsoLock ?? [])].map(async (file) => {
      const resolveTarget =
        file.resolveTarget ?? (() => configurationFileTarget(file.path));
      return { ...file, resolveTarget, target: await resolveTarget() };
    }),
  );
  const target = authorities[0]!.target;
  const lockPaths: string[] = [];
  for (const file of authorities) {
    await mkdir(dirname(file.target), { recursive: true, mode: 0o700 });
    const lexical = join(
      await realpath(dirname(file.path)),
      basename(file.path),
    );
    lockPaths.push(...(await configurationEditLockPaths(lexical, file.target)));
  }
  const releases: Array<() => Promise<void>> = [];
  const temporary = join(
    dirname(target),
    `.inspire-config-${randomUUID()}.json`,
  );
  let compromised = false;
  let failed = false;
  const changed = () =>
    requestError(
      "Pi configuration changed elsewhere. Refresh before saving.",
      409,
    );
  try {
    for (const authority of [...new Set(lockPaths)].sort()) {
      try {
        releases.push(
          await lockfile.lock(authority, {
            realpath: false,
            retries: { retries: 40, factor: 1, minTimeout: 50, maxTimeout: 50 },
            onCompromised: () => {
              compromised = true;
            },
          }),
        );
      } catch {
        throw requestError(
          "Pi configuration is being edited elsewhere. Refresh and try again.",
          409,
        );
      }
    }
    const source = await readConfigurationText(edit.path);
    if (edit.revision(source, target) !== edit.expectedRevision)
      throw changed();
    const next = await transform(source);
    await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
    for (const file of authorities)
      if ((await file.resolveTarget()) !== file.target) throw changed();
    if (
      compromised ||
      edit.revision(await readConfigurationText(edit.path), target) !==
        edit.expectedRevision
    )
      throw changed();
    await rename(temporary, target);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A failed temporary-file cleanup must not strand any acquired lock, and
    // cleanup errors must not replace the original validation/conflict error.
    const cleanup = await Promise.allSettled([
      rm(temporary, { force: true }),
      ...releases.reverse().map(async (release) => release()),
    ]);
    if (!failed) {
      const rejected = cleanup.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
    }
  }
}
