import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import type { RootSnapshot } from "./attachment-retention-identity.js";
import {
  type LinuxTrashOptions,
  linuxDirectoryAuthority,
  linuxMounts,
} from "./linux-trash.js";
import { windowsPowerShellCommand } from "./platform-environment.mjs";

const execFile = promisify(execFileCallback);
export type StorageVolumeIdentity =
  | {
      kind: "linux-anchor";
      directory: string;
      id: string;
      mountPoint: string;
      root: string;
    }
  | {
      kind: "windows-guid" | "macos-uuid";
      directory: string;
      id: string;
      format?: string;
    };
export interface StorageVolumeOptions {
  parent: string;
  platform?: NodeJS.Platform;
  linux?: LinuxTrashOptions;
  /** Native-query boundary; fixtures return logical volume identities. */
  nativeIdentity?: (path: string) => Promise<StorageVolumeIdentity>;
  nativeIdentities?: (
    paths: readonly string[],
  ) => Promise<readonly StorageVolumeIdentity[]>;
}
type MarkerIO = (
  path: string,
  create?: boolean,
  createId?: string,
) => Promise<RootSnapshot>;
export interface StorageVolumeProof {
  identity: StorageVolumeIdentity;
  verify: () => Promise<void>;
}
const nativeUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function contains(parent: string, path: string) {
  const part = relative(parent, path);
  return (
    part === "" ||
    (!isAbsolute(part) &&
      part !== ".." &&
      !part.startsWith("../") &&
      !part.startsWith("..\\"))
  );
}
export function isStorageVolumeIdentity(
  value: unknown,
): value is StorageVolumeIdentity {
  if (!value || typeof value !== "object") return false;
  const item = value as StorageVolumeIdentity;
  return (
    ["linux-anchor", "windows-guid", "macos-uuid"].includes(item.kind) &&
    typeof item.directory === "string" &&
    isAbsolute(item.directory) &&
    !item.directory.includes("\0") &&
    typeof item.id === "string" &&
    nativeUuid.test(item.id) &&
    !/^0+-0+-0+-0+-0+$/u.test(item.id) &&
    (item.kind !== "linux-anchor" ||
      (isAbsolute(item.mountPoint) && isAbsolute(item.root))) &&
    (item.kind !== "windows-guid" ||
      (typeof item.format === "string" &&
        /^(?!00000000)[0-9a-f]{8}$/u.test(item.format)))
  );
}
export function sameStorageVolume(
  a: StorageVolumeIdentity,
  b: StorageVolumeIdentity,
): boolean {
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    (a.kind !== "windows-guid" ||
      (b.kind === "windows-guid" && a.format === b.format)) &&
    (a.kind !== "linux-anchor" ||
      (b.kind === "linux-anchor" &&
        a.directory === b.directory &&
        a.mountPoint === b.mountPoint &&
        a.root === b.root))
  );
}

