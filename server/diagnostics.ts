import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DiagnosticLevel = "debug" | "info" | "warning" | "error";

export interface DiagnosticLogger {
  readonly hostId: string;
  record(
    level: DiagnosticLevel,
    event: string,
    fields?: Record<string, unknown>,
  ): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface FileDiagnosticLoggerOptions {
  path: string;
  base?: Record<string, unknown>;
  hostId?: string;
  maxBytes?: number;
  retainedFiles?: number;
  /** Default state paths may be created and tightened. Explicit paths must
   * already live in a current-user-private directory. */
  createPrivateDirectory?: boolean;
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 4;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_STRING_CHARS = 500;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 4;
const REDACTED_KEY =
  /(?:authorization|cookie|token|password|secret|credential|prompt|message|content|payload|result|stderr|environment|(?:^|[_-])env(?:$|[_-])|headers|toolOutput|api[_-]?key|bearer)/i;

function installationKey(root: string, host: string, port: number): string {
  return createHash("sha256")
    .update(root)
    .update("\0")
    .update(host)
    .update("\0")
    .update(String(port))
    .digest("hex");
}

export function defaultDiagnosticLogPath(
  root: string,
  host: string,
  port: number,
): string {
  const stateHome =
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(
    stateHome,
    "inspire",
    "logs",
    `${installationKey(root, host, port)}.jsonl`,
  );
}

function boundedString(value: string): string {
  return value.length <= MAX_STRING_CHARS
    ? value
    : `${value.slice(0, MAX_STRING_CHARS)}…`;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "bigint") return value.toString();
  if (depth >= MAX_DEPTH) return "[bounded]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitize(item, depth + 1));
    if (value.length > items.length)
      items.push(`[${value.length - items.length} more]`);
    return items;
  }
  if (!value || typeof value !== "object") return String(value);
  const result: Record<string, unknown> = {};
  const allEntries = Object.entries(value as Record<string, unknown>);
  const entries = allEntries.slice(0, MAX_OBJECT_KEYS);
  for (const [key, item] of entries) {
    result[key] = REDACTED_KEY.test(key)
      ? "[redacted]"
      : sanitize(item, depth + 1);
  }
  if (allEntries.length > entries.length) result.__bounded = true;
  return result;
}

async function verifyPrivateDirectory(
  path: string,
  create: boolean,
): Promise<void> {
  if (create)
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(
      `The Inspire diagnostics directory is not a private directory: ${path}`,
    );
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(
      `The Inspire diagnostics directory is not owned by the current user: ${path}`,
    );
  }
  if ((info.mode & 0o077) !== 0) {
    if (!create)
      throw new Error(
        `The Inspire diagnostics directory must not be accessible by other users: ${path}`,
      );
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  }
}

async function openPrivateAppend(path: string): Promise<FileHandle> {
  const noFollow =
    process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow,
    PRIVATE_FILE_MODE,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new Error(
        `The Inspire diagnostics path is not a regular file: ${path}`,
      );
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(
        `The Inspire diagnostics file is not owned by the current user: ${path}`,
      );
    }
    if ((info.mode & 0o077) !== 0) await chmod(path, PRIVATE_FILE_MODE);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export class FileDiagnosticLogger implements DiagnosticLogger {
  readonly hostId: string;
  private readonly base: Record<string, unknown>;
  private readonly maxBytes: number;
  private readonly retainedFiles: number;
  private handle: FileHandle | null = null;
  private currentBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private reportedFailure = false;

  private constructor(
    private readonly path: string,
    options: FileDiagnosticLoggerOptions,
  ) {
    this.hostId = options.hostId ?? randomBytes(12).toString("base64url");
    this.base = sanitize(options.base ?? {}) as Record<string, unknown>;
    this.maxBytes = Math.max(64 * 1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.retainedFiles = Math.max(
      1,
      Math.min(20, options.retainedFiles ?? DEFAULT_RETAINED_FILES),
    );
  }

  static async open(
    options: FileDiagnosticLoggerOptions,
  ): Promise<FileDiagnosticLogger> {
    await verifyPrivateDirectory(
      dirname(options.path),
      options.createPrivateDirectory ?? false,
    );
    const logger = new FileDiagnosticLogger(options.path, options);
    logger.handle = await openPrivateAppend(options.path);
    logger.currentBytes = (await logger.handle.stat()).size;
    return logger;
  }

  record(
    level: DiagnosticLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    if (this.closed) return;
    const record = {
      ...this.base,
      ...(sanitize(fields) as Record<string, unknown>),
      timestamp: new Date().toISOString(),
      level,
      event: boundedString(event),
      hostId: this.hostId,
    };
    let encoded = `${JSON.stringify(record)}\n`;
    const originalBytes = Buffer.byteLength(encoded);
    if (originalBytes > MAX_RECORD_BYTES) {
      encoded = `${JSON.stringify({
        ...this.base,
        timestamp: record.timestamp,
        level,
        event: record.event,
        hostId: this.hostId,
        recordTruncated: true,
        originalBytes,
      })}\n`;
    }
    this.queue = this.queue
      .then(() => this.append(encoded))
      .catch((error) => {
        if (this.reportedFailure) return;
        this.reportedFailure = true;
        console.error(
          "Unable to persist Inspire diagnostics",
          error instanceof Error ? error.message : String(error),
        );
      });
  }

  private async append(encoded: string): Promise<void> {
    const bytes = Buffer.byteLength(encoded);
    if (this.currentBytes > 0 && this.currentBytes + bytes > this.maxBytes)
      await this.rotate();
    if (!this.handle) this.handle = await openPrivateAppend(this.path);
    await this.handle.write(encoded, undefined, "utf8");
    this.currentBytes += bytes;
  }

  private async rotate(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
    await rm(`${this.path}.${this.retainedFiles}`, { force: true });
    for (let index = this.retainedFiles - 1; index >= 1; index -= 1) {
      try {
        await rename(`${this.path}.${index}`, `${this.path}.${index + 1}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    try {
      await rename(this.path, `${this.path}.1`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.handle = await openPrivateAppend(this.path);
    this.currentBytes = 0;
  }

  async flush(): Promise<void> {
    await this.queue;
    await this.handle?.sync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    if (this.handle) {
      await this.handle.sync();
      await this.handle.close();
      this.handle = null;
    }
  }
}

export async function openDiagnosticLogger(
  options: FileDiagnosticLoggerOptions,
): Promise<DiagnosticLogger> {
  return FileDiagnosticLogger.open(options);
}

export function nullDiagnosticLogger(
  hostId = randomBytes(12).toString("base64url"),
): DiagnosticLogger {
  return {
    hostId,
    record: () => undefined,
    flush: async () => undefined,
    close: async () => undefined,
  };
}
