import { fileURLToPath } from "node:url";

/** OSC 7 is advisory shell metadata, not resource authorization. POSIX shells
 * commonly include the local hostname. A Windows UNC authority must survive,
 * while a /C:/ path unambiguously identifies a local drive. */
export function terminalDirectoryFromUrl(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const url = new URL(value);
  if (url.protocol !== "file:") throw new Error("Not a file directory URL");
  const windows = platform === "win32";
  if (!windows || /^\/[a-z]:\//iu.test(url.pathname)) url.hostname = "";
  return fileURLToPath(url, { windows });
}
