import type { Stats } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HostDirListing, HostRootsResponse } from "../shared/contracts.js";

const WINDOWS_DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
type RootInspector = (path: string) => Promise<Pick<Stats, "isDirectory">>;

/** Discover the host's navigable filesystem roots. Windows has no parent
 * directory above a drive root, so drive enumeration is the only path from
 * `C:\\` to `D:\\` inside a hierarchical picker. */
export async function listHostRoots(
  hostPlatform: NodeJS.Platform = process.platform,
  inspect: RootInspector = stat,
): Promise<HostRootsResponse> {
  if (hostPlatform !== "win32") return { roots: [{ name: "/", path: "/" }] };

  const roots = await Promise.all(
    [...WINDOWS_DRIVE_LETTERS].map(async (letter) => {
      const path = `${letter}:\\`;
      try {
        return (await inspect(path)).isDirectory()
          ? { name: `${letter}:`, path }
          : null;
      } catch {
        // An absent, empty, or unreadable drive is not a navigable location.
        return null;
      }
    }),
  );
  return {
    roots: roots.filter(
      (root): root is NonNullable<typeof root> => root !== null,
    ),
  };
}

/** List the immediate subdirectories of one host directory for the
 * session-start picker. The host filesystem is the authority — the bearer
 * token already grants session creation at any path, so browsing reveals
 * nothing that power did not. The route schema guarantees an absolute path;
 * none means the host user's home. Dotted names stay hidden; entries that
 * cannot be inspected are skipped; symlinks count when they resolve to
 * directories. */
export async function listHostDirectories(
  requested?: string,
): Promise<HostDirListing> {
  const path = await realpath(requested ?? homedir());
  const dirs: HostDirListing["dirs"] = [];
  for await (const entry of await opendir(path)) {
    if (entry.name.startsWith(".")) continue;
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: absolute });
    } else if (entry.isSymbolicLink()) {
      try {
        if ((await stat(absolute)).isDirectory())
          dirs.push({ name: entry.name, path: absolute });
      } catch {
        // broken or unreadable link — not a browsable directory
      }
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, dirs };
}
