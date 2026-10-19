import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function nativeVolumeRoots(
  paths: readonly string[],
): Promise<readonly string[]> {
  // NSURL's documented volumeURL resource handles APFS volume/firmlink
  // placement; walking stat.dev parents does not reliably identify it.
  const { stdout } = await execFile(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      [
        'ObjC.import("Foundation");',
        "function run(argv) {",
        "  return JSON.stringify(argv.map(function(path) {",
        "    const volume = Ref();",
        "    const error = Ref();",
        "    const url = $.NSURL.fileURLWithPath(path);",
        "    if (!url.getResourceValueForKeyError(volume, $.NSURLVolumeURLKey, error))",
        "      throw new Error(ObjC.unwrap(error[0].localizedDescription));",
        "    return ObjC.unwrap(volume[0].path);",
        "  }));",
        "}",
      ].join("\n"),
      ...paths,
    ],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  const roots: unknown = JSON.parse(stdout);
  if (
    !Array.isArray(roots) ||
    roots.length !== paths.length ||
    roots.some(
      (path) =>
        typeof path !== "string" || !isAbsolute(path) || path.includes("\0"),
    )
  )
    throw new Error("Unable to identify macOS session Trash volumes");
  return roots as string[];
}

/** Only the home Trash and current-user Trash on volumes holding known session
 * roots are candidates. No volume enumeration or unrelated directory crawl.
 * Native lookup/access failures propagate so reclamation is deferred. */
export async function macosSessionTrashDirectories(
  sessionDirectories: readonly string[],
  options: {
    home?: string;
    uid?: number;
    volumeRoots?: (paths: readonly string[]) => Promise<readonly string[]>;
  } = {},
): Promise<string[]> {
  const home = options.home ?? homedir();
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    throw new Error("Unable to identify the current macOS Trash user");
  const directories = [
    ...new Set(sessionDirectories.map((path) => resolve(path))),
  ];
  const roots = await (options.volumeRoots ?? nativeVolumeRoots)([
    home,
    ...directories,
  ]);
  if (
    roots.length !== directories.length + 1 ||
    roots.some((path) => !isAbsolute(path) || path.includes("\0"))
  )
    throw new Error("Unable to identify macOS session Trash volumes");
  const [homeVolume, ...sessionVolumes] = roots;
  return [
    ...new Set([
      join(home, ".Trash"),
      ...sessionVolumes
        .filter((volume) => volume !== homeVolume)
        .map((volume) => join(volume, ".Trashes", String(uid))),
    ]),
  ];
}