function nativeChunks(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [],
    characters = 2,
    bytes = 2;
  for (const path of paths) {
    const json = JSON.stringify(path),
      size = Buffer.byteLength(json, "utf8") + 1;
    if (json.length + 2 > 30000)
      throw new Error(
        "A session root exceeds the native volume-query path budget",
      );
    if (
      current.length &&
      (characters + json.length + 1 > 12000 ||
        bytes + size > 24000 ||
        current.length >= 64)
    ) {
      chunks.push(current);
      current = [];
      characters = 2;
      bytes = 2;
    }
    current.push(path);
    characters += json.length + 1;
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
const nativeOutputLimit = (paths: readonly string[]) =>
  Math.max(
    64 * 1024,
    Buffer.byteLength(JSON.stringify(paths), "utf8") * 2 + paths.length * 512,
  );

export async function nativeMacosVolumeIdentities(
  paths: readonly string[],
): Promise<readonly StorageVolumeIdentity[]> {
  const results: StorageVolumeIdentity[] = [];
  for (const chunk of nativeChunks(paths))
    results.push(...(await queryMacosVolumeBatch(chunk)));
  return results;
}
export async function nativeWindowsVolumeIdentities(
  paths: readonly string[],
): Promise<readonly StorageVolumeIdentity[]> {
  const results: StorageVolumeIdentity[] = [];
  for (const chunk of nativeChunks(paths))
    results.push(...(await queryWindowsVolumeBatch(chunk)));
  return results;
}

async function queryMacosVolumeBatch(
  paths: readonly string[],
): Promise<readonly StorageVolumeIdentity[]> {
  const { stdout } = await execFile(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      [
        'ObjC.import("Foundation");',
        "function run(argv) { return JSON.stringify(argv.map(function(path) {",
        "  const url = $.NSURL.fileURLWithPath(path);",
        "  const root = Ref(), uuid = Ref(), error = Ref();",
        "  if (!url.getResourceValueForKeyError(root, $.NSURLVolumeURLKey, error) ||",
        "      !url.getResourceValueForKeyError(uuid, $.NSURLVolumeUUIDStringKey, error))",
        '    throw new Error("Unable to identify the persistent session volume");',
        "  return {directory:ObjC.unwrap(root[0].path), id:ObjC.unwrap(uuid[0])};",
        "})); }",
      ].join("\n"),
      ...paths,
    ],
    { encoding: "utf8", timeout: 10000, maxBuffer: nativeOutputLimit(paths) },
  );
  const values: unknown = JSON.parse(stdout);
  if (!Array.isArray(values) || values.length !== paths.length)
    throw new Error("Unknown macOS volume identity");
  return values.map((value) => {
    const identity = {
      kind: "macos-uuid" as const,
      directory: value?.directory,
      id: typeof value?.id === "string" ? value.id.toLowerCase() : "",
    };
    if (!isStorageVolumeIdentity(identity))
      throw new Error("macOS supplied no persistent filesystem UUID");
    return identity;
  });
}

async function queryWindowsVolumeBatch(
  paths: readonly string[],
): Promise<readonly StorageVolumeIdentity[]> {
  const command = windowsPowerShellCommand();
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition @'",
    "using System; using System.Text; using System.Runtime.InteropServices;",
    "public static class InspireVolume {",
    ' [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    " [return: MarshalAs(UnmanagedType.Bool)]",
    " public static extern bool GetVolumePathName(string path, StringBuilder volume, uint length);",
    ' [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    " [return: MarshalAs(UnmanagedType.Bool)]",
    " public static extern bool GetVolumeNameForVolumeMountPoint(string path, StringBuilder name, uint length);",
    ' [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    " [return: MarshalAs(UnmanagedType.Bool)]",
    " public static extern bool GetVolumeInformation(string path, StringBuilder label, uint labelSize, out uint serial, out uint maxComponent, out uint flags, StringBuilder fsName, uint fsNameSize);",
    "}",
    "'@",
    "$paths = Microsoft.PowerShell.Utility\\ConvertFrom-Json -InputObject $env:INSPIRE_RETENTION_PATHS",
    "$result = @(foreach ($path in $paths) {",
    "$root = [System.Text.StringBuilder]::new(32768)",
    "$guid = [System.Text.StringBuilder]::new(1024)",
    "if (-not [InspireVolume]::GetVolumePathName($path, $root, 32768)) { throw 'Cannot identify mounted session storage' }",
    "if (-not [InspireVolume]::GetVolumeNameForVolumeMountPoint($root.ToString(), $guid, 1024)) { throw 'Session storage has no persistent local volume GUID' }",
    "$serial = [uint32]0; $max = [uint32]0; $flags = [uint32]0",
    "if (-not [InspireVolume]::GetVolumeInformation($root.ToString(), $null, 0, [ref]$serial, [ref]$max, [ref]$flags, $null, 0)) { throw 'Cannot identify filesystem format' }",
    "@{directory=$root.ToString(); id=$guid.ToString(); format=$serial.ToString('x8')}",
    "})",
    "Microsoft.PowerShell.Utility\\ConvertTo-Json -InputObject $result -Compress",
  ].join("\n");
  const { stdout } = await execFile(
    command,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, INSPIRE_RETENTION_PATHS: JSON.stringify(paths) },
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: nativeOutputLimit(paths),
    },
  );
  const values: unknown = JSON.parse(stdout);
  if (!Array.isArray(values) || values.length !== paths.length)
    throw new Error("Unknown Windows volume identity");
  return values.map((value) => {
    const match =
      typeof value?.id === "string"
        ? /^\\\\\?\\Volume\{([0-9a-f-]{36})\}\\$/iu.exec(value.id)
        : null;
    const identity = {
      kind: "windows-guid" as const,
      directory: value?.directory,
      id: match?.[1]?.toLowerCase() ?? "",
      format: value?.format,
    };
    if (!isStorageVolumeIdentity(identity))
      throw new Error(
        "Windows supplied no persistent local volume GUID/format identity",
      );
    return identity;
  });
}

