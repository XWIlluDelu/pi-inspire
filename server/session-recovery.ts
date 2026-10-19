import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

export const RECOVERY_MANIFEST = "inspire-session-recovery.json";
export const RECOVERY_README = "README.txt";
const MAX_HEADER_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;

interface RecoveryManifest {
  format: "inspire-session-recovery";
  version: 1;
  originalPath: string;
  payload: string;
  sessionId: string;
  cwd: string;
  size: string;
  sha256: string;
}

function sameVersion(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

async function pinnedFile(
  path: string,
): Promise<{ handle: FileHandle; stats: BigIntStats }> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("Recovery requires a regular, non-symlink file");
  const handle = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  );
  try {
    const stats = await handle.stat({ bigint: true });
    if (!sameVersion(before, stats))
      throw new Error("The recovery file changed while opening");
    return { handle, stats };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function unchanged(
  path: string,
  handle: FileHandle,
  before: BigIntStats,
): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    !sameVersion(before, current) ||
    !sameVersion(before, await handle.stat({ bigint: true }))
  )
    throw new Error("The recovery payload changed; no session was restored");
}

async function sessionHeader(
  handle: FileHandle,
): Promise<{ id: string; cwd: string }> {
  const buffer = Buffer.alloc(MAX_HEADER_BYTES);
  let length = 0;
  let newline = -1;
  while (length < buffer.length && newline < 0) {
    const { bytesRead } = await handle.read(
      buffer,
      length,
      buffer.length - length,
      length,
    );
    if (!bytesRead) break;
    newline = buffer.indexOf(0x0a, length);
    length += bytesRead;
    if (newline >= length) newline = -1;
  }
  if (newline < 0)
    throw new Error("The recovery payload has no bounded Pi session header");
  const header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
  if (
    header?.type !== "session" ||
    typeof header.id !== "string" ||
    !header.id ||
    typeof header.cwd !== "string" ||
    !isAbsolute(header.cwd) ||
    header.cwd.includes("\0")
  )
    throw new Error("The recovery payload has an invalid Pi session header");
  return { id: header.id, cwd: header.cwd };
}

async function payloadDigest(
  handle: FileHandle,
  size: bigint,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (BigInt(position) < size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, Number(size - BigInt(position))),
      position,
    );
    if (!bytesRead) throw new Error("The recovery payload was truncated");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function writePrivate(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The caller supplies the already-private quarantine bundle, never a public
 * session directory. Metadata is durable before the native Trash consumes it. */
export async function prepareSessionRecovery(
  payloadPath: string,
  originalPath: string,
): Promise<void> {
  if (
    !isAbsolute(originalPath) ||
    resolve(originalPath) !== originalPath ||
    extname(originalPath).toLowerCase() !== ".jsonl" ||
    basename(originalPath) !== basename(payloadPath) ||
    originalPath.includes("\0")
  )
    throw new Error("Invalid original session recovery path");
  // Preserve the physical original directory while its configured aliases
  // still exist. Recovery never follows a subsequently retargeted alias.
  const physicalOriginalPath = join(
    await realpath(dirname(originalPath)),
    basename(originalPath),
  );
  const directory = dirname(payloadPath);
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink())
    throw new Error("The recovery bundle is not a private directory");
  const entries = await readdir(directory);
  if (entries.length !== 1 || entries[0] !== basename(payloadPath))
    throw new Error(
      "The recovery bundle must contain only its session payload",
    );
  const { handle, stats } = await pinnedFile(payloadPath);
  try {
    const header = await sessionHeader(handle);
    const manifest: RecoveryManifest = {
      format: "inspire-session-recovery",
      version: 1,
      originalPath: physicalOriginalPath,
      payload: basename(payloadPath),
      sessionId: header.id,
      cwd: header.cwd,
      size: stats.size.toString(),
      sha256: await payloadDigest(handle, stats.size),
    };
    await writePrivate(
      join(directory, RECOVERY_MANIFEST),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    // Source modules are TS in server/; compiled release modules are JS in
    // build/server/. Do not infer this from the checkout directory's name.
    const launcher = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".js")
          ? "../../inspire.mjs"
          : "../inspire.mjs",
        import.meta.url,
      ),
    );
    const launcherArgument =
      process.platform === "win32"
        ? "'" + launcher.replaceAll("'", "''") + "'"
        : "'" + launcher.replaceAll("'", "'\"'\"'") + "'";
    await writePrivate(
      join(directory, RECOVERY_README),
      `Inspire session recovery\n\nOriginal session path:\n${physicalOriginalPath}\n\n` +
        "Restore this entire folder from Recycle Bin, or drag it out of macOS Trash.\n" +
        "Native Restore / Put Back restores this private folder, not the Pi session.\n" +
        "Then run ONE of these commands, replacing <bundle-folder> with this folder's path:\n\n" +
        '  inspire recover-session "<bundle-folder>"\n' +
        `  node ${launcherArgument} recover-session "<bundle-folder>"\n\n` +
        "Use PowerShell on Windows, or a POSIX shell on macOS.\n" +
        "Recovery refuses any existing destination. It does not start Pi or restore Hidden/pinned preferences.\n" +
        "Keep the complete folder until recovery succeeds; do not edit the manifest or JSONL.\n" +
        "Recover promptly after moving this folder: arbitrary locations are not scanned to retain uploaded attachments.\n",
    );
    await unchanged(payloadPath, handle, stats);
  } finally {
    await handle.close();
  }
}

