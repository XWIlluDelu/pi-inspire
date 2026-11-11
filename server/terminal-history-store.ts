import { constants } from "node:fs";
import { open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./private-directory.js";
import { readPrivateTerminalFile } from "./terminal-private-file.js";
import type { TerminalHistoryBackend } from "./terminal-session-manager.js";

const PRIVATE_FILE_MODE = 0o600;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
// Leave append headroom after compaction instead of rewriting the retained
// history for every small batch once a terminal reaches its size limit.
const RETAIN_HISTORY_BYTES = 24 * 1024 * 1024;
const FLUSH_DELAY_MS = 100;
const TERMINAL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/u;
const RESET_SEQUENCE = Buffer.from("\u001bc", "utf8");

function historyFile(directory: string, terminalId: string): string {
  if (!TERMINAL_ID_PATTERN.test(terminalId))
    throw new Error("Terminal history identifier is invalid");
  return join(directory, `${terminalId}.log`);
}

export class TerminalHistoryStore implements TerminalHistoryBackend {
  private readonly pending = new Map<
    string,
    { chunks: Buffer[]; size: number }
  >();
  private tail = Promise.resolve();
  private writing: Promise<void> | null = null;
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
    const pending = this.pending.get(terminalId) ?? { chunks: [], size: 0 };
    pending.chunks.push(Buffer.from(data));
    pending.size += data.byteLength;
    if (pending.size > MAX_HISTORY_BYTES) {
      const combined = Buffer.concat(pending.chunks, pending.size);
      const keep = combined.subarray(
        combined.byteLength -
          (RETAIN_HISTORY_BYTES - RESET_SEQUENCE.byteLength),
      );
      pending.chunks = [RESET_SEQUENCE, Buffer.from(keep)];
      pending.size = RESET_SEQUENCE.byteLength + keep.byteLength;
    }
    this.pending.set(terminalId, pending);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueuePending();
    }, FLUSH_DELAY_MS);
    this.timer.unref();
  }

  async read(terminalId: string): Promise<Buffer | null> {
    await this.flush();
    const path = historyFile(this.directory, terminalId);
    return readPrivateTerminalFile(path, "history", MAX_HISTORY_BYTES);
  }

  async remove(terminalId: string): Promise<void> {
    await this.flush();
    const path = historyFile(this.directory, terminalId);
    return this.enqueue(() => rm(path, { force: true }));
  }

  clear(): Promise<void> {
    return this.removeLogs();
  }

  prune(retentionDays: number): Promise<void> {
    return this.removeLogs(retentionDays);
  }

  private async removeLogs(retentionDays?: number): Promise<void> {
    await this.flush();
    const cutoff =
      retentionDays === undefined
        ? undefined
        : Date.now() - retentionDays * 24 * 60 * 60 * 1_000;
    return this.enqueue(async () => {
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
            if (cutoff === undefined) return rm(path, { force: true });
            const info = await stat(path).catch(() => null);
            if (info && info.mtimeMs < cutoff) await rm(path, { force: true });
          }),
      );
    });
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A slow write keeps later output in the bounded pending buffer. Wait for
    // it before capturing the remaining bytes received by this flush call.
    if (this.writing) await this.writing;
    this.enqueuePending();
    await this.tail;
  }

  private enqueuePending(): void {
    if (this.writing || this.pending.size === 0) return;
    const batches = [...this.pending].map(
      ([id, { chunks, size }]) => [id, Buffer.concat(chunks, size)] as const,
    );
    this.pending.clear();
    void this.enqueue(async () => {
      await ensurePrivateDirectory(
        this.directory,
        "terminal history directory",
        { loose: "repair" },
      );
      for (const [terminalId, data] of batches)
        await this.appendBatch(terminalId, data);
    });
    this.writing = this.tail;
    const finished = (): void => {
      this.writing = null;
      if (!this.timer) this.enqueuePending();
    };
    void this.writing.then(finished, finished);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch((error) => this.onError(error));
    return result;
  }

  private async appendBatch(terminalId: string, data: Buffer): Promise<void> {
    const path = historyFile(this.directory, terminalId);
    const noFollow =
      process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    const handle = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | noFollow,
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
      let output = data;
      let position = knownSize;
      if (knownSize + data.byteLength > MAX_HISTORY_BYTES) {
        const capacity = RETAIN_HISTORY_BYTES - RESET_SEQUENCE.byteLength;
        const newTail = data.subarray(Math.max(0, data.byteLength - capacity));
        const oldTailBytes = Math.min(
          knownSize,
          Math.max(0, capacity - newTail.byteLength),
        );
        const oldTail = Buffer.allocUnsafe(oldTailBytes);
        if (oldTailBytes > 0)
          await handle.read(oldTail, 0, oldTailBytes, knownSize - oldTailBytes);
        output = Buffer.concat([RESET_SEQUENCE, oldTail, newTail]);
        await handle.truncate(0);
        position = 0;
      }
      // Windows append-only handles cannot truncate. This serialized owner
      // writes explicit offsets for both ordinary appends and compaction.
      let offset = 0;
      while (offset < output.byteLength) {
        const { bytesWritten } = await handle.write(
          output,
          offset,
          output.byteLength - offset,
          position + offset,
        );
        offset += bytesWritten;
      }
    } finally {
      await handle.close();
    }
  }
}
