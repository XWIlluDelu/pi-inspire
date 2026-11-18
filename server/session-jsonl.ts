import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { SessionHeader } from "@earendil-works/pi-coding-agent";
import { MAX_SESSION_ID_CHARS } from "../shared/contracts.js";

/** Persisted JSONL and child RPC frames are independent trust boundaries. */
export const MAX_PERSISTED_ENTRY_BYTES = 32 * 1024 * 1024;

export class PersistedJsonlError extends Error {}
export class MissingSessionHeaderError extends PersistedJsonlError {}

export interface SessionSourceIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function sessionSourceIdentity({
  dev,
  ino,
  size,
  mtimeNs,
  ctimeNs,
}: SessionSourceIdentity): SessionSourceIdentity {
  return { dev, ino, size, mtimeNs, ctimeNs };
}

export function sessionSourceVersion(identity: SessionSourceIdentity): string {
  const { dev, ino, size, mtimeNs, ctimeNs } = identity;
  return `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
}

export function sameSessionObject(
  left: Pick<SessionSourceIdentity, "dev" | "ino">,
  right: Pick<SessionSourceIdentity, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameSessionVersion(
  left: SessionSourceIdentity,
  right: SessionSourceIdentity,
): boolean {
  return (
    sameSessionObject(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Admit same-file growth under Pi's append-only persistence model. */
export function preservesSessionPrefix(
  current: SessionSourceIdentity,
  observed: SessionSourceIdentity,
): boolean {
  return (
    sameSessionVersion(current, observed) ||
    (sameSessionObject(current, observed) && current.size > observed.size)
  );
}

export function isDisappearedSessionPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR";
}

export class SessionSourceTypeError extends Error {}

async function sourceAtPath(
  path: string,
  canonicalPath?: string,
): Promise<SessionSourceIdentity | null> {
  if (canonicalPath !== undefined && (await realpath(path)) !== canonicalPath)
    return null;
  const details = await lstat(path, { bigint: true });
  return details.isFile() ? details : null;
}

export async function sessionVersionAtPath(
  path: string,
  source: SessionSourceIdentity,
  canonicalPath?: string,
): Promise<boolean> {
  const addressed = await sourceAtPath(path, canonicalPath);
  return addressed !== null && sameSessionVersion(addressed, source);
}

/** A regular file and the byte interval observed when it was opened. */
export class SessionDocumentReader {
  private constructor(
    private readonly path: string,
    private readonly handle: FileHandle,
    readonly source: SessionSourceIdentity,
  ) {}

  static async open(path: string): Promise<SessionDocumentReader> {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const details = await handle.stat({ bigint: true });
      if (!details.isFile())
        throw new SessionSourceTypeError(
          "Session source must be a regular file",
        );
      if (details.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("Session source is too large to address safely");
      return new SessionDocumentReader(
        path,
        handle,
        sessionSourceIdentity(details),
      );
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  close(): Promise<void> {
    return this.handle.close();
  }

  private async addressesSource(
    canonicalPath?: string,
    allowGrowth = false,
  ): Promise<boolean> {
    try {
      const addressed = await sourceAtPath(this.path, canonicalPath);
      return (
        addressed !== null &&
        (allowGrowth
          ? preservesSessionPrefix(addressed, this.source)
          : sameSessionVersion(addressed, this.source))
      );
    } catch (error) {
      if (isDisappearedSessionPath(error)) return false;
      throw error;
    }
  }

  addressesVersion(canonicalPath?: string): Promise<boolean> {
    return this.addressesSource(canonicalPath);
  }

  async stillCurrent(canonicalPath?: string): Promise<boolean> {
    return (
      sameSessionVersion(
        await this.handle.stat({ bigint: true }),
        this.source,
      ) && (await this.addressesVersion(canonicalPath))
    );
  }

  /** Search admits an append to the same file under Pi's one-writer rule. */
  async stillAddressesPrefix(canonicalPath: string): Promise<boolean> {
    return (
      (await this.handle.stat({ bigint: true })).size >= this.source.size &&
      (await this.addressesSource(canonicalPath, true))
    );
  }

  async readBytes(
    start: number,
    end: number,
    visit: (chunk: Buffer, offset: number) => void | Promise<void>,
  ): Promise<number> {
    const buffer = Buffer.allocUnsafe(
      Math.min(64 * 1024, Math.max(0, end - start)),
    );
    let offset = start;
    while (offset < end) {
      const length = Math.min(buffer.length, end - offset);
      const { bytesRead } = await this.handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      await visit(buffer.subarray(0, bytesRead), offset);
      offset += bytesRead;
    }
    return offset;
  }

  async scan(
    start: number,
    visit: (
      entry: Record<string, unknown>,
      header: SessionHeader | null,
    ) => void,
    onFrame?: (frame: Buffer) => void,
    onChunk?: (chunk: Buffer, offset: number) => void | Promise<void>,
    limit = Number(this.source.size),
  ) {
    const result: { header: SessionHeader | null } = { header: null };
    const decoder = new JsonlObjectDecoder((entry, frame) => {
      onFrame?.(frame);
      if (start === 0 && result.header === null) {
        assertSessionHeader(entry);
        result.header = entry;
        visit(entry, entry);
      } else {
        if (entry.type === "session")
          throw new PersistedJsonlError(
            "Persisted session contains a second session header",
          );
        visit(entry, null);
      }
    });
    const end = await this.readBytes(start, limit, async (chunk, offset) => {
      if (onChunk) await onChunk(chunk, offset);
      decoder.push(chunk);
    });
    return {
      header: result.header,
      completeBytes: start + decoder.completeBytes,
      end,
      tail: () => decoder.tail(),
    };
  }
}

function isSessionPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32_768 &&
    !value.includes("\0") &&
    isAbsolute(value)
  );
}

/** Authority fields common to every supported on-disk version. */
function assertSessionHeader(
  entry: Record<string, unknown>,
): asserts entry is Record<string, unknown> & SessionHeader {
  if (entry.type !== "session")
    throw new MissingSessionHeaderError("Missing Pi session header");
  if (
    typeof entry.id !== "string" ||
    !entry.id.length ||
    entry.id.length > MAX_SESSION_ID_CHARS ||
    !isSessionPath(entry.cwd) ||
    (entry.parentSession !== undefined && !isSessionPath(entry.parentSession))
  )
    throw new PersistedJsonlError(
      "Persisted session has an invalid Pi session header",
    );
}

function decodeJsonlObject(line: Buffer): Record<string, unknown> {
  if (line.length === 0)
    throw new PersistedJsonlError(
      "Persisted session contains an empty JSONL entry",
    );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
  } catch (error) {
    throw new PersistedJsonlError(
      `Persisted session contains a malformed complete JSONL entry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersistedJsonlError(
      "Persisted session entry must be a JSON object",
    );
  }
  return value as Record<string, unknown>;
}

