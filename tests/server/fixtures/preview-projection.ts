import { EventEmitter } from "node:events";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  type ComposerHistoryFileNameResolver,
  type ComposerHistoryMessage,
  projectComposerHistoryPage,
} from "../../../server/composer-history.js";
import { requestError } from "../../../server/request-error.js";
import type { ActiveSessionSnapshot } from "../../../server/session-preview.js";
import {
  boundedTranscriptValue,
  type InitialMaterializationAttestation,
  type ProjectionReconcileHandler,
  type ProjectionReconcileResult,
  type SessionProjectionView,
} from "../../../server/session-projection.js";
import type {
  BranchEntryResponse,
  BranchTreeResponse,
  ComposerHistoryPage,
  TranscriptActivityPage,
  TranscriptPage,
  UserTurnAnchor,
  UserTurnIndexPage,
  UserTurnTranscriptPage,
} from "../../../shared/contracts.js";
import { jsonRecord } from "../../../shared/json-record.js";
import { userTurnSummary } from "../../../shared/user-turns.js";

/** Index an in-memory transcript's user inputs with sequential ordinals. */
function sequentialUserTurnAnchors(
  messages: readonly unknown[],
  fallbackIdPrefix: string,
): UserTurnAnchor[] {
  const turns: UserTurnAnchor[] = [];
  for (const [index, value] of messages.entries()) {
    const record = jsonRecord(value);
    if (record?.role !== "user") continue;
    turns.push({
      id:
        typeof record.__inspireMessageId === "string"
          ? record.__inspireMessageId
          : `${fallbackIdPrefix}:${index}`,
      ordinal: turns.length,
      ...userTurnSummary(record),
    });
  }
  return turns;
}

/**
 * Snapshot-only projection for runtime scheduling and UI fixtures. Persistence
 * tests must use SessionProjection over real temporary JSONL instead.
 */
