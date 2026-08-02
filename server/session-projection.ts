import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import {
  buildContextEntries,
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  sessionEntryToContextMessages,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { BranchTreeResponse, ProjectionHealth, TranscriptPage } from "../shared/contracts.js";
import { messageFallbackCorrelation } from "../shared/message-identity.js";
import type { SessionRecord } from "./session-catalog.js";
import { BRANCH_TREE_MAX_BYTES, boundedUserText, projectSessionTree } from "./session-tree.js";
import { samePersistedJson } from "./persisted-json.js";
import { projectSafeValue } from "./safe-projection.js";

/** Persisted JSONL and child RPC frames are independent trust boundaries. */
export const MAX_PERSISTED_ENTRY_BYTES = 32 * 1024 * 1024;
/** Includes the complete JSON representation of a TranscriptPage. */
export const TRANSCRIPT_PAGE_MAX_BYTES = 1024 * 1024;
export const TRANSCRIPT_PAGE_MAX_MESSAGES = 100;
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
  committedBytes: number;
  uncommittedBytes: number;
  uncommittedFingerprint: string | null;
  /** Fingerprints observed from this same read, never a later filesystem pass. */
  previousPrefixFingerprint: string | null;
  previousTailFingerprint: string | null;
  header: SessionHeader;
  entries: SessionEntry[];
  messages: unknown[];
  model: unknown;
  thinkingLevel: string;
  leafId: string | null;
}

export type InitialMaterializationAttestation = "partial" | "complete" | "mismatch";

export interface ProjectionReconcileResult {
  changed: boolean;
  /** This observation belongs to the new-session file's first materialization. */
  initialMaterialization: boolean;
  kind: "none" | "append" | "rewrite";
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
  attestInitialMaterialization(cwd: string, workerEntries: readonly SessionEntry[]): InitialMaterializationAttestation;
  hasActiveEntryType(type: string): boolean;
  suspendReconciliation(): Promise<void>;
  resumeReconciliation(): void;
  latestPage(overlay?: readonly unknown[], effectiveLeafId?: string | null, viewId?: string): TranscriptPage;
  page(cursor: string, effectiveLeafId?: string | null, viewId?: string): TranscriptPage;
  branchTree(effectiveLeafId?: string | null): BranchTreeResponse;
  entry(id: string): ProjectionEntryTarget | null;
  userText(id: string, maxChars: number): string;
  viewMessages(effectiveLeafId?: string | null): readonly unknown[];
  reconcile(force?: boolean): Promise<ProjectionReconcileResult>;
  /** Host startup attestation only: reconcile while ordinary readers are suspended. */
  reconcileSuspended(force?: boolean): Promise<ProjectionReconcileResult>;
  close(): Promise<void>;
  on(event: "update", listener: (result: ProjectionReconcileResult) => void): this;
}

function identity(details: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>): FileIdentity {
  const value = details as unknown as {
    dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint;
  };
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs };
}

