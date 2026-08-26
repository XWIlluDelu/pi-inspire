import { opendir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { ProjectDirEntry } from "../shared/contracts.js";
import { GIT_CONFIG_ARGS, GitInspectionError, spawnGit } from "./git-runner.js";
import { escapesBase } from "./paths.js";

const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".cache",
  ".pi-subagents",
]);
const CACHE_MS = 5_000;
const MAX_PROJECT_INDEX_FILES = 20_000;
const MAX_PROJECT_INDEX_DIRECTORIES = 10_000;
const PROJECT_INDEX_WALK_MS = 5_000;
const MAX_PROJECT_INDEX_CACHE_ENTRIES = 8;

interface ProjectIndexCache {
  expiresAt: number;
  paths: Promise<string[]>;
}

const cache = new Map<string, ProjectIndexCache>();
const cacheAliases = new Map<string, string>();

interface ProjectFileResult {
  path: string;
  name: string;
}

function validRelativePath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !escapesBase(path);
}

async function gitPaths(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await spawnGit([...GIT_CONFIG_ARGS, "-C", cwd, ...args], {
    stdoutLimit: 4 * 1024 * 1024,
  });
  // Git -z emits raw pathname bytes. Node strings cannot represent arbitrary
  // POSIX byte names without replacement collisions, so reject such an index
  // instead of granting two byte-distinct files one browser identity.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: string[] = [];
  let start = 0;
  try {
    for (let index = 0; index <= stdout.length; index += 1) {
      if (index < stdout.length && stdout[index] !== 0) continue;
      if (index > start) {
        const path = decoder.decode(stdout.subarray(start, index));
        if (validRelativePath(path)) paths.push(path);
      }
      start = index + 1;
    }
  } catch {
    throw new Error("Git reported a project path that is not valid UTF-8");
  }
  return paths;
}

async function fromGit(cwd: string): Promise<string[]> {
  const [listed, deleted] = await Promise.all([
    gitPaths(cwd, ["ls-files", "-co", "--exclude-standard", "-z"]),
    // A tracked file stays listed after its worktree copy is removed. Without
    // subtracting those, the explorer and search keep offering paths whose
    // preview can only 404.
    gitPaths(cwd, ["ls-files", "-d", "-z"]),
  ]);
  if (deleted.length === 0) return listed;
  const gone = new Set(deleted);
  return listed.filter((path) => !gone.has(path));
}

/** Whether a directory is definitely outside any git work tree (or the host
 * has no git at all). Only then may the filesystem walker run: an
 * operational git failure — timeout, output over the buffer cap — must fail
 * closed instead of widening what the explorer and preview authority see. */
async function isNonGitDirectory(cwd: string): Promise<boolean> {
  try {
    const result = await spawnGit(
      [...GIT_CONFIG_ARGS, "-C", cwd, "rev-parse", "--is-inside-work-tree"],
      { stdoutLimit: 64 * 1024, acceptedExitCodes: [0, 128] },
    );
    if (result.code === 0)
      return result.stdout.toString("utf8").trim() !== "true";
    return /not a git repository|cannot change to|no such file or directory/i.test(
      result.stderr.toString("utf8"),
    );
  } catch (error) {
    if (
      error instanceof GitInspectionError &&
      error.message === "Git is not available on this host"
    )
      return true;
    return false;
  }
}

/** Non-git walker. Without .gitignore semantics available, hidden entries
 * stay out wholesale — they are where credentials live (.env, .ssh, …). */
async function fromFilesystem(cwd: string): Promise<string[]> {
  const values: string[] = [];
  const pending = [cwd];
  const deadline = Date.now() + PROJECT_INDEX_WALK_MS;
  let directories = 0;
  while (
    pending.length > 0 &&
    values.length < MAX_PROJECT_INDEX_FILES &&
    directories < MAX_PROJECT_INDEX_DIRECTORIES &&
    Date.now() < deadline
  ) {
    const directory = pending.pop()!;
    directories += 1;
    let entries;
    try {
      entries = await opendir(directory);
    } catch {
      continue;
    }
    for await (const entry of entries) {
      if (Date.now() >= deadline) break;
      if (
        entry.isSymbolicLink() ||
        ignored.has(entry.name) ||
        entry.name.startsWith(".")
      )
        continue;
      const absolute = join(directory, entry.name);
      if (
        entry.isDirectory() &&
        directories + pending.length < MAX_PROJECT_INDEX_DIRECTORIES
      )
        pending.push(absolute);
      else if (entry.isFile()) values.push(relative(cwd, absolute));
      if (values.length >= MAX_PROJECT_INDEX_FILES) break;
    }
  }
  return values.sort((left, right) => left.localeCompare(right));
}

