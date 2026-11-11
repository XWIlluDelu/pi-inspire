import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** Read a private file belonging to the terminal daemon without following a
 * link substituted between checking the path and opening it. */
export async function readPrivateTerminalFile(
  path: string,
  kind: "state" | "history",
  maxBytes: number,
): Promise<Buffer | null> {
  try {
    const pathInfo = await lstat(path);
    if (!pathInfo.isFile())
      throw new Error(`The terminal ${kind} path is invalid: ${path}`);
    if (
      typeof process.getuid === "function" &&
      pathInfo.uid !== process.getuid()
    )
      throw new Error(
        `The terminal ${kind} file is owned by another user: ${path}`,
      );
    if (pathInfo.size > maxBytes)
      throw new Error(`The terminal ${kind} file is too large: ${path}`);

    const noFollow =
      process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const openedInfo = await handle.stat();
      if (
        !openedInfo.isFile() ||
        openedInfo.dev !== pathInfo.dev ||
        openedInfo.ino !== pathInfo.ino
      )
        throw new Error(
          `The terminal ${kind} path changed while opening: ${path}`,
        );
      if (process.platform !== "win32" && (openedInfo.mode & 0o077) !== 0)
        throw new Error(`The terminal ${kind} file is not private: ${path}`);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