/** One native batch before and one after a sweep, not one process per JSONL
 * or repeated opens of an already-registered session directory. */
export async function snapshotStorageVolumes(
  paths: readonly string[],
  options: StorageVolumeOptions,
): Promise<{
  options: StorageVolumeOptions;
  verify: () => Promise<void>;
}> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32")
    return { options, verify: async () => undefined };
  const physical = [
    ...new Set(await Promise.all(paths.map((path) => realpath(path)))),
  ];
  const query =
    options.nativeIdentities ??
    (options.nativeIdentity
      ? async (paths: readonly string[]) =>
          Promise.all(paths.map(options.nativeIdentity!))
      : platform === "win32"
        ? nativeWindowsVolumeIdentities
        : nativeMacosVolumeIdentities);
  const before = physical.length ? await query(physical) : [];
  if (
    before.length !== physical.length ||
    before.some((identity) => !isStorageVolumeIdentity(identity))
  )
    throw new Error("Incomplete native session volume identities");
  const cache = new Map(physical.map((path, index) => [path, before[index]!]));
  return {
    options: {
      ...options,
      nativeIdentity: async (path) => {
        const identity = cache.get(path);
        if (!identity)
          throw new Error("Session volume path changed during the sweep");
        return identity;
      },
    },
    verify: async () => {
      const after = physical.length ? await query(physical) : [];
      if (
        after.length !== before.length ||
        after.some(
          (identity, index) =>
            !isStorageVolumeIdentity(identity) ||
            !sameStorageVolume(before[index]!, identity) ||
            before[index]!.directory !== identity.directory,
        )
      )
        throw new Error("Session volume changed during attachment reclamation");
    },
  };
}

async function canonicalFuturePath(
  path: string,
): Promise<{ path: string; ancestor: string }> {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const ancestor = await realpath(current);
      return { path: join(ancestor, ...missing.reverse()), ancestor };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        dirname(current) === current
      )
        throw error;
      missing.push(basename(current));
      current = dirname(current);
    }
  }
}

