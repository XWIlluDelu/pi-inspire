import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  type Hash,
} from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import type {
  SessionEntry,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";
import {
  buildContextEntries,
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  sessionEntryToContextMessages,
} from "./pi-runtime.js";
import type {
  BranchTreeResponse,
  ComposerHistoryPage,
  ProjectionHealth,
  TranscriptActivityKind,
  TranscriptActivityPage,
  TranscriptActivityRange,
  TranscriptPage,
  UserTurnAnchor,
  UserTurnIndexPage,
  UserTurnTranscriptPage,
} from "../shared/contracts.js";
import { messageFallbackCorrelation } from "../shared/message-identity.js";
import { projectComposerHistoryPage } from "./composer-history.js";
import type { SessionRecord } from "./session-catalog.js";
import {
  BRANCH_TREE_MAX_BYTES,
  boundedUserText,
  projectSessionTree,
} from "./session-tree.js";
import { samePersistedJson } from "./persisted-json.js";
import { projectSafeValue } from "./safe-projection.js";
import { JsonlObjectDecoder } from "./session-jsonl.js";

export { MAX_PERSISTED_ENTRY_BYTES } from "./session-jsonl.js";
/** Includes the complete JSON representation of a TranscriptPage. */
export const TRANSCRIPT_PAGE_MAX_BYTES = 1024 * 1024;
export const TRANSCRIPT_PAGE_MAX_MESSAGES = 100;
const USER_TURN_INDEX_PAGE_SIZE = 100;
const USER_TURN_SNIPPET_CHARS = 180;
const USER_TURN_INDEX_MAX_BYTES = 128 * 1024;
/** Per-slot reconnect-only live messages are separately bounded by runtime. */
export const TRANSIENT_OVERLAY_MAX_BYTES = 512 * 1024;

const WATCH_DEBOUNCE_MS = 75;
const RECONCILE_INTERVAL_MS = 750;
const CURSOR_KEY = randomBytes(32);
interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface Candidate {
  identity: FileIdentity;
  fingerprint: string;
  hashState: Hash;
  committedBytes: number;
  uncommittedBytes: number;
  uncommittedFingerprint: string | null;
  /** Fingerprints observed from this same read, never a later filesystem pass. */
  previousPrefixFingerprint: string | null;
  previousTailFingerprint: string | null;
  header: SessionHeader;
  entries: SessionEntry[];
  entriesById: Map<string, SessionEntry>;
  messages: unknown[];
  model: unknown;
  thinkingLevel: string;
  leafId: string | null;
}

export type InitialMaterializationAttestation =
  | "partial"
  | "complete"
  | "mismatch";

type ProjectionMessageChange = "none" | "append" | "replace";

export interface ProjectionReconcileResult {
  changed: boolean;
  /** This observation belongs to the new-session file's first materialization. */
  initialMaterialization: boolean;
  /** Physical JSONL movement; distinct from the projected message view. */
  kind: "none" | "append" | "rewrite";
  /** Whether the projected active-path message sequence stayed stable, grew by suffix, or was replaced. */
  messageChange: ProjectionMessageChange;
  previousRevision: number;
  revision: number;
  previousFingerprint: string;
  fingerprint: string;
  healthChanged: boolean;
  /** Full file identity or unresolved-tail state moved even if no entry committed. */
  sourceChanged: boolean;
  previousSourceVersion: string | null;
  sourceVersion: string | null;
  uncommittedBytes: number;
  previousUncommittedBytes: number;
  /** A prior unresolved tail is an exact prefix of this candidate's post-commit bytes. */
  previousTailVerified: boolean;
  /** Exact migrated entries added after the previously verified prefix. */
  appendedEntries?: readonly SessionEntry[];
  previousLeafId?: string | null;
}

export interface ProjectionEntryTarget {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
}

export interface SessionProjectionView {
  readonly sessionId: string;
  readonly path: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly health: ProjectionHealth;
  readonly messages: readonly unknown[];
  readonly model: unknown;
  readonly thinkingLevel: string;
  readonly leafId: string | null;
  readonly tailEntryId: string | null;
  /** Stable only while the projection still addresses the same filesystem object. */
  readonly sourceIdentity: string | null;
  /** Exact stat version used to reject any pre-start disk movement. */
  readonly sourceVersion: string | null;
  readonly committedBytes: number;
  readonly uncommittedBytes: number;
  readonly uncommittedFingerprint: string | null;
  attestInitialMaterialization(
    cwd: string,
    workerEntries: readonly SessionEntry[],
  ): InitialMaterializationAttestation;
  hasActiveEntryType(type: string): boolean;
  suspendReconciliation(): Promise<void>;
  resumeReconciliation(): void;
  /** Reuse the verified content-hash prefix only while the Host has an exact
   * append claim from the sole writer for this projection. */
  setOwnedAppendWindow?(isOpen: () => boolean): void;
  latestPage(
    overlay?: readonly unknown[],
    effectiveLeafId?: string | null,
    viewId?: string,
  ): TranscriptPage;
  page(
    cursor: string,
    effectiveLeafId?: string | null,
    viewId?: string,
  ): TranscriptPage;
  visiblePage(
    cursor: string,
    effectiveLeafId?: string | null,
    viewId?: string,
  ): TranscriptPage;
  activityPage(
    cursor: string,
    effectiveLeafId?: string | null,
    viewId?: string,
  ): TranscriptActivityPage;
  userTurnIndexPage(
    start?: number,
    effectiveLeafId?: string | null,
    viewId?: string,
  ): UserTurnIndexPage;
  userTurnTranscriptPage(
    targetMessageId: string,
    effectiveLeafId?: string | null,
    viewId?: string,
    cursor?: string,
  ): UserTurnTranscriptPage;
  composerHistoryPage(
    start?: number,
    effectiveLeafId?: string | null,
    viewId?: string,
  ): ComposerHistoryPage;
  branchTree(effectiveLeafId?: string | null): BranchTreeResponse;
  entry(id: string): ProjectionEntryTarget | null;
  persistedEntryMatches(entry: SessionEntry): boolean;
  userText(id: string, maxChars: number): string;
  viewMessages(effectiveLeafId?: string | null): readonly unknown[];
  reconcile(force?: boolean): Promise<ProjectionReconcileResult>;
  /** Host startup attestation only: reconcile while ordinary readers are suspended. */
  reconcileSuspended(force?: boolean): Promise<ProjectionReconcileResult>;
  close(): Promise<void>;
  on(
    event: "update",
    listener: (result: ProjectionReconcileResult) => void,
  ): this;
}

function identity(
  details: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): FileIdentity {
  const value = details as unknown as {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function sameObject(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left: FileIdentity, right: FileIdentity): boolean {
  return (
    sameObject(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function indexSessionEntries(
  entries: readonly SessionEntry[],
  existing: ReadonlyMap<string, SessionEntry> = new Map(),
): Map<string, SessionEntry> {
  const byId = new Map(existing);
  for (const entry of entries) {
    if (
      typeof entry.type !== "string" ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      (entry.parentId !== null && typeof entry.parentId !== "string")
    )
      throw new Error("Persisted session contains an invalid entry identity");
    if (byId.has(entry.id))
      throw new Error(`Persisted session contains duplicate entry ${entry.id}`);
    if (entry.parentId !== null && !byId.has(entry.parentId))
      throw new Error(
        `Persisted session entry ${entry.id} has a missing or forward parent`,
      );
    byId.set(entry.id, entry);
  }
  return byId;
}

function contextMessages(
  entries: SessionEntry[],
  leafId: string | null,
  byId: Map<string, SessionEntry>,
): unknown[] {
  const messages = buildContextEntries(entries, leafId, byId).flatMap((entry) =>
    sessionEntryToContextMessages(entry).map((message, index) => ({
      ...message,
      __inspireMessageId: `${entry.id}:${index}`,
      __inspireEntryId: entry.id,
    })),
  );
  let turnOrdinal = -1;
  let turnId: string | null = null;
  return messages.map((message) => {
    if (message.role === "user") {
      turnOrdinal += 1;
      turnId = message.__inspireMessageId;
    }
    return {
      ...message,
      ...(turnId !== null
        ? {
            __inspireUserTurnId: turnId,
            __inspireUserTurnIndex: turnOrdinal,
          }
        : {}),
    };
  });
}

function appendContextMessages(
  previous: readonly unknown[],
  entries: readonly SessionEntry[],
): unknown[] {
  let turnOrdinal = -1;
  let turnId: string | null = null;
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const value = previous[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (
      Number.isSafeInteger(record.__inspireUserTurnIndex) &&
      typeof record.__inspireUserTurnId === "string"
    ) {
      turnOrdinal = record.__inspireUserTurnIndex as number;
      turnId = record.__inspireUserTurnId;
      break;
    }
  }
  const appended = entries.flatMap((entry) =>
    sessionEntryToContextMessages(entry).map((message, index) => {
      const id = `${entry.id}:${index}`;
      if (message.role === "user") {
        turnOrdinal += 1;
        turnId = id;
      }
      return {
        ...message,
        __inspireMessageId: id,
        __inspireEntryId: entry.id,
        ...(turnId !== null
          ? {
              __inspireUserTurnId: turnId,
              __inspireUserTurnIndex: turnOrdinal,
            }
          : {}),
      };
    }),
  );
  return [...previous, ...appended];
}

function appendedContextSettings(
  currentModel: unknown,
  currentThinkingLevel: string,
  entries: readonly SessionEntry[],
): { model: unknown; thinkingLevel: string } {
  let model = currentModel;
  let thinkingLevel = currentThinkingLevel;
  for (const entry of entries) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, id: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = {
        provider: entry.message.provider,
        id: entry.message.model,
      };
    }
  }
  return { model, thinkingLevel };
}

function isLinearAppend(
  currentLeafId: string | null,
  entries: readonly SessionEntry[],
): boolean {
  let parentId = currentLeafId;
  for (const entry of entries) {
    if (
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      entry.parentId !== parentId
    )
      return false;
    parentId = entry.id;
  }
  return !entries.some((entry) => entry.type === "compaction");
}

function projectedMessageId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).__inspireMessageId;
  return typeof id === "string" ? id : null;
}

function projectedMessageChange(
  physicalKind: ProjectionReconcileResult["kind"],
  previous: readonly unknown[],
  next: readonly unknown[],
): ProjectionMessageChange {
  if (physicalKind === "rewrite") return "replace";
  if (previous.length > next.length) return "replace";
  const prefixMatches = previous.every((message, index) => {
    const previousId = projectedMessageId(message);
    const nextId = projectedMessageId(next[index]);
    return previousId !== null && previousId === nextId;
  });
  if (!prefixMatches) return "replace";
  return previous.length === next.length ? "none" : "append";
}

interface BoundedTranscriptItem {
  value: unknown;
  serialized: string;
}

/** Pi persists embedded image bytes in the canonical message. The browser only
 * needs their MIME and stable message/part coordinates: content is fetched
 * through the existing session-bound resource adapter when a thumbnail mounts. */
function withoutPersistedImageData(
  value: unknown,
  persistedIndex: number | undefined,
): unknown {
  if (
    persistedIndex === undefined ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.content)) return value;
  let changed = false;
  const content = record.content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    const item = part as Record<string, unknown>;
    if (item.type !== "image" || typeof item.data !== "string") return part;
    const { data: _data, ...metadata } = item;
    changed = true;
    return metadata;
  });
  return changed ? { ...record, content } : value;
}

