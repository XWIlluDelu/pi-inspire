import {
  createHash,
  createHmac,
  type Hash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
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
  type ComposerHistoryPage,
  type ModelOption,
  type NativeTurnPage,
  type ProjectionHealth,
  type SessionHistoryPages,
  type TranscriptPage,
} from "../shared/contracts.js";
import { HISTORY_PROMPT_PAGE_SIZE } from "../shared/contracts.js";
import { userTurnSummary } from "../shared/user-turns.js";
import type { SessionHistoryQuery } from "../shared/history-query.js";
import { jsonRecord } from "../shared/json-record.js";
import { resultChildCalls } from "../shared/tool-activity.js";
import { userMessageContent } from "../shared/user-message.js";
import {
  type ComposerHistoryFileNameResolver,
  projectComposerHistoryPage,
} from "./composer-history.js";
import { samePersistedJson } from "./persisted-json.js";
import {
  buildContextEntries,
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
  selectedBranchModel,
} from "./session-model-selection.js";
import {
  BRANCH_CONTENT_PAGE_CHARS,
  boundedEditableText,
  boundedUserText,
  branchEntryContent,
  branchEntryText,
  branchMessageSource,
  branchAncestors,
  projectHistoryPoint,
  projectSessionTree,
  indexSessionEntries,
  latestSessionRouteLeaf,
  sessionRouteIndex,
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
  committedBytes: number;
  uncommittedBytes: number;
  uncommittedFingerprint: string | null;
  /** Fingerprints observed from this same read, never a later filesystem pass. */
  previousPrefixFingerprint: string | null;
  /** This read hashed the old committed bytes instead of reusing an owned prefix. */
  previousTailFingerprint: string | null;
  header: SessionHeader | null;
  entries: SessionEntry[];
  /** Byte offset where the entries scan began. */
  start: number;
}

type InitialMaterializationAttestation = "partial" | "complete" | "mismatch";

export interface ProjectionReconcileResult {
  changed: boolean;
  /** This observation belongs to the new-session file's first materialization. */
  initialMaterialization: boolean;
  /** Physical JSONL movement; distinct from the projected message view. */
  kind: "none" | "append" | "rewrite";
  /** The active row prefix no longer describes this revision. */
  replacesRows: boolean;
  previousRevision: number;
  revision: number;
  previousLeafId: string | null;
  healthChanged: boolean;
  /** Full file identity or unresolved-tail state moved even if no entry committed. */
  sourceChanged: boolean;
  committedBytes: number;
  uncommittedBytes: number;
  health: ProjectionHealth;
  previousUncommittedBytes: number;
  /** A prior unresolved tail is an exact prefix of this candidate's post-commit bytes. */
  previousTailVerified: boolean;
}

type ProjectionReconcileHandler = (
  result: ProjectionReconcileResult,
) => Promise<void>;

