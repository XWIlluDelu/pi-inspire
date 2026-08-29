import { EventEmitter } from "node:events";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  BranchTreeResponse,
  ComposerHistoryPage,
  TranscriptActivityPage,
  TranscriptPage,
  UserTurnIndexPage,
  UserTurnTranscriptPage,
} from "../shared/contracts.js";
import { sequentialUserTurnAnchors } from "../shared/user-turns.js";
import {
  type ComposerHistoryFileNameResolver,
  projectComposerHistoryPage,
} from "./composer-history.js";
import type { ActiveSessionSnapshot } from "./session-preview.js";
import {
  boundedTranscriptValue,
  type InitialMaterializationAttestation,
  type ProjectionReconcileResult,
  type SessionProjectionView,
} from "./session-projection.js";

/**
 * Read-only catalog preview adapter. It satisfies the projection surface used
 * by RuntimeController without pretending a catalog snapshot has a live Pi
 * writer, durable branch tree, or reconciled persistence authority.
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
      messages,
      hasOlder: false,
      olderCursor: null,
    };
  }

  page(
    _cursor: string,
    _effectiveLeafId?: string | null,
    _viewId?: string,
  ): TranscriptPage {
    throw Object.assign(new Error("This transcript has no older page"), {
      status: 409,
    });
  }

  visiblePage(
    cursor: string,
    effectiveLeafId?: string | null,
    viewId?: string,
  ): TranscriptPage {
    return this.page(cursor, effectiveLeafId, viewId);
  }

  activityPage(
    _cursor: string,
    _effectiveLeafId?: string | null,
    _viewId?: string,
  ): TranscriptActivityPage {
    throw Object.assign(new Error("This transcript has no deferred activity"), {
      status: 409,
    });
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
      this.preview.transcriptPage.messages,
      {
        sessionId: this.sessionId,
        revision: this.revision,
        viewId,
        ...(this.incarnation ? { incarnation: this.incarnation } : {}),
        effectiveLeafId,
      },
      start,
      cwd,
      fileNameForPath,
    );
  }

  branchTree(): BranchTreeResponse {
    throw Object.assign(
      new Error("Branch history is unavailable for this preview"),
      { status: 503 },
    );
  }

  entry(_id: string): SessionEntry | null {
    return null;
  }

  persistedEntryMatches(_entry: SessionEntry): boolean {
    return false;
  }

  userText(_id: string, _maxChars: number): string {
    throw Object.assign(
      new Error("Branch history is unavailable for this preview"),
      { status: 503 },
    );
  }

  viewMessages(): readonly unknown[] {
    return this.preview.transcriptPage.messages;
  }

  async reconcile(_force = false): Promise<ProjectionReconcileResult> {
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

  reconcileSuspended(force = false): Promise<ProjectionReconcileResult> {
    return this.reconcile(force);
  }

  async close(): Promise<void> {
    this.removeAllListeners();
  }
}
