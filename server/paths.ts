import { isAbsolute } from "node:path";

/** True when a `relative(base, target)` result leaves its base (or was never
 * inside it). Accept both separator spellings because persisted or mocked
 * relative paths can cross platform boundaries. */
export function escapesBase(relativePath: string): boolean {
  return isAbsolute(relativePath) || /^\.\.(?:[\\/]|$)/u.test(relativePath);
}
