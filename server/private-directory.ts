import { chmod, lstat, mkdir } from "node:fs/promises";
import { supportsPosixPermissions } from "./platform-paths.mjs";

const PRIVATE_DIRECTORY_MODE = 0o700;

/**
 * Ensures `path` is a real directory owned by this OS user and closed to
 * others. A directory open to others is either repaired or refused:
 * `repair` suits Inspire's own leaf directories; `reject` suits a directory
 * that may be user-chosen or shared, which must not be changed.
 */
export async function ensurePrivateDirectory(
  path: string,
  label: string,
  {
    create = true,
    loose = "reject",
  }: {
    create?: boolean;
    loose?: "reject" | "repair";
  } = {},
): Promise<void> {
  if (create)
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`The ${label} is not a private directory: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error(`The ${label} is owned by another user: ${path}`);
  if (supportsPosixPermissions() && (info.mode & 0o077) !== 0) {
    if (loose === "reject")
      throw new Error(
        `The ${label} must not be accessible by other users; use a private directory: ${path}`,
      );
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  }
}
