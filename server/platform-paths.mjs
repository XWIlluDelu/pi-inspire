import { homedir, tmpdir, userInfo } from "node:os";
import { posix, win32 } from "node:path";

function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}

function environmentValue(environment, key) {
  const value = environment[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Platform-native per-user configuration directory for INSΠRE. */
export function inspireConfigDirectory(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const { join } = pathApi(platform);
  if (platform === "win32") {
    const base =
      environmentValue(environment, "APPDATA") ??
      environmentValue(environment, "LOCALAPPDATA") ??
      join(home, "AppData", "Roaming");
    return join(base, "Inspire");
  }
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "Inspire");
  return join(
    environmentValue(environment, "XDG_CONFIG_HOME") ?? join(home, ".config"),
    "inspire",
  );
}

/** Platform-native per-user cache directory for transient INSΠRE data. */
export function inspireCacheDirectory(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const { join } = pathApi(platform);
  if (platform === "win32") {
    const base =
      environmentValue(environment, "LOCALAPPDATA") ??
      environmentValue(environment, "APPDATA") ??
      join(home, "AppData", "Local");
    return join(base, "Inspire", "Cache");
  }
  if (platform === "darwin") return join(home, "Library", "Caches", "Inspire");
  return join(
    environmentValue(environment, "XDG_CACHE_HOME") ?? join(home, ".cache"),
    "inspire",
  );
}

/** Platform-native durable per-user state directory for INSΠRE. */
export function inspireStateDirectory(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const { join } = pathApi(platform);
  if (platform === "win32") {
    const base =
      environmentValue(environment, "LOCALAPPDATA") ??
      environmentValue(environment, "APPDATA") ??
      join(home, "AppData", "Local");
    return join(base, "Inspire");
  }
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "Inspire");
  return join(
    environmentValue(environment, "XDG_STATE_HOME") ??
      join(home, ".local", "state"),
    "inspire",
  );
}

/** Ephemeral per-user runtime directory used for instance state and locks. */
export function inspireRuntimeDirectory(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const temporary = options.temporary ?? tmpdir();
  const { join } = pathApi(platform);
  if (platform === "win32") {
    const base = environmentValue(environment, "LOCALAPPDATA") ?? temporary;
    return join(base, "Inspire", "runtime");
  }
  const xdgRuntime = environmentValue(environment, "XDG_RUNTIME_DIR");
  if (xdgRuntime) return join(xdgRuntime, "inspire");
  let identity = "user";
  try {
    identity =
      typeof process.getuid === "function"
        ? String(process.getuid())
        : userInfo().username.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");
  } catch {
    // A stable generic suffix is still private once the directory is mode 0700.
  }
  return join(temporary, `inspire-${identity}`, "inspire");
}

export function supportsPosixPermissions(platform = process.platform) {
  return platform !== "win32";
}
