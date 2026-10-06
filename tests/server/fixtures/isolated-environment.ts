import { dirname, posix, win32 } from "node:path";

const windowsRuntimeKeys = new Set([
  "systemroot",
  "programfiles",
  "programfiles(x86)",
]);

/** Overrides for launchers that merge process.env; never inherit credentials or user state. */
export function isolatedTestEnvironment(
  root: string,
  overrides: NodeJS.ProcessEnv = {},
  {
    source = process.env,
    platform = process.platform,
  }: { source?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const normalize = (key: string) => (windows ? key.toLowerCase() : key);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    environment[key] =
      windows && windowsRuntimeKeys.has(normalize(key)) ? value : undefined;
  }
  const systemRoot = Object.entries(source).find(
    ([key]) => normalize(key) === "systemroot",
  )?.[1];
  const defaults: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PATH: windows
      ? [
          dirname(process.execPath),
          ...(systemRoot ? [path.join(systemRoot, "System32")] : []),
        ].join(";")
      : [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  };
  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    // Node sorts and deduplicates Windows keys BEFORE dropping undefined values.
    // Reuse source spelling, rather than adding e.g. PATH beside an erased Path.
    const inherited = Object.keys(source).filter(
      (candidate) => normalize(candidate) === normalize(key),
    );
    for (const actualKey of inherited.length ? inherited : [key])
      environment[actualKey] = value;
  }
  return environment;
}
