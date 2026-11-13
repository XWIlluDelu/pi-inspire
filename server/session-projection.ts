import {
  createHash,
  createHmac,
  type Hash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { EventEmitter } from "node:events";
import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type {
  SessionEntry,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { assistantOutcome } from "../shared/assistant-outcome.js";
import { interruptAssistantToolCalls } from "../shared/assistant-stream.js";
import {
  type BranchEntryResponse,
  type BranchTreeQuery,
  type BranchTreeResponse,
  type ComposerHistoryPage,
  type ModelOption,
  type NativeTurnPage,
  type HistoryMatch,
  type ProjectionHealth,
  type SessionHistoryPages,
  type SessionHistoryQuery,
  type TranscriptPage,
} from "../shared/contracts.js";
import { jsonRecord } from "../shared/json-record.js";
import { resultChildCalls } from "../shared/tool-activity.js";
import { userMessageContent } from "../shared/user-message.js";
import {
  type ComposerHistoryFileNameResolver,
  type ComposerHistoryMessage,
  projectComposerHistoryPage,
} from "./composer-history.js";
import { samePersistedJson } from "./persisted-json.js";
import {
  buildContextEntries,
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  sessionEntryToContextMessages,
} from "./pi-runtime.js";
import { requestError } from "./request-error.js";
import { projectSafeValue } from "./safe-projection.js";
import type { SessionRecord } from "./session-catalog.js";
import {
  SessionDocumentReader,
  type SessionSourceIdentity,
  sameSessionObject,
  sessionSourceVersion,
  sessionVersionAtPath,
} from "./session-jsonl.js";
import {
  appendModelSelection,
  type BranchModelSelection,
  branchModelSelection,
  selectedBranchModel,
} from "./session-model-selection.js";
import {
  BRANCH_CONTENT_PAGE_CHARS,
  BRANCH_TREE_MAX_BYTES,
  boundedEditableText,
  boundedUserText,
  branchEntryContent,
  branchEntryText,
  branchMessageSource,
  branchNode,
  indexSessionEntries,
  projectSessionTree,
} from "./session-tree.js";

export { MAX_PERSISTED_ENTRY_BYTES } from "./session-jsonl.js";
/** Includes the complete JSON representation of a TranscriptPage. */
export const TRANSCRIPT_PAGE_MAX_BYTES = 1024 * 1024;
export const TRANSCRIPT_PAGE_MAX_MESSAGES = 100;
/** Per-slot reconnect-only live messages are separately bounded by runtime. */
export const TRANSIENT_OVERLAY_MAX_BYTES = 512 * 1024;
export const TRANSCRIPT_ITEM_MAX_BYTES = 256 * 1024;

const WATCH_DEBOUNCE_MS = 75;
const RECONCILE_INTERVAL_MS = 750;
const CURSOR_KEY = randomBytes(32);
interface Candidate {
  identity: SessionSourceIdentity;
  fingerprint: string;
  hashState: Hash;
  committedBytes: number;
  uncommittedBytes: number;
  uncommittedFingerprint: string | null;
  /** Fingerprints observed from this same read, never a later filesystem pass. */
  previousPrefixFingerprint: string | null;
  /** This read hashed the old committed bytes instead of reusing an owned prefix. */
  previousTailFingerprint: string | null;
  header: SessionHeader | null;
  entries: SessionEntry[];
  entriesById: Map<string, SessionEntry>;
  messages: unknown[];
  modelSelection: BranchModelSelection;
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
  /** Present only after a stable, complete byte-for-byte revalidation of the same object. */
  verifiedUnchangedContent?: true;
  previousSourceVersion: string | null;
  sourceVersion: string | null;
  /** Projection state captured by this exact filesystem observation. */
  sourceIdentity: string | null;
  committedBytes: number;
  uncommittedBytes: number;
  uncommittedFingerprint: string | null;
  health: ProjectionHealth;
  previousUncommittedBytes: number;
  /** A prior unresolved tail is an exact prefix of this candidate's post-commit bytes. */
  previousTailVerified: boolean;
  /** Exact migrated entries added after the previously verified prefix. */
  appendedEntries?: readonly SessionEntry[];
  previousLeafId?: string | null;
}

export type ProjectionReconcileHandler = (
  result: ProjectionReconcileResult,
) => Promise<void>;

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
  readonly incarnation: string | null;
  readonly health: ProjectionHealth;
  readonly messages: readonly unknown[];
  readonly model: unknown;
  selectedModel(virtualModels: readonly ModelOption[]): unknown;
  readonly thinkingLevel: string;
  readonly leafId: string | null;
  /** Whether `other` is an ancestor of `leafId`, `leafId` itself, or one of
   * its continuations in the saved tree. */
  onSameLine(leafId: string | null, other: string | null): boolean;
  continues(leafId: string | null, from: string | null): boolean;
  /** The most recently saved entry continuing `leafId`, or `leafId`. */
  latestContinuation(leafId: string | null): string | null;
  /** Branch ends, most recently saved first. */
  readonly tailEntryId: string | null;
  /** Stable only while the projection still addresses the same filesystem object. */
  readonly sourceIdentity: string | null;
  /** Exact stat version used to reject any pre-start disk movement. */
  readonly sourceVersion: string | null;
  readonly committedBytes: number;
  readonly uncommittedBytes: number;
  readonly uncommittedFingerprint: string | null;
  attestInitialMaterialization(
    workerEntries: readonly SessionEntry[],
  ): InitialMaterializationAttestation;
  hasActiveEntryType(type: string): boolean;
  suspendReconciliation(): Promise<void>;
  resumeReconciliation(): void;
  /** The Host consumes each observation inside the read FIFO, before the next read. */
  setReconcileHandler(handler: ProjectionReconcileHandler): void;
  latestPage(
    overlay?: readonly unknown[],
    effectiveLeafId?: string | null,
    viewId?: string,
  ): TranscriptPage;
  historyPage<Q extends SessionHistoryQuery>(
    query: Q,
    effectiveLeafId?: string | null,
    viewId?: string,
    cwd?: string,
    fileNameForPath?: ComposerHistoryFileNameResolver,
  ): SessionHistoryPages[Q["kind"]];
  branchTree(
    effectiveLeafId?: string | null,
    query?: BranchTreeQuery,
  ): BranchTreeResponse;
  branchImage(id: string, index: number): { data: Buffer; mimeType: string };
  editableText(id: string, maxChars: number): string;
  entry(id: string): ProjectionEntryTarget | null;
  /** Committed append suffix after an operation's admitted durable tail. */
  entriesAfter(tailEntryId: string | null): readonly SessionEntry[];
  persistedEntryMatches(entry: SessionEntry): boolean;
  userText(id: string, maxChars: number): string;
  userImages(id: string): Array<{ data: string; mimeType: string }>;
  viewMessages(effectiveLeafId?: string | null): readonly unknown[];
  /** Retained USER entries on this branch, independent of model compaction. */
  composerHistoryMessages(
    effectiveLeafId?: string | null,
  ): readonly ComposerHistoryMessage[];
  reconcile(force?: boolean): Promise<ProjectionReconcileResult>;
  /** Host startup attestation only: reconcile while ordinary readers are suspended. */
  reconcileSuspended(force?: boolean): Promise<ProjectionReconcileResult>;
  close(): Promise<void>;
  on(
    event: "update",
    listener: (result: ProjectionReconcileResult) => void,
  ): this;
}

function fingerprintOfSpan(
  hash: Hash,
  length: number,
  bytesRead: number,
): string | null {
  if (length === 0) return null;
  return bytesRead >= length ? hash.digest("hex") : "";
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([
      stat(left, { bigint: true }),
      stat(right, { bigint: true }),
    ]);
    return (
      leftStat.isDirectory() &&
      rightStat.isDirectory() &&
      leftStat.dev === rightStat.dev &&
      leftStat.ino === rightStat.ino
    );
  } catch {
    return false;
  }
}

