import { execFile as execFileCallback } from "node:child_process";
import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { HostDirListing, HostRootsResponse } from "../shared/contracts.js";
import { listNativeHiddenNames } from "./host-hidden-dirs.js";
import { resolveUserPath } from "./paths.js";
import { windowsPowerShellCommand } from "./platform-environment.mjs";

const execFile = promisify(execFileCallback);

async function windowsDriveNames(): Promise<string> {
  const command = windowsPowerShellCommand();
  const { stdout } = await execFile(
    command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Microsoft.PowerShell.Utility\\ConvertTo-Json -InputObject @([Environment]::GetLogicalDrives()) -Compress",
    ],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 4_096, windowsHide: true },
  );
  return stdout;
}

/** Enumerate assigned drive names without probing their availability. A mapped
 * drive can block filesystem I/O; only explicit navigation should touch it. */
export async function listHostRoots(
  hostPlatform: NodeJS.Platform = process.platform,
  enumerate: () => Promise<string> = windowsDriveNames,
): Promise<HostRootsResponse> {
  if (hostPlatform !== "win32") return { roots: [{ name: "/", path: "/" }] };
  const paths: unknown = JSON.parse(
    (await enumerate()).replace(/^\uFEFF/u, "").trim(),
  );
  if (
    !Array.isArray(paths) ||
    paths.length > 26 ||
    paths.some((path) => typeof path !== "string" || !/^[A-Z]:\\$/iu.test(path))
  )
    throw new Error("The Host could not enumerate Windows drive names");
  return {
    roots: [...new Set((paths as string[]).map((path) => path.toUpperCase()))]
      .sort()
      .map((path) => ({ name: path.slice(0, 2), path })),
  };
}

/** List the immediate subdirectories of one host directory for the
 * session-start picker. The host filesystem is the authority — the bearer
 * token already grants session creation at any path, so browsing reveals
 * nothing that power did not. The route schema guarantees an absolute path;
 * none means the host user's home. Dot names and native hidden attributes
 * are filtered unless explicitly requested; unreadable links are skipped;
 * symlinks count when they resolve to directories. */
export async function listHostDirectories(
  requested?: string,
  showHidden = false,
): Promise<HostDirListing> {
  const path = await realpath(
    requested === undefined
      ? homedir()
      : resolveUserPath(requested, process.cwd()),
  );
  const hidden = showHidden
    ? new Set<string>()
    : await listNativeHiddenNames(path);
  const dirs: HostDirListing["dirs"] = [];
  for await (const entry of await opendir(path)) {
    // Native-hidden links/junctions must not resolve offline targets before
    // being filtered. Attribute enumeration inspects the directory entries.
    if (!showHidden && (entry.name.startsWith(".") || hidden.has(entry.name)))
      continue;
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
  return {
    path,
    parent: parent === path ? null : parent,
    dirs,
  };
}
