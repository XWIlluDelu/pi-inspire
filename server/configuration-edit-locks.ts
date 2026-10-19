import { lstat } from "node:fs/promises";

/** The caller resolved the parent and target before locking. A regular final
 * component has just the target authority: native realpath may canonicalize
 * its case/spelling without introducing another file. Symlinks still need
 * both lexical and target locks; missing files retain their creation authority.
 * Callers must recheck the target and revision before publishing.
 */
export async function configurationEditLockPaths(
  lexical: string,
  target: string,
): Promise<string[]> {
  const details = await lstat(lexical).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return [...new Set(details?.isFile() ? [target] : [lexical, target])].sort();
}