function sameObject(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left: FileIdentity, right: FileIdentity): boolean {
  return sameObject(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function contextMessages(entries: SessionEntry[], leafId: string | null, byId: Map<string, SessionEntry>): unknown[] {
  return buildContextEntries(entries, leafId, byId).flatMap((entry) =>
    sessionEntryToContextMessages(entry).map((message, index) => ({
      ...message,
      __inspireMessageId: `${entry.id}:${index}`,
    })),
  );
}

interface BoundedTranscriptItem { value: unknown; serialized: string }

/** Browser projection, not persisted data: constrain breadth/depth and strings.
 * The optional persisted index is applied before the item's sole serialization. */
function boundedTranscriptItem(value: unknown, persistedIndex?: number): BoundedTranscriptItem {
  const decorate = (projected: unknown): unknown => persistedIndex !== undefined && projected && typeof projected === "object" && !Array.isArray(projected)
    ? { ...(projected as Record<string, unknown>), __inspireMessageIndex: persistedIndex }
    : projected;
  for (const limits of [
    { depth: 16, stringChars: 64_000, arrayItems: 256, objectEntries: 256 },
    { depth: 8, stringChars: 2_000, arrayItems: 32, objectEntries: 32 },
  ]) {
    const projected = decorate(projectSafeValue(value, limits));
    const serialized = JSON.stringify(projected) ?? "null";
    if (Buffer.byteLength(serialized) <= 256 * 1024) return { value: projected, serialized };
  }
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const projected = decorate({
    role: typeof record.role === "string" ? record.role : "unknown",
    ...(record.timestamp !== undefined ? { timestamp: record.timestamp } : {}),
    content: "[message omitted: projected content exceeded the transcript item limit]",
  });
  return { value: projected, serialized: JSON.stringify(projected) };
}

export function boundedTranscriptValue(value: unknown): unknown {
  return boundedTranscriptItem(value).value;
}

function cursorFor(sessionId: string, incarnation: string, fingerprint: string, revision: number, before: number, effectiveLeafId: string | null, viewId: string): string {
  const payload = Buffer.from(JSON.stringify({ sessionId, incarnation, fingerprint, revision, before, effectiveLeafId, viewId })).toString("base64url");
  const signature = createHmac("sha256", CURSOR_KEY).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function parseCursor(cursor: string): { sessionId: string; incarnation: string; fingerprint: string; revision: number; before: number; effectiveLeafId: string | null; viewId: string } {
  const [payload, supplied] = cursor.split(".");
  if (!payload || !supplied) throw Object.assign(new Error("Transcript cursor is invalid"), { status: 400 });
  const expected = createHmac("sha256", CURSOR_KEY).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(supplied, "base64url");
  } catch {
    throw Object.assign(new Error("Transcript cursor is invalid"), { status: 400 });
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw Object.assign(new Error("Transcript cursor is invalid"), { status: 400 });
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof parsed.sessionId !== "string" ||
      typeof parsed.incarnation !== "string" ||
      typeof parsed.fingerprint !== "string" ||
      !Number.isSafeInteger(parsed.revision) ||
      !Number.isSafeInteger(parsed.before) ||
      Number(parsed.before) < 0 ||
      (parsed.effectiveLeafId !== null && typeof parsed.effectiveLeafId !== "string") ||
      typeof parsed.viewId !== "string" || !parsed.viewId
    ) throw new Error("invalid");
    return {
      sessionId: parsed.sessionId,
      incarnation: parsed.incarnation,
      fingerprint: parsed.fingerprint,
      revision: Number(parsed.revision),
      before: Number(parsed.before),
      effectiveLeafId: parsed.effectiveLeafId,
      viewId: parsed.viewId,
    };
  } catch {
    throw Object.assign(new Error("Transcript cursor is invalid"), { status: 400 });
  }
}

function healthError(error: unknown): ProjectionHealth {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "error", message };
}