/**
 * Incrementally frames complete JSONL objects without repeatedly copying an
 * unfinished large line. A non-LF tail remains unparsed for the next read.
 */
export class JsonlObjectDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private framedBytes = 0;

  constructor(
    private readonly onEntry: (
      entry: Record<string, unknown>,
      frame: Buffer,
    ) => void,
  ) {}

  get completeBytes(): number {
    return this.framedBytes;
  }

  tail(): Buffer {
    if (this.pendingBytes === 0) return Buffer.alloc(0);
    return Buffer.concat(this.pending, this.pendingBytes);
  }

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const lf = chunk.indexOf(0x0a, offset);
      if (lf === -1) {
        // Callers may refill and reuse their read buffer. The unfinished frame
        // must own its bytes across push() calls rather than retain a view.
        const remainder = Buffer.from(chunk.subarray(offset));
        this.pending.push(remainder);
        this.pendingBytes += remainder.length;
        if (this.pendingBytes > MAX_PERSISTED_ENTRY_BYTES)
          throw new PersistedJsonlError(
            `Persisted session entry exceeds ${MAX_PERSISTED_ENTRY_BYTES} bytes`,
          );
        break;
      }

      const terminal = chunk.subarray(offset, lf + 1);
      const frame =
        this.pendingBytes === 0
          ? terminal
          : Buffer.concat(
              [...this.pending, terminal],
              this.pendingBytes + terminal.length,
            );
      const lineLength = frame.length - 1;
      if (lineLength > MAX_PERSISTED_ENTRY_BYTES)
        throw new PersistedJsonlError(
          `Persisted session entry exceeds ${MAX_PERSISTED_ENTRY_BYTES} bytes`,
        );
      this.onEntry(decodeJsonlObject(frame.subarray(0, lineLength)), frame);
      this.framedBytes += frame.length;
      this.pending = [];
      this.pendingBytes = 0;
      offset = lf + 1;
    }
  }
}
