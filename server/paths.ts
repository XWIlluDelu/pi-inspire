import { isAbsolute } from "node:path";

/** True when a `relative(base, target)` result leaves its base (or was never
 * inside it). The one authority for path-containment checks. */
export function escapesBase(relativePath: string): boolean {
  return relativePath.startsWith("..") || isAbsolute(relativePath);
}
