import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import stripJsonComments from "strip-json-comments";
import { isJsonRecord } from "../shared/json-record.js";
import { replacePrivateStateFile } from "./private-state-file.js";
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

async function readConfigurationText(
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

export interface ConfigurationAuthority {
  path: string;
  /** Services retain project containment and other scope-specific authority. */
  resolveTarget?: () => Promise<string>;
}

interface JsonDocument {
  invalid: string;
  comments?: boolean;
  preserveIndent?: boolean;
}

interface ConfigurationEdit extends ConfigurationAuthority {
  expectedRevision: string;
  /** Related files whose namespace participates in this edit. */
  alsoLock?: ConfigurationAuthority[];
  /** Validate the exact candidate before it replaces the reviewed file. */
  validate?: (candidatePath: string) => Promise<void>;
}

type ConfigurationObject = Record<string, unknown>;

function revisionOf(source: string | undefined, target: string) {
  return createHash("sha256")
    .update(JSON.stringify([target, source ?? null]))
    .digest("hex");
}

function resolveAuthority(file: ConfigurationAuthority): Promise<string> {
  return file.resolveTarget?.() ?? configurationFileTarget(file.path);
}

export async function readConfigurationFile(file: ConfigurationAuthority) {
  const target = await resolveAuthority(file);
  const source = await readConfigurationText(target);
  return { source, revision: revisionOf(source, target) };
}

function parseConfigurationObject(
  source: string | undefined,
  { invalid, comments }: JsonDocument,
): ConfigurationObject {
  try {
    const text = source?.replace(/^\uFEFF/u, "");
    const value: unknown =
      text === undefined
        ? {}
        : JSON.parse(comments ? stripJsonComments(text) : text);
    if (isJsonRecord(value)) return value;
  } catch {
    // Diagnostics describe the file without returning raw configuration text.
  }
  throw requestError(invalid, 409);
}

/** Inspect reports malformed files. An explicit reveal must match the reviewed
 * revision before returning any protected values. */
export async function readConfigurationDocument(
  file: ConfigurationAuthority,
  recipe: JsonDocument,
  expected?: { revision: string; stale: string },
) {
  const { source, revision } = await readConfigurationFile(file);
  if (expected && revision !== expected.revision)
    throw requestError(expected.stale, 409);
  try {
    return { value: parseConfigurationObject(source, recipe), revision };
  } catch (error) {
    if (expected) throw error;
    return { value: {}, revision, error: recipe.invalid };
  }
}

/** Omission preserves the native field. Null removes it. */
export function applyConfigurationPatch(
  current: ConfigurationObject,
  patch: ConfigurationObject,
): ConfigurationObject {
  const next: ConfigurationObject = { __proto__: null, ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return { ...next };
}

export function editConfigurationDocument(
  edit: ConfigurationEdit,
  recipe: JsonDocument,
  transform: (
    document: ConfigurationObject,
  ) => ConfigurationObject | Promise<ConfigurationObject>,
): Promise<void> {
  return editConfigurationFile(edit, async (source) => {
    const document = await transform(parseConfigurationObject(source, recipe));
    const indent =
      (recipe.preserveIndent && source?.match(/^([ \t]+)\S/m)?.[1]) || "  ";
    return `${JSON.stringify(document, null, indent)}\n`;
  });
}

/** One native-compatible lock/revision/publication boundary for Pi file editors.
 * A revision binds the exact reviewed text to its resolved native target. */
export async function editConfigurationFile(
  edit: ConfigurationEdit,
  transform: (source: string | undefined) => Promise<string>,
): Promise<void> {
  const authorities = await Promise.all(
    [edit, ...(edit.alsoLock ?? [])].map(async (file) => ({
      ...file,
      target: await resolveAuthority(file),
    })),
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
  let compromised = false;
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
    const source = await readConfigurationText(target);
    if (revisionOf(source, target) !== edit.expectedRevision) throw changed();
    await replacePrivateStateFile(target, await transform(source), {
      beforeReplace: async (candidate) => {
        await edit.validate?.(candidate);
        for (const file of authorities)
          if ((await resolveAuthority(file)) !== file.target) throw changed();
        const current = await readConfigurationText(target);
        if (
          compromised ||
          revisionOf(current, target) !== edit.expectedRevision
        )
          throw changed();
      },
    });
  } finally {
    await Promise.allSettled(
      releases.reverse().map(async (release) => release()),
    );
  }
}