interface ProjectionEntryTarget {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
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

/** Pi places the latest compaction first, then its kept prefix and the
 * entire suffix after it. Put the summary back at that boundary for display. */
function transcriptEntries(
  leafId: string | null,
  byId: Map<string, SessionEntry>,
) {
  const entries = buildContextEntries([], leafId, byId);
  const summary = entries[0];
  if (summary?.type === "compaction") {
    entries.shift();
    const child = entries.findIndex((entry) => entry.parentId === summary.id);
    entries.splice(child < 0 ? entries.length : child, 0, summary);
  }
  return entries;
}

function appendContextMessages(
  previous: unknown[],
  entries: readonly SessionEntry[],
): unknown[] {
  const last = jsonRecord(previous.at(-1));
  let turnOrdinal = Number(last?.__inspireUserTurnIndex ?? -1);
  let turnId = last?.__inspireUserTurnId;
  let messages = previous;
  for (const entry of entries) {
    const source =
      entry.type === "compaction"
        ? jsonRecord(entry.details)?.source
        : undefined;
    // Keep Pi's per-entry indices even when a system checkpoint precedes a summary.
    for (const [index, message] of sessionEntryToContextMessages(
      entry,
    ).entries()) {
      if (message.role === "system") continue;
      if (messages === previous) messages = previous.slice();
      const id = `${entry.id}:${index}`;
      if (message.role === "user") {
        turnOrdinal++;
        turnId = id;
      }
      messages.push({
        ...message,
        __inspireMessageId: id,
        __inspireEntryId: entry.id,
        ...(typeof source === "string" &&
        source &&
        message.role === "compactionSummary"
          ? { __inspireCompactionSource: source }
          : {}),
        // Pi messages may carry extension fields; these coordinates belong to the projection.
        __inspireUserTurnId: turnId,
        __inspireUserTurnIndex: turnId === undefined ? undefined : turnOrdinal,
      });
    }
  }
  return messages;
}

function isLinearAppend(
  currentLeafId: string | null,
  entries: readonly SessionEntry[],
): boolean {
  let parentId = currentLeafId;
  for (const entry of entries) {
    if (entry.parentId !== parentId || entry.type === "compaction")
      return false;
    parentId = entry.id;
  }
  return true;
}

function composerInputMessage(entry: SessionEntry) {
  if (
    entry.type === "message" &&
    (entry.message.role === "user" || entry.message.role === "bashExecution")
  )
    return entry.message;
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
        ...(typeof sourceRecord.__inspireTurnId === "string"
          ? { __inspireTurnId: sourceRecord.__inspireTurnId }
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

function signedCursor(payloadValue: ParsedCursor): string {
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
  const [payload, supplied, extra] = cursor.split(".");
  if (payload && supplied && extra === undefined) {
    const expected = createHmac("sha256", CURSOR_KEY)
      .update(payload)
      .digest("base64url");
    const signature = Buffer.from(supplied);
    if (
      signature.length === expected.length &&
      timingSafeEqual(signature, Buffer.from(expected))
    ) {
      // Only signedCursor can produce a payload for this process-lifetime key.
      return JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as ParsedCursor;
    }
  }
  throw requestError("Transcript cursor is invalid", 400);
}

function healthError(error: unknown): ProjectionHealth {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "error", message };
}

export interface SessionProjectionReadHooks {
  afterFullReadChunk?(): Promise<void> | void;
}

/** Read queries over native entries, independent of any filesystem source. */
class SessionEntryIndex {
  readonly sessionId: string;
  protected currentPath: string;
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
  protected currentEntries: readonly SessionEntry[] = [];
  protected currentEntriesById = new Map<string, SessionEntry>();
  protected currentHistoryAnchor: string | null = null;
  protected historySourceGeneration = 0;
  private historyCache?: {
    leafId: string | null;
    messages: unknown[];
    entries: Map<string, number>;
    turns: number[];
  };
  constructor(
    session: Pick<SessionRecord, "id" | "path">,
    private readonly fileNameForPath?: ComposerHistoryFileNameResolver,
  ) {
    this.sessionId = session.id;
    this.currentPath = resolve(session.path);
  }

  get path(): string {
    return this.currentPath;
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

  /** Validate the incoming suffix before touching the index, and publish the
   * rows and metadata together. Unsealed checkpoints only advance the index. */
  protected applyEntries(
    incoming: readonly SessionEntry[],
    kind: "append" | "rewrite",
    retainPrefix: boolean,
    requestedLeaf?: string | null,
    publishLeaf = true,
  ): boolean {
    const prefix = retainPrefix ? this.currentEntriesById : undefined;
    const added = indexSessionEntries(incoming, prefix);
    const entries = !retainPrefix
      ? incoming
      : incoming.length === 0
        ? this.currentEntries
        : this.currentEntries.concat(incoming);
    const leafId = requestedLeaf === undefined
      ? (entries.at(-1)?.id ?? null)
      : requestedLeaf;
    if (leafId !== null && !added.has(leafId) && !prefix?.has(leafId))
      throw requestError("The Pi checkpoint refers to an unknown leaf", 409);
    const byId = prefix ?? added;
    if (prefix) for (const [id, entry] of added) prefix.set(id, entry);
    try {
      const replacesRows = publishLeaf && this.publishEntries(
        leafId,
        byId,
        retainPrefix ? incoming : entries.slice(this.currentEntries.length),
        kind,
      );
      this.currentEntries = entries;
      this.currentEntriesById = byId;
      return replacesRows;
    } catch (error) {
      if (prefix) for (const id of added.keys()) prefix.delete(id);
      throw error;
    }
  }

  private publishEntries(
    leafId: string | null,
    byId: Map<string, SessionEntry>,
    suffix: readonly SessionEntry[],
    kind: ProjectionReconcileResult["kind"],
  ): boolean {
    const linear =
      kind === "append" &&
      isLinearAppend(this.currentLeafId, suffix) &&
      (suffix.at(-1)?.id ?? this.currentLeafId) === leafId;
    const previousMessages = this.currentMessages;
    const visible = linear ? suffix : transcriptEntries(leafId, byId);
    const messages = appendContextMessages(
      linear ? previousMessages : [],
      visible,
    );
    const replacesRows =
      kind === "rewrite" ||
      (!linear &&
        (previousMessages.length > messages.length ||
          previousMessages.some(
            (row, index) =>
              jsonRecord(row)?.__inspireMessageId !==
              jsonRecord(messages[index])?.__inspireMessageId,
          )));
    // Compaction can conceal model and thinking settings earlier on this branch.
    const branch =
      !linear && visible.some((entry) => entry.type === "compaction")
        ? [...branchAncestors(byId, leafId)].reverse()
        : visible;
    const modelSelection = appendModelSelection(
      linear ? this.currentModelSelection : { change: null, fallback: null },
      branch,
    );
    const thinking = branch.findLast(
      (entry) => entry.type === "thinking_level_change",
    );
    const historyAnchor =
      branch.findLast(composerInputMessage)?.id ??
      (linear ? this.currentHistoryAnchor : null);
    this.currentModelSelection = modelSelection;
    if (thinking) this.currentThinkingLevel = thinking.thinkingLevel;
    else if (!linear) this.currentThinkingLevel = "off";
    this.currentHistoryAnchor = historyAnchor;
    this.currentLeafId = leafId;
    this.currentMessages = messages;
    this.historyCache = undefined;
    this.currentRevision += 1;
    if (replacesRows) this.appendFromRevision = this.currentRevision;
    return replacesRows;
  }

  /** The most recently saved entry continuing this leaf. */
  latestContinuation(leafId: string | null): string | null {
    if (leafId === null) return this.tailEntryId;
    if (leafId === this.tailEntryId || !this.currentEntriesById.has(leafId))
      return leafId;
    return latestSessionRouteLeaf(this.currentEntries, leafId);
  }

  /** Whether either leaf is on the other's saved ancestry. */
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

  /** Committed append suffix after an operation's admitted durable tail. */
  entriesAfter(tailEntryId: string | null): readonly SessionEntry[] {
    if (tailEntryId === null) return this.currentEntries;
    const index = this.currentEntries.findLastIndex(
      (entry) => entry.id === tailEntryId,
    );
    if (index < 0)
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
    format?: "message",
    pointLeaf?: string | null,
  ): BranchEntryResponse {
    const entry = this.currentEntriesById.get(id);
    if (!entry) throw requestError("History point no longer exists", 404);
    const shell =
      entry.type === "message" && entry.message.role === "bashExecution"
        ? entry.message
        : undefined;
    const text =
      format === "message"
        ? branchMessageSource(entry)
        : (shell?.output ?? branchEntryText(entry, "separate"));
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
      ...(shell && offset === 0
        ? {
            shell: {
              command: shell.command,
              exitCode: shell.exitCode,
              cancelled: shell.cancelled,
              truncated: shell.truncated,
              fullOutputPath: shell.fullOutputPath,
              excludeFromContext: shell.excludeFromContext,
            },
          }
        : {}),
      ...(pointLeaf !== undefined
        ? {
            node: projectHistoryPoint(
              this.currentEntries,
              entry,
              this.continues(pointLeaf, entry.id),
              entry.id === pointLeaf,
            ),
            totalChars: text.length,
          }
        : {}),
      text: text.slice(offset, end),
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
    return appendContextMessages(
      [],
      transcriptEntries(effectiveLeafId, this.currentEntriesById),
    );
  }

  /** Preserve the displayed image number from the chronological recall list. */
  historyImage(id: string, part: number, leaf: string | null) {
    const entry = this.currentEntriesById.get(id);
    if (
      entry?.type !== "message" ||
      entry.message.role !== "user" ||
      jsonRecord(entry.message)?.display === false ||
      !this.continues(leaf, id)
    )
      return null;
    const block = Array.isArray(entry.message.content)
      ? entry.message.content[part]
      : undefined;
    if (block?.type !== "image") return null;
    let messageIndex = this.viewMessages(leaf).length;
    for (const ancestor of branchAncestors(
      this.currentEntriesById,
      entry.parentId,
    ))
      if (composerInputMessage(ancestor)) messageIndex++;
    return { block, messageIndex };
  }

  /** Retained user entry on this branch, independent of model compaction. */
  historyUserContent(id: string, leafId: string | null): unknown {
    const message = this.currentEntriesById.get(id);
    if (
      message?.type !== "message" ||
      message.message.role !== "user" ||
      !this.continues(leafId, id)
    )
      throw requestError("A recalled attachment is no longer available", 409);
    return message.message.content;
  }

  private *recentComposerMessages(leaf: string | null) {
    for (const entry of branchAncestors(this.currentEntriesById, leaf)) {
      const message = composerInputMessage(entry);
      if (message) yield { ...message, __inspireHistoryEntryId: entry.id };
    }
  }

  latestPage(
    overlay: readonly { message: unknown }[] = [],
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
    entryTurns?: ReadonlyMap<string, string>,
  ): TranscriptPage {
    const persisted = this.viewMessages(effectiveLeafId);
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
    let start = persisted.length + overlay.length;
    while (start > 0 && builder.length < TRANSCRIPT_PAGE_MAX_MESSAGES) {
      const index = start - 1;
      const saved = index < persisted.length;
      const message = saved
        ? persisted[index]
        : overlay[index - persisted.length]!.message;
      const raw = jsonRecord(message);
      const entryId = raw?.__inspireEntryId;
      const turn =
        typeof entryId === "string" ? entryTurns?.get(entryId) : undefined;
      const item = boundedTranscriptItem(
        turn ? { ...raw, __inspireTurnId: turn } : message,
        saved ? index : undefined,
        this.fileNameForPath,
      );
      if (!builder.add(index, item)) break;
      start = index;
    }
    if (builder.length === 0 && start > 0) oversizedTranscriptItem();
    return builder.page(start, true);
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

  private validateCursorAuthority(
    cursor: ParsedCursor,
    effectiveLeafId: string | null,
    viewId: string,
  ): void {
    if (cursor.sessionId !== this.sessionId) {
      throw requestError("Transcript cursor belongs to another session", 409);
    }
    if (cursor.incarnation !== this.incarnation) {
      throw requestError(
        "Transcript cursor belongs to an expired projection incarnation",
        409,
      );
    }
    if (cursor.viewId !== viewId) {
      throw requestError(
        "Transcript cursor belongs to another branch view",
        409,
      );
    }
    if (!this.continues(effectiveLeafId, cursor.effectiveLeafId))
      throw requestError("History is no longer on the selected branch", 409);
    if (
      cursor.sourceGeneration !== this.historySourceGeneration ||
      cursor.revision > this.revision
    ) {
      throw requestError(
        "Transcript cursor is stale; refresh the session",
        409,
      );
    }
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
      case "turns": {
        const { messages, turns } = this.nativeHistory(effectiveLeafId);
        const total = turns.length;
        const size = HISTORY_PROMPT_PAGE_SIZE;
        const start = Math.min(
          query.start ?? Infinity,
          Math.floor(Math.max(0, total - 1) / size) * size,
        );
        return {
          start,
          total,
          turns: turns.slice(start, start + size).flatMap((index, offset) => {
            const message = messages[index];
            const id = jsonRecord(message)?.__inspireEntryId;
            return typeof id === "string"
              ? [{ id, ordinal: start + offset, ...userTurnSummary(message) }]
              : [];
          }),
        };
      }
      case "outline":
        return {
          sessionId: this.sessionId,
          revision: this.revision,
          incarnation: this.incarnation,
          durableLeafId: this.currentLeafId,
          effectiveLeafId,
          ...projectSessionTree(
            this.currentEntries,
            this.currentEntriesById,
            effectiveLeafId,
            query,
          ),
        };
      case "branches":
        return this.branchLeaves(effectiveLeafId);
      case "entry":
        return this.branchEntry(
          query.targetId,
          query.offset ?? 0,
          query.format,
          query.point ? effectiveLeafId : undefined,
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

  branchEntries(leafId: string | null): SessionEntry[] {
    return [...branchAncestors(this.currentEntriesById, leafId)].reverse();
  }

  private nativeHistory(leafId: string | null) {
    if (this.historyCache?.leafId === leafId) return this.historyCache;
    const messages =
      leafId === this.currentLeafId &&
      !this.currentMessages.some(
        (row) => jsonRecord(row)?.role === "compactionSummary",
      )
        ? this.currentMessages
        : appendContextMessages([], this.branchEntries(leafId));
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
    if (cursor) this.validateCursorAuthority(cursor, leafId, viewId);
    const pinnedLeaf = cursor ? cursor.effectiveLeafId : leafId;
    const { messages, entries } = this.nativeHistory(pinnedLeaf);
    if (cursor && cursor.before > messages.length)
      throw requestError("Transcript cursor is invalid", 400);
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
      earlier: start > 0 ? boundary(start, "before") : null,
      later: end < messages.length ? boundary(end, "after") : null,
    });
    const anchor =
      query.entryId === undefined ? undefined : entries.get(query.entryId);
    if (query.entryId !== undefined && anchor === undefined)
      throw requestError("The entry is not on this branch", 404);
    const reverse =
      cursor?.kind === "native-before" ||
      (!cursor && (anchor === undefined || query.direction === "earlier"));
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

  private branchLeaves(
    currentLeafId: string | null,
  ): SessionHistoryPages["branches"] {
    const routes = sessionRouteIndex(this.currentEntries);
    const excerpt = (leaf: SessionEntry): string => {
      for (const entry of branchAncestors(this.currentEntriesById, leaf.id)) {
        if (entry.type === "message" && entry.message.role === "user") {
          const text = branchEntryText(entry).replace(/\s+/gu, " ").trim();
          return text.length > 80 ? `${text.slice(0, 79)}…` : text;
        }
      }
      return "";
    };
    const leaves: SessionHistoryPages["branches"]["leaves"] = [];
    for (
      let i = this.currentEntries.length - 1;
      i >= 0 && leaves.length < 30;
      i--
    ) {
      const leaf = this.currentEntries[i]!;
      if (!routes.has(leaf.id))
        leaves.push({
          id: leaf.id,
          excerpt: excerpt(leaf),
          updatedAt: leaf.timestamp,
          isCurrent: leaf.id === currentLeafId,
        });
    }
    return { total: this.currentEntries.length - routes.size, leaves };
  }

  private composerHistoryVersion(effectiveLeafId: string | null): string {
    let anchor = this.currentHistoryAnchor;
    if (effectiveLeafId !== this.currentLeafId) {
      anchor = null;
      for (const entry of branchAncestors(
        this.currentEntriesById,
        effectiveLeafId,
      )) {
        if (composerInputMessage(entry)) {
          anchor = entry.id;
          break;
        }
      }
    }
    // Entry ancestry is immutable during append. A rewrite may reuse IDs with
    // changed content, so it starts a new history epoch even at the same leaf.
    return JSON.stringify([this.historySourceGeneration, anchor]);
  }

  private composerHistoryPage(
    start: number | undefined,
    effectiveLeafId: string | null = this.currentLeafId,
    viewId = this.incarnation,
    cwd?: string,
    fileNameForPath?: ComposerHistoryFileNameResolver,
  ): ComposerHistoryPage {
    return projectComposerHistoryPage(
      this.recentComposerMessages(effectiveLeafId),
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
}

export class WorkerEntryIndex extends SessionEntryIndex {
  appendWorkerEntries(
    entries: readonly SessionEntry[],
    leafId: string | null,
    publishLeaf = true,
  ): boolean {
    if (entries.length === 0 && leafId === this.currentLeafId) return false;
    this.applyEntries(entries, "append", true, leafId, publishLeaf);
    return publishLeaf;
  }
}

export class SessionProjection extends SessionEntryIndex {
  private currentHealth: ProjectionHealth = { status: "ok" };
  private currentFailureStatus: number | null = null;
  private currentFailureCode: string | undefined;
  private currentHeader: SessionHeader | null = null;
  private currentIdentity: SessionSourceIdentity | null = null;
  private currentFingerprint = "";
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
  private reconciliationResume: PromiseWithResolvers<void> | null = null;
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
    await projection.reconcile(true);
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

  get health(): ProjectionHealth {
    return this.currentHealth;
  }
  get sourceIdentity(): string | null {
    return this.currentIdentity
      ? `${this.currentIdentity.dev}:${this.currentIdentity.ino}`
      : null;
  }
  /** Exact stat version used to fence movement before worker startup. */
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
  async suspendReconciliation(): Promise<void> {
    this.reconciliationResume ??= Promise.withResolvers<void>();
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watchTimer = null;
    this.pollTimer = null;
    this.watcher?.close();
    this.watcher = null;
    await this.reconcileTail;
  }

  /** The published hard link must address the same complete bytes we indexed in staging. */
  async adoptPublishedFork(path: string): Promise<void> {
    const identity = this.sourceIdentity;
    const fingerprint = this.fingerprint;
    this.currentPath = resolve(path);
    await this.reconcileSuspended(true);
    if (
      this.health.status !== "ok" ||
      this.sourceIdentity !== identity ||
      this.fingerprint !== fingerprint ||
      this.uncommittedBytes !== 0
    )
      throw new Error("Published fork destination failed revalidation");
    this.resumeReconciliation();
  }

  resumeReconciliation(): void {
    this.reconciliationResume?.resolve();
    this.reconciliationResume = null;
    if (!this.closed && !this.watcher && !this.pollTimer) this.startWatching();
  }

  setReconcileHandler(handler: ProjectionReconcileHandler): void {
    this.reconcileHandler = handler;
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
      const result = await this.observe(() => {
        this.currentHealth = healthError(error);
      });
      if (result.healthChanged) await this.reconcileHandler?.(result);
    }).catch(() => undefined);
  }

  async reconcile(force = false): Promise<ProjectionReconcileResult> {
    while (this.reconciliationResume) await this.reconciliationResume.promise;
    return this.enqueueReconcile(force, true);
  }

  /** Startup attestation while ordinary readers are suspended. */
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
      const result = await this.observe(() => this.reconcileOnce(force));
      if (consume) await this.reconcileHandler?.(result);
      return result;
    });
  }

  private async observe(
    reconcile: () => void | Promise<
      | {
          kind: ProjectionReconcileResult["kind"];
          replacesRows: boolean;
          previousTailVerified: boolean;
        }
      | undefined
    >,
  ): Promise<ProjectionReconcileResult> {
    if (this.closed) throw new Error("Session projection is closed");
    const previousRevision = this.revision;
    const previousLeafId = this.currentLeafId;
    const previousHealth = this.health;
    const previousSourceVersion = this.sourceVersion;
    const previousUncommittedBytes = this.uncommittedBytes;
    const previousUncommittedFingerprint = this.currentUncommittedFingerprint;
    const result = await reconcile();
    return {
      changed: previousRevision !== this.revision,
      initialMaterialization: this.initialMaterializationPending,
      kind: result?.kind ?? "none",
      replacesRows: result?.replacesRows ?? false,
      previousRevision,
      revision: this.revision,
      previousLeafId,
      healthChanged:
        previousHealth.status !== this.health.status ||
        previousHealth.message !== this.health.message,
      sourceChanged:
        previousSourceVersion !== this.sourceVersion ||
        previousUncommittedBytes !== this.uncommittedBytes ||
        previousUncommittedFingerprint !== this.currentUncommittedFingerprint,
      committedBytes: this.committedBytes,
      uncommittedBytes: this.uncommittedBytes,
      health: this.health,
      previousUncommittedBytes,
      previousTailVerified: result?.previousTailVerified ?? true,
    };
  }

  private async reconcileOnce(force: boolean) {
    try {
      if (
        !force &&
        this.currentIdentity &&
        this.currentHealth.status === "ok" &&
        (await sessionVersionAtPath(this.path, this.currentIdentity))
      )
        return;

      const candidate = await this.readCandidate();
      const initialFileAppearance =
        this.initialMaterializationPending && this.currentHeader === null;
      const changed = candidate.fingerprint !== this.currentFingerprint;
      const replaced =
        this.currentHeader !== null &&
        this.currentIdentity !== null &&
        !sameSessionObject(candidate.identity, this.currentIdentity);
      let kind: ProjectionReconcileResult["kind"] = "none";
      let replacesRows = false;
      const previousTailVerified =
        this.uncommittedBytes === 0 ||
        candidate.previousTailFingerprint ===
          this.currentUncommittedFingerprint;
      if (replaced) kind = "rewrite";
      if (changed) {
        if (!candidate.header)
          throw new Error("Session file has no complete Pi session header");
        const prefixVerified =
          this.currentCommittedBytes === 0 ||
          candidate.previousPrefixFingerprint === this.currentFingerprint;
        kind =
          initialFileAppearance ||
          (this.currentIdentity &&
            !replaced &&
            candidate.committedBytes >= this.currentCommittedBytes &&
            this.currentFingerprint &&
            prefixVerified &&
            previousTailVerified)
            ? "append"
            : "rewrite";
        replacesRows = this.applyEntries(
          candidate.entries,
          kind,
          candidate.start > 0,
        );
        this.currentHeader = candidate.header;
        this.currentFingerprint = candidate.fingerprint;
        this.currentCommittedBytes = candidate.committedBytes;
      }
      if (kind === "rewrite") this.historySourceGeneration += 1;
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
      return { kind, replacesRows, previousTailVerified };
    } catch (error) {
      if (
        this.initialMaterializationPending &&
        this.currentIdentity === null &&
        (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ) {
        this.currentHealth = { status: "ok" };
        this.currentFailureStatus = null;
        this.currentFailureCode = undefined;
        return;
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
        kind: "none" as const,
        replacesRows: false,
        previousTailVerified: false,
      };
    }
  }

  /** Verify the old bytes before accepting appended frames. */
  private async verifiedPrefix(document: SessionDocumentReader) {
    if (
      !this.currentIdentity ||
      !this.currentHeader ||
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
        return {
          identity: document.source,
          fingerprint: header
            ? hash.copy().digest("hex")
            : this.currentFingerprint,
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
          entries: suffix,
          start,
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
    this.reconciliationResume?.resolve();
    this.reconciliationResume = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    await this.reconcileTail;
    this.reconcileHandler = null;
    this.currentEntries = [];
    this.currentMessages = [];
  }
}
