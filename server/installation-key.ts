import { createHash } from "node:crypto";

export function installationKey(
  root: string,
  host: string,
  port: number,
): string {
  return createHash("sha256")
    .update(root)
    .update("\0")
    .update(host)
    .update("\0")
    .update(String(port))
    .digest("hex");
}