/** Browser projection, not persisted data: constrain breadth/depth and strings.
 * The optional persisted index is applied before the item's sole serialization. */
function boundedTranscriptItem(
  value: unknown,
  persistedIndex?: number,
): BoundedTranscriptItem {
  const browserValue = withoutPersistedImageData(value, persistedIndex);
  const sourceRecord =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const identityMetadata = sourceRecord
    ? {
        ...(typeof sourceRecord.__inspireMessageId === "string"
          ? { __inspireMessageId: sourceRecord.__inspireMessageId }
          : {}),
        ...(typeof sourceRecord.__inspireEntryId === "string"
          ? { __inspireEntryId: sourceRecord.__inspireEntryId }
          : {}),
        ...(typeof sourceRecord.__inspireLiveId === "string"
          ? { __inspireLiveId: sourceRecord.__inspireLiveId }
          : {}),
        ...(typeof sourceRecord.__inspireSettled === "boolean"
          ? { __inspireSettled: sourceRecord.__inspireSettled }
          : {}),
        ...(typeof sourceRecord.__inspireUserTurnId === "string"
          ? { __inspireUserTurnId: sourceRecord.__inspireUserTurnId }
          : {}),
        ...(Number.isSafeInteger(sourceRecord.__inspireUserTurnIndex)
          ? { __inspireUserTurnIndex: sourceRecord.__inspireUserTurnIndex }
          : {}),
      }
    : {};
  const decorate = (projected: unknown): unknown =>
    projected && typeof projected === "object" && !Array.isArray(projected)
      ? {
          ...(projected as Record<string, unknown>),
          ...identityMetadata,
          ...(persistedIndex !== undefined
            ? { __inspireMessageIndex: persistedIndex }
            : {}),
        }
      : projected;
  for (const limits of [
    { depth: 16, stringChars: 64_000, arrayItems: 256, objectEntries: 256 },
    { depth: 8, stringChars: 2_000, arrayItems: 32, objectEntries: 32 },
  ]) {
    const projected = decorate(projectSafeValue(browserValue, limits));
    const serialized = JSON.stringify(projected) ?? "null";
    if (Buffer.byteLength(serialized) <= 256 * 1024)
      return { value: projected, serialized };
  }
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const role = typeof record.role === "string" ? record.role : "unknown";
  const omitted =
    "[message omitted: projected content exceeded the transcript item limit]";
  const projected = decorate({
    role,
    ...(record.timestamp !== undefined ? { timestamp: record.timestamp } : {}),
    ...(typeof record.display === "boolean" ? { display: record.display } : {}),
    ...(typeof record.toolCallId === "string"
      ? { toolCallId: record.toolCallId }
      : {}),
    ...(typeof record.toolName === "string"
      ? { toolName: record.toolName }
      : {}),
    content:
      role === "assistant" && !isVisibleTranscriptBoundary(value)
        ? [{ type: "projectionOmitted", content: omitted }]
        : omitted,
  });
  return { value: projected, serialized: JSON.stringify(projected) };
}

export function boundedTranscriptValue(value: unknown): unknown {
  return boundedTranscriptItem(value).value;
}

function isVisibleTranscriptBoundary(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.role === "user") return true;
  if (record.role !== "assistant") return false;
  if (typeof record.content === "string") return record.content.length > 0;
  return (
    Array.isArray(record.content) &&
    record.content.some(
      (part) =>
        part !== null &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string" &&
        String((part as Record<string, unknown>).text).length > 0,
    )
  );
}

function userTurnSnippet(value: unknown): {
  snippet: string;
  attachmentCount: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { snippet: "User message", attachmentCount: 0 };
  const record = value as Record<string, unknown>;
  const text: string[] = [];
  let attachmentCount = 0;
  if (typeof record.content === "string") text.push(record.content);
  else if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string")
        text.push(item.text);
      else if (item.type === "image") attachmentCount += 1;
    }
  }
  const normalized = text.join(" ").replace(/\s+/g, " ").trim();
  return {
    snippet:
      normalized.length > 0
        ? Array.from(normalized.slice(0, USER_TURN_SNIPPET_CHARS * 2))
            .slice(0, USER_TURN_SNIPPET_CHARS)
            .join("")
        : attachmentCount > 0
          ? attachmentCount === 1
            ? "Image attachment"
            : `${attachmentCount} image attachments`
          : "User message",
    attachmentCount,
  };
}