export async function resolveStorageVolume(
  sessionRoot: string,
  options: StorageVolumeOptions,
  markerIO: MarkerIO,
  expected?: StorageVolumeIdentity,
  create = false,
): Promise<StorageVolumeProof> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || platform === "darwin") {
    const query =
      options.nativeIdentity ??
      (async (path: string) => {
        const values = await (
          options.nativeIdentities ??
          (platform === "win32"
            ? nativeWindowsVolumeIdentities
            : nativeMacosVolumeIdentities)
        )([path]);
        return values[0]!;
      });
    const current = await query(await realpath(sessionRoot));
    if (
      !isStorageVolumeIdentity(current) ||
      current.kind !== (platform === "win32" ? "windows-guid" : "macos-uuid")
    )
      throw new Error("Unknown persistent session volume");
    if (expected && !sameStorageVolume(expected, current))
      throw new Error("Persistent session volume changed");
    return {
      identity: current,
      verify: async () => {
        const after = await query(await realpath(sessionRoot));
        if (
          !sameStorageVolume(current, after) ||
          current.directory !== after.directory
        )
          throw new Error(
            "Session volume changed during attachment reclamation",
          );
      },
    };
  }
  if (platform !== "linux")
    throw new Error("Persistent session volume is unsupported");
  if (expected && expected.kind !== "linux-anchor")
    throw new Error("Persistent session volume kind changed");
  const source = await realpath(sessionRoot);
  const mounts = await linuxMounts(options.linux);
  const authority = await linuxDirectoryAuthority(
    source,
    mounts,
    options.linux,
  );
  if (
    expected?.kind === "linux-anchor" &&
    (expected.mountPoint !== authority.mount.mountPoint ||
      expected.root !== authority.mount.root)
  )
    throw new Error(
      "Persistent session volume scope changed; --accept-replacement requires verified complete session and Trash migration",
    );
  const sameFilesystem = async (path: string) => {
    const existing = (await canonicalFuturePath(path)).ancestor;
    if (options.linux?.mounts) {
      const candidate = await linuxDirectoryAuthority(
        existing,
        mounts,
        options.linux,
      );
      return (
        candidate.mount.source === authority.mount.source &&
        candidate.mount.filesystem === authority.mount.filesystem
      );
    }
    // st_dev is only a current same-filesystem placement check. The persisted
    // identity is the separately pinned random anchor, never this device value.
    return (await stat(existing)).dev === (await stat(source)).dev;
  };
  const candidates = expected
    ? [expected.directory]
    : [
        join(options.parent, ".inspire-retention-volume"),
        join(
          authority.mount.mountPoint,
          ".inspire-retention-" + (options.linux?.uid ?? process.getuid?.()),
        ),
      ];
  let last: unknown = new Error(
    "No independent writable session-volume anchor is available",
  );
  for (const candidate of [...new Set(candidates)]) {
    try {
      const physical = (await canonicalFuturePath(candidate)).path;
      if (contains(source, physical) || !(await sameFilesystem(candidate)))
        throw new Error(
          "Session volume anchor must be outside session storage on the same filesystem",
        );
      if (create) {
        await mkdir(candidate, { recursive: true, mode: 0o700 });
        const stats = await lstat(candidate);
        if (
          !stats.isDirectory() ||
          stats.isSymbolicLink() ||
          (process.getuid && stats.uid !== process.getuid())
        )
          throw new Error(
            "Session volume anchor is not a current-user private directory",
          );
        if ((stats.mode & 0o077) !== 0) await chmod(candidate, 0o700);
      }
      const marker = await markerIO(candidate, create, expected?.id);
      if (
        contains(source, marker.directory) ||
        !(await sameFilesystem(marker.directory))
      )
        throw new Error("Session volume anchor placement changed");
      const identity = {
        kind: "linux-anchor" as const,
        directory: marker.directory,
        id: marker.id,
        mountPoint: authority.mount.mountPoint,
        root: authority.mount.root,
      };
      if (expected && !sameStorageVolume(expected, identity))
        throw new Error("Persistent session volume anchor changed");
      return {
        identity,
        verify: async () => {
          const after = await markerIO(identity.directory);
          if (
            after.id !== marker.id ||
            after.markerVersion !== marker.markerVersion ||
            after.rootVersion !== marker.rootVersion ||
            after.directory !== marker.directory ||
            !(await sameFilesystem(identity.directory))
          )
            throw new Error(
              "Session volume anchor changed during attachment reclamation",
            );
        },
      };
    } catch (error) {
      last = error;
      if (expected) throw error;
    }
  }
  throw last;
}
