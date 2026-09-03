import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TerminalHistoryBackend } from "./terminal-session-manager.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const FLUSH_DELAY_MS = 100;
const TERMINAL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/u;
const RESET_SEQUENCE = Buffer.from("\u001bc", "utf8");

function historyFile(directory: string, terminalId: string): string {
  if (!TERMINAL_ID_PATTERN.test(terminalId))
    throw new Error("Terminal history identifier is invalid");
  return join(directory, `${terminalId}.log`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`The terminal history directory is invalid: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error(
      `The terminal history directory is owned by another user: ${path}`,
    );
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    await chmod(path, PRIVATE_DIRECTORY_MODE);
}

export class TerminalHistoryStore implements TerminalHistoryBackend {
  private readonly pending = new Map<string, Buffer[]>();
  private readonly pendingSizes = new Map<string, number>();
  private tail = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly directory: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  append(terminalId: string, data: Uint8Array): void {
    if (data.byteLength === 0) return;
    try {
      historyFile(this.directory, terminalId);
    } catch (error) {
      this.onError(error);
      return;
    }
    let chunks = this.pending.get(terminalId) ?? [];
    chunks.push(Buffer.from(data));
    let pendingSize =
      (this.pendingSizes.get(terminalId) ?? 0) + data.byteLength;
    if (pendingSize > MAX_HISTORY_BYTES) {
      const combined = Buffer.concat(chunks, pendingSize);
      const keep = combined.subarray(
        combined.byteLength - (MAX_HISTORY_BYTES - RESET_SEQUENCE.byteLength),
      );
      chunks = [RESET_SEQUENCE, Buffer.from(keep)];
      pendingSize = RESET_SEQUENCE.byteLength + keep.byteLength;
    }
    this.pending.set(terminalId, chunks);
    this.pendingSizes.set(terminalId, pendingSize);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueuePending();
    }, FLUSH_DELAY_MS);
    this.timer.unref?.();
  }

  async read(terminalId: string): Promise<Buffer | null> {
    await this.flush();
    const path = historyFile(this.directory, terminalId);
    try {
      const pathInfo = await lstat(path);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink())
        throw new Error(`The terminal history path is invalid: ${path}`);
      if (
        typeof process.getuid === "function" &&
        pathInfo.uid !== process.getuid()
      )
        throw new Error(
          `The terminal history file is owned by another user: ${path}`,
        );
      if (pathInfo.size > MAX_HISTORY_BYTES)
        throw new Error(
          `The terminal history file exceeds its size limit: ${path}`,
        );
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
            `The terminal history path changed while opening: ${path}`,
          );
        if (process.platform !== "win32" && (openedInfo.mode & 0o077) !== 0)
          throw new Error(`The terminal history file is not private: ${path}`);
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async remove(terminalId: string): Promise<void> {
    await this.flush();
    const path = historyFile(this.directory, terminalId);
    const operation = this.tail.then(async () => {
      await rm(path, { force: true });
    });
    this.tail = operation.catch(this.onError);
    await operation;
  }

  async clear(): Promise<void> {
    await this.flush();
    const operation = this.tail.then(async () => {
      let entries: string[];
      try {
        entries = await readdir(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".log"))
          .map((entry) => rm(join(this.directory, entry), { force: true })),
      );
    });
    this.tail = operation.catch(this.onError);
    await operation;
  }

  async prune(retentionDays: number): Promise<void> {
    await this.flush();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1_000;
    const operation = this.tail.then(async () => {
      let entries: string[];
      try {
        entries = await readdir(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".log"))
          .map(async (entry) => {
            const path = join(this.directory, entry);
            const info = await stat(path).catch(() => null);
            if (info && info.mtimeMs < cutoff) await rm(path, { force: true });
          }),
      );
    });
    this.tail = operation.catch(this.onError);
    await operation;
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.enqueuePending();
    await this.tail;
  }

  private enqueuePending(): void {
    if (this.pending.size === 0) return;
    const batches = [...this.pending].map(([id, chunks]) => [
      id,
      Buffer.concat(chunks),
    ]) as Array<[string, Buffer]>;
    this.pending.clear();
    this.pendingSizes.clear();
    this.tail = this.tail
      .then(async () => {
        await ensurePrivateDirectory(this.directory);
        for (const [terminalId, data] of batches)
          await this.appendBatch(terminalId, data);
      })
      .catch((error) => this.onError(error));
  }

  private async appendBatch(terminalId: string, data: Buffer): Promise<void> {
    const path = historyFile(this.directory, terminalId);
    const noFollow =
      process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    const handle = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | noFollow,
      PRIVATE_FILE_MODE,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile())
        throw new Error(`The terminal history path is invalid: ${path}`);
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new Error(
          `The terminal history file is owned by another user: ${path}`,
        );
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
        await handle.chmod(PRIVATE_FILE_MODE);
      const knownSize = info.size;
      if (knownSize + data.byteLength > MAX_HISTORY_BYTES) {
        const capacity = MAX_HISTORY_BYTES - RESET_SEQUENCE.byteLength;
        const newTail = data.subarray(Math.max(0, data.byteLength - capacity));
        const oldTailBytes = Math.min(
          knownSize,
          Math.max(0, capacity - newTail.byteLength),
        );
        const oldTail = Buffer.allocUnsafe(oldTailBytes);
        if (oldTailBytes > 0)
          await handle.read(oldTail, 0, oldTailBytes, knownSize - oldTailBytes);
        const retained = Buffer.concat([RESET_SEQUENCE, oldTail, newTail]);
        await handle.truncate(0);
        await handle.writeFile(retained);
      } else {
        await handle.writeFile(data);
      }
    } finally {
      await handle.close();
    }
  }
}