export class PreviewProjection
  extends EventEmitter
  implements SessionProjectionView
{
  readonly path: string;
  readonly revision = 1;
  readonly fingerprint = "preview";
  readonly incarnation: string | null;
  readonly health = { status: "ok" as const };
  readonly leafId = null;
  readonly tailEntryId = null;
  readonly sourceIdentity = "preview";
  readonly sourceVersion = "preview";
  readonly committedBytes = 0;
  readonly uncommittedBytes = 0;
  readonly uncommittedFingerprint = null;
  private reconcileHandler: ProjectionReconcileHandler | null = null;
  private reconcileTail: Promise<void> = Promise.resolve();

  constructor(
    readonly sessionId: string,
    private readonly preview: ActiveSessionSnapshot,
  ) {
    super();
    this.path = preview.sessionFile ?? "";
    this.incarnation = preview.transcriptPage.incarnation ?? null;
  }

  get messages(): readonly unknown[] {
    return this.preview.transcriptPage.messages;
  }

  get model(): unknown {
    return this.preview.model;
  }

  selectedModel(): unknown {
    return this.preview.model;
  }

  get thinkingLevel(): string {
    return this.preview.thinkingLevel;
  }

  attestInitialMaterialization(
    _workerEntries: readonly SessionEntry[],
  ): InitialMaterializationAttestation {
    return "mismatch";
  }

  hasActiveEntryType(_type: string): boolean {
    return false;
  }

  async suspendReconciliation(): Promise<void> {}

  resumeReconciliation(): void {}

  setReconcileHandler(handler: ProjectionReconcileHandler): void {
    this.reconcileHandler = handler;
  }

  latestPage(
    overlay: readonly unknown[] = [],
    _effectiveLeafId?: string | null,
    viewId = "preview",
  ): TranscriptPage {
    const messages = [...this.preview.transcriptPage.messages, ...overlay].map(
      (value) => boundedTranscriptValue(value),
    );
    return {
      sessionId: this.sessionId,
      revision: this.revision,
      viewId,
      ...(this.incarnation ? { incarnation: this.incarnation } : {}),
      effectiveLeafId: null,
      composerHistoryVersion:
        this.preview.transcriptPage.composerHistoryVersion,
      messages,
      hasOlder: false,
      olderCursor: null,
    };
  }

  visiblePage(
    _cursor: string,
    _effectiveLeafId?: string | null,
    _viewId?: string,
  ): TranscriptPage {
    throw requestError("This transcript has no older page", 409);
  }

  activityPage(
    _cursor: string,
    _effectiveLeafId?: string | null,
    _viewId?: string,
  ): TranscriptActivityPage {
    throw requestError("This transcript has no deferred activity", 409);
  }

  userTurnIndexPage(
    start?: number,
    _effectiveLeafId?: string | null,
    viewId = "preview",
  ): UserTurnIndexPage {
    const turns = sequentialUserTurnAnchors(
      this.preview.transcriptPage.messages,
      "preview-user",
    );
    const pageStart =
      start === undefined
        ? Math.max(0, turns.length - 100)
        : Math.min(start, turns.length);
    return {
      sessionId: this.sessionId,
      revision: this.revision,
      viewId,
      ...(this.incarnation ? { incarnation: this.incarnation } : {}),
      effectiveLeafId: null,
      total: turns.length,
      start: pageStart,
      turns: turns.slice(pageStart, pageStart + 100),
    };
  }

  userTurnTranscriptPage(
    targetMessageId: string,
    effectiveLeafId?: string | null,
    viewId = "preview",
    _cursor?: string,
  ): UserTurnTranscriptPage {
    const page = this.latestPage([], effectiveLeafId, viewId);
    return {
      ...page,
      targetMessageId,
      rangeStart: 0,
      rangeEnd: page.messages.length,
      hasMoreInTurn: false,
      continuationCursor: null,
    };
  }

  composerHistoryPage(
    start = 0,
    effectiveLeafId: string | null = null,
    viewId = "preview",
    cwd = this.preview.cwd,
    fileNameForPath?: ComposerHistoryFileNameResolver,
  ): ComposerHistoryPage {
    return projectComposerHistoryPage(
      this.composerHistoryMessages(),
      {
        sessionId: this.sessionId,
        revision: this.revision,
        viewId,
        composerHistoryVersion:
          this.preview.transcriptPage.composerHistoryVersion,
        ...(this.incarnation ? { incarnation: this.incarnation } : {}),
        effectiveLeafId,
      },
      start,
      cwd,
      fileNameForPath,
    );
  }

  branchTree(): BranchTreeResponse {
    throw requestError("Branch history is unavailable for this preview", 503);
  }

  branchEntry(): BranchEntryResponse {
    throw requestError("Branch history is unavailable for this preview", 503);
  }

  branchImage(): { data: Buffer; mimeType: string } {
    throw requestError("Branch history is unavailable for this preview", 503);
  }

  editableText(): string {
    throw requestError("Branch history is unavailable for this preview", 503);
  }

  entry(_id: string): SessionEntry | null {
    return null;
  }

  onSameLine(leafId: string | null, other: string | null): boolean {
    return leafId === other;
  }

  continues(leafId: string | null, from: string | null): boolean {
    return leafId === from;
  }

  latestContinuation(leafId: string | null): string | null {
    return leafId;
  }

  branchLeaves() {
    return { leaves: [], total: 0 };
  }

  entriesAfter(_tailEntryId: string | null): readonly SessionEntry[] {
    return [];
  }

  persistedEntryMatches(_entry: SessionEntry): boolean {
    return false;
  }

  userText(_id: string, _maxChars: number): string {
    throw requestError("Branch history is unavailable for this preview", 503);
  }

  userImages(_id: string): Array<{ data: string; mimeType: string }> {
    throw requestError("Branch history is unavailable for this preview", 503);
  }

  composerHistoryMessages(): readonly ComposerHistoryMessage[] {
    return this.preview.transcriptPage.messages.filter(
      (value): value is ComposerHistoryMessage =>
        typeof jsonRecord(value)?.__inspireHistoryEntryId === "string",
    );
  }

  viewMessages(): readonly unknown[] {
    return this.preview.transcriptPage.messages;
  }

  private reconcileResult(): ProjectionReconcileResult {
    return {
      changed: false,
      initialMaterialization: false,
      kind: "none",
      messageChange: "none",
      previousRevision: 1,
      revision: 1,
      previousFingerprint: this.fingerprint,
      fingerprint: this.fingerprint,
      healthChanged: false,
      sourceChanged: false,
      previousSourceVersion: this.sourceVersion,
      sourceVersion: this.sourceVersion,
      sourceIdentity: this.sourceIdentity,
      committedBytes: this.committedBytes,
      uncommittedBytes: this.uncommittedBytes,
      uncommittedFingerprint: this.uncommittedFingerprint,
      health: this.health,
      previousUncommittedBytes: 0,
      previousTailVerified: true,
    };
  }

  reconcile(_force = false): Promise<ProjectionReconcileResult> {
    const reading = this.reconcileTail.then(async () => {
      const result = this.reconcileResult();
      await this.reconcileHandler?.(result);
      return result;
    });
    this.reconcileTail = reading.then(
      () => undefined,
      () => undefined,
    );
    return reading;
  }

  async reconcileSuspended(_force = false): Promise<ProjectionReconcileResult> {
    await this.reconcileTail;
    return this.reconcileResult();
  }

  async close(): Promise<void> {
    await this.reconcileTail;
    this.reconcileHandler = null;
    this.removeAllListeners();
  }
}
