import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JsonlObjectDecoder } from "./session-jsonl.js";

/** Messages can contain a literal path or Inspire's JSON-string reference. */
export function containsAttachmentPath(text: string, path: string): boolean {
  return text.includes(path) || text.includes(JSON.stringify(path));
}

function containsPath(
  value: unknown,
  paths: ReadonlySet<string>,
  found: Set<string>,
): void {
  if (typeof value === "string") {
    for (const path of paths)
      if (containsAttachmentPath(value, path)) found.add(path);
  } else if (Array.isArray(value)) {
    for (const item of value) containsPath(item, paths, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) containsPath(item, paths, found);
  }
}

interface CachedSessionReferences {
  version: string;
  ownedKey: string;
  references: Set<string>;
}

export type AttachmentReferenceCache = Map<string, CachedSessionReferences>;

async function scanSession(
  path: string,
  ownedPaths: ReadonlySet<string>,
  found: Set<string>,
  trash: boolean,
  cache: AttachmentReferenceCache,
  ownedKey: string,
): Promise<boolean> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new Error(
        `Attachment reference source is not a regular file: ${path}`,
      );
    const version = [
      before.dev,
      before.ino,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
    ].join(":");
    const requireUnchanged = async () => {
      const [after, linked] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(path, { bigint: true }),
      ]);
      if (
        [after, linked].some(
          (value) =>
            [
              value.dev,
              value.ino,
              value.size,
              value.mtimeNs,
              value.ctimeNs,
            ].join(":") !== version,
        )
      )
        throw new Error(
          `Pi session changed during attachment reclamation: ${path}`,
        );
    };
    const cached = cache.get(path);
    if (cached?.version === version && cached.ownedKey === ownedKey) {
      await requireUnchanged();
      for (const reference of cached.references) found.add(reference);
      return true;
    }
    const first = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(first, 0, first.length, 0);
    const lf = first.subarray(0, bytesRead).indexOf(0x0a);
    let header: Record<string, unknown> | null = null;
    let parsed = false;
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          first.subarray(0, lf < 0 ? bytesRead : lf),
        ),
      );
      parsed = true;
      if (value && typeof value === "object" && !Array.isArray(value))
        header = value as Record<string, unknown>;
    } catch {
      /* Unidentified or incomplete payload; the source name still matters. */
    }
    // Trash contains arbitrary applications' JSONL files. A valid non-Pi
    // record is not a corrupt session merely because its name ends in .jsonl.
    // A Pi entry envelope without its session header remains incomplete.
    const piRecord =
      header?.type === "session" ||
      (typeof header?.type === "string" &&
        typeof header.id === "string" &&
        ("parentId" in header || typeof header.timestamp === "string"));
    if (header?.type !== "session" || typeof header.id !== "string") {
      if (
        trash &&
        ((parsed && !piRecord) || (!parsed && !/\.jsonl(?:\.|$)/u.test(path)))
      ) {
        await requireUnchanged();
        return false;
      }
      throw new Error(
        `Incomplete or invalid Pi session prevents attachment reclamation: ${path}`,
      );
    }
    const decoder = new JsonlObjectDecoder(() => undefined);
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
      for (const entry of decoder.push(buffer.subarray(0, read.bytesRead)))
        containsPath(entry, ownedPaths, found);
    }
    if (decoder.tail().length)
      throw new Error(
        `Incomplete Pi session prevents attachment reclamation: ${path}`,
      );
    await requireUnchanged();
    cache.set(path, { version, ownedKey, references: new Set(found) });
    return true;
  } finally {
    await handle.close();
  }
}

/** Read every retained branch, not just catalog previews/current leaves. An
 * incomplete source set or concurrent write yields no negative-reference proof. */
export async function sessionAttachmentReferences(
  ownedPaths: ReadonlySet<string>,
  sessionDirectories: readonly string[],
  trashDirectories: readonly string[],
  cache: AttachmentReferenceCache,
): Promise<{ paths: Set<string>; sessions: Map<string, Set<string>> }> {
  const ownedKey = createHash("sha256")
    .update([...ownedPaths].sort().join("\0"))
    .digest("hex");
  const sources = new Set<string>();
  const found = new Set<string>();
  const sessions = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const directoryVersions = new Map<string, string | null>();
  const directoryVersion = async (path: string): Promise<string | null> => {
    try {
      const value = await stat(path, { bigint: true });
      return [value.dev, value.ino, value.mtimeNs, value.ctimeNs].join(":");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const walk = async (directory: string, trash: boolean): Promise<void> => {
    const path = resolve(directory);
    let entries;
    directoryVersions.set(path, await directoryVersion(path));
    try {
      const physical = await realpath(path);
      if (visited.has(physical)) return;
      visited.add(physical);
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name.endsWith(".jsonl"))
          throw new Error(
            `Symlinked Pi session prevents attachment reclamation: ${candidate}`,
          );
        const linked = await stat(candidate).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (linked?.isDirectory()) await walk(candidate, trash);
      } else if (entry.isDirectory())
        await walk(
          candidate,
          trash || entry.name.startsWith(".inspire-delete-"),
        );
      else if (
        entry.isFile() &&
        !entry.name.startsWith("$I") &&
        (trash || entry.name.endsWith(".jsonl"))
      ) {
        const references = new Set<string>();
        sources.add(candidate);
        const session = await scanSession(
          candidate,
          ownedPaths,
          references,
          trash,
          cache,
          ownedKey,
        );
        if (!session) continue;
        sessions.set(candidate, references);
        for (const reference of references) found.add(reference);
      }
    }
  };
  for (const directory of sessionDirectories) await walk(directory, false);
  for (const directory of trashDirectories) await walk(directory, true);
  // A restoration can move a payload from Trash into an already-scanned Pi
  // directory. Detect membership changes across the entire sweep, not only
  // writes to an individual JSONL file.
  for (const [directory, version] of directoryVersions) {
    if ((await directoryVersion(directory)) !== version)
      throw new Error(
        `Pi/Trash directory changed during attachment reclamation: ${directory}`,
      );
  }
  for (const path of cache.keys()) if (!sources.has(path)) cache.delete(path);
  return { paths: found, sessions };
}