/** System prompts/tool declarations remain canonical Pi state, not transcript
 * rows. Keep the SDK's original per-entry index for stable message identities,
 * including summaries returned after a compaction's system checkpoint. */
function transcriptEntryMessages(entry: SessionEntry) {
  const source =
    entry.type === "compaction" &&
    entry.details &&
    typeof entry.details === "object" &&
    "source" in entry.details &&
    typeof entry.details.source === "string"
      ? entry.details.source
      : undefined;
  return sessionEntryToContextMessages(entry).flatMap((message, index) =>
    message.role === "system"
      ? []
      : [
          {
            ...message,
            __inspireMessageId: `${entry.id}:${index}`,
            __inspireEntryId: entry.id,
            ...(source && message.role === "compactionSummary"
              ? { __inspireCompactionSource: source }
              : {}),
          },
        ],
  );
}

function contextMessages(
  entries: SessionEntry[],
  leafId: string | null,
  byId: Map<string, SessionEntry>,
): unknown[] {
  const contextEntries = buildContextEntries(entries, leafId, byId);
  // Pi prepends the latest summary for model consumption. A transcript must
  // retain the same selected entries, but show the compaction where it happened.
  // Persisted append order is authoritative even with skewed/equal timestamps;
  // membership from Pi excludes discarded context and unrelated branches.
  let transcriptEntries = contextEntries;
  if (contextEntries[0]?.type === "compaction") {
    const included = new Set(contextEntries.map((entry) => entry.id));
    transcriptEntries = entries.filter((entry) => included.has(entry.id));
  }
  return appendContextMessages([], transcriptEntries);
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
  const appended = entries.flatMap(transcriptEntryMessages).map((message) => {
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
  return [...previous, ...appended];
}

function appendedThinkingLevel(
  currentThinkingLevel: string,
  entries: readonly SessionEntry[],
): string {
  let thinkingLevel = currentThinkingLevel;
  for (const entry of entries) {
    if (entry.type === "thinking_level_change")
      thinkingLevel = entry.thinkingLevel;
  }
  return thinkingLevel;
}

function isLinearAppend(
  currentLeafId: string | null,
  entries: readonly SessionEntry[],
): boolean {
  let parentId = currentLeafId;
  for (const entry of entries) {
    if (entry.parentId !== parentId) return false;
    parentId = entry.id;
  }
  return !entries.some((entry) => entry.type === "compaction");
}

function changesComposerHistory(entry: SessionEntry): boolean {
  return (
    entry.type === "message" &&
    (entry.message.role === "user" || entry.message.role === "bashExecution")
  );
}

function composerHistoryAnchor(
  entries: ReadonlyMap<string, SessionEntry>,
  leafId: string | null,
): string | null {
  let id = leafId;
  while (id !== null) {
    const entry = entries.get(id);
    if (!entry) break;
    if (changesComposerHistory(entry)) return id;
    id = entry.parentId;
  }
  return null;
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
  fileNameForPath?: ComposerHistoryFileNameResolver,
): BoundedTranscriptItem {
  const browserValue = withoutPersistedImageData(
    interruptAssistantToolCalls(value),
    persistedIndex,
  );
  const sourceRecord =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const calls =
    sourceRecord?.role === "toolResult"
      ? projectSafeValue(resultChildCalls(sourceRecord), {
          depth: 12,
          stringChars: 8_192,
          arrayItems: 256,
          objectEntries: 256,
        })
      : undefined;
  const fileNames =
    sourceRecord?.role === "user" && fileNameForPath
      ? Object.fromEntries(
          userMessageContent(sourceRecord.content).references.flatMap(
            (path) => {
              const name = fileNameForPath(path);
              return name ? [[path, name]] : [];
            },
          ),
        )
      : {};
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
        ...(sourceRecord.__inspireUnconfirmed === true
          ? { __inspireUnconfirmed: true }
          : {}),
        ...(typeof sourceRecord.__inspireSettled === "boolean"
          ? { __inspireSettled: sourceRecord.__inspireSettled }
          : {}),
        ...(Number.isSafeInteger(sourceRecord.__inspireStreamRevision) &&
        Number(sourceRecord.__inspireStreamRevision) >= 0
          ? {
              __inspireStreamRevision: Number(
                sourceRecord.__inspireStreamRevision,
              ),
            }
          : {}),
        ...(typeof sourceRecord.__inspireUserTurnId === "string"
          ? { __inspireUserTurnId: sourceRecord.__inspireUserTurnId }
          : {}),
        ...(Number.isSafeInteger(sourceRecord.__inspireUserTurnIndex)
          ? { __inspireUserTurnIndex: sourceRecord.__inspireUserTurnIndex }
          : {}),
      }
    : {};
  const decorate = (projected: unknown, stringChars: number): unknown =>
    projected && typeof projected === "object" && !Array.isArray(projected)
      ? {
          ...(projected as Record<string, unknown>),
          ...identityMetadata,
          ...(Object.keys(fileNames).length
            ? { __inspireFileNames: fileNames }
            : {}),
          ...(calls ? { __inspireCalls: calls } : {}),
          ...(sourceRecord?.role === "toolResult" &&
          typeof sourceRecord.isError === "boolean"
            ? { isError: sourceRecord.isError }
            : {}),
          // Reduced item projections are replacements, not valid bases for
          // replaying the original un-clipped argument patch on a browser.
          ...(stringChars === 2_000
            ? { __inspireProjectionReduced: true }
            : {}),
          // Terminal outcomes remain inspectable even when large content forces
          // the reduced or omitted projection. Keep the same string budget.
          ...(sourceRecord?.role === "assistant" &&
          assistantOutcome(sourceRecord) !== null
            ? {
                role: "assistant",
                stopReason: sourceRecord.stopReason,
                ...(typeof sourceRecord.errorMessage === "string"
                  ? {
                      errorMessage: projectSafeValue(
                        sourceRecord.errorMessage,
                        {
                          depth: 0,
                          stringChars,
                          arrayItems: 0,
                        },
                      ),
                    }
                  : {}),
              }
            : {}),
          ...(persistedIndex !== undefined
            ? { __inspireMessageIndex: persistedIndex }
            : {}),
        }
      : projected;
  for (const limits of [
    { depth: 16, stringChars: 64_000, arrayItems: 256, objectEntries: 256 },
    { depth: 8, stringChars: 2_000, arrayItems: 32, objectEntries: 32 },
  ]) {
    const projected = decorate(
      projectSafeValue(browserValue, limits),
      limits.stringChars,
    );
    const serialized = JSON.stringify(projected) ?? "null";
    if (Buffer.byteLength(serialized) <= TRANSCRIPT_ITEM_MAX_BYTES)
      return { value: projected, serialized };
  }
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const role = typeof record.role === "string" ? record.role : "unknown";
  const omitted =
    "[message omitted: projected content exceeded the transcript item limit]";
  const projected = decorate(
    {
      role,
      ...(record.timestamp !== undefined
        ? { timestamp: record.timestamp }
        : {}),
      ...(typeof record.display === "boolean"
        ? { display: record.display }
        : {}),
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
    },
    2_000,
  );
  return { value: projected, serialized: JSON.stringify(projected) };
}

function oversizedTranscriptItem(): never {
  throw requestError(
    "A projected transcript message exceeds the browser page budget",
    422,
  );
}

function withinTranscriptPageBudget<T>(page: T): T {
  if (Buffer.byteLength(JSON.stringify(page)) > TRANSCRIPT_PAGE_MAX_BYTES)
    throw new Error("Transcript page exceeded its declared byte bound");
  return page;
}

/** Charge each projected row and its actual page shell against the wire budget. */
class TranscriptPageBuilder<Page> {
  private readonly messages: unknown[] = [];
  private bytes = 0;

  constructor(
    private readonly shell: (boundary: number, messages: unknown[]) => Page,
  ) {}

  get length(): number {
    return this.messages.length;
  }

  add(
    boundary: number,
    item: ReturnType<typeof boundedTranscriptItem>,
  ): boolean {
    const bytes =
      this.bytes +
      Buffer.byteLength(item.serialized) +
      Number(this.messages.length > 0);
    if (
      bytes + Buffer.byteLength(JSON.stringify(this.shell(boundary, []))) >
      TRANSCRIPT_PAGE_MAX_BYTES
    )
      return false;
    this.messages.push(item.value);
    this.bytes = bytes;
    return true;
  }

  page(boundary: number, reverse = false): Page {
    if (reverse) this.messages.reverse();
    return withinTranscriptPageBudget(this.shell(boundary, this.messages));
  }
}

export function boundedTranscriptProjection(
  value: unknown,
  fileNameForPath?: ComposerHistoryFileNameResolver,
): {
  value: unknown;
  bytes: number;
} {
  const item = boundedTranscriptItem(value, undefined, fileNameForPath);
  return { value: item.value, bytes: Buffer.byteLength(item.serialized) };
}

export function boundedTranscriptValue(value: unknown): unknown {
  return boundedTranscriptItem(value).value;
}

function isVisibleTranscriptBoundary(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.role === "user" || record.role === "bashExecution") return true;
  // Visible extension messages are context content, not lazily hidden tools.
  if (record.role === "custom") return record.display !== false;
  if (record.role !== "assistant") return false;
  if (assistantOutcome(record) !== null) return true;
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

function signedCursor(payloadValue: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(payloadValue)).toString(
    "base64url",
  );
  const signature = createHmac("sha256", CURSOR_KEY)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

interface ParsedCursor {
  kind: "native-before" | "native-after";
  sessionId: string;
  incarnation: string;
  sourceGeneration: number;
  revision: number;
  before: number;
  effectiveLeafId: string | null;
  viewId: string;
}

function parseCursor(cursor: string): ParsedCursor {
  const [payload, supplied] = cursor.split(".");
  if (!payload || !supplied)
    throw requestError("Transcript cursor is invalid", 400);
  const expected = createHmac("sha256", CURSOR_KEY).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(supplied, "base64url");
  } catch {
    throw requestError("Transcript cursor is invalid", 400);
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw requestError("Transcript cursor is invalid", 400);
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.sessionId !== "string" ||
      typeof parsed.incarnation !== "string" ||
      !Number.isSafeInteger(parsed.sourceGeneration) ||
      !Number.isSafeInteger(parsed.revision) ||
      !Number.isSafeInteger(parsed.before) ||
      Number(parsed.before) < 0 ||
      (parsed.effectiveLeafId !== null &&
        typeof parsed.effectiveLeafId !== "string") ||
      typeof parsed.viewId !== "string" ||
      !parsed.viewId ||
      (parsed.kind !== "native-before" && parsed.kind !== "native-after")
    )
      throw new Error("invalid");
    return {
      kind: parsed.kind,
      sessionId: parsed.sessionId,
      incarnation: parsed.incarnation,
      sourceGeneration: Number(parsed.sourceGeneration),
      revision: Number(parsed.revision),
      before: Number(parsed.before),
      effectiveLeafId: parsed.effectiveLeafId,
      viewId: parsed.viewId,
    };
  } catch {
    throw requestError("Transcript cursor is invalid", 400);
  }
}

