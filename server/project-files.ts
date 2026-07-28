import { execFile } from "node:child_process";
import { opendir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import type { ProjectDirEntry } from "../shared/contracts.js";
import { escapesBase } from "./paths.js";

const execFileAsync = promisify(execFile);
const ignored = new Set([".git", "node_modules", "dist", "coverage", ".cache", ".pi-subagents"]);
const CACHE_MS = 5_000;
let cache: { cwd: string; expiresAt: number; paths: Promise<string[]> } | null = null;

export interface ProjectFileResult {
  path: string;
  name: string;
}

async function gitPaths(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 4_000,
  });
  return stdout.split("\0").filter(Boolean);
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
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 4_000,
    });
    return stdout.trim() !== "true";
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: unknown };
    if (failure.code === "ENOENT") return true; // no git binary on this host
    // "Not a repository" and "directory does not exist" are definite
    // negatives; a missing directory has nothing to leak either way.
    return (
      typeof failure.stderr === "string" &&
      /not a git repository|cannot change to|no such file or directory/i.test(failure.stderr)
    );
  }
}

/** Non-git walker. Without .gitignore semantics available, hidden entries
 * stay out wholesale — they are where credentials live (.env, .ssh, …). */
async function fromFilesystem(cwd: string, cap = 10_000): Promise<string[]> {
  const values: string[] = [];
  const pending = [cwd];
  while (pending.length > 0 && values.length < cap) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await opendir(directory);
    } catch {
      continue;
    }
    for await (const entry of entries) {
      if (entry.isSymbolicLink() || ignored.has(entry.name) || entry.name.startsWith(".")) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) values.push(relative(cwd, absolute));
      if (values.length >= cap) break;
    }
  }
  return values;
}

function projectPaths(cwd: string): Promise<string[]> {
  if (cache?.cwd === cwd && cache.expiresAt > Date.now()) return cache.paths;
  const paths = fromGit(cwd).catch(async (error) => {
    if (await isNonGitDirectory(cwd)) return fromFilesystem(cwd);
    throw error;
  });
  // A failure is not an index: evict it so the next request retries instead
  // of serving the cached rejection for the whole cache window.
  paths.catch(() => {
    if (cache?.paths === paths) cache = null;
  });
  cache = { cwd, expiresAt: Date.now() + CACHE_MS, paths };
  return paths;
}

export async function searchProjectFiles(cwd: string, query = "", limit = 50): Promise<ProjectFileResult[]> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (await projectPaths(cwd))
    .filter((path) => words.every((word) => path.toLocaleLowerCase().includes(word)))
    .slice(0, Math.min(100, Math.max(1, limit)))
    .map((path) => ({ path, name: basename(path) }));
}

/** One directory level derived from a flat cwd-relative path list: no
 * filesystem resolution happens against the requested dir, so the explorer
 * can only ever surface what the project index already contains. */
export function directoryEntries(paths: string[], dir: string): ProjectDirEntry[] {
  const prefix = dir ? `${dir.replace(/\/+$/, "")}/` : "";
  const seen = new Map<string, ProjectDirEntry["type"]>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) seen.set(rest, "file");
    else if (!seen.has(rest.slice(0, slash))) seen.set(rest.slice(0, slash), "dir");
  }
  return [...seen.entries()]
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

export async function listProjectDirectory(cwd: string, dir = ""): Promise<ProjectDirEntry[]> {
  return directoryEntries(await projectPaths(cwd), dir);
}

/** Whether an absolute path names a file the project index contains. The
 * index — not mere cwd containment — is the authority, so ignored trees
 * (node_modules, .git, …) stay out of reach. */
export async function isIndexedProjectFile(cwd: string, absolutePath: string): Promise<boolean> {
  const relativePath = relative(cwd, absolutePath);
  if (!relativePath || escapesBase(relativePath)) return false;
  return (await projectPaths(cwd)).includes(relativePath);
}

/** Indexed files whose basename matches, as cwd-relative paths. This is the
 * only recovery route for a bare textual reference, so it stays inside the
 * project index and never searches the filesystem. */
export async function indexedBasenameMatches(cwd: string, name: string, limit = 12): Promise<string[]> {
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
  if (cache?.cwd === cwd) cache = null;
}
