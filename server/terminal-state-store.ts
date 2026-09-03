import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { TerminalPersistedState } from "./terminal-session-manager.js";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const WRITE_DELAY_MS = 200;

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`The terminal state directory is invalid: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error(
      `The terminal state directory is owned by another user: ${path}`,
    );
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    await chmod(path, PRIVATE_DIRECTORY_MODE);
}

export async function readTerminalState(path: string): Promise<unknown | null> {
  try {
    const pathInfo = await lstat(path);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink())
      throw new Error(`The terminal state path is not a regular file: ${path}`);
    if (
      typeof process.getuid === "function" &&
      pathInfo.uid !== process.getuid()
    )
      throw new Error(
        `The terminal state file is owned by another user: ${path}`,
      );
    if (pathInfo.size > MAX_STATE_BYTES)
      throw new Error(`The terminal state file is too large: ${path}`);
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
          `The terminal state path changed while opening: ${path}`,
        );
      if (process.platform !== "win32" && (openedInfo.mode & 0o077) !== 0)
        throw new Error(`The terminal state file is not private: ${path}`);
      return JSON.parse(await handle.readFile("utf8")) as unknown;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeTerminalState(
  path: string,
  state: TerminalPersistedState,
): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES)
    throw new Error("Terminal state exceeds its size limit");
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class TerminalStateWriter {
  private timer: NodeJS.Timeout | null = null;
  private tail = Promise.resolve();
  private dirty = false;

  constructor(
    private readonly path: string,
    private readonly snapshot: () => TerminalPersistedState,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueue();
    }, WRITE_DELAY_MS);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.enqueue();
    await this.tail;
  }

  private enqueue(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const state = this.snapshot();
    this.tail = this.tail
      .then(() => writeTerminalState(this.path, state))
      .catch((error) => this.onError(error));
  }
}
