import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/** True when a `relative(base, target)` result leaves its base (or was never
 * inside it). Accept both separator spellings because persisted or mocked
 * relative paths can cross platform boundaries. */
export function escapesBase(relativePath: string): boolean {
  return isAbsolute(relativePath) || /^\.\.(?:[\\/]|$)/u.test(relativePath);
}

/** Resolve one user-selected project to its physical directory identity. */
export async function resolveProjectDirectory(cwd: string): Promise<string> {
  let root: string;
  let details;
  try {
    root = await realpath(resolve(cwd));
    details = await stat(root);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ["ENOENT", "ENOTDIR"].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    ) {
      throw Object.assign(new Error("Project path does not exist"), {
        status: 400,
      });
    }
    throw error;
  }
  if (!details.isDirectory()) {
    throw Object.assign(new Error("Project path is not a directory"), {
      status: 400,
    });
  }
  return root;
}