function healthError(error: unknown): ProjectionHealth {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "error", message };
}

export interface SessionProjectionReadHooks {
  afterFullReadChunk?(): Promise<void> | void;
}

/** Read queries over native entries, independent of any filesystem source. */
class SessionEntryIndex extends EventEmitter {
  readonly sessionId: string;
  readonly path: string;
  protected currentRevision = 0;
  readonly incarnation = randomBytes(18).toString("base64url");
  protected appendFromRevision = 0;
  protected currentMessages: unknown[] = [];
  protected currentModelSelection: BranchModelSelection = {
    change: null,
    fallback: null,
  };
  protected currentThinkingLevel = "off";
  protected currentLeafId: string | null = null;
  protected currentEntries: SessionEntry[] = [];
  protected currentEntriesById = new Map<string, SessionEntry>();
  protected currentHistoryAnchor: string | null = null;
  protected historyReplacementRevision = 0;
  protected historySourceGeneration = 0;
  private historyCache?: {
    leafId: string | null;
    revision: number;
    messages: unknown[];
    entries: Map<string, number>;
    turns: number[];
  };
  constructor(
    session: Pick<SessionRecord, "id" | "path">,
    private readonly fileNameForPath?: ComposerHistoryFileNameResolver,
  ) {
    super();
    this.sessionId = session.id;
    this.path = resolve(session.path);
  }

  get revision(): number {
    return this.currentRevision;
  }

