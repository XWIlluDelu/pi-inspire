import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { chmod, open, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION, SessionManager } from "./pi-runtime.js";

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;

export interface SessionForkWorkerRequest {
  sourcePath: string;
  sourceSessionId: string;
  sourceCommittedBytes: number;
  sourceFingerprint: string;
  stagingDir: string;
  targetId: string;
  targetParentId: string | null;
}

export interface SessionForkWorkerResult {
  destinationId: string;
  stagedPath: string;
  cwd: string;
  parentSessionPath: string;
  sessionName?: string;
}

interface ForkDestination {
  getHeader(): SessionHeader | null;
  getSessionId(): string;
  getSessionName(): string | undefined;
  getEntry(id: string): SessionEntry | undefined;
  getEntries(): SessionEntry[];
  getCwd(): string;
}

class WorkerInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRequest(value: unknown): SessionForkWorkerRequest {
  const record = objectValue(value);
  if (!record)
    throw new WorkerInputError("INVALID_REQUEST", "Expected an object");
  const stringFields = [
    "sourcePath",
    "sourceSessionId",
    "sourceFingerprint",
    "stagingDir",
    "targetId",
  ] as const;
  for (const field of stringFields) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new WorkerInputError("INVALID_REQUEST", `Invalid ${field}`);
    }
  }
  if (
    !Number.isSafeInteger(record.sourceCommittedBytes) ||
    Number(record.sourceCommittedBytes) <= 0
  ) {
    throw new WorkerInputError(
      "INVALID_REQUEST",
      "Invalid sourceCommittedBytes",
    );
  }
  if (
    record.targetParentId !== null &&
    (typeof record.targetParentId !== "string" ||
      record.targetParentId.length === 0)
  ) {
    throw new WorkerInputError("INVALID_REQUEST", "Invalid targetParentId");
  }
  return record as unknown as SessionForkWorkerRequest;
}

async function readHeader(path: string): Promise<SessionHeader> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) {
      throw new WorkerInputError(
        "SOURCE_FORMAT",
        "Source has no bounded complete header",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    } catch {
      throw new WorkerInputError(
        "SOURCE_FORMAT",
        "Source header is invalid JSON",
      );
    }
    const header = objectValue(parsed);
    if (
      !header ||
      header.type !== "session" ||
      typeof header.id !== "string" ||
      typeof header.cwd !== "string"
    ) {
      throw new WorkerInputError("SOURCE_FORMAT", "Source header is invalid");
    }
    if (header.version !== CURRENT_SESSION_VERSION) {
      throw new WorkerInputError(
        "SOURCE_FORMAT",
        `Source Session format ${String(header.version)} is not current`,
      );
    }
    return header as unknown as SessionHeader;
  } finally {
    await handle.close();
  }
}

