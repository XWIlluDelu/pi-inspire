import { opendir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectDirEntry } from "../shared/contracts.js";
import { listNativeHiddenNames } from "./host-hidden-dirs.js";
import { escapesBase } from "./paths.js";
import { requestError } from "./request-error.js";
import { TextDecoder } from "node:util";

const pathDecoder = new TextDecoder("utf-8", { fatal: true });

const CACHE_MS = 5_000;
const MAX_SEARCH_FILES = 20_000;
const MAX_SEARCH_DIRECTORIES = 10_000;
// Allow native Windows/macOS hidden-attribute lookups in small workspaces;
// this is a cooperative scan budget, not a deadline on a filesystem read.
const SEARCH_WALK_MS = 5_000;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_CACHE_ENTRIES = 8;

interface FileMatch {
  path: string;
  name: string;
}
interface FileScan {
  paths: string[];
  truncated: boolean;
}
interface SearchCache {
  expiresAt: number;
  scan: Promise<FileScan>;
}
const cache = new Map<string, SearchCache>();

/** Discovery only. Neither hidden visibility nor inclusion in these bounded
 * results grants or revokes access to a file. Git is never invoked here. */
export async function listProjectDirectory(
  cwd: string,
  dir = "",
  showHidden = false,
): Promise<{ entries: ProjectDirEntry[]; truncated: boolean }> {
  if (isAbsolute(dir) || escapesBase(dir) || dir.split("/").includes(".."))
    throw requestError("Directory must stay inside the project", 400);
  const root = await realpath(cwd);
  const requested = resolve(root, dir);
  if (escapesBase(relative(root, requested)))
    throw requestError("Directory must stay inside the project", 400);
  const path = await realpath(requested);
  if (escapesBase(relative(root, path)))
    throw requestError("Directory is outside the project", 403);
  const before = await stat(path, { bigint: true });
  if (!before.isDirectory()) throw requestError("Not a directory", 400);
  const hidden = showHidden
    ? new Set<string>()
    : await listNativeHiddenNames(path);
  const entries: ProjectDirEntry[] = [];
  let inspected = 0;
  let truncated = false;
  // Latin-1 preserves raw filename bytes bijectively; fatal UTF-8 decoding
  // avoids replacement-character collisions between distinct POSIX names.
  for await (const entry of await opendir(path, { encoding: "latin1" })) {
    if (++inspected > MAX_DIRECTORY_ENTRIES) {
      truncated = true;
      break;
    }
    let name: string;
    try {
      name = pathDecoder.decode(Buffer.from(entry.name, "latin1"));
    } catch {
      truncated = true;
      continue;
    }
    if (!showHidden && (name.startsWith(".") || hidden.has(name))) continue;
    if (entry.isDirectory()) entries.push({ name, type: "dir" });
    else if (entry.isFile()) entries.push({ name, type: "file" });
    else if (entry.isSymbolicLink()) {
      // Links are real filesystem entries, but never expose an outside target.
      const target = await realpath(join(path, name)).catch(() => null);
      if (!target || escapesBase(relative(root, target))) continue;
      const details = await stat(target).catch(() => null);
      if (details?.isDirectory() || details?.isFile())
        entries.push({
          name,
          type: details.isDirectory() ? "dir" : "file",
        });
    }
  }
  const [afterPath, after, currentRoot] = await Promise.all([
    realpath(requested),
    stat(path, { bigint: true }),
    realpath(cwd),
  ]);
  if (
    currentRoot !== root ||
    afterPath !== path ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  )
    throw requestError("The directory changed while it was being read", 409);
  entries.sort((a, b) =>
    a.type === b.type
      ? a.name.localeCompare(b.name)
      : a.type === "dir"
        ? -1
        : 1,
  );
  return { entries, truncated };
}

async function scanFilesystem(
  root: string,
  showHidden: boolean,
): Promise<FileScan> {
  const paths: string[] = [];
  const pending = [""];
  const visited = new Set<string>();
  const deadline = Date.now() + SEARCH_WALK_MS;
  let truncated = false;
  for (let index = 0; index < pending.length; index++) {
    if (
      Date.now() >= deadline ||
      visited.size >= MAX_SEARCH_DIRECTORIES ||
      paths.length >= MAX_SEARCH_FILES
    ) {
      truncated = true;
      break;
    }
    const dir = pending[index]!;
    try {
      const canonical = await realpath(resolve(root, dir));
      if (escapesBase(relative(root, canonical))) {
        truncated = true;
        continue;
      }
      if (visited.has(canonical)) continue; // Directory symlink cycles/aliases.
      visited.add(canonical);
      const level = await listProjectDirectory(root, dir, showHidden);
      truncated ||= level.truncated;
      for (const entry of level.entries) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.type === "dir") {
          if (pending.length < MAX_SEARCH_DIRECTORIES) pending.push(path);
          else truncated = true;
        } else if (paths.length < MAX_SEARCH_FILES) paths.push(path);
        else truncated = true;
      }
    } catch (error) {
      if (dir === "") throw error;
      // An unreadable/racing subtree is not evidence of a complete search.
      truncated = true;
    }
  }
  return { paths, truncated };
}

async function projectPaths(
  cwd: string,
  showHidden: boolean,
): Promise<FileScan> {
  const root = await realpath(cwd);
  const key = JSON.stringify([root, showHidden]);
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, existing);
    return existing.scan;
  }
  const entry: SearchCache = {
    expiresAt: Number.POSITIVE_INFINITY,
    scan: scanFilesystem(root, showHidden),
  };
  cache.set(key, entry);
  void entry.scan.then(
    () => {
      if (cache.get(key) === entry) entry.expiresAt = Date.now() + CACHE_MS;
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  while (cache.size > MAX_CACHE_ENTRIES)
    cache.delete(cache.keys().next().value!);
  return entry.scan;
}

export async function searchProjectFiles(
  cwd: string,
  query = "",
  limit = 50,
  showHidden = false,
): Promise<{ files: FileMatch[]; truncated: boolean }> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scan = await projectPaths(cwd, showHidden);
  const matches = scan.paths.filter((path) =>
    words.every((word) => path.toLowerCase().includes(word)),
  );
  const count = Math.min(100, Math.max(1, limit));
  return {
    files: matches
      .slice(0, count)
      .map((path) => ({ path, name: basename(path) })),
    truncated: scan.truncated || matches.length > count,
  };
}

/** Bare-name recovery is bounded discovery, not authority. An incomplete scan
 * can never prove that a name is unique. Hidden files remain eligible here:
 * an explicit textual reference is not controlled by a browser visibility toggle. */
export async function workspaceBasenameMatches(
  cwd: string,
  name: string,
): Promise<{ matches: string[]; truncated: boolean }> {
  const scan = await projectPaths(cwd, true);
  const matches = scan.paths.filter((path) => basename(path) === name);
  return {
    matches: matches.slice(0, 12),
    truncated: scan.truncated || matches.length > 12,
  };
}

/** Invalidate bounded discovery, never access authority. Small global eviction
 * also covers cwd aliases without retaining another path-identity registry. */
export function invalidateProjectFiles(_cwd: string): void {
  cache.clear();
}