/** Only fixed, non-payload metadata names are removed. Unknown entries and every
 * indeterminate payload remain private; callers never recursively purge them. */
export async function removeSessionRecoveryMetadata(
  directory: string,
): Promise<void> {
  for (const name of [RECOVERY_MANIFEST, RECOVERY_README]) {
    await unlink(join(directory, name)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
}

async function readManifest(directory: string): Promise<RecoveryManifest> {
  const path = join(directory, RECOVERY_MANIFEST);
  const { handle, stats } = await pinnedFile(path);
  try {
    if (stats.size > BigInt(MAX_HEADER_BYTES))
      throw new Error("The recovery manifest is too large");
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    await unchanged(path, handle, stats);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid session recovery manifest");
    const value = parsed as Partial<RecoveryManifest>;
    if (
      value.format !== "inspire-session-recovery" ||
      value.version !== 1 ||
      typeof value.originalPath !== "string" ||
      !isAbsolute(value.originalPath) ||
      resolve(value.originalPath) !== value.originalPath ||
      value.originalPath.includes("\0") ||
      extname(value.originalPath).toLowerCase() !== ".jsonl" ||
      typeof value.payload !== "string" ||
      value.payload !== basename(value.payload) ||
      value.payload.includes("/") ||
      value.payload.includes("\\") ||
      value.payload !== basename(value.originalPath) ||
      typeof value.sessionId !== "string" ||
      !value.sessionId ||
      typeof value.cwd !== "string" ||
      !isAbsolute(value.cwd) ||
      value.cwd.includes("\0") ||
      typeof value.size !== "string" ||
      !/^(0|[1-9][0-9]*)$/u.test(value.size) ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.sha256)
    )
      throw new Error("Invalid session recovery manifest");
    return value as RecoveryManifest;
  } finally {
    await handle.close();
  }
}

/** Recover from an explicitly selected bundle. Cross-volume sources are copied
 * from a pinned handle; only a complete revalidated copy is atomically published.
 * The original bundle remains intact for the operator to remove after checking. */
export async function recoverSessionBundle(
  bundlePath: string,
): Promise<string> {
  const directory = resolve(bundlePath);
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink())
    throw new Error("The recovery bundle must be a non-symlink directory");
  const manifest = await readManifest(directory);
  const payloadPath = join(directory, manifest.payload);
  const { handle, stats } = await pinnedFile(payloadPath);
  let staging: string | undefined;
  try {
    const header = await sessionHeader(handle);
    if (stats.size.toString() !== manifest.size)
      throw new Error("The recovery payload size does not match its manifest");
    if (header.id !== manifest.sessionId || header.cwd !== manifest.cwd)
      throw new Error(
        "The recovery payload does not match its session manifest",
      );
    // Do not create missing parent trees or follow a symlinked destination
    // parent. The user can repair moved storage explicitly before retrying.
    const parent = dirname(manifest.originalPath);
    let ancestor = parent;
    while (true) {
      const entry = await lstat(ancestor);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error(
          "The original session directory contains a symlink or is unavailable",
        );
      const next = dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
    try {
      await lstat(manifest.originalPath);
      throw new Error(
        "The original session path already exists; nothing was overwritten",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    staging = await mkdtemp(join(parent, ".inspire-recover-"));
    await chmod(staging, PRIVATE_DIRECTORY_MODE);
    const copy = join(staging, "payload");
    const output = await open(copy, "wx", 0o600);
    const hash = createHash("sha256");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (BigInt(position) < stats.size) {
        const length = Math.min(
          buffer.length,
          Number(stats.size - BigInt(position)),
        );
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (!bytesRead) throw new Error("The recovery payload was truncated");
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(
            buffer,
            written,
            bytesRead - written,
          );
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await output.sync();
    } finally {
      await output.close();
    }
    await unchanged(payloadPath, handle, stats);
    if (hash.digest("hex") !== manifest.sha256)
      throw new Error("The recovery payload bytes do not match its manifest");
    // A hard link on the destination volume gives atomic no-replace publish.
    // An existing file, symlink or concurrent Pi write wins without damage.
    await link(copy, manifest.originalPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST")
          throw new Error(
            "The original session path already exists; nothing was overwritten",
          );
        throw error;
      },
    );
    return manifest.originalPath;
  } finally {
    // A close or private staging cleanup error cannot undo a published session.
    await handle.close().catch(() => undefined);
    if (staging) {
      // These are fresh private names; cleanup cannot touch the public path.
      await unlink(join(staging, "payload")).catch(() => undefined);
      await rmdir(staging).catch(() => undefined);
    }
  }
}