function projectedTimestamp(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const raw = (value as Record<string, unknown>).timestamp;
  if (typeof raw !== "string" && typeof raw !== "number") return;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function deferredActivityKinds(value: unknown): TranscriptActivityKind[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (record.role === "assistant") {
    if (!Array.isArray(record.content)) return [];
    let thinking = false;
    let tool = false;
    for (const part of record.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const type = (part as Record<string, unknown>).type;
      if (type === "text") continue;
      if (type === "thinking") thinking = true;
      else tool = true;
    }
    return [
      ...(thinking ? (["thinking"] as const) : []),
      ...(tool ? (["tool"] as const) : []),
    ];
  }
  if (record.role === "custom" && record.display === false) return [];
  return ["tool"];
}

function signedCursor(payloadValue: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(payloadValue)).toString(
    "base64url",
  );
  const signature = createHmac("sha256", CURSOR_KEY)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function cursorFor(
  sessionId: string,
  incarnation: string,
  fingerprint: string,
  revision: number,
  before: number,
  effectiveLeafId: string | null,
  viewId: string,
): string {
  return signedCursor({
    sessionId,
    incarnation,
    fingerprint,
    revision,
    before,
    effectiveLeafId,
    viewId,
  });
}

function activityCursorFor(
  sessionId: string,
  incarnation: string,
  fingerprint: string,
  revision: number,
  start: number,
  before: number,
  effectiveLeafId: string | null,
  viewId: string,
): string {
  return signedCursor({
    kind: "activity",
    sessionId,
    incarnation,
    fingerprint,
    revision,
    start,
    before,
    effectiveLeafId,
    viewId,
  });
}

function userTurnCursorFor(
  sessionId: string,
  incarnation: string,
  fingerprint: string,
  revision: number,
  target: number,
  after: number,
  effectiveLeafId: string | null,
  viewId: string,
): string {
  return signedCursor({
    kind: "user-turn",
    sessionId,
    incarnation,
    fingerprint,
    revision,
    start: target,
    before: after,
    effectiveLeafId,
    viewId,
  });
}

interface ParsedCursor {
  kind: "page" | "activity" | "user-turn";
  sessionId: string;
  incarnation: string;
  fingerprint: string;
  revision: number;
  start: number;
  before: number;
  effectiveLeafId: string | null;
  viewId: string;
}

function parseCursor(cursor: string): ParsedCursor {
  const [payload, supplied] = cursor.split(".");
  if (!payload || !supplied)
    throw Object.assign(new Error("Transcript cursor is invalid"), {
      status: 400,
    });
  const expected = createHmac("sha256", CURSOR_KEY).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(supplied, "base64url");
  } catch {
    throw Object.assign(new Error("Transcript cursor is invalid"), {
      status: 400,
    });
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw Object.assign(new Error("Transcript cursor is invalid"), {
      status: 400,
    });
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.sessionId !== "string" ||
      typeof parsed.incarnation !== "string" ||
      typeof parsed.fingerprint !== "string" ||
      !Number.isSafeInteger(parsed.revision) ||
      !Number.isSafeInteger(parsed.before) ||
      Number(parsed.before) < 0 ||
      (parsed.effectiveLeafId !== null &&
        typeof parsed.effectiveLeafId !== "string") ||
      typeof parsed.viewId !== "string" ||
      !parsed.viewId ||
      (parsed.kind !== undefined &&
        parsed.kind !== "activity" &&
        parsed.kind !== "user-turn") ||
      ((parsed.kind === "activity" || parsed.kind === "user-turn") &&
        (!Number.isSafeInteger(parsed.start) ||
          Number(parsed.start) < 0 ||
          Number(parsed.start) > Number(parsed.before)))
    )
      throw new Error("invalid");
    return {
      kind:
        parsed.kind === "activity"
          ? "activity"
          : parsed.kind === "user-turn"
            ? "user-turn"
            : "page",
      sessionId: parsed.sessionId,
      incarnation: parsed.incarnation,
      fingerprint: parsed.fingerprint,
      revision: Number(parsed.revision),
      start:
        parsed.kind === "activity" || parsed.kind === "user-turn"
          ? Number(parsed.start)
          : 0,
      before: Number(parsed.before),
      effectiveLeafId: parsed.effectiveLeafId,
      viewId: parsed.viewId,
    };
  } catch {
    throw Object.assign(new Error("Transcript cursor is invalid"), {
      status: 400,
    });
  }
}

function healthError(error: unknown): ProjectionHealth {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "error", message };
}

export interface SessionProjectionReadHooks {
  afterFullReadChunk?(): Promise<void> | void;
  afterPrefixReadChunk?(): Promise<void> | void;
  afterMessageProjection?(): void;
}