  get messages(): readonly unknown[] {
    return this.currentMessages;
  }
  get model(): unknown {
    return this.currentModelSelection.fallback;
  }
  selectedModel(virtualModels: readonly ModelOption[]): unknown {
    return selectedBranchModel(this.currentModelSelection, virtualModels);
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
  latestContinuation(leafId: string | null): string | null {
    if (leafId === null) return this.tailEntryId;
    if (leafId === this.tailEntryId || !this.currentEntriesById.has(leafId))
      return leafId;
    const descendants = new Set([leafId]);
    let latest = leafId;
    // Parents precede children in the validated file, so one pass classifies
    // each entry and the last match is the latest saved continuation.
    for (const entry of this.currentEntries) {
      if (entry.parentId === null || !descendants.has(entry.parentId)) continue;
      descendants.add(entry.id);
      latest = entry.id;
    }
    return latest;
  }

  onSameLine(leafId: string | null, other: string | null): boolean {
    return this.continues(leafId, other) || this.continues(other, leafId);
  }

  continues(leafId: string | null, from: string | null): boolean {
    if (from === null) return true;
    // Index validation requires parents to precede children.
    let id = leafId;
    while (id !== null) {
      if (id === from) return true;
      id = this.currentEntriesById.get(id)?.parentId ?? null;
    }
    return false;
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

  entriesAfter(tailEntryId: string | null): readonly SessionEntry[] {
    const index =
      tailEntryId === null
        ? -1
        : this.currentEntries.findLastIndex(
            (entry) => entry.id === tailEntryId,
          );
    if (tailEntryId !== null && index < 0)
      throw requestError("Session persistence boundary no longer exists", 409);
    return this.currentEntries.slice(index + 1);
  }

  persistedEntryMatches(entry: SessionEntry): boolean {
    const found = this.currentEntriesById.get(entry.id);
    return found !== undefined && samePersistedJson(found, entry);
  }

  userText(id: string, maxChars: number): string {
    const entry = this.currentEntriesById.get(id);
    if (!entry) throw requestError("Branch target does not exist", 404);
    return boundedUserText(entry, maxChars);
  }

  userImages(id: string): Array<{ data: string; mimeType: string }> {
    const entry = this.currentEntriesById.get(id);
    if (entry?.type !== "message" || entry.message.role !== "user")
      throw requestError("Fork requires a retained user message", 409);
    const content = entry.message.content;
    return Array.isArray(content)
      ? content.filter((block) => block.type === "image")
      : [];
  }

  editableText(id: string, maxChars: number): string {
    const entry = this.currentEntriesById.get(id);
    if (!entry) throw requestError("Branch target does not exist", 404);
    return boundedEditableText(entry, maxChars);
  }

  private branchEntry(
    id: string,
    offset: number,
    effectiveLeafId: string | null,
    format?: "message",
  ): BranchEntryResponse {
    const entry = this.currentEntriesById.get(id);
    if (!entry) throw requestError("History point no longer exists", 404);
    const text =
      format === "message"
        ? branchMessageSource(entry)
        : branchEntryText(entry, "separate");
    if (offset > text.length)
      throw requestError("History content offset is invalid", 400);
    const end = Math.min(text.length, offset + BRANCH_CONTENT_PAGE_CHARS);
    const content = branchEntryContent(entry);
    const images = Array.isArray(content)
      ? content.flatMap((block, index) =>
          block.type === "image" ? [{ index, mimeType: block.mimeType }] : [],
        )
      : [];
    return {
      sessionId: this.sessionId,
      revision: this.revision,
      node: branchNode(entry, false, id === effectiveLeafId),
      text: text.slice(offset, end),
      totalChars: text.length,
      nextOffset: end < text.length ? end : null,
      images,
    };
  }

  branchImage(id: string, index: number): { data: Buffer; mimeType: string } {
    const entry = this.currentEntriesById.get(id);
    const content = entry ? branchEntryContent(entry) : undefined;
    const block = Array.isArray(content) ? content[index] : undefined;
    if (block?.type !== "image")
      throw requestError("History image no longer exists", 404);
    return {
      data: Buffer.from(block.data, "base64"),
      mimeType: block.mimeType,
    };
  }

  protected historyHealth(): ProjectionHealth {
    return { status: "ok" };
  }

  branchTree(
    effectiveLeafId: string | null = this.currentLeafId,
    query: BranchTreeQuery = {},
  ): BranchTreeResponse {
    if (
      effectiveLeafId !== null &&
      !this.currentEntriesById.has(effectiveLeafId)
    ) {
      throw requestError("Effective branch leaf does not exist", 409);
    }
    const tree = projectSessionTree(
      this.currentEntries,
      effectiveLeafId,
      query,
      this.currentEntriesById,
    );
    const response: BranchTreeResponse = {
      sessionId: this.sessionId,
      revision: this.revision,
      incarnation: this.incarnation,
      durableLeafId: this.currentLeafId,
      effectiveLeafId,
      activePath: tree.activePath,
      nodes: tree.nodes,
      ...(tree.leadingPrompt ? { leadingPrompt: tree.leadingPrompt } : {}),
      truncated: tree.truncated,
      nextBefore: tree.nextBefore,
      routeLeafId: tree.routeLeafId,
      rootCount: tree.rootCount,
      health: this.historyHealth(),
    };
    if (Buffer.byteLength(JSON.stringify(response)) > BRANCH_TREE_MAX_BYTES) {
      throw requestError(
        "Session tree response exceeds its serialized limit",
        422,
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
      throw requestError("Effective branch leaf does not exist", 409);
    }
    return contextMessages(
      this.currentEntries,
      effectiveLeafId,
      this.currentEntriesById,
    );
  }

  composerHistoryMessages(
    effectiveLeafId: string | null = this.currentLeafId,
  ): readonly ComposerHistoryMessage[] {
    if (
      effectiveLeafId !== null &&
      !this.currentEntriesById.has(effectiveLeafId)
    )
      throw requestError("Effective branch leaf does not exist", 409);
    const messages: ComposerHistoryMessage[] = [];
    let id = effectiveLeafId;
    while (id !== null) {
      const entry = this.currentEntriesById.get(id)!;
      if (
        entry.type === "message" &&
        (entry.message.role === "user" ||
          entry.message.role === "bashExecution")
      ) {
        messages.push({
          ...entry.message,
          __inspireHistoryEntryId: entry.id,
        });
      }
      id = entry.parentId;
    }
    return messages.reverse();
  }

  latestPage(
    overlay: readonly unknown[] = [],
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
  ): TranscriptPage {
    const persisted = this.viewMessages(effectiveLeafId);
    const messages = overlay.length ? [...persisted, ...overlay] : persisted;
    return this.buildPage(messages, persisted.length, effectiveLeafId, viewId);
  }

  private historyCursor(
    kind: ParsedCursor["kind"],
    before: number,
    effectiveLeafId: string | null,
    viewId: string,
  ): string {
    return signedCursor({
      kind,
      sessionId: this.sessionId,
      incarnation: this.incarnation,
      sourceGeneration: this.historySourceGeneration,
      revision: this.revision,
      effectiveLeafId,
      viewId,
      before,
    });
  }

  private validatedCursor(
    cursor: string,
    expectedKind: ParsedCursor["kind"],
    effectiveLeafId: string | null,
    viewId: string,
    length: number,
  ): ParsedCursor {
    const decoded = parseCursor(cursor);
    if (decoded.kind !== expectedKind) {
      throw requestError("Transcript cursor has the wrong purpose", 400);
    }
    if (decoded.sessionId !== this.sessionId) {
      throw requestError("Transcript cursor belongs to another session", 409);
    }
    if (decoded.incarnation !== this.incarnation) {
      throw requestError(
        "Transcript cursor belongs to an expired projection incarnation",
        409,
      );
    }
    if (decoded.viewId !== viewId) {
      throw requestError(
        "Transcript cursor belongs to another branch view",
        409,
      );
    }
    if (!this.continues(effectiveLeafId, decoded.effectiveLeafId))
      throw requestError(
        "Transcript cursor is stale or belongs to another branch view",
        409,
      );
    if (
      decoded.sourceGeneration !== this.historySourceGeneration ||
      decoded.revision > this.revision
    ) {
      throw requestError(
        "Transcript cursor is stale; refresh the session",
        409,
      );
    }
    if (decoded.before > length) {
      throw requestError("Transcript cursor is invalid", 400);
    }
    return decoded;
  }

  historyPage<Q extends SessionHistoryQuery>(
    query: Q,
    effectiveLeafId?: string | null,
    viewId?: string,
    cwd?: string,
    fileNameForPath?: ComposerHistoryFileNameResolver,
  ): SessionHistoryPages[Q["kind"]];
  historyPage(
    query: SessionHistoryQuery,
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
    cwd?: string,
    fileNameForPath?: ComposerHistoryFileNameResolver,
  ): SessionHistoryPages[keyof SessionHistoryPages] {
    switch (query.kind) {
      case "page":
        return this.nativeTurnPage(
          query,
          query.leafId ?? effectiveLeafId,
          viewId,
        );
      case "search":
        return this.findHistory(query.text, query.leafId ?? effectiveLeafId);

      case "entry":
        return this.branchEntry(
          query.targetId,
          query.offset ?? 0,
          effectiveLeafId,
          query.format,
        );
      case "composer":
        return this.composerHistoryPage(
          query.start,
          effectiveLeafId,
          viewId,
          cwd,
          fileNameForPath,
        );
    }
  }

  private nativeHistory(leafId: string | null) {
    if (
      this.historyCache?.leafId === leafId &&
      this.historyCache.revision === this.revision
    )
      return this.historyCache;
    const path: SessionEntry[] = [];
    for (let id = leafId; id !== null; ) {
      const entry = this.currentEntriesById.get(id);
      if (!entry)
        throw requestError("The selected branch no longer exists", 409);
      path.push(entry);
      id = entry.parentId;
    }
    const messages = appendContextMessages([], path.reverse());
    const entries = new Map<string, number>();
    const turns: number[] = [];
    messages.forEach((message, index) => {
      const record = message as Record<string, unknown>;
      const id = record.__inspireEntryId;
      if (typeof id === "string" && !entries.has(id)) entries.set(id, index);
      if (record.role === "user") turns.push(index);
    });
    return (this.historyCache = {
      leafId,
      revision: this.revision,
      messages,
      entries,
      turns,
    });
  }

  private nativeTurnPage(
    query: Extract<SessionHistoryQuery, { kind: "page" }>,
    leafId: string | null,
    viewId: string,
  ): NativeTurnPage {
    const cursor = query.cursor ? parseCursor(query.cursor) : null;
    // Cursor positions belong to a fixed leaf, even while Pi continues it.
    const pinnedLeaf = cursor ? cursor.effectiveLeafId : leafId;
    if (cursor && !this.continues(leafId, pinnedLeaf))
      throw requestError("History is no longer on the selected branch", 409);
    const { messages, entries, turns } = this.nativeHistory(pinnedLeaf);
    const boundary = (at: number, direction: "before" | "after") =>
      this.historyCursor(
        direction === "before" ? "native-before" : "native-after",
        at,
        pinnedLeaf,
        viewId,
      );
    const turnOf = (index: number) =>
      Number(jsonRecord(messages[index])?.__inspireUserTurnIndex ?? -1) + 1;
    const shell = (
      start: number,
      end: number,
      rows: unknown[],
    ): NativeTurnPage => ({
      sessionId: this.sessionId,
      viewId,
      incarnation: this.incarnation,
      revision: this.revision,
      leafId: pinnedLeaf,
      messages: rows,
      firstTurn: turnOf(start),
      lastTurn: turnOf(end - 1),
      totalTurns: turns.length,
      earlier: start > 0 ? boundary(start, "before") : null,
      later: end < messages.length ? boundary(end, "after") : null,
    });
    if (cursor) {
      if (cursor.kind !== "native-before" && cursor.kind !== "native-after")
        throw requestError("History cursor has the wrong purpose", 400);
      this.validatedCursor(
        query.cursor!,
        cursor.kind,
        leafId,
        viewId,
        messages.length,
      );
    }
    const anchor =
      query.entryId === undefined ? undefined : entries.get(query.entryId);
    if (query.entryId !== undefined && anchor === undefined)
      throw requestError("The entry is not on this branch", 404);
    const reverse =
      cursor?.kind === "native-before" || (!cursor && anchor === undefined);
    const pivot = cursor?.before ?? anchor ?? messages.length;
    const index = (i: number) => (reverse ? i - 1 : i);
    const advance = reverse ? -1 : 1;
    const builder = new TranscriptPageBuilder((end, rows) =>
      reverse ? shell(end, pivot, rows) : shell(pivot, end, rows),
    );
    let edge = pivot;
    while (
      index(edge) >= 0 &&
      index(edge) < messages.length &&
      builder.length < TRANSCRIPT_PAGE_MAX_MESSAGES
    ) {
      const row = index(edge);
      if (builder.length && Math.abs(turnOf(row) - turnOf(index(pivot))) >= 8)
        break;
      const item = boundedTranscriptItem(
        messages[row],
        row,
        this.fileNameForPath,
      );
      if (!builder.add(edge + advance, item)) break;
      edge += advance;
    }
    return builder.page(edge, reverse);
  }

  private findHistory(text: string, leafId: string | null) {
    const needle = text.toLowerCase();
    const { entries, messages } = this.nativeHistory(leafId);
    const matches: HistoryMatch[] = [];
    for (const [entryId, index] of entries) {
      const entry = this.currentEntriesById.get(entryId)!;
      const body = branchEntryText(entry, "separate");
      const offset = body.toLowerCase().indexOf(needle);
      if (offset < 0) continue;
      if (matches.length >= 40) return { matches, more: true };
      matches.push({
        entryId,
        turn:
          Number(jsonRecord(messages[index])?.__inspireUserTurnIndex ?? -1) + 1,
        snippet: body.slice(
          Math.max(0, offset - 45),
          offset + needle.length + 90,
        ),
      });
    }
    return { matches, more: false };
  }

  private composerHistoryVersion(effectiveLeafId: string | null): string {
    const anchor =
      effectiveLeafId === this.currentLeafId
        ? this.currentHistoryAnchor
        : composerHistoryAnchor(this.currentEntriesById, effectiveLeafId);
    // Entry ancestry is immutable during append. A rewrite may reuse IDs with
    // changed content, so it starts a new history epoch even at the same leaf.
    return JSON.stringify([this.historyReplacementRevision, anchor]);
  }

  private composerHistoryPage(
    start: number | undefined,
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
    cwd?: string,
    fileNameForPath?: ComposerHistoryFileNameResolver,
  ): ComposerHistoryPage {
    return projectComposerHistoryPage(
      this.composerHistoryMessages(effectiveLeafId),
      {
        sessionId: this.sessionId,
        revision: this.revision,
        viewId,
        incarnation: this.incarnation,
        effectiveLeafId,
        composerHistoryVersion: this.composerHistoryVersion(effectiveLeafId),
      },
      start,
      cwd,
      fileNameForPath,
    );
  }

  private buildPage(
    source: readonly unknown[],
    persistedLength: number,
    effectiveLeafId: string | null,
    viewId: string,
  ): TranscriptPage {
    const identity = {
      sessionId: this.sessionId,
      revision: this.revision,
      viewId,
      incarnation: this.incarnation,
      appendFromRevision: this.appendFromRevision,
      effectiveLeafId,
      composerHistoryVersion: this.composerHistoryVersion(effectiveLeafId),
    };
    const builder = new TranscriptPageBuilder((start, messages) => ({
      ...identity,
      messages,
      hasOlder: start > 0,
    }));
    let start = source.length;
    while (start > 0 && builder.length < TRANSCRIPT_PAGE_MAX_MESSAGES) {
      const index = start - 1;
      const item = boundedTranscriptItem(
        source[index],
        index < persistedLength ? index : undefined,
        this.fileNameForPath,
      );
      if (!builder.add(index, item)) break;
      start = index;
    }
    if (builder.length === 0 && source.length > 0) oversizedTranscriptItem();
    return builder.page(start, true);
  }
}

export class WorkerEntryIndex extends SessionEntryIndex {
  appendWorkerEntries(
    entries: readonly SessionEntry[],
    leafId: string | null,
  ): boolean {
    if (entries.length === 0 && leafId === this.currentLeafId) return false;
    const byId = indexSessionEntries(entries, this.currentEntriesById);
    if (leafId !== null && !byId.has(leafId))
      throw requestError("The Pi checkpoint refers to an unknown leaf", 409);
    const all = [...this.currentEntries, ...entries];
    const linear =
      isLinearAppend(this.currentLeafId, entries) &&
      (entries.at(-1)?.id ?? this.currentLeafId) === leafId;
    const previousMessages = this.currentMessages;
    this.currentMessages = linear
      ? appendContextMessages(this.currentMessages, entries)
      : contextMessages(all, leafId, byId);
    this.currentEntriesById = byId;
    this.currentEntries = all;
    this.currentLeafId = leafId;
    this.currentRevision += 1;
    if (
      projectedMessageChange(
        "append",
        previousMessages,
        this.currentMessages,
      ) === "replace"
    )
      this.appendFromRevision = this.currentRevision;
    if (linear) {
      for (const entry of entries)
        if (changesComposerHistory(entry)) this.currentHistoryAnchor = entry.id;
    } else this.currentHistoryAnchor = composerHistoryAnchor(byId, leafId);
    return true;
  }
}

export class SessionProjection
  extends SessionEntryIndex
  implements SessionProjectionView
{
  private currentHealth: ProjectionHealth = { status: "ok" };
  private currentFailureStatus: number | null = null;
  private currentFailureCode: string | undefined;
  private currentHeader: SessionHeader | null = null;
  private currentIdentity: SessionSourceIdentity | null = null;
  private currentFingerprint = "";
  private currentHashState: Hash | null = null;
  private currentCommittedBytes = 0;
  private currentUncommittedBytes = 0;
  private currentUncommittedFingerprint: string | null = null;
  private reconcileTail: Promise<void> = Promise.resolve();
  private reconcileHandler: ProjectionReconcileHandler | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private hintReading = false;
  private hintDirty = false;
  private reconciliationResume: Promise<void> | null = null;
  private resolveReconciliationResume: (() => void) | null = null;
  private closed = false;
  /** Pi reserves a path for a new session but delays creating the JSONL.
   * Only new-session ownership may enter this state; it remains active across
   * complete-line prefixes until disk catches the creating worker's entries. */
  private initialMaterializationPending: boolean;
  private readonly initialSourceIdentity: { dev: bigint; ino: bigint } | null;
  private readonly initialCwd: string;

  private constructor(
    session: Pick<SessionRecord, "id" | "path" | "cwd" | "source">,
    private readonly readHooks?: SessionProjectionReadHooks,
    initialMaterializationPending = false,
    fileNameForPath?: ComposerHistoryFileNameResolver,
  ) {
    super(session, fileNameForPath);
    this.initialCwd = session.cwd;
    this.initialMaterializationPending = initialMaterializationPending;
    this.initialSourceIdentity =
      initialMaterializationPending || !session.source
        ? null
        : { dev: session.source.dev, ino: session.source.ino };
    if (initialMaterializationPending) {
      this.currentRevision = 1;
      this.appendFromRevision = 1;
    }
  }

  private static async openMode(
    session: SessionRecord,
    readHooks: SessionProjectionReadHooks | undefined,
    initialMaterializationPending: boolean,
    fileNameForPath?: ComposerHistoryFileNameResolver,
  ): Promise<SessionProjection> {
    const projection = new SessionProjection(
      session,
      readHooks,
      initialMaterializationPending,
      fileNameForPath,
    );
    const result = await projection.reconcile(true);
    const loaded = initialMaterializationPending
      ? projection.health.status !== "error"
      : projection.revision > 0;
    if (!loaded) {
      await projection.close();
      throw requestError(
        projection.health.message ?? "Session projection could not be loaded",
        projection.currentFailureStatus ?? 422,
        projection.currentFailureCode
          ? { code: projection.currentFailureCode }
          : undefined,
      );
    }
    projection.startWatching();
    if (result.changed) projection.emit("update", result);
    return projection;
  }

  static open(
    session: SessionRecord,
    readHooks?: SessionProjectionReadHooks,
    fileNameForPath?: ComposerHistoryFileNameResolver,
  ): Promise<SessionProjection> {
    return SessionProjection.openMode(
      session,
      readHooks,
      false,
      fileNameForPath,
    );
  }

  /** Create the sole projection for a Pi-owned new session whose reported
   * path may not exist until Pi flushes its first assistant message. */
  static openPending(
    session: SessionRecord,
    fileNameForPath?: ComposerHistoryFileNameResolver,
  ): Promise<SessionProjection> {
    return SessionProjection.openMode(
      session,
      undefined,
      true,
      fileNameForPath,
    );
  }

  get fingerprint(): string {
    return this.currentFingerprint;
  }
  protected override historyHealth(): ProjectionHealth {
    return this.health;
  }

  get health(): ProjectionHealth {
    return this.currentHealth;
  }
  get sourceIdentity(): string | null {
    return this.currentIdentity
      ? `${this.currentIdentity.dev}:${this.currentIdentity.ino}`
      : null;
  }
  get sourceVersion(): string | null {
    const value = this.currentIdentity;
    return value ? sessionSourceVersion(value) : null;
  }
  attestInitialMaterialization(
    workerEntries: readonly SessionEntry[],
  ): InitialMaterializationAttestation {
    if (!this.initialMaterializationPending) return "mismatch";
    const header = this.currentHeader;
    if (!header) {
      return this.currentEntries.length === 0 &&
        this.currentCommittedBytes === 0 &&
        this.currentUncommittedBytes > 0
        ? "partial"
        : "mismatch";
    }
    if (
      header.version !== CURRENT_SESSION_VERSION ||
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

  setReconcileHandler(handler: ProjectionReconcileHandler): void {
    this.reconcileHandler = handler;
  }

  private resultObservation(): Pick<
    ProjectionReconcileResult,
    | "sourceIdentity"
    | "committedBytes"
    | "uncommittedBytes"
    | "uncommittedFingerprint"
    | "health"
  > {
    return {
      sourceIdentity: this.sourceIdentity,
      committedBytes: this.committedBytes,
      uncommittedBytes: this.uncommittedBytes,
      uncommittedFingerprint: this.uncommittedFingerprint,
      health: this.health,
    };
  }

  private recordHealthFailure(
    error: unknown,
  ): ProjectionReconcileResult | null {
    const health = healthError(error);
    if (
      health.status === this.currentHealth.status &&
      health.message === this.currentHealth.message
    )
      return null;
    this.currentHealth = health;
    return {
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
      ...this.resultObservation(),
      previousUncommittedBytes: this.uncommittedBytes,
      previousTailVerified: true,
    };
  }

  private startWatching(): void {
    if (this.closed || this.watcher || this.pollTimer) return;
    try {
      const watcher = watch(
        dirname(this.path),
        { persistent: false },
        (_event, name) => {
          if (this.closed || this.watcher !== watcher) return;
          if (name && name !== basename(this.path)) return;
          if (this.watchTimer) clearTimeout(this.watchTimer);
          this.watchTimer = setTimeout(() => {
            this.watchTimer = null;
            this.reconcileFromHint();
          }, WATCH_DEBOUNCE_MS);
          this.watchTimer.unref();
        },
      );
      this.watcher = watcher;
      watcher.on("error", (error) => {
        if (this.closed || this.watcher !== watcher) return;
        this.reportHealthFailure(
          new Error(`Session watch failed: ${error.message}`),
        );
      });
    } catch (error) {
      this.reportHealthFailure(error);
    }
    this.pollTimer = setInterval(
      () => this.reconcileFromHint(),
      RECONCILE_INTERVAL_MS,
    );
    this.pollTimer.unref();
  }

  private reconcileFromHint(): void {
    if (this.closed || this.reconciliationResume) return;
    if (this.hintReading) {
      this.hintDirty = true;
      return;
    }
    this.hintReading = true;
    void this.reconcile()
      .then((result) => {
        if (result.changed || result.healthChanged || result.sourceChanged)
          this.emit("update", result);
      })
      .catch((error) => this.reportHealthFailure(error))
      .finally(() => {
        this.hintReading = false;
        if (this.hintDirty) {
          this.hintDirty = false;
          this.reconcileFromHint();
        }
      });
  }

  private reportHealthFailure(error: unknown): void {
    void this.enqueueObservation(async () => {
      if (this.closed) return;
      const result = this.recordHealthFailure(error);
      if (!result) return;
      await this.reconcileHandler?.(result);
      this.emit("update", result);
    }).catch(() => undefined);
  }

  async reconcile(force = false): Promise<ProjectionReconcileResult> {
    while (this.reconciliationResume) await this.reconciliationResume;
    return this.enqueueReconcile(force, true);
  }

  reconcileSuspended(force = false): Promise<ProjectionReconcileResult> {
    // Startup attestation consumes its result itself while ordinary readers wait.
    return this.enqueueReconcile(force, false);
  }

  private enqueueObservation<T>(observe: () => Promise<T>): Promise<T> {
    const run = this.reconcileTail.then(observe);
    // A failed operation still rejects its caller. Draining the FIFO means only
    // that its consumer settled, not that the observation or worker stop succeeded.
    this.reconcileTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private enqueueReconcile(
    force: boolean,
    consume: boolean,
  ): Promise<ProjectionReconcileResult> {
    return this.enqueueObservation(async () => {
      const result = await this.reconcileOnce(force);
      if (consume) await this.reconcileHandler?.(result);
      return result;
    });
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
      if (
        !force &&
        this.currentIdentity &&
        this.currentHealth.status === "ok"
      ) {
        // Ordinary reads reuse a verified version, not merely a pathname or
        // size. Do not follow a replacement symlink back to the former inode;
        // changed or unhealthy sources still take the full verification path.
        if (await sessionVersionAtPath(this.path, this.currentIdentity)) {
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
            ...this.resultObservation(),
            previousUncommittedBytes: this.uncommittedBytes,
            previousTailVerified: true,
          };
        }
      }

      const candidate = await this.readCandidate();
      const initialFileAppearance =
        initialMaterialization && this.currentHeader === null;
      const changed = candidate.fingerprint !== this.currentFingerprint;
      const replaced =
        this.currentHeader !== null &&
        this.currentIdentity !== null &&
        !sameSessionObject(candidate.identity, this.currentIdentity);
      const verifiedUnchangedContent =
        !changed &&
        this.currentIdentity !== null &&
        sameSessionObject(candidate.identity, this.currentIdentity) &&
        previousUncommittedBytes === 0 &&
        candidate.uncommittedBytes === 0 &&
        candidate.committedBytes === this.currentCommittedBytes &&
        candidate.identity.size === BigInt(this.currentCommittedBytes) &&
        candidate.previousPrefixFingerprint === previousFingerprint;
      const previousEntries = this.currentEntries;
      const previousLeafId = this.currentLeafId;
      let kind: ProjectionReconcileResult["kind"] = "none";
      let messageChange: ProjectionMessageChange = "none";
      let appendedEntries: SessionEntry[] | undefined;
      if (replaced) {
        this.historySourceGeneration += 1;
        if (!changed) kind = "rewrite";
      }
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
            sameSessionObject(candidate.identity, this.currentIdentity) &&
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
        if (kind !== "append")
          this.historyReplacementRevision = this.currentRevision;
        if (
          appendedEntries &&
          isLinearAppend(previousLeafId, appendedEntries)
        ) {
          for (const entry of appendedEntries)
            if (changesComposerHistory(entry))
              this.currentHistoryAnchor = entry.id;
        } else {
          this.currentHistoryAnchor = composerHistoryAnchor(
            candidate.entriesById,
            candidate.leafId,
          );
        }
        this.currentModelSelection = candidate.modelSelection;
        this.currentMessages = candidate.messages;
        this.currentThinkingLevel = candidate.thinkingLevel;
        this.currentLeafId = candidate.leafId;
        this.currentEntries = candidate.entries;
        this.currentEntriesById = candidate.entriesById;
        if (!candidate.header)
          throw new Error("Session file has no complete Pi session header");
        this.currentHeader = candidate.header;
        this.currentFingerprint = candidate.fingerprint;
        this.currentCommittedBytes = candidate.committedBytes;
      }
      this.currentHashState = candidate.hashState;
      this.currentIdentity = candidate.identity;
      this.currentUncommittedBytes = candidate.uncommittedBytes;
      this.currentUncommittedFingerprint = candidate.uncommittedFingerprint;
      this.currentHealth =
        candidate.uncommittedBytes > 0
          ? {
              status: "pending",
              message:
                "Session persistence is not yet confirmed. Waiting for Pi to complete its write.",
            }
          : { status: "ok" };
      this.currentFailureStatus = null;
      this.currentFailureCode = undefined;
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
        ...(verifiedUnchangedContent
          ? { verifiedUnchangedContent: true as const }
          : {}),
        previousSourceVersion,
        sourceVersion: this.sourceVersion,
        ...this.resultObservation(),
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
        this.currentFailureStatus = null;
        this.currentFailureCode = undefined;
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
          ...this.resultObservation(),
          previousUncommittedBytes,
          previousTailVerified: true,
        };
      }
      this.currentHealth = healthError(error);
      const code = (error as { code?: string } | null)?.code;
      this.currentFailureCode =
        code === "SESSION_CATALOG_STALE" ||
        (this.currentRevision === 0 &&
          (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP"))
          ? "SESSION_CATALOG_STALE"
          : undefined;
      this.currentFailureStatus =
        error &&
        typeof error === "object" &&
        Number.isInteger((error as { status?: unknown }).status)
          ? (error as { status: number }).status
          : 422;
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
        ...this.resultObservation(),
        previousUncommittedBytes,
        previousTailVerified: false,
      };
    }
  }

  /** Verify the old bytes before accepting appended frames. */
  private async verifiedPrefix(document: SessionDocumentReader) {
    if (
      !this.currentIdentity ||
      !this.currentHeader ||
      !this.currentHashState ||
      !sameSessionObject(document.source, this.currentIdentity) ||
      document.source.size < BigInt(this.currentCommittedBytes)
    )
      return null;

    const hash = createHash("sha256");
    const bytes = await document.readBytes(
      0,
      this.currentCommittedBytes,
      (chunk) => {
        hash.update(chunk);
      },
    );
    return bytes === this.currentCommittedBytes &&
      hash.copy().digest("hex") === this.currentFingerprint
      ? { hash }
      : null;
  }

  private async readCandidate(): Promise<Candidate> {
    // Retry against the currently addressed object when a read races a write
    // or a rename. Both append and full scans use the same open descriptor.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const document = await SessionDocumentReader.open(this.path);
      try {
        if (
          this.currentRevision === 0 &&
          this.initialSourceIdentity &&
          !sameSessionObject(document.source, this.initialSourceIdentity)
        ) {
          throw requestError(
            "The session changed since the catalog was loaded",
            409,
            {
              code: "SESSION_CATALOG_STALE",
            },
          );
        }
        const prefix = await this.verifiedPrefix(document);
        const committed = this.currentCommittedBytes;
        const tailEnd = committed + this.currentUncommittedBytes;
        const start = prefix ? committed : 0;
        const hash = prefix?.hash ?? createHash("sha256");
        const prefixHash = createHash("sha256");
        const tailHash = createHash("sha256");
        const parsed: Record<string, unknown>[] = [];
        const scan = await document
          .scan(
            start,
            (entry) => parsed.push(entry),
            (frame) => hash.update(frame),
            async (chunk, offset) => {
              if (!prefix) await this.readHooks?.afterFullReadChunk?.();
              if (offset < committed)
                prefixHash.update(chunk.subarray(0, committed - offset));
              const tailStart = Math.max(offset, committed);
              if (tailStart < tailEnd && tailStart < offset + chunk.length)
                tailHash.update(
                  chunk.subarray(tailStart - offset, tailEnd - offset),
                );
            },
          )
          .catch(async (error: unknown) => {
            if (await document.stillCurrent()) throw error;
            return null;
          });
        if (!scan || !(await document.stillCurrent())) continue;

        const tail = scan.tail();
        const header = prefix ? this.currentHeader : scan.header;
        if (!header) {
          if (!this.initialMaterializationPending || this.currentHeader)
            throw new Error("Session file has an invalid Pi session header");
          if (tail.length === 0) {
            const pending = new Error(
              "The new session file has not materialized yet",
            ) as NodeJS.ErrnoException;
            pending.code = "ENOENT";
            throw pending;
          }
        } else if (!prefix) {
          if (header.id !== this.sessionId)
            throw requestError("Session file belongs to another session", 409, {
              code: "SESSION_CATALOG_STALE",
            });
          if (
            header.cwd !== this.initialCwd &&
            !(await sameDirectory(header.cwd, this.initialCwd))
          )
            throw requestError(
              "The session working directory changed since the catalog was loaded",
              409,
              {
                code: "SESSION_CATALOG_STALE",
              },
            );
        }

        const mutable = parsed as unknown as Array<
          SessionHeader | SessionEntry
        >;
        if (header && !prefix) migrateSessionEntries(mutable);
        const suffix = (prefix ? mutable : mutable.slice(1)) as SessionEntry[];
        const entries = prefix ? [...this.currentEntries, ...suffix] : suffix;
        const entriesById = indexSessionEntries(
          suffix,
          prefix ? this.currentEntriesById : undefined,
        );
        const leafId = entries.at(-1)?.id ?? null;
        const linearAppend =
          prefix && isLinearAppend(this.currentLeafId, suffix);
        return {
          identity: document.source,
          fingerprint: header
            ? hash.copy().digest("hex")
            : this.currentFingerprint,
          hashState: hash,
          committedBytes: scan.completeBytes,
          uncommittedBytes: tail.length,
          uncommittedFingerprint: tail.length
            ? createHash("sha256").update(tail).digest("hex")
            : null,
          previousPrefixFingerprint: prefix
            ? this.currentFingerprint
            : fingerprintOfSpan(prefixHash, committed, scan.end),
          previousTailFingerprint: fingerprintOfSpan(
            tailHash,
            this.currentUncommittedBytes,
            scan.end - committed,
          ),
          header,
          entries,
          entriesById,
          messages: linearAppend
            ? appendContextMessages(this.currentMessages, suffix)
            : contextMessages(entries, leafId, entriesById),
          modelSelection: linearAppend
            ? appendModelSelection(this.currentModelSelection, suffix)
            : branchModelSelection(entriesById, leafId),
          thinkingLevel: linearAppend
            ? appendedThinkingLevel(this.currentThinkingLevel, suffix)
            : buildSessionContext(entries, leafId, entriesById).thinkingLevel,
          leafId,
        };
      } finally {
        await document.close();
      }
    }
    throw new Error("Session file changed while it was being reconciled");
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
    await this.reconcileTail;
    this.reconcileHandler = null;
    this.removeAllListeners();
    this.currentEntries = [];
    this.currentMessages = [];
  }
}