function removeCacheEntry(root: string): void {
  cache.delete(root);
  for (const [alias, target] of cacheAliases) {
    if (target === root) cacheAliases.delete(alias);
  }
}

async function projectPaths(cwd: string): Promise<string[]> {
  const alias = resolve(cwd);
  let root: string;
  try {
    root = await realpath(alias);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    root = alias;
  }
  cacheAliases.set(alias, root);
  cacheAliases.set(root, root);
  const existing = cache.get(root);
  if (existing && existing.expiresAt > Date.now()) {
    // Map insertion order is the LRU order.
    cache.delete(root);
    cache.set(root, existing);
    return existing.paths;
  }
  if (existing) removeCacheEntry(root);

  const paths = fromGit(root)
    .then((values) => values.slice(0, MAX_PROJECT_INDEX_FILES))
    .catch(async (error) => {
      if (await isNonGitDirectory(root)) return fromFilesystem(root);
      throw error;
    });
  // Keep one in-flight build shareable, then start the freshness window only
  // when its result is usable. A slow scan must not expire while it runs.
  const entry = { expiresAt: Number.POSITIVE_INFINITY, paths };
  cache.set(root, entry);
  void paths.then(
    () => {
      if (cache.get(root) === entry) entry.expiresAt = Date.now() + CACHE_MS;
    },
    () => {
      if (cache.get(root) === entry) removeCacheEntry(root);
    },
  );
  while (cache.size > MAX_PROJECT_INDEX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    removeCacheEntry(oldest);
  }
  return paths;
}

export async function searchProjectFiles(
  cwd: string,
  query = "",
  limit = 50,
): Promise<ProjectFileResult[]> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (await projectPaths(cwd))
    .filter((path) => words.every((word) => path.toLowerCase().includes(word)))
    .slice(0, Math.min(100, Math.max(1, limit)))
    .map((path) => ({ path, name: basename(path) }));
}

/** One directory level derived from a flat cwd-relative path list: no
 * filesystem resolution happens against the requested dir, so the explorer
 * can only ever surface what the project index already contains. */
export function directoryEntries(
  paths: string[],
  dir: string,
): ProjectDirEntry[] {
  const prefix = dir ? `${dir.replace(/\/+$/, "")}/` : "";
  const seen = new Map<string, ProjectDirEntry["type"]>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) seen.set(rest, "file");
    else if (!seen.has(rest.slice(0, slash)))
      seen.set(rest.slice(0, slash), "dir");
  }
  return [...seen.entries()]
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "dir"
          ? -1
          : 1,
    );
}

export async function listProjectDirectory(
  cwd: string,
  dir = "",
): Promise<ProjectDirEntry[]> {
  return directoryEntries(await projectPaths(cwd), dir);
}

/** Whether an absolute path names a file the project index contains. The
 * index — not mere cwd containment — is the authority, so ignored trees
 * (node_modules, .git, …) stay out of reach. */
export async function isIndexedProjectFile(
  cwd: string,
  absolutePath: string,
): Promise<boolean> {
  const relativePath = relative(cwd, absolutePath);
  if (!relativePath || escapesBase(relativePath)) return false;
  return (await projectPaths(cwd)).includes(relativePath);
}

/** Indexed files whose basename matches, as cwd-relative paths. This is the
 * only recovery route for a bare textual reference, so it stays inside the
 * project index and never searches the filesystem. */
export async function indexedBasenameMatches(
  cwd: string,
  name: string,
  limit = 12,
): Promise<string[]> {
  const matches: string[] = [];
  for (const path of await projectPaths(cwd)) {
    if (basename(path) !== name) continue;
    matches.push(path);
    if (matches.length >= limit) break;
  }
  return matches;
}

/** Drop a cached index that has proved stale — a path it offered no longer
 * exists — so the next request rescans instead of serving the same missing
 * file for the rest of the cache window. */
export function invalidateProjectIndex(cwd: string): void {
  const alias = resolve(cwd);
  removeCacheEntry(cacheAliases.get(alias) ?? alias);
}