export class SessionProjection
  extends EventEmitter
  implements SessionProjectionView
{
  readonly sessionId: string;
  readonly path: string;
  private currentRevision = 0;
  private readonly incarnation = randomBytes(18).toString("base64url");
  private appendFromRevision = 0;
  private readonly revisionFingerprints = new Map<number, string>();
  private currentHealth: ProjectionHealth = { status: "ok" };
  private currentMessages: unknown[] = [];
  private currentModel: unknown = null;
  private currentThinkingLevel = "off";
  private currentLeafId: string | null = null;
  private currentEntries: SessionEntry[] = [];
  private currentEntriesById = new Map<string, SessionEntry>();
  private readonly userTurnIndexes = new Map<
    string,
    { revision: number; turns: readonly UserTurnAnchor[] }
  >();
  private currentHeader: SessionHeader | null = null;
  private currentIdentity: FileIdentity | null = null;
  private currentFingerprint = "";
  private currentHashState: Hash | null = null;
  private currentCommittedBytes = 0;
  private currentUncommittedBytes = 0;
  private currentUncommittedFingerprint: string | null = null;
  private reconcileTail: Promise<ProjectionReconcileResult> = Promise.resolve({
    changed: false,
    initialMaterialization: false,
    kind: "none",
    messageChange: "none",
    previousRevision: 0,
    revision: 0,
    previousFingerprint: "",
    fingerprint: "",
    healthChanged: false,
    sourceChanged: false,
    previousSourceVersion: null,
    sourceVersion: null,
    uncommittedBytes: 0,
    previousUncommittedBytes: 0,
    previousTailVerified: true,
  });
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconciliationResume: Promise<void> | null = null;
  private resolveReconciliationResume: (() => void) | null = null;
  private closed = false;
  private ownedAppendWindow: () => boolean = () => false;
  /** Pi reserves a path for a new session but delays creating the JSONL.
   * Only new-session ownership may enter this state; it remains active across
   * complete-line prefixes until disk catches the creating worker's entries. */
  private initialMaterializationPending: boolean;

  private constructor(
    session: SessionRecord,
    private readonly readHooks?: SessionProjectionReadHooks,
    initialMaterializationPending = false,
  ) {
    super();
    this.sessionId = session.id;
    this.path = resolve(session.path);
    this.initialMaterializationPending = initialMaterializationPending;
    if (initialMaterializationPending) {
      this.currentRevision = 1;
      this.appendFromRevision = 1;
      this.revisionFingerprints.set(1, "");
    }
  }

  private static async openMode(
    session: SessionRecord,
    readHooks: SessionProjectionReadHooks | undefined,
    initialMaterializationPending: boolean,
  ): Promise<SessionProjection> {
    const projection = new SessionProjection(
      session,
      readHooks,
      initialMaterializationPending,
    );
    const result = await projection.reconcile(true);
    const loaded = initialMaterializationPending
      ? projection.health.status !== "error"
      : projection.revision > 0;
    if (!loaded) {
      await projection.close();
      throw Object.assign(
        new Error(
          projection.health.message ?? "Session projection could not be loaded",
        ),
        { status: 422 },
      );
    }
    projection.startWatching();
    if (result.changed) projection.emit("update", result);
    return projection;
  }

  static open(
    session: SessionRecord,
    readHooks?: SessionProjectionReadHooks,
  ): Promise<SessionProjection> {
    return SessionProjection.openMode(session, readHooks, false);
  }

  /** Create the sole projection for a Pi-owned new session whose reported
   * path may not exist until Pi flushes its first assistant message. */
  static openPending(
    session: SessionRecord,
    readHooks?: SessionProjectionReadHooks,
  ): Promise<SessionProjection> {
    return SessionProjection.openMode(session, readHooks, true);
  }

  get revision(): number {
    return this.currentRevision;
  }
  get fingerprint(): string {
    return this.currentFingerprint;
  }
  get health(): ProjectionHealth {
    return this.currentHealth;
  }
  get messages(): readonly unknown[] {
    return this.currentMessages;
  }
  get model(): unknown {
    return this.currentModel;
  }
  get thinkingLevel(): string {
    return this.currentThinkingLevel;
  }
  get leafId(): string | null {
    return this.currentLeafId;
  }
  get tailEntryId(): string | null {
    return this.currentEntries.at(-1)?.id ?? null;
  }
  get sourceIdentity(): string | null {
    return this.currentIdentity
      ? `${this.currentIdentity.dev}:${this.currentIdentity.ino}`
      : null;
  }
  get sourceVersion(): string | null {
    const value = this.currentIdentity;
    return value
      ? `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`
      : null;
  }
  attestInitialMaterialization(
    cwd: string,
    workerEntries: readonly SessionEntry[],
  ): InitialMaterializationAttestation {
    const header = this.currentHeader;
    if (
      !this.initialMaterializationPending ||
      !header ||
      header.version !== CURRENT_SESSION_VERSION ||
      resolve(header.cwd) !== resolve(cwd) ||
      header.parentSession !== undefined ||
      this.currentEntries.length > workerEntries.length ||
      !samePersistedJson(
        this.currentEntries,
        workerEntries.slice(0, this.currentEntries.length),
      )
    )
      return "mismatch";
    if (
      this.currentEntries.length < workerEntries.length ||
      this.currentUncommittedBytes > 0
    )
      return "partial";
    this.initialMaterializationPending = false;
    return "complete";
  }
  get committedBytes(): number {
    return this.currentCommittedBytes;
  }
  get uncommittedBytes(): number {
    return this.currentUncommittedBytes;
  }
  get uncommittedFingerprint(): string | null {
    return this.currentUncommittedFingerprint;
  }

  hasActiveEntryType(type: string): boolean {
    const seen = new Set<string>();
    let id = this.currentLeafId;
    while (id !== null) {
      if (seen.has(id)) return false;
      seen.add(id);
      const entry = this.currentEntriesById.get(id);
      if (!entry) return false;
      if (entry.type === type) return true;
      id = entry.parentId;
    }
    return false;
  }

  async suspendReconciliation(): Promise<void> {
    if (!this.reconciliationResume) {
      this.reconciliationResume = new Promise<void>((resolveResume) => {
        this.resolveReconciliationResume = resolveResume;
      });
    }
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watchTimer = null;
    this.pollTimer = null;
    this.watcher?.close();
    this.watcher = null;
    await this.reconcileTail;
  }

  resumeReconciliation(): void {
    this.resolveReconciliationResume?.();
    this.resolveReconciliationResume = null;
    this.reconciliationResume = null;
    if (!this.closed && !this.watcher && !this.pollTimer) this.startWatching();
  }

  setOwnedAppendWindow(isOpen: () => boolean): void {
    this.ownedAppendWindow = isOpen;
  }

  entry(id: string): ProjectionEntryTarget | null {
    const found = this.currentEntriesById.get(id);
    if (!found) return null;
    return {
      id: found.id,
      parentId: found.parentId,
      type: found.type,
      ...(found.type === "message" &&
      typeof (found.message as { role?: unknown }).role === "string"
        ? { role: (found.message as { role: string }).role }
        : {}),
    };
  }

  persistedEntryMatches(entry: SessionEntry): boolean {
    const found = this.currentEntriesById.get(entry.id);
    return found !== undefined && samePersistedJson(found, entry);
  }

  userText(id: string, maxChars: number): string {
    const entry = this.currentEntriesById.get(id);
    if (!entry)
      throw Object.assign(new Error("Branch target does not exist"), {
        status: 404,
      });
    return boundedUserText(entry, maxChars);
  }

  branchTree(
    effectiveLeafId: string | null = this.currentLeafId,
  ): BranchTreeResponse {
    if (
      effectiveLeafId !== null &&
      !this.currentEntriesById.has(effectiveLeafId)
    ) {
      throw Object.assign(new Error("Effective branch leaf does not exist"), {
        status: 409,
      });
    }
    const tree = projectSessionTree(this.currentEntries, effectiveLeafId);
    const response: BranchTreeResponse = {
      sessionId: this.sessionId,
      revision: this.revision,
      incarnation: this.incarnation,
      durableLeafId: this.currentLeafId,
      effectiveLeafId,
      activePath: tree.activePath,
      nodes: tree.nodes,
      truncated: tree.truncated,
      health: this.health,
    };
    if (Buffer.byteLength(JSON.stringify(response)) > BRANCH_TREE_MAX_BYTES) {
      throw Object.assign(
        new Error("Session tree response exceeds its serialized limit"),
        { status: 422 },
      );
    }
    return response;
  }

  viewMessages(
    effectiveLeafId: string | null = this.currentLeafId,
  ): readonly unknown[] {
    if (effectiveLeafId === this.currentLeafId) return this.currentMessages;
    if (
      effectiveLeafId !== null &&
      !this.currentEntriesById.has(effectiveLeafId)
    ) {
      throw Object.assign(new Error("Effective branch leaf does not exist"), {
        status: 409,
      });
    }
    return contextMessages(
      this.currentEntries,
      effectiveLeafId,
      this.currentEntriesById,
    );
  }

  private startWatching(): void {
    if (this.closed || this.watcher || this.pollTimer) return;
    try {
      this.watcher = watch(
        dirname(this.path),
        { persistent: false },
        (_event, name) => {
          if (name && String(name) !== basename(this.path)) return;
          if (this.watchTimer) clearTimeout(this.watchTimer);
          this.watchTimer = setTimeout(() => {
            this.watchTimer = null;
            this.reconcileFromHint();
          }, WATCH_DEBOUNCE_MS);
          this.watchTimer.unref?.();
        },
      );
      this.watcher.on("error", (error) => {
        if (this.closed) return;
        const previous = this.currentHealth;
        this.currentHealth = healthError(
          new Error(`Session watch failed: ${error.message}`),
        );
        if (JSON.stringify(previous) !== JSON.stringify(this.currentHealth)) {
          this.emit("update", {
            changed: false,
            initialMaterialization: this.initialMaterializationPending,
            kind: "none",
            messageChange: "none",
            previousRevision: this.revision,
            revision: this.revision,
            previousFingerprint: this.fingerprint,
            fingerprint: this.fingerprint,
            healthChanged: true,
            sourceChanged: false,
            previousSourceVersion: this.sourceVersion,
            sourceVersion: this.sourceVersion,
            uncommittedBytes: this.uncommittedBytes,
            previousUncommittedBytes: this.uncommittedBytes,
            previousTailVerified: true,
          } satisfies ProjectionReconcileResult);
        }
      });
    } catch (error) {
      this.currentHealth = healthError(error);
    }
    this.pollTimer = setInterval(
      () => this.reconcileFromHint(),
      RECONCILE_INTERVAL_MS,
    );
    this.pollTimer.unref?.();
  }

  private reconcileFromHint(): void {
    void this.reconcile()
      .then((result) => {
        if (result.changed || result.healthChanged || result.sourceChanged)
          this.emit("update", result);
      })
      .catch((error) => {
        if (this.closed) return;
        const previous = JSON.stringify(this.currentHealth);
        this.currentHealth = healthError(error);
        if (previous !== JSON.stringify(this.currentHealth)) {
          this.emit("update", {
            changed: false,
            initialMaterialization: this.initialMaterializationPending,
            kind: "none",
            messageChange: "none",
            previousRevision: this.revision,
            revision: this.revision,
            previousFingerprint: this.fingerprint,
            fingerprint: this.fingerprint,
            healthChanged: true,
            sourceChanged: false,
            previousSourceVersion: this.sourceVersion,
            sourceVersion: this.sourceVersion,
            uncommittedBytes: this.uncommittedBytes,
            previousUncommittedBytes: this.uncommittedBytes,
            previousTailVerified: true,
          } satisfies ProjectionReconcileResult);
        }
      });
  }

  async reconcile(force = false): Promise<ProjectionReconcileResult> {
    const resume = this.reconciliationResume;
    if (resume) await resume;
    return this.enqueueReconcile(force);
  }

  reconcileSuspended(force = false): Promise<ProjectionReconcileResult> {
    return this.enqueueReconcile(force);
  }

  private enqueueReconcile(force: boolean): Promise<ProjectionReconcileResult> {
    const run = this.reconcileTail.then(
      () => this.reconcileOnce(force),
      () => this.reconcileOnce(force),
    );
    this.reconcileTail = run;
    return run;
  }

  private async reconcileOnce(
    force: boolean,
  ): Promise<ProjectionReconcileResult> {
    if (this.closed) throw new Error("Session projection is closed");
    const previousRevision = this.revision;
    const previousFingerprint = this.fingerprint;
    const previousHealth = JSON.stringify(this.health);
    const previousSourceVersion = this.sourceVersion;
    const previousUncommittedBytes = this.uncommittedBytes;
    const previousUncommittedFingerprint = this.uncommittedFingerprint;
    const initialMaterialization = this.initialMaterializationPending;
    try {
      if (!force && this.currentIdentity) {
        const details = await stat(this.path, { bigint: true });
        const next = identity(details as never);
        if (
          sameObject(next, this.currentIdentity) &&
          next.size === this.currentIdentity.size &&
          next.mtimeNs === this.currentIdentity.mtimeNs &&
          next.ctimeNs === this.currentIdentity.ctimeNs
        ) {
          return {
            changed: false,
            initialMaterialization,
            kind: "none",
            messageChange: "none",
            previousRevision,
            revision: this.revision,
            previousFingerprint,
            fingerprint: this.fingerprint,
            healthChanged: false,
            sourceChanged: false,
            previousSourceVersion: this.sourceVersion,
            sourceVersion: this.sourceVersion,
            uncommittedBytes: this.uncommittedBytes,
            previousUncommittedBytes: this.uncommittedBytes,
            previousTailVerified: true,
          };
        }
      }

      const candidate =
        (await this.tryReadAppendCandidate()) ?? (await this.readCandidate());
      const initialFileAppearance =
        initialMaterialization && this.currentIdentity === null;
      const changed = candidate.fingerprint !== this.currentFingerprint;
      const previousEntries = this.currentEntries;
      const previousLeafId = this.currentLeafId;
      let kind: ProjectionReconcileResult["kind"] = "none";
      let messageChange: ProjectionMessageChange = "none";
      let appendedEntries: SessionEntry[] | undefined;
      if (changed) {
        const prefixVerified =
          this.currentCommittedBytes === 0 ||
          candidate.previousPrefixFingerprint === this.currentFingerprint;
        const tailVerified =
          previousUncommittedBytes === 0 ||
          candidate.previousTailFingerprint === previousUncommittedFingerprint;
        kind =
          initialFileAppearance ||
          (this.currentIdentity &&
            sameObject(candidate.identity, this.currentIdentity) &&
            candidate.committedBytes >= this.currentCommittedBytes &&
            this.currentFingerprint &&
            prefixVerified &&
            tailVerified)
            ? "append"
            : "rewrite";
        if (
          kind === "append" &&
          previousEntries.every(
            (entry, index) => candidate.entries[index]?.id === entry.id,
          )
        ) {
          appendedEntries = structuredClone(
            candidate.entries.slice(previousEntries.length),
          );
        }
        messageChange = projectedMessageChange(
          kind,
          this.currentMessages,
          candidate.messages,
        );
        this.currentRevision += 1;
        if (messageChange === "replace")
          this.appendFromRevision = this.currentRevision;
        this.revisionFingerprints.set(
          this.currentRevision,
          candidate.fingerprint,
        );
        while (this.revisionFingerprints.size > 256) {
          this.revisionFingerprints.delete(
            this.revisionFingerprints.keys().next().value!,
          );
        }
        this.currentMessages = candidate.messages;
        this.currentModel = candidate.model;
        this.currentThinkingLevel = candidate.thinkingLevel;
        this.currentLeafId = candidate.leafId;
        this.currentEntries = candidate.entries;
        this.currentEntriesById = candidate.entriesById;
        this.currentHeader = candidate.header;
        this.currentFingerprint = candidate.fingerprint;
        this.currentCommittedBytes = candidate.committedBytes;
      }
      this.currentHashState = candidate.hashState;
      this.currentIdentity = candidate.identity;
      this.currentUncommittedBytes = candidate.uncommittedBytes;
      this.currentUncommittedFingerprint = candidate.uncommittedFingerprint;
      this.currentHealth = { status: "ok" };
      const sourceChanged =
        previousSourceVersion !== this.sourceVersion ||
        previousUncommittedBytes !== this.uncommittedBytes ||
        previousUncommittedFingerprint !== this.uncommittedFingerprint;
      const previousTailVerified =
        previousUncommittedBytes === 0 ||
        candidate.previousTailFingerprint === previousUncommittedFingerprint;
      return {
        changed,
        initialMaterialization,
        kind,
        messageChange,
        previousRevision,
        revision: this.revision,
        previousFingerprint,
        fingerprint: this.fingerprint,
        healthChanged: previousHealth !== JSON.stringify(this.health),
        sourceChanged,
        previousSourceVersion,
        sourceVersion: this.sourceVersion,
        uncommittedBytes: this.uncommittedBytes,
        previousUncommittedBytes,
        previousTailVerified,
        ...(appendedEntries ? { appendedEntries, previousLeafId } : {}),
      };
    } catch (error) {
      if (
        initialMaterialization &&
        this.currentIdentity === null &&
        (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ) {
        this.currentHealth = { status: "ok" };
        return {
          changed: false,
          initialMaterialization,
          kind: "none",
          messageChange: "none",
          previousRevision,
          revision: this.revision,
          previousFingerprint,
          fingerprint: this.fingerprint,
          healthChanged: previousHealth !== JSON.stringify(this.health),
          sourceChanged: false,
          previousSourceVersion,
          sourceVersion: this.sourceVersion,
          uncommittedBytes: this.uncommittedBytes,
          previousUncommittedBytes,
          previousTailVerified: true,
        };
      }
      this.currentHealth = healthError(error);
      return {
        changed: false,
        initialMaterialization,
        kind: "none",
        messageChange: "none",
        previousRevision,
        revision: this.revision,
        previousFingerprint,
        fingerprint: this.fingerprint,
        healthChanged: previousHealth !== JSON.stringify(this.health),
        sourceChanged: false,
        previousSourceVersion: this.sourceVersion,
        sourceVersion: this.sourceVersion,
        uncommittedBytes: this.uncommittedBytes,
        previousUncommittedBytes,
        previousTailVerified: false,
      };
    }
  }

  /** Reconcile newly appended frames, reusing an owned prefix when provenance allows. */
  private async tryReadAppendCandidate(): Promise<Candidate | null> {
    if (
      !this.currentIdentity ||
      !this.currentHeader ||
      !this.currentHashState ||
      this.currentRevision === 0
    )
      return null;
    const addressed = identity(
      (await stat(this.path, { bigint: true })) as never,
    );
    if (
      !sameObject(addressed, this.currentIdentity) ||
      addressed.size < BigInt(this.currentCommittedBytes)
    )
      return null;
    const handle = await open(this.path, "r");
    try {
      const before = identity((await handle.stat({ bigint: true })) as never);
      if (!sameObject(before, addressed)) return null;
      // An exact pending Pi claim supplies the provenance for the ordinary
      // one-writer append path. Otherwise reread the prefix so unowned rewrites
      // still fail closed before any new entries are projected.
      const reuseVerifiedPrefix =
        before.size > this.currentIdentity.size && this.ownedAppendWindow();
      const hash = reuseVerifiedPrefix
        ? this.currentHashState.copy()
        : createHash("sha256");
      if (!reuseVerifiedPrefix) {
        let prefixBytes = 0;
        if (this.currentCommittedBytes > 0) {
          for await (const raw of handle.createReadStream({
            start: 0,
            end: this.currentCommittedBytes - 1,
            autoClose: false,
          })) {
            const chunk = raw as Buffer;
            hash.update(chunk);
            await this.readHooks?.afterPrefixReadChunk?.();
            prefixBytes += chunk.length;
          }
        }
        if (
          prefixBytes !== this.currentCommittedBytes ||
          hash.copy().digest("hex") !== this.currentFingerprint
        )
          return null;
      }

      const appended: Record<string, unknown>[] = [];
      let committedBytes = this.currentCommittedBytes;
      let previousTailRemaining = this.currentUncommittedBytes;
      const previousTailHash = createHash("sha256");
      const decoder = new JsonlObjectDecoder((frame) => {
        hash.update(frame);
        committedBytes += frame.length;
      });
      if (before.size > BigInt(this.currentCommittedBytes)) {
        for await (const raw of handle.createReadStream({
          start: this.currentCommittedBytes,
          autoClose: false,
        })) {
          const chunk = raw as Buffer;
          if (previousTailRemaining > 0) {
            const used = chunk.subarray(0, previousTailRemaining);
            previousTailHash.update(used);
            previousTailRemaining -= used.length;
          }
          for (const value of decoder.push(chunk)) {
            if (value.type === "session")
              throw new Error(
                "Persisted session contains a second session header",
              );
            appended.push(value);
          }
        }
      }
      const after = identity((await handle.stat({ bigint: true })) as never);
      const finalAddressed = identity(
        (await stat(this.path, { bigint: true })) as never,
      );
      if (!sameVersion(before, after) || !sameVersion(after, finalAddressed))
        return null;
      const tail = decoder.tail();
      const appendedEntries = appended as unknown as SessionEntry[];
      const entriesById = indexSessionEntries(
        appendedEntries,
        this.currentEntriesById,
      );
      const entries = [...this.currentEntries, ...appendedEntries];
      const leafId = entries.at(-1)?.id ?? null;
      let messages = this.currentMessages;
      let model = this.currentModel;
      let thinkingLevel = this.currentThinkingLevel;
      if (appendedEntries.length > 0) {
        if (isLinearAppend(this.currentLeafId, appendedEntries)) {
          messages = appendContextMessages(
            this.currentMessages,
            appendedEntries,
          );
          ({ model, thinkingLevel } = appendedContextSettings(
            this.currentModel,
            this.currentThinkingLevel,
            appendedEntries,
          ));
        } else {
          const context = buildSessionContext(entries, leafId, entriesById);
          messages = contextMessages(entries, leafId, entriesById);
          model = context.model
            ? { provider: context.model.provider, id: context.model.modelId }
            : null;
          thinkingLevel = context.thinkingLevel;
        }
      }
      const fingerprint = hash.copy().digest("hex");
      return {
        identity: finalAddressed,
        fingerprint,
        hashState: hash,
        committedBytes,
        uncommittedBytes: tail.length,
        uncommittedFingerprint:
          tail.length > 0
            ? createHash("sha256").update(tail).digest("hex")
            : null,
        previousPrefixFingerprint: this.currentFingerprint,
        previousTailFingerprint:
          previousTailRemaining === 0 && this.currentUncommittedBytes > 0
            ? previousTailHash.digest("hex")
            : this.currentUncommittedBytes === 0
              ? null
              : "",
        header: this.currentHeader,
        entries,
        entriesById,
        messages,
        model,
        thinkingLevel,
        leafId,
      };
    } finally {
      await handle.close();
    }
  }

  private async readCandidate(): Promise<Candidate> {
    // A path can be atomically replaced while its old inode is being read. Retry
    // once against the now-addressed object rather than publishing an orphan.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const handle = await open(this.path, "r");
      try {
        const before = identity((await handle.stat({ bigint: true })) as never);
        const hash = createHash("sha256");
        const parsed: Record<string, unknown>[] = [];
        let committedBytes = 0;
        let readOffset = 0;
        let previousPrefixBytes = 0;
        let previousTailBytes = 0;
        const previousPrefixHash = createHash("sha256");
        const previousTailHash = createHash("sha256");
        const decoder = new JsonlObjectDecoder((frame) => {
          hash.update(frame);
          committedBytes += frame.length;
        });
        for await (const raw of handle.createReadStream({ autoClose: false })) {
          const chunk = raw as Buffer;
          await this.readHooks?.afterFullReadChunk?.();
          const end = readOffset + chunk.length;
          if (readOffset < this.currentCommittedBytes) {
            const prefixEnd = Math.min(end, this.currentCommittedBytes);
            const used = chunk.subarray(0, prefixEnd - readOffset);
            previousPrefixHash.update(used);
            previousPrefixBytes += used.length;
          }
          const tailStart = Math.max(readOffset, this.currentCommittedBytes);
          const tailEnd = Math.min(
            end,
            this.currentCommittedBytes + this.currentUncommittedBytes,
          );
          if (tailEnd > tailStart) {
            const used = chunk.subarray(
              tailStart - readOffset,
              tailEnd - readOffset,
            );
            previousTailHash.update(used);
            previousTailBytes += used.length;
          }
          readOffset = end;
          parsed.push(...decoder.push(chunk));
        }
        const after = identity((await handle.stat({ bigint: true })) as never);
        const addressed = identity(
          (await stat(this.path, { bigint: true })) as never,
        );
        if (!sameVersion(before, after) || !sameVersion(after, addressed))
          continue;
        const tail = decoder.tail();
        const header = parsed[0] as SessionHeader | undefined;
        if (!header || header.type !== "session")
          throw new Error("Session file is not a valid Pi session");
        if (header.id !== this.sessionId) {
          throw new Error(
            `Session file belongs to ${String(header.id)}, expected ${this.sessionId}`,
          );
        }
        if (
          parsed
            .slice(1)
            .some((entry) => (entry as { type?: unknown }).type === "session")
        ) {
          throw new Error("Persisted session contains a second session header");
        }
        const mutable = parsed as unknown as Array<
          SessionHeader | SessionEntry
        >;
        migrateSessionEntries(mutable);
        const entries = mutable.slice(1) as SessionEntry[];
        const leafId = entries.at(-1)?.id ?? null;
        const byId = indexSessionEntries(entries);
        const context = buildSessionContext(entries, leafId, byId);
        const fingerprint = hash.copy().digest("hex");
        return {
          identity: addressed,
          fingerprint,
          hashState: hash,
          committedBytes,
          uncommittedBytes: tail.length,
          uncommittedFingerprint:
            tail.length > 0
              ? createHash("sha256").update(tail).digest("hex")
              : null,
          previousPrefixFingerprint:
            previousPrefixBytes === this.currentCommittedBytes &&
            this.currentCommittedBytes > 0
              ? previousPrefixHash.digest("hex")
              : this.currentCommittedBytes === 0
                ? null
                : "",
          previousTailFingerprint:
            previousTailBytes === this.currentUncommittedBytes &&
            this.currentUncommittedBytes > 0
              ? previousTailHash.digest("hex")
              : this.currentUncommittedBytes === 0
                ? null
                : "",
          header,
          entries,
          entriesById: byId,
          messages: contextMessages(entries, leafId, byId),
          model: context.model
            ? { provider: context.model.provider, id: context.model.modelId }
            : null,
          thinkingLevel: context.thinkingLevel,
          leafId,
        };
      } finally {
        await handle.close();
      }
    }
    throw new Error("Session file changed while it was being reconciled");
  }

  latestPage(
    overlay: readonly unknown[] = [],
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
  ): TranscriptPage {
    const persisted = this.viewMessages(effectiveLeafId);
    const persistedCorrelation = new Set(
      persisted
        .map((value) => {
          if (!value || typeof value !== "object") return null;
          const record = value as Record<string, unknown>;
          const copy = { ...record };
          delete copy.__inspireMessageId;
          return messageFallbackCorrelation(copy);
        })
        .filter((key): key is string => key !== null),
    );
    const persistedIndexByEntryId = new Map(
      persisted.flatMap((value, index) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return [];
        const entryId = (value as Record<string, unknown>).__inspireEntryId;
        return typeof entryId === "string" ? [[entryId, index] as const] : [];
      }),
    );
    const combined = [...persisted];
    for (const item of overlay) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const overlayRecord = item as Record<string, unknown>;
        const entryId =
          typeof overlayRecord.__inspireEntryId === "string"
            ? overlayRecord.__inspireEntryId
            : null;
        const persistedIndex = entryId
          ? persistedIndexByEntryId.get(entryId)
          : undefined;
        if (persistedIndex !== undefined) {
          const durable = persisted[persistedIndex] as Record<string, unknown>;
          combined[persistedIndex] = {
            ...overlayRecord,
            __inspireMessageId: durable.__inspireMessageId,
            __inspireEntryId: entryId,
            ...(durable.__inspireMessageIndex !== undefined
              ? { __inspireMessageIndex: durable.__inspireMessageIndex }
              : {}),
            ...(durable.__inspireUserTurnId !== undefined
              ? { __inspireUserTurnId: durable.__inspireUserTurnId }
              : {}),
            ...(durable.__inspireUserTurnIndex !== undefined
              ? { __inspireUserTurnIndex: durable.__inspireUserTurnIndex }
              : {}),
          };
          continue;
        }
      }
      let key: string | null = null;
      if (item && typeof item === "object") {
        const copy = { ...(item as Record<string, unknown>) };
        delete copy.__inspireLiveId;
        key = messageFallbackCorrelation(copy);
      }
      if (!key || !persistedCorrelation.has(key)) combined.push(item);
    }
    return this.buildPage(
      combined,
      combined.length,
      persisted.length,
      effectiveLeafId,
      viewId,
    );
  }

  private validatedCursor(
    cursor: string,
    expectedKind: ParsedCursor["kind"],
    effectiveLeafId: string | null,
    viewId: string,
  ): { decoded: ParsedCursor; messages: readonly unknown[] } {
    const decoded = parseCursor(cursor);
    if (decoded.kind !== expectedKind) {
      throw Object.assign(
        new Error("Transcript cursor has the wrong purpose"),
        {
          status: 400,
        },
      );
    }
    if (decoded.sessionId !== this.sessionId) {
      throw Object.assign(
        new Error("Transcript cursor belongs to another session"),
        { status: 409 },
      );
    }
    if (decoded.incarnation !== this.incarnation) {
      throw Object.assign(
        new Error(
          "Transcript cursor belongs to an expired projection incarnation",
        ),
        { status: 409 },
      );
    }
    if (decoded.viewId !== viewId) {
      throw Object.assign(
        new Error("Transcript cursor belongs to another branch view"),
        { status: 409 },
      );
    }
    if (decoded.effectiveLeafId !== effectiveLeafId) {
      let branchCursor = effectiveLeafId;
      let appendDescendant = decoded.effectiveLeafId === null;
      while (branchCursor && !appendDescendant) {
        if (branchCursor === decoded.effectiveLeafId) appendDescendant = true;
        branchCursor =
          this.currentEntriesById.get(branchCursor)?.parentId ?? null;
      }
      // Cursors survive a strictly append-only continuation of the same
      // branch. A switch to a sibling or ancestor view remains stale.
      if (!appendDescendant || decoded.revision < this.appendFromRevision) {
        throw Object.assign(
          new Error(
            "Transcript cursor is stale or belongs to another branch view",
          ),
          { status: 409 },
        );
      }
    }
    const knownFingerprint = this.revisionFingerprints.get(decoded.revision);
    if (
      decoded.revision > this.revision ||
      decoded.revision < this.appendFromRevision ||
      knownFingerprint !== decoded.fingerprint
    ) {
      throw Object.assign(
        new Error("Transcript cursor is stale; refresh the session"),
        { status: 409 },
      );
    }
    const messages = this.viewMessages(effectiveLeafId);
    if (decoded.before > messages.length) {
      throw Object.assign(new Error("Transcript cursor is invalid"), {
        status: 400,
      });
    }
    return { decoded, messages };
  }

  page(
    cursor: string,
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
  ): TranscriptPage {
    const { decoded, messages } = this.validatedCursor(
      cursor,
      "page",
      effectiveLeafId,
      viewId,
    );
    return this.buildPage(
      messages,
      decoded.before,
      messages.length,
      effectiveLeafId,
      viewId,
    );
  }

  visiblePage(
    cursor: string,
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
  ): TranscriptPage {
    const { decoded, messages } = this.validatedCursor(
      cursor,
      "page",
      effectiveLeafId,
      viewId,
    );
    return this.buildVisiblePage(
      messages,
      decoded.before,
      effectiveLeafId,
      viewId,
    );
  }

  activityPage(
    cursor: string,
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
  ): TranscriptActivityPage {
    const { decoded, messages } = this.validatedCursor(
      cursor,
      "activity",
      effectiveLeafId,
      viewId,
    );
    return this.buildActivityPage(
      messages,
      decoded.start,
      decoded.before,
      effectiveLeafId,
      viewId,
    );
  }

  userTurnIndexPage(
    start: number | undefined,
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
  ): UserTurnIndexPage {
    const indexKey = effectiveLeafId ?? "\u0000current";
    const cached = this.userTurnIndexes.get(indexKey);
    const turns =
      cached?.revision === this.revision
        ? cached.turns
        : this.buildUserTurnIndex(effectiveLeafId);
    if (cached?.revision !== this.revision) {
      if (this.userTurnIndexes.size >= 16) this.userTurnIndexes.clear();
      this.userTurnIndexes.set(indexKey, { revision: this.revision, turns });
    }
    if (start !== undefined && (!Number.isSafeInteger(start) || start < 0))
      throw Object.assign(new Error("User-turn index offset is invalid"), {
        status: 400,
      });
    const pageStart =
      start === undefined
        ? Math.max(0, turns.length - USER_TURN_INDEX_PAGE_SIZE)
        : Math.min(start, turns.length);
    const page: UserTurnIndexPage = {
      sessionId: this.sessionId,
      revision: this.revision,
      viewId,
      incarnation: this.incarnation,
      appendFromRevision: this.appendFromRevision,
      effectiveLeafId,
      total: turns.length,
      start: pageStart,
      turns: turns.slice(pageStart, pageStart + USER_TURN_INDEX_PAGE_SIZE),
    };
    if (Buffer.byteLength(JSON.stringify(page)) > USER_TURN_INDEX_MAX_BYTES) {
      throw new Error("User-turn index page exceeded its declared byte bound");
    }
    return page;
  }

  composerHistoryPage(
    start = 0,
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
  ): ComposerHistoryPage {
    return projectComposerHistoryPage(
      this.viewMessages(effectiveLeafId),
      {
        sessionId: this.sessionId,
        revision: this.revision,
        viewId,
        incarnation: this.incarnation,
        effectiveLeafId,
      },
      start,
    );
  }

  private buildUserTurnIndex(
    effectiveLeafId: string | null,
  ): readonly UserTurnAnchor[] {
    return this.viewMessages(effectiveLeafId).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return [];
      const record = value as Record<string, unknown>;
      const id = projectedMessageId(value);
      const ordinal = record.__inspireUserTurnIndex;
      if (
        record.role !== "user" ||
        id === null ||
        !Number.isSafeInteger(ordinal) ||
        Number(ordinal) < 0
      )
        return [];
      const summary = userTurnSnippet(value);
      const timestamp = projectedTimestamp(value);
      return [
        {
          id,
          ordinal: Number(ordinal),
          snippet: summary.snippet,
          ...(timestamp ? { timestamp } : {}),
          attachmentCount: summary.attachmentCount,
        },
      ];
    });
  }

  userTurnTranscriptPage(
    targetMessageId: string,
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
    continuationCursor?: string,
  ): UserTurnTranscriptPage {
    const source = this.viewMessages(effectiveLeafId);
    const target = source.findIndex(
      (value) =>
        projectedMessageId(value) === targetMessageId &&
        Boolean(
          value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            (value as Record<string, unknown>).role === "user",
        ),
    );
    if (target < 0)
      throw Object.assign(
        new Error("User turn does not exist in this branch"),
        {
          status: 404,
        },
      );
    let turnEnd = target + 1;
    while (turnEnd < source.length) {
      const value = source[turnEnd];
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).role === "user"
      )
        break;
      turnEnd += 1;
    }

    let cursor = target;
    if (continuationCursor) {
      const validated = this.validatedCursor(
        continuationCursor,
        "user-turn",
        effectiveLeafId,
        viewId,
      ).decoded;
      if (
        validated.start !== target ||
        validated.before <= target ||
        validated.before >= turnEnd
      )
        throw Object.assign(new Error("User-turn cursor is invalid"), {
          status: 400,
        });
      cursor = validated.before;
    }

    const messages: unknown[] = [];
    const activityRanges: TranscriptActivityRange[] = [];
    let committedEnd = cursor;
    let previousVisibleId: string | null = null;
    for (let index = cursor - 1; index >= target; index -= 1) {
      if (!isVisibleTranscriptBoundary(source[index])) continue;
      previousVisibleId = projectedMessageId(source[index]);
      break;
    }
    let pendingStart: number | null = null;
    const pendingKinds = new Set<TranscriptActivityKind>();
    const makeRange = (
      rangeStart: number,
      rangeEnd: number,
      afterMessageId: string | null,
      kinds: ReadonlySet<TranscriptActivityKind>,
    ): TranscriptActivityRange | null =>
      kinds.size > 0
        ? {
            cursor: activityCursorFor(
              this.sessionId,
              this.incarnation,
              this.currentFingerprint,
              this.revision,
              rangeStart,
              rangeEnd,
              effectiveLeafId,
              viewId,
            ),
            afterMessageId,
            messageCount: rangeEnd - rangeStart,
            kinds: (["thinking", "tool"] as const).filter((kind) =>
              kinds.has(kind),
            ),
          }
        : null;
    const shell = (
      nextMessages: unknown[],
      nextRanges: TranscriptActivityRange[],
      rangeEnd: number,
    ): UserTurnTranscriptPage => ({
      sessionId: this.sessionId,
      revision: this.revision,
      viewId,
      incarnation: this.incarnation,
      appendFromRevision: this.appendFromRevision,
      effectiveLeafId,
      messages: nextMessages,
      ...(nextRanges.length > 0 ? { activityRanges: nextRanges } : {}),
      hasOlder: target > 0,
      olderCursor:
        target > 0
          ? cursorFor(
              this.sessionId,
              this.incarnation,
              this.currentFingerprint,
              this.revision,
              target,
              effectiveLeafId,
              viewId,
            )
          : null,
      targetMessageId,
      rangeStart: target,
      rangeEnd,
      hasMoreInTurn: rangeEnd < turnEnd,
      continuationCursor:
        rangeEnd < turnEnd
          ? userTurnCursorFor(
              this.sessionId,
              this.incarnation,
              this.currentFingerprint,
              this.revision,
              target,
              rangeEnd,
              effectiveLeafId,
              viewId,
            )
          : null,
    });

    while (cursor < turnEnd && messages.length < TRANSCRIPT_PAGE_MAX_MESSAGES) {
      const value = source[cursor];
      if (!isVisibleTranscriptBoundary(value)) {
        if (pendingStart === null) pendingStart = cursor;
        for (const kind of deferredActivityKinds(value)) pendingKinds.add(kind);
        cursor += 1;
        continue;
      }
      const item = boundedTranscriptItem(value, cursor);
      this.readHooks?.afterMessageProjection?.();
      const range =
        pendingStart === null
          ? null
          : makeRange(pendingStart, cursor, previousVisibleId, pendingKinds);
      const nextMessages = [...messages, item.value];
      const nextRanges = [...activityRanges, ...(range ? [range] : [])];
      if (
        Buffer.byteLength(
          JSON.stringify(shell(nextMessages, nextRanges, cursor + 1)),
        ) > TRANSCRIPT_PAGE_MAX_BYTES
      ) {
        if (messages.length === 0)
          throw Object.assign(
            new Error(
              "A projected transcript message exceeds the browser page budget",
            ),
            { status: 422 },
          );
        cursor = pendingStart ?? cursor;
        break;
      }
      messages.push(item.value);
      if (range) activityRanges.push(range);
      previousVisibleId = projectedMessageId(value);
      pendingStart = null;
      pendingKinds.clear();
      cursor += 1;
      committedEnd = cursor;
    }

    if (cursor === turnEnd && pendingStart !== null) {
      const trailing = makeRange(
        pendingStart,
        turnEnd,
        previousVisibleId,
        pendingKinds,
      );
      if (
        trailing &&
        Buffer.byteLength(
          JSON.stringify(
            shell(messages, [...activityRanges, trailing], turnEnd),
          ),
        ) <= TRANSCRIPT_PAGE_MAX_BYTES
      ) {
        activityRanges.push(trailing);
        committedEnd = turnEnd;
      } else if (!trailing) {
        committedEnd = turnEnd;
      }
    }
    const page = shell(messages, activityRanges, committedEnd);
    if (Buffer.byteLength(JSON.stringify(page)) > TRANSCRIPT_PAGE_MAX_BYTES)
      throw new Error("Transcript page exceeded its declared byte bound");
    return page;
  }

  private buildPage(
    source: readonly unknown[],
    before: number,
    persistedLength: number,
    effectiveLeafId: string | null,
    viewId: string,
  ): TranscriptPage {
    let start = before;
    const reversed: unknown[] = [];
    let messagesBytes = 2; // JSON array brackets; commas are added per accepted item.
    const shell = (
      candidateStart: number,
      messages: unknown[],
    ): TranscriptPage => {
      const persistedStart = Math.min(candidateStart, persistedLength);
      return {
        sessionId: this.sessionId,
        revision: this.revision,
        viewId,
        incarnation: this.incarnation,
        appendFromRevision: this.appendFromRevision,
        effectiveLeafId,
        messages,
        hasOlder: persistedStart > 0,
        olderCursor:
          persistedStart > 0
            ? cursorFor(
                this.sessionId,
                this.incarnation,
                this.currentFingerprint,
                this.revision,
                persistedStart,
                effectiveLeafId,
                viewId,
              )
            : null,
      };
    };
    while (start > 0 && reversed.length < TRANSCRIPT_PAGE_MAX_MESSAGES) {
      const index = start - 1;
      const item = boundedTranscriptItem(
        source[index],
        index < persistedLength ? index : undefined,
      );
      this.readHooks?.afterMessageProjection?.();
      const projected = item.value;
      const serialized = item.serialized;
      const candidateMessagesBytes =
        messagesBytes +
        Buffer.byteLength(serialized) +
        (reversed.length > 0 ? 1 : 0);
      const emptyShellBytes = Buffer.byteLength(
        JSON.stringify(shell(index, [])),
      );
      if (
        emptyShellBytes - 2 + candidateMessagesBytes >
        TRANSCRIPT_PAGE_MAX_BYTES
      )
        break;
      reversed.push(projected);
      messagesBytes = candidateMessagesBytes;
      start = index;
    }
    if (reversed.length === 0 && before > 0) {
      throw Object.assign(
        new Error(
          "A projected transcript message exceeds the browser page budget",
        ),
        { status: 422 },
      );
    }
    const page = shell(start, reversed.reverse());
    if (Buffer.byteLength(JSON.stringify(page)) > TRANSCRIPT_PAGE_MAX_BYTES) {
      throw new Error("Transcript page exceeded its declared byte bound");
    }
    return page;
  }

  private buildVisiblePage(
    source: readonly unknown[],
    before: number,
    effectiveLeafId: string | null,
    viewId: string,
  ): TranscriptPage {
    let start = before;
    let pendingActivityEnd: number | null = null;
    const pendingKinds = new Set<TranscriptActivityKind>();
    const reversed: unknown[] = [];
    const ranges: TranscriptActivityRange[] = [];
    const shell = (
      candidateStart: number,
      messages: unknown[],
      activityRanges: TranscriptActivityRange[],
    ): TranscriptPage => ({
      sessionId: this.sessionId,
      revision: this.revision,
      viewId,
      incarnation: this.incarnation,
      appendFromRevision: this.appendFromRevision,
      effectiveLeafId,
      messages,
      ...(activityRanges.length > 0 ? { activityRanges } : {}),
      hasOlder: candidateStart > 0,
      olderCursor:
        candidateStart > 0
          ? cursorFor(
              this.sessionId,
              this.incarnation,
              this.currentFingerprint,
              this.revision,
              candidateStart,
              effectiveLeafId,
              viewId,
            )
          : null,
    });
    const range = (
      rangeStart: number,
      rangeEnd: number,
      afterMessageId: string | null,
      kinds: ReadonlySet<TranscriptActivityKind>,
    ): TranscriptActivityRange | null =>
      kinds.size > 0
        ? {
            cursor: activityCursorFor(
              this.sessionId,
              this.incarnation,
              this.currentFingerprint,
              this.revision,
              rangeStart,
              rangeEnd,
              effectiveLeafId,
              viewId,
            ),
            afterMessageId,
            messageCount: rangeEnd - rangeStart,
            kinds: (["thinking", "tool"] as const).filter((kind) =>
              kinds.has(kind),
            ),
          }
        : null;

    while (start > 0 && reversed.length < TRANSCRIPT_PAGE_MAX_MESSAGES) {
      const index = start - 1;
      const sourceItem = source[index];
      if (!isVisibleTranscriptBoundary(sourceItem)) {
        if (pendingActivityEnd === null) pendingActivityEnd = start;
        for (const kind of deferredActivityKinds(sourceItem))
          pendingKinds.add(kind);
        start = index;
        continue;
      }

      const item = boundedTranscriptItem(sourceItem, index);
      this.readHooks?.afterMessageProjection?.();
      const nextRange =
        pendingActivityEnd === null
          ? null
          : range(
              index + 1,
              pendingActivityEnd,
              projectedMessageId(sourceItem),
              pendingKinds,
            );
      const candidateMessages = [...reversed, item.value].reverse();
      const candidateRanges = [
        ...ranges,
        ...(nextRange ? [nextRange] : []),
      ].reverse();
      if (
        Buffer.byteLength(
          JSON.stringify(shell(index, candidateMessages, candidateRanges)),
        ) > TRANSCRIPT_PAGE_MAX_BYTES
      ) {
        // The skipped activity needs this older visible message as its stable
        // insertion anchor, so leave both for the next page.
        start = pendingActivityEnd ?? start;
        break;
      }
      reversed.push(item.value);
      if (nextRange) ranges.push(nextRange);
      start = index;
      pendingActivityEnd = null;
      pendingKinds.clear();
    }

    if (start === 0 && pendingActivityEnd !== null) {
      const leading = range(0, pendingActivityEnd, null, pendingKinds);
      if (leading) {
        const withLeading = shell(
          0,
          [...reversed].reverse(),
          [...ranges, leading].reverse(),
        );
        if (
          Buffer.byteLength(JSON.stringify(withLeading)) <=
          TRANSCRIPT_PAGE_MAX_BYTES
        )
          ranges.push(leading);
        else start = pendingActivityEnd;
      }
    }
    if (reversed.length === 0 && start === before && before > 0) {
      throw Object.assign(
        new Error(
          "A projected transcript message exceeds the browser page budget",
        ),
        { status: 422 },
      );
    }
    const page = shell(start, reversed.reverse(), ranges.reverse());
    if (Buffer.byteLength(JSON.stringify(page)) > TRANSCRIPT_PAGE_MAX_BYTES) {
      throw new Error("Transcript page exceeded its declared byte bound");
    }
    return page;
  }

  private buildActivityPage(
    source: readonly unknown[],
    floor: number,
    before: number,
    effectiveLeafId: string | null,
    viewId: string,
  ): TranscriptActivityPage {
    let start = before;
    const reversed: unknown[] = [];
    const shell = (
      candidateStart: number,
      messages: unknown[],
    ): TranscriptActivityPage => ({
      sessionId: this.sessionId,
      revision: this.revision,
      viewId,
      incarnation: this.incarnation,
      effectiveLeafId,
      messages,
      hasMore: candidateStart > floor,
      cursor:
        candidateStart > floor
          ? activityCursorFor(
              this.sessionId,
              this.incarnation,
              this.currentFingerprint,
              this.revision,
              floor,
              candidateStart,
              effectiveLeafId,
              viewId,
            )
          : null,
    });
    while (start > floor && reversed.length < TRANSCRIPT_PAGE_MAX_MESSAGES) {
      const index = start - 1;
      const item = boundedTranscriptItem(source[index], index);
      this.readHooks?.afterMessageProjection?.();
      const candidate = [...reversed, item.value].reverse();
      if (
        Buffer.byteLength(JSON.stringify(shell(index, candidate))) >
        TRANSCRIPT_PAGE_MAX_BYTES
      )
        break;
      reversed.push(item.value);
      start = index;
    }
    if (reversed.length === 0 && before > floor) {
      throw Object.assign(
        new Error(
          "A projected transcript message exceeds the browser page budget",
        ),
        { status: 422 },
      );
    }
    const page = shell(start, reversed.reverse());
    if (Buffer.byteLength(JSON.stringify(page)) > TRANSCRIPT_PAGE_MAX_BYTES) {
      throw new Error("Transcript page exceeded its declared byte bound");
    }
    return page;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.resolveReconciliationResume?.();
    this.resolveReconciliationResume = null;
    this.reconciliationResume = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    await this.reconcileTail.catch(() => undefined);
    this.removeAllListeners();
    this.currentEntries = [];
    this.currentMessages = [];
  }
}