function decodeJsonlObject(line: Buffer): Record<string, unknown> {
  if (line.length === 0) throw new Error("Persisted session contains an empty JSONL entry");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
  } catch (error) {
    throw new Error(`Persisted session contains a malformed complete JSONL entry: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted session entry must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/** One incremental decoder owns full and append framing. A non-LF tail stays unparsed on disk. */
class JsonlObjectDecoder {
  private pending: Buffer = Buffer.alloc(0);
  constructor(private readonly onFrame: (frame: Buffer) => void) {}
  tail(): Buffer { return Buffer.from(this.pending); }
  push(chunk: Buffer): Record<string, unknown>[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const values: Record<string, unknown>[] = [];
    while (true) {
      const lf = this.pending.indexOf(0x0a);
      if (lf === -1) {
        if (this.pending.length > MAX_PERSISTED_ENTRY_BYTES) throw new Error(`Persisted session entry exceeds ${MAX_PERSISTED_ENTRY_BYTES} bytes`);
        return values;
      }
      const line = this.pending.subarray(0, lf);
      if (line.length > MAX_PERSISTED_ENTRY_BYTES) throw new Error(`Persisted session entry exceeds ${MAX_PERSISTED_ENTRY_BYTES} bytes`);
      const frame = this.pending.subarray(0, lf + 1);
      this.onFrame(frame);
      this.pending = this.pending.subarray(lf + 1);
      values.push(decodeJsonlObject(line));
    }
  }
}

export interface SessionProjectionReadHooks {
  afterFullReadChunk?(): Promise<void> | void;
  afterPrefixReadChunk?(): Promise<void> | void;
  afterMessageProjection?(): void;
}

export class SessionProjection extends EventEmitter implements SessionProjectionView {
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
  private currentHeader: SessionHeader | null = null;
  private currentIdentity: FileIdentity | null = null;
  private currentFingerprint = "";
  private currentCommittedBytes = 0;
  private currentUncommittedBytes = 0;
  private currentUncommittedFingerprint: string | null = null;
  private reconcileTail: Promise<ProjectionReconcileResult> = Promise.resolve({
    changed: false,
    initialMaterialization: false,
    kind: "none",
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
    const projection = new SessionProjection(session, readHooks, initialMaterializationPending);
    const result = await projection.reconcile(true);
    const loaded = initialMaterializationPending ? projection.health.status !== "error" : projection.revision > 0;
    if (!loaded) {
      await projection.close();
      throw Object.assign(new Error(projection.health.message ?? "Session projection could not be loaded"), { status: 422 });
    }
    projection.startWatching();
    if (result.changed) projection.emit("update", result);
    return projection;
  }

  static open(session: SessionRecord, readHooks?: SessionProjectionReadHooks): Promise<SessionProjection> {
    return SessionProjection.openMode(session, readHooks, false);
  }

  /** Create the sole projection for a Pi-owned new session whose reported
   * path may not exist until Pi flushes its first assistant message. */
  static openPending(session: SessionRecord, readHooks?: SessionProjectionReadHooks): Promise<SessionProjection> {
    return SessionProjection.openMode(session, readHooks, true);
  }

  get revision(): number { return this.currentRevision; }
  get fingerprint(): string { return this.currentFingerprint; }
  get health(): ProjectionHealth { return this.currentHealth; }
  get messages(): readonly unknown[] { return this.currentMessages; }
  get model(): unknown { return this.currentModel; }
  get thinkingLevel(): string { return this.currentThinkingLevel; }
  get leafId(): string | null { return this.currentLeafId; }
  get tailEntryId(): string | null { return this.currentEntries.at(-1)?.id ?? null; }
  get sourceIdentity(): string | null {
    return this.currentIdentity ? `${this.currentIdentity.dev}:${this.currentIdentity.ino}` : null;
  }
  get sourceVersion(): string | null {
    const value = this.currentIdentity;
    return value ? `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}` : null;
  }
  attestInitialMaterialization(cwd: string, workerEntries: readonly SessionEntry[]): InitialMaterializationAttestation {
    const header = this.currentHeader;
    if (
      !this.initialMaterializationPending || !header ||
      header.version !== CURRENT_SESSION_VERSION ||
      resolve(header.cwd) !== resolve(cwd) ||
      header.parentSession !== undefined ||
      this.currentEntries.length > workerEntries.length ||
      !samePersistedJson(this.currentEntries, workerEntries.slice(0, this.currentEntries.length))
    ) return "mismatch";
    if (this.currentEntries.length < workerEntries.length || this.currentUncommittedBytes > 0) return "partial";
    this.initialMaterializationPending = false;
    return "complete";
  }
  get committedBytes(): number { return this.currentCommittedBytes; }
  get uncommittedBytes(): number { return this.currentUncommittedBytes; }
  get uncommittedFingerprint(): string | null { return this.currentUncommittedFingerprint; }

  hasActiveEntryType(type: string): boolean {
    const byId = new Map(this.currentEntries.map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    let id = this.currentLeafId;
    while (id !== null) {
      if (seen.has(id)) return false;
      seen.add(id);
      const entry = byId.get(id);
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

  entry(id: string): ProjectionEntryTarget | null {
    const found = this.currentEntries.find((entry) => entry.id === id);
    if (!found) return null;
    return {
      id: found.id,
      parentId: found.parentId,
      type: found.type,
      ...(found.type === "message" && typeof (found.message as { role?: unknown }).role === "string"
        ? { role: (found.message as { role: string }).role }
        : {}),
    };
  }

  userText(id: string, maxChars: number): string {
    const entry = this.currentEntries.find((candidate) => candidate.id === id);
    if (!entry) throw Object.assign(new Error("Branch target does not exist"), { status: 404 });
    return boundedUserText(entry, maxChars);
  }

  branchTree(effectiveLeafId: string | null = this.currentLeafId): BranchTreeResponse {
    if (effectiveLeafId !== null && !this.currentEntries.some((entry) => entry.id === effectiveLeafId)) {
      throw Object.assign(new Error("Effective branch leaf does not exist"), { status: 409 });
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
      throw Object.assign(new Error("Session tree response exceeds its serialized limit"), { status: 422 });
    }
    return response;
  }

  viewMessages(effectiveLeafId: string | null = this.currentLeafId): readonly unknown[] {
    if (effectiveLeafId === this.currentLeafId) return this.currentMessages;
    if (effectiveLeafId !== null && !this.currentEntries.some((entry) => entry.id === effectiveLeafId)) {
      throw Object.assign(new Error("Effective branch leaf does not exist"), { status: 409 });
    }
    const byId = new Map(this.currentEntries.map((entry) => [entry.id, entry]));
    return contextMessages(this.currentEntries, effectiveLeafId, byId);
  }

  private startWatching(): void {
    if (this.closed || this.watcher || this.pollTimer) return;
    try {
      this.watcher = watch(dirname(this.path), { persistent: false }, (_event, name) => {
        if (name && String(name) !== basename(this.path)) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          this.reconcileFromHint();
        }, WATCH_DEBOUNCE_MS);
        this.watchTimer.unref?.();
      });
      this.watcher.on("error", (error) => {
        if (this.closed) return;
        const previous = this.currentHealth;
        this.currentHealth = healthError(new Error(`Session watch failed: ${error.message}`));
        if (JSON.stringify(previous) !== JSON.stringify(this.currentHealth)) {
          this.emit("update", {
            changed: false,
            initialMaterialization: this.initialMaterializationPending,
            kind: "none",
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
    this.pollTimer = setInterval(() => this.reconcileFromHint(), RECONCILE_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private reconcileFromHint(): void {
    void this.reconcile().then((result) => {
      if (result.changed || result.healthChanged || result.sourceChanged) this.emit("update", result);
    }).catch((error) => {
      if (this.closed) return;
      const previous = JSON.stringify(this.currentHealth);
      this.currentHealth = healthError(error);
      if (previous !== JSON.stringify(this.currentHealth)) {
        this.emit("update", {
          changed: false,
          initialMaterialization: this.initialMaterializationPending,
          kind: "none",
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
    const run = this.reconcileTail.then(() => this.reconcileOnce(force), () => this.reconcileOnce(force));
    this.reconcileTail = run;
    return run;
  }

  private async reconcileOnce(force: boolean): Promise<ProjectionReconcileResult> {
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
            changed: false, initialMaterialization, kind: "none", previousRevision, revision: this.revision,
            previousFingerprint, fingerprint: this.fingerprint, healthChanged: false,
            sourceChanged: false, previousSourceVersion: this.sourceVersion, sourceVersion: this.sourceVersion,
            uncommittedBytes: this.uncommittedBytes,
            previousUncommittedBytes: this.uncommittedBytes, previousTailVerified: true,
          };
        }
      }

      const candidate = (await this.tryReadAppendCandidate()) ?? await this.readCandidate();
      const initialFileAppearance = initialMaterialization && this.currentIdentity === null;
      const changed = candidate.fingerprint !== this.currentFingerprint;
      const previousEntries = this.currentEntries;
      const previousLeafId = this.currentLeafId;
      let kind: ProjectionReconcileResult["kind"] = "none";
      let appendedEntries: SessionEntry[] | undefined;
      if (changed) {
        const prefixVerified = this.currentCommittedBytes === 0 || candidate.previousPrefixFingerprint === this.currentFingerprint;
        const tailVerified = previousUncommittedBytes === 0 || candidate.previousTailFingerprint === previousUncommittedFingerprint;
        kind = initialFileAppearance || (
          this.currentIdentity && sameObject(candidate.identity, this.currentIdentity) &&
          candidate.committedBytes >= this.currentCommittedBytes && this.currentFingerprint && prefixVerified && tailVerified
        ) ? "append" : "rewrite";
        if (
          kind === "append" &&
          previousEntries.every((entry, index) => candidate.entries[index]?.id === entry.id)
        ) {
          appendedEntries = structuredClone(candidate.entries.slice(previousEntries.length));
        }
        this.currentRevision += 1;
        if (kind !== "append") this.appendFromRevision = this.currentRevision;
        this.revisionFingerprints.set(this.currentRevision, candidate.fingerprint);
        while (this.revisionFingerprints.size > 256) {
          this.revisionFingerprints.delete(this.revisionFingerprints.keys().next().value!);
        }
        this.currentMessages = candidate.messages;
        this.currentModel = candidate.model;
        this.currentThinkingLevel = candidate.thinkingLevel;
        this.currentLeafId = candidate.leafId;
        this.currentEntries = candidate.entries;
        this.currentHeader = candidate.header;
        this.currentFingerprint = candidate.fingerprint;
        this.currentCommittedBytes = candidate.committedBytes;
      }
      this.currentIdentity = candidate.identity;
      this.currentUncommittedBytes = candidate.uncommittedBytes;
      this.currentUncommittedFingerprint = candidate.uncommittedFingerprint;
      this.currentHealth = { status: "ok" };
      const sourceChanged = previousSourceVersion !== this.sourceVersion ||
        previousUncommittedBytes !== this.uncommittedBytes || previousUncommittedFingerprint !== this.uncommittedFingerprint;
      const previousTailVerified = previousUncommittedBytes === 0 ||
        candidate.previousTailFingerprint === previousUncommittedFingerprint;
      return {
        changed,
        initialMaterialization,
        kind,
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

  /** Verify the established prefix while parsing only newly appended lines. */
  private async tryReadAppendCandidate(): Promise<Candidate | null> {
    if (!this.currentIdentity || !this.currentHeader || this.currentRevision === 0) return null;
    const addressed = identity(await stat(this.path, { bigint: true }) as never);
    if (!sameObject(addressed, this.currentIdentity) || addressed.size < BigInt(this.currentCommittedBytes)) return null;
    const handle = await open(this.path, "r");
    try {
      const before = identity(await handle.stat({ bigint: true }) as never);
      if (!sameObject(before, addressed)) return null;
      const hash = createHash("sha256");
      let prefixBytes = 0;
      if (this.currentCommittedBytes > 0) {
        for await (const raw of handle.createReadStream({ start: 0, end: this.currentCommittedBytes - 1, autoClose: false })) {
          const chunk = raw as Buffer;
          hash.update(chunk);
          await this.readHooks?.afterPrefixReadChunk?.();
          prefixBytes += chunk.length;
        }
      }
      if (prefixBytes !== this.currentCommittedBytes || hash.copy().digest("hex") !== this.currentFingerprint) return null;

      const appended: Record<string, unknown>[] = [];
      let committedBytes = this.currentCommittedBytes;
      let previousTailRemaining = this.currentUncommittedBytes;
      const previousTailHash = createHash("sha256");
      const decoder = new JsonlObjectDecoder((frame) => {
        hash.update(frame);
        committedBytes += frame.length;
      });
      if (before.size > BigInt(this.currentCommittedBytes)) {
        for await (const raw of handle.createReadStream({ start: this.currentCommittedBytes, autoClose: false })) {
          const chunk = raw as Buffer;
          if (previousTailRemaining > 0) {
            const used = chunk.subarray(0, previousTailRemaining);
            previousTailHash.update(used);
            previousTailRemaining -= used.length;
          }
          for (const value of decoder.push(chunk)) {
            if (value.type === "session") throw new Error("Persisted session contains a second session header");
            appended.push(value);
          }
        }
      }
      const after = identity(await handle.stat({ bigint: true }) as never);
      const finalAddressed = identity(await stat(this.path, { bigint: true }) as never);
      if (!sameVersion(before, after) || !sameVersion(after, finalAddressed)) return null;
      const tail = decoder.tail();
      const mutable = [structuredClone(this.currentHeader), ...structuredClone(this.currentEntries), ...appended] as Array<SessionHeader | SessionEntry>;
      migrateSessionEntries(mutable);
      const entries = mutable.slice(1) as SessionEntry[];
      const leafId = entries.at(-1)?.id ?? null;
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const context = buildSessionContext(entries, leafId, byId);
      return {
        identity: finalAddressed,
        fingerprint: hash.digest("hex"),
        committedBytes,
        uncommittedBytes: tail.length,
        uncommittedFingerprint: tail.length > 0 ? createHash("sha256").update(tail).digest("hex") : null,
        previousPrefixFingerprint: this.currentFingerprint,
        previousTailFingerprint: previousTailRemaining === 0 && this.currentUncommittedBytes > 0
          ? previousTailHash.digest("hex")
          : this.currentUncommittedBytes === 0 ? null : "",
        header: mutable[0] as SessionHeader,
        entries,
        messages: contextMessages(entries, leafId, byId),
        model: context.model ? { provider: context.model.provider, id: context.model.modelId } : null,
        thinkingLevel: context.thinkingLevel,
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
        const before = identity(await handle.stat({ bigint: true }) as never);
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
          const tailEnd = Math.min(end, this.currentCommittedBytes + this.currentUncommittedBytes);
          if (tailEnd > tailStart) {
            const used = chunk.subarray(tailStart - readOffset, tailEnd - readOffset);
            previousTailHash.update(used);
            previousTailBytes += used.length;
          }
          readOffset = end;
          parsed.push(...decoder.push(chunk));
        }
        const after = identity(await handle.stat({ bigint: true }) as never);
        const addressed = identity(await stat(this.path, { bigint: true }) as never);
        if (!sameVersion(before, after) || !sameVersion(after, addressed)) continue;
        const tail = decoder.tail();
        const header = parsed[0] as SessionHeader | undefined;
        if (!header || header.type !== "session") throw new Error("Session file is not a valid Pi session");
        if (header.id !== this.sessionId) {
          throw new Error(`Session file belongs to ${String(header.id)}, expected ${this.sessionId}`);
        }
        if (parsed.slice(1).some((entry) => (entry as { type?: unknown }).type === "session")) {
          throw new Error("Persisted session contains a second session header");
        }
        const mutable = parsed as unknown as Array<SessionHeader | SessionEntry>;
        migrateSessionEntries(mutable);
        const entries = mutable.slice(1) as SessionEntry[];
        const leafId = entries.at(-1)?.id ?? null;
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        const context = buildSessionContext(entries, leafId, byId);
        return {
          identity: addressed,
          fingerprint: hash.digest("hex"),
          committedBytes,
          uncommittedBytes: tail.length,
          uncommittedFingerprint: tail.length > 0 ? createHash("sha256").update(tail).digest("hex") : null,
          previousPrefixFingerprint: previousPrefixBytes === this.currentCommittedBytes && this.currentCommittedBytes > 0
            ? previousPrefixHash.digest("hex")
            : this.currentCommittedBytes === 0 ? null : "",
          previousTailFingerprint: previousTailBytes === this.currentUncommittedBytes && this.currentUncommittedBytes > 0
            ? previousTailHash.digest("hex")
            : this.currentUncommittedBytes === 0 ? null : "",
          header,
          entries,
          messages: contextMessages(entries, leafId, byId),
          model: context.model ? { provider: context.model.provider, id: context.model.modelId } : null,
          thinkingLevel: context.thinkingLevel,
          leafId,
        };
      } finally {
        await handle.close();
      }
    }
    throw new Error("Session file changed while it was being reconciled");
  }

  latestPage(overlay: readonly unknown[] = [], effectiveLeafId: string | null = this.currentLeafId, viewId = this.incarnation): TranscriptPage {
    const persisted = this.viewMessages(effectiveLeafId);
    const persistedCorrelation = new Set(persisted.map((value) => {
      if (!value || typeof value !== "object") return null;
      const record = value as Record<string, unknown>;
      const copy = { ...record };
      delete copy.__inspireMessageId;
      return messageFallbackCorrelation(copy);
    }).filter((key): key is string => key !== null));
    const combined = [...persisted];
    for (const item of overlay) {
      let key: string | null = null;
      if (item && typeof item === "object") {
        const copy = { ...(item as Record<string, unknown>) };
        delete copy.__inspireLiveId;
        key = messageFallbackCorrelation(copy);
      }
      if (!key || !persistedCorrelation.has(key)) combined.push(item);
    }
    return this.buildPage(combined, combined.length, persisted.length, effectiveLeafId, viewId);
  }

  page(cursor: string, effectiveLeafId: string | null = this.currentLeafId, viewId = this.incarnation): TranscriptPage {
    const decoded = parseCursor(cursor);
    if (decoded.sessionId !== this.sessionId) {
      throw Object.assign(new Error("Transcript cursor belongs to another session"), { status: 409 });
    }
    if (decoded.incarnation !== this.incarnation) {
      throw Object.assign(new Error("Transcript cursor belongs to an expired projection incarnation"), { status: 409 });
    }
    if (decoded.viewId !== viewId) {
      throw Object.assign(new Error("Transcript cursor belongs to another branch view"), { status: 409 });
    }
    if (decoded.effectiveLeafId !== effectiveLeafId) {
      const byId = new Map(this.currentEntries.map((entry) => [entry.id, entry]));
      let cursor = effectiveLeafId;
      let appendDescendant = decoded.effectiveLeafId === null;
      while (cursor && !appendDescendant) {
        if (cursor === decoded.effectiveLeafId) appendDescendant = true;
        cursor = byId.get(cursor)?.parentId ?? null;
      }
      // Older-page cursors survive a strictly append-only continuation of the
      // same branch. A switch to a sibling/ancestor view remains stale.
      if (!appendDescendant || decoded.revision < this.appendFromRevision) {
        throw Object.assign(new Error("Transcript cursor is stale or belongs to another branch view"), { status: 409 });
      }
    }
    const knownFingerprint = this.revisionFingerprints.get(decoded.revision);
    if (
      decoded.revision > this.revision ||
      decoded.revision < this.appendFromRevision ||
      knownFingerprint !== decoded.fingerprint
    ) {
      throw Object.assign(new Error("Transcript cursor is stale; refresh the session"), { status: 409 });
    }
    const messages = this.viewMessages(effectiveLeafId);
    if (decoded.before > messages.length) {
      throw Object.assign(new Error("Transcript cursor is invalid"), { status: 400 });
    }
    return this.buildPage(messages, decoded.before, messages.length, effectiveLeafId, viewId);
  }

  private buildPage(source: readonly unknown[], before: number, persistedLength: number, effectiveLeafId: string | null, viewId: string): TranscriptPage {
    let start = before;
    const reversed: unknown[] = [];
    let messagesBytes = 2; // JSON array brackets; commas are added per accepted item.
    const shell = (candidateStart: number, messages: unknown[]): TranscriptPage => {
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
        olderCursor: persistedStart > 0
          ? cursorFor(this.sessionId, this.incarnation, this.currentFingerprint, this.revision, persistedStart, effectiveLeafId, viewId)
          : null,
      };
    };
    while (start > 0 && reversed.length < TRANSCRIPT_PAGE_MAX_MESSAGES) {
      const index = start - 1;
      const item = boundedTranscriptItem(source[index], index < persistedLength ? index : undefined);
      this.readHooks?.afterMessageProjection?.();
      const projected = item.value;
      const serialized = item.serialized;
      const candidateMessagesBytes = messagesBytes + Buffer.byteLength(serialized) + (reversed.length > 0 ? 1 : 0);
      const emptyShellBytes = Buffer.byteLength(JSON.stringify(shell(index, [])));
      if (emptyShellBytes - 2 + candidateMessagesBytes > TRANSCRIPT_PAGE_MAX_BYTES) break;
      reversed.push(projected);
      messagesBytes = candidateMessagesBytes;
      start = index;
    }
    if (reversed.length === 0 && before > 0) {
      throw Object.assign(new Error("A projected transcript message exceeds the browser page budget"), { status: 422 });
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
