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

async function fromGit(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 4_000,
  });
  return stdout.split("\0").filter(Boolean);
}

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
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
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
  const paths = fromGit(cwd).catch(() => fromFilesystem(cwd));
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
