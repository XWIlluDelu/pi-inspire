import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HostDirListing } from "../shared/contracts.js";

/** List the immediate subdirectories of one host directory for the
 * session-start picker. The host filesystem is the authority — the bearer
 * token already grants session creation at any path, so browsing reveals
 * nothing that power did not. The route schema guarantees an absolute path;
 * none means the host user's home. Dotted names stay hidden; entries that
 * cannot be inspected are skipped; symlinks count when they resolve to
 * directories. */
export async function listHostDirectories(requested?: string): Promise<HostDirListing> {
  const path = await realpath(requested ?? homedir());
  const dirs: HostDirListing["dirs"] = [];
  for await (const entry of await opendir(path)) {
    if (entry.name.startsWith(".")) continue;
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: absolute });
    } else if (entry.isSymbolicLink()) {
      try {
        if ((await stat(absolute)).isDirectory()) dirs.push({ name: entry.name, path: absolute });
      } catch {
        // broken or unreadable link — not a browsable directory
      }
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, dirs };
}
