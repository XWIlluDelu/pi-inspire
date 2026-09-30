import { resolve } from "node:path";
import { SettingsManager } from "./pi-runtime.js";

/** Match Pi CLI storage selection for a worker launched in cwd. Inspire does
 * not pass --session-dir; the inherited environment precedes Pi settings.
 * Use Pi's own path normalization (tilde, file URLs, platform paths), then
 * anchor relative paths to the worker cwd rather than the Host process cwd. */
export function resolvePiSessionDirectory(cwd: string): string | undefined {
  const environment = process.env.PI_CODING_AGENT_SESSION_DIR;
  const directory = environment
    ? SettingsManager.inMemory({ sessionDir: environment }).getSessionDir()
    : SettingsManager.create(cwd).getSessionDir();
  // Pi SessionManager.create treats an empty setting as default storage.
  return directory ? resolve(cwd, directory) : undefined;
}
