import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { resolveUserPath } from "./platform-paths.mjs";
import { requestError } from "./request-error.js";

export { resolveUserPath } from "./platform-paths.mjs";

/** True when a `relative(base, target)` result leaves its base (or was never
 * inside it). Accept both separator spellings because persisted or mocked
 * relative paths can cross platform boundaries. */
export function escapesBase(relativePath: string): boolean {
  return isAbsolute(relativePath) || /^\.\.(?:[\\/]|$)/u.test(relativePath);
}

/** Resolve one user-selected project to its physical directory identity. */
export async function resolveProjectDirectory(cwd: string): Promise<string> {
  const requested = resolveUserPath(cwd, process.cwd());
  let candidate = requested;
  for (;;) {
    let root: string;
    let details;
    try {
      root = await realpath(candidate);
      details = await stat(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR")
        throw requestError("Project path is not a directory", 400);
      if (code !== "ENOENT") throw error;
      // Windows also reports ENOENT for children of a file. Find the
      // existing ancestor before classifying a path as creatable.
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
      continue;
    }
    if (!details.isDirectory())
      throw requestError("Project path is not a directory", 400);
    if (candidate === requested) return root;
    break;
  }
  throw requestError("Project path does not exist", 400, {
    code: "PROJECT_DIRECTORY_MISSING",
  });
}

/** User-authorized creation; never called by directory/model observations. */
export async function createProjectDirectory(cwd: string): Promise<string> {
  const requested = resolveUserPath(cwd, process.cwd());
  try {
    await mkdir(requested, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR")
      throw requestError("Project path is not a directory", 400);
    if (code === "EACCES" || code === "EPERM")
      throw requestError("The host cannot create that directory", 403);
    throw error;
  }
  return resolveProjectDirectory(requested);
}
