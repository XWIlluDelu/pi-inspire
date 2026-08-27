import { randomBytes } from "node:crypto";

/** Unpredictable process-local correlation identity with a readable namespace. */
export function runtimeToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}
