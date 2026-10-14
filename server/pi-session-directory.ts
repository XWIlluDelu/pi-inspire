import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir, piInstallation, SettingsManager } from "./pi-runtime.js";

/** Read under the same lock as Pi, but yield while another writer owns it.
 * Do not create settings directories for missing/offline projects. */
async function readSettings(path: string): Promise<string | undefined> {
  try {
    await access(path);
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return undefined;
    throw error;
  }
  let compromised: Error | undefined;
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 9, factor: 1, minTimeout: 20, maxTimeout: 20 },
    onCompromised: (error) => {
      compromised = error;
    },
  });
  try {
    const text = await readFile(path, "utf8");
    if (compromised) throw compromised;
    return text;
  } finally {
    await release();
  }
}

/** Match Pi CLI storage selection for a worker launched in cwd. Inspire does
 * not pass --session-dir; the inherited environment precedes Pi settings.
 * Pi still parses, migrates, merges and normalizes settings; only file reads
 * and lock waits move to asynchronous I/O. Nothing is cached between scans. */
export async function resolvePiSessionDirectory(
  cwd: string,
): Promise<string | undefined> {
  const environment = process.env.PI_CODING_AGENT_SESSION_DIR;
  let settings: ReturnType<typeof SettingsManager.fromStorage>;
  if (environment) {
    settings = SettingsManager.inMemory({ sessionDir: environment });
  } else {
    // Use Pi path normalization for the settings locations as well as the value.
    const normalize = (path: string) =>
      resolve(SettingsManager.inMemory({ sessionDir: path }).getSessionDir()!);
    const [global, project] = await Promise.allSettled([
      readSettings(join(normalize(getAgentDir()), "settings.json")),
      readSettings(
        join(
          normalize(cwd),
          piInstallation.sdk.CONFIG_DIR_NAME,
          "settings.json",
        ),
      ),
    ]);
    settings = SettingsManager.fromStorage({
      withLock(scope, read) {
        const layer = scope === "global" ? global : project;
        // Pi decides how a failed layer affects the effective settings.
        if (layer.status === "rejected") throw layer.reason;
        read(layer.value);
      },
    });
  }
  const directory = settings.getSessionDir();
  // Pi SessionManager.create treats an empty setting as default storage.
  return directory ? resolve(cwd, directory) : undefined;
}
