import { stat } from "node:fs/promises";
import { dirname, parse, resolve, sep } from "node:path";

/** Candidate matching only. Unicode/case similarity is never authority. */
function aliasCandidate(component: string): string {
  return component.normalize("NFD").toUpperCase().normalize("NFD");
}

/** A native relative path, or null when the target is outside/unknown.
 * Callers still resolve symlinks and pin/revalidate files at their existing
 * authorization boundaries. This also supports lexical checks before touching
 * a target: only the candidate's base-level directory is inspected.
 */
export async function filesystemRelativePath(
  base: string,
  target: string,
): Promise<string | null> {
  const root = resolve(base);
  const path = resolve(target);
  if (path === root) return "";
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (path.startsWith(prefix)) return path.slice(prefix.length);

  // Root authorities are not directory aliases: never probe another drive,
  // UNC server/share, or POSIX root to establish project membership.
  const rootAuthority = parse(root).root;
  const pathAuthority = parse(path).root;
  if (rootAuthority.toLowerCase() !== pathAuthority.toLowerCase()) return null;
  const baseParts = root.slice(rootAuthority.length).split(sep).filter(Boolean);
  const pathParts = path.slice(pathAuthority.length).split(sep).filter(Boolean);
  if (
    pathParts.length < baseParts.length ||
    baseParts.some(
      (part, index) =>
        aliasCandidate(part) !== aliasCandidate(pathParts[index]!),
    )
  )
    return null;

  // Both POSIX and Windows volumes can alias spelling/normalization. Prove
  // that the candidate's base-level ancestor is this actual directory. The
  // ancestor calculation is string-only, not a filesystem walk per file.
  let ancestor = path;
  const suffix = pathParts.slice(baseParts.length);
  for (const _component of suffix) ancestor = dirname(ancestor);
  try {
    const [expected, actual] = await Promise.all([
      stat(root, { bigint: true }),
      stat(ancestor, { bigint: true }),
    ]);
    if (
      expected.isDirectory() &&
      actual.isDirectory() &&
      expected.ino !== 0n &&
      expected.ino === actual.ino &&
      expected.dev === actual.dev
    )
      return suffix.join(sep);
  } catch {
    // Unavailable or unidentified directory aliases grant no file authority.
  }
  return null;
}