async function hashPrefix(path: string, byteLength: number): Promise<string> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    while (offset < byteLength) {
      const requested = Math.min(buffer.length, byteLength - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (bytesRead === 0) {
        throw new WorkerInputError(
          "SOURCE_CHANGED",
          "Source became shorter than its admitted prefix",
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function snapshotVerifiedPrefix(
  sourcePath: string,
  snapshotPath: string,
  byteLength: number,
  expectedFingerprint: string,
): Promise<void> {
  const source = await open(sourcePath, "r");
  const snapshot = await open(snapshotPath, "wx", 0o600);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let sourceOffset = 0;
  try {
    while (sourceOffset < byteLength) {
      const requested = Math.min(buffer.length, byteLength - sourceOffset);
      const { bytesRead } = await source.read(
        buffer,
        0,
        requested,
        sourceOffset,
      );
      if (bytesRead === 0) {
        throw new WorkerInputError(
          "SOURCE_CHANGED",
          "Source became shorter than its admitted prefix",
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await snapshot.write(
          buffer,
          written,
          bytesRead - written,
          null,
        );
        if (result.bytesWritten === 0) {
          throw new WorkerInputError(
            "WORKER_FAILURE",
            "Could not materialize the source snapshot",
          );
        }
        written += result.bytesWritten;
      }
      sourceOffset += bytesRead;
    }
  } finally {
    await Promise.all([source.close(), snapshot.close()]);
  }
  if (hash.digest("hex") !== expectedFingerprint) {
    throw new WorkerInputError("SOURCE_CHANGED", "Source prefix changed");
  }
}

function isUserMessage(
  entry: SessionEntry | undefined,
): entry is SessionMessageEntry {
  return (
    entry?.type === "message" && objectValue(entry.message)?.role === "user"
  );
}

async function materializeCanonicalDestination(
  destinationPath: string,
  destination: ForkDestination,
  sourcePath: string,
): Promise<void> {
  const header = destination.getHeader();
  if (!header) {
    throw new WorkerInputError(
      "DESTINATION_INVALID",
      "Pi supplied no destination header",
    );
  }
  const entries = [
    { ...header, parentSession: sourcePath },
    ...destination.getEntries(),
  ];
  const contents = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(destinationPath, contents, { mode: 0o600 });
  await chmod(destinationPath, 0o600);
}

/** The one-shot operation intentionally constructs no AgentSession or resource
 * loader. SessionManager owns branch semantics over an exact verified snapshot;
 * the real source is never opened by Pi and is only read for attestation. */
async function runSessionForkWorker(
  rawRequest: unknown,
): Promise<SessionForkWorkerResult> {
  const request = parseRequest(rawRequest);
  const sourcePath = resolve(request.sourcePath);
  const stagingDir = resolve(request.stagingDir);
  if (resolve(dirname(stagingDir)) !== resolve(dirname(sourcePath))) {
    throw new WorkerInputError(
      "INVALID_REQUEST",
      "Staging and source must share a parent directory",
    );
  }

  const before = await stat(sourcePath, { bigint: true });
  if (!before.isFile() || before.size < BigInt(request.sourceCommittedBytes)) {
    throw new WorkerInputError("SOURCE_CHANGED", "Source identity changed");
  }
  const snapshotPath = resolve(stagingDir, "source-snapshot.jsonl");
  await snapshotVerifiedPrefix(
    sourcePath,
    snapshotPath,
    request.sourceCommittedBytes,
    request.sourceFingerprint,
  );
  const sourceHeader = await readHeader(snapshotPath);
  if (sourceHeader.id !== request.sourceSessionId) {
    throw new WorkerInputError("SOURCE_ID_MISMATCH", "Source identity changed");
  }

  const manager = SessionManager.open(snapshotPath, stagingDir);
  if (
    manager.getSessionId() !== request.sourceSessionId ||
    resolve(manager.getSessionFile() ?? "") !== snapshotPath
  ) {
    throw new WorkerInputError(
      "SOURCE_ID_MISMATCH",
      "Pi opened another source",
    );
  }
  const target = manager.getEntry(request.targetId);
  if (!isUserMessage(target) || target.parentId !== request.targetParentId) {
    throw new WorkerInputError("TARGET_INVALID", "Fork target changed");
  }

  // A user message with no structural parent is the only path Pi cannot branch
  // before. Create an empty canonical Session with the same parent provenance.
  if (request.targetParentId === null) {
    const empty = SessionManager.create(manager.getCwd(), stagingDir);
    empty.newSession({ parentSession: sourcePath });
    const emptyPath = empty.getSessionFile();
    if (!emptyPath) {
      throw new WorkerInputError(
        "DESTINATION_INVALID",
        "Pi supplied no destination path",
      );
    }
    await materializeCanonicalDestination(emptyPath, empty, sourcePath);
    return finishResult(request, sourcePath, before, empty, emptyPath);
  }
  const destinationPath = manager.createBranchedSession(request.targetParentId);
  if (!destinationPath) {
    throw new WorkerInputError(
      "DESTINATION_INVALID",
      "Pi supplied no destination path",
    );
  }
  await materializeCanonicalDestination(destinationPath, manager, sourcePath);
  return finishResult(request, sourcePath, before, manager, destinationPath);
}

async function finishResult(
  request: SessionForkWorkerRequest,
  sourcePath: string,
  before: BigIntStats,
  destination: ForkDestination,
  destinationPath: string,
): Promise<SessionForkWorkerResult> {
  const after = await stat(sourcePath, { bigint: true });
  if (
    !after.isFile() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size < BigInt(request.sourceCommittedBytes) ||
    (await hashPrefix(sourcePath, request.sourceCommittedBytes)) !==
      request.sourceFingerprint
  ) {
    throw new WorkerInputError(
      "SOURCE_CHANGED",
      "Source prefix changed during fork",
    );
  }
  const header = destination.getHeader();
  const persistedHeader = await readHeader(destinationPath);
  const resolvedDestination = resolve(destinationPath);
  if (
    !header ||
    header.id !== destination.getSessionId() ||
    persistedHeader.id !== destination.getSessionId() ||
    resolve(persistedHeader.parentSession ?? "") !== sourcePath ||
    resolve(dirname(resolvedDestination)) !== resolve(request.stagingDir) ||
    destination.getEntry(request.targetId)
  ) {
    throw new WorkerInputError(
      "DESTINATION_INVALID",
      "Pi produced an invalid branch",
    );
  }
  return {
    destinationId: destination.getSessionId(),
    stagedPath: resolvedDestination,
    cwd: destination.getCwd(),
    parentSessionPath: sourcePath,
    sessionName: destination.getSessionName(),
  };
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new WorkerInputError("INVALID_REQUEST", "Request is too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main(): Promise<void> {
  try {
    const result = await runSessionForkWorker(await readStdin());
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    const code =
      error instanceof WorkerInputError ? error.code : "WORKER_FAILURE";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (
  invokedPath === import.meta.url ||
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  void main();
}
