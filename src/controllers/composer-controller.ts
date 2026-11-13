import {
  type ComposerHistoryEntry,
  MAX_ATTACHMENTS,
  MAX_PROJECT_FILES,
  type PromptAcceptedResponse,
  type PromptDeliveryRequest,
  type UploadedAttachment,
} from "../../shared/contracts";
import {
  isImageMimeType,
  isSupportedPromptImageMimeType,
} from "../../shared/image-types";
import { type Api, ApiError, ApiTransportError } from "../api";
import { selectAttachmentFiles } from "../attachment-selection";
import {
  type ComposerHistoryScope,
  composerHistoryScopeKey,
  discardComposerHistory,
} from "../composer-history";
import { isTransientFailure, RecoveryBackoff } from "../recovery-backoff";
import {
  deleteSessionDraft,
  sessionDraftRevision,
  touchSessionDraft,
} from "../session-drafts";

interface RecalledHistoryArtifact {
  type: "image" | "file";
  reference: string;
  fileKind?: "attachment" | "project";
  viewId: string;
  incarnation: string | null;
  effectiveLeafId: string | null;
  scopeKey: string;
}

export interface PendingAttachment {
  localId: string;
  fileName: string;
  mimeType: string;
  size: number;
  /** Delivery kind, not preview capability. Ordinary image files may have a preview URL. */
  kind: "image" | "file";
  previewUrl?: string;
  previewLoading?: boolean;
  status: "uploading" | "ready" | "error";
  uploadedId?: string;
  uploadedAuthorityId?: string;
  recalledArtifact?: RecalledHistoryArtifact;
  error?: string;
  retryable?: boolean;
}

interface StagedFile {
  sessionId: string;
  file: File;
  recovery: RecoveryBackoff;
  /** Possibly delivered bytes must never enter automatic upload recovery. */
  submitted: boolean;
}

interface DeliveryRecord {
  request: PromptDeliveryRequest;
  message: string;
  postHandoffRevision: number;
  attachments: PendingAttachment[];
  projectFiles: string[];
  /** Palette preparation owns its text; it never transfers the Composer draft. */
  independent: boolean;
}

type DeliveryState =
  | {
      state: "sending";
      signature: string;
      record: DeliveryRecord;
      confirmation: AbortController;
    }
  | {
      state: "unknown";
      signature: string;
      request: PromptDeliveryRequest;
      draft?: DeliveryRecord;
    }
  | { state: "refused"; draft: DeliveryRecord };

interface ComposerPartition {
  attachments: PendingAttachment[];
  projectFiles: string[];
  deliveries: Map<string, DeliveryState>;
}

function* attachmentOwners(composer: ComposerPartition) {
  yield composer;
  for (const delivery of composer.deliveries.values()) {
    const owner =
      delivery.state === "sending" ? delivery.record : delivery.draft;
    if (owner) yield owner;
  }
}

interface ComposerControllerState {
  sessionId: string | null;
  transcriptViewId: string | null;
}

export type ComposerSlice = Pick<
  ComposerPartition,
  "attachments" | "projectFiles"
> & { failedDeliveryCount: number };

interface ComposerControllerHost {
  state(): ComposerControllerState;
  api(): Api | null;
  authorityId(): string | null;
  patch(slice: ComposerSlice): void;
  notify(kind: "warning", text: string): void;
  notifyVisible(sessionId: string, message: string): void;
  handleAuthFailure(): void;
  restoreDraftIfEmpty(sessionId: string, message: string): boolean;
}

/**
 * Owns per-session staged attachments, project files, and prompt delivery.
 * AppStore remains the canonical browser snapshot and commits this controller's
 * visible slice only when its session owns the active composer.
 */
export class ComposerController {
  private readonly composers = new Map<string, ComposerPartition>();
  private readonly uploads = new Map<string, AbortController>();
  private readonly stagedFiles = new Map<string, StagedFile>();
  private requestEpoch = 0;
  private recoveryAuthorityId: string | null = null;
  private readonly appliedRecoveryImages = new Map<string, Set<string>>();

  constructor(private readonly host: ComposerControllerHost) {}

  slice(sessionId: string | null): ComposerSlice {
    const composer = sessionId ? this.composers.get(sessionId) : undefined;
    return composer
      ? {
          attachments: composer.attachments,
          projectFiles: composer.projectFiles,
          failedDeliveryCount: [...composer.deliveries.values()].filter(
            (delivery) => delivery.state !== "sending" && delivery.draft,
          ).length,
        }
      : {
          attachments: [],
          projectFiles: [],
          failedDeliveryCount: 0,
        };
  }

  invalidateForTransportReplacement(): void {
    this.requestEpoch += 1;
    for (const upload of new Set(this.uploads.values())) upload.abort();
    this.uploads.clear();
    for (const staged of this.stagedFiles.values()) staged.recovery.reset();
    let deliveryOutcomeUnknown = false;
    for (const [sessionId, composer] of this.composers) {
      for (const delivery of [...composer.deliveries.values()]) {
        if (delivery.state !== "sending") continue;
        deliveryOutcomeUnknown = true;
        delivery.confirmation.abort();
        this.settleDelivery(
          composer,
          delivery.signature,
          delivery.record,
          "unknown",
        );
      }
      this.restoreFailed(sessionId, composer, true);
      const invalidateUploads = (items: PendingAttachment[]) =>
        items.map((item) =>
          item.status === "uploading"
            ? {
                ...item,
                status: this.stagedFiles.has(item.localId)
                  ? ("uploading" as const)
                  : ("error" as const),
                error: this.stagedFiles.has(item.localId)
                  ? undefined
                  : "The attachment upload was interrupted.",
              }
            : item,
        );
      composer.attachments = invalidateUploads(composer.attachments);
      this.prune(sessionId, composer);
    }
    const sessionId = this.host.state().sessionId;
    if (sessionId) this.publish(sessionId);
    if (deliveryOutcomeUnknown)
      this.host.notify(
        "warning",
        "Connection changed while sending. If the Host restarted, check the conversation before retrying.",
      );
  }

  /** Upload handles belong to one Host process, unlike a dropped event socket.
   * Include hidden partitions and saved/failed drafts so restoring them cannot
   * resurrect a ready-looking handle from a retired Host. */
  reconcileAuthority(authorityId: string): void {
    if (this.recoveryAuthorityId !== authorityId) {
      this.appliedRecoveryImages.clear();
      this.recoveryAuthorityId = authorityId;
    }
    let changed = false;
    const reconcile = (items: PendingAttachment[]): PendingAttachment[] =>
      items.map((item) => {
        if (
          !item.uploadedId ||
          item.status === "error" ||
          item.uploadedAuthorityId === authorityId
        )
          return item;
        changed = true;
        const staged = this.stagedFiles.get(item.localId);
        if (staged && !staged.submitted) {
          staged.recovery.reset();
          return {
            ...item,
            uploadedId: undefined,
            uploadedAuthorityId: undefined,
            status: "uploading",
            error: undefined,
            retryable: false,
          };
        }
        return {
          ...item,
          status: "error",
          error: "This attachment is no longer available. Add it again.",
        };
      });
    for (const composer of this.composers.values())
      for (const owner of attachmentOwners(composer))
        owner.attachments = reconcile(owner.attachments);
    const sessionId = this.host.state().sessionId;
    if (changed && sessionId) this.publish(sessionId);
  }

  /** The receipt transfers handles, not a browser queue. Preserve every image
   * and the existing draft even when their combined count exceeds send limits. */
  restoreStagedAttachments(
    sessionId: string,
    attachments: UploadedAttachment[],
    authorityId: string | null,
    recoveryId?: string,
  ): void {
    if (
      recoveryId &&
      attachments.length &&
      authorityId === this.host.authorityId()
    ) {
      const key = JSON.stringify([authorityId, sessionId, recoveryId]);
      const applied = this.appliedRecoveryImages.get(key) ?? new Set<string>();
      this.appliedRecoveryImages.set(key, applied);
      attachments = attachments.filter((item) => {
        if (applied.has(item.id)) return false;
        applied.add(item.id);
        return true;
      });
      if (!attachments.length) return;
    }
    const composer = this.forSession(sessionId);
    const api = this.host.api();
    const currentAuthority = this.host.authorityId();
    const known = new Set(
      composer.attachments
        .filter((item) => item.uploadedAuthorityId === authorityId)
        .map((item) => item.uploadedId),
    );
    const pending: PendingAttachment[] = attachments
      .filter((item) => {
        if (known.has(item.id)) return false;
        known.add(item.id);
        return true;
      })
      .map((item) => ({
        localId: globalThis.crypto.randomUUID(),
        fileName: item.fileName,
        mimeType: item.mimeType,
        size: item.size,
        kind: item.kind,
        uploadedId: item.id,
        uploadedAuthorityId: authorityId ?? undefined,
        previewLoading: item.kind === "image",
        status: authorityId === currentAuthority ? "ready" : "error",
        ...(authorityId === currentAuthority
          ? {}
          : {
              error:
                "The Host changed; remove this attachment and add it again",
            }),
      }));
    if (pending.length) touchSessionDraft(sessionId);
    composer.attachments = [...pending, ...composer.attachments];
    this.publish(sessionId);
    if (!api || authorityId !== currentAuthority) return;
    for (const item of pending)
      if (item.kind === "image") {
        void api
          .attachmentPreview(item.uploadedId!)
          .then((blob) => {
            if (
              this.composers.get(sessionId) !== composer ||
              this.host.authorityId() !== authorityId
            )
              return;
            const previewUrl = URL.createObjectURL(blob);
            if (
              this.patchAttachment(composer, item.localId, {
                previewUrl,
                previewLoading: false,
              })
            )
              this.publish(sessionId);
            else URL.revokeObjectURL(previewUrl);
          })
          .catch((error) => {
            if (
              this.composers.get(sessionId) !== composer ||
              this.host.authorityId() !== authorityId
            )
              return;
            if (
              this.patchAttachment(composer, item.localId, {
                previewLoading: false,
                error:
                  error instanceof Error
                    ? error.message
                    : "Image preview failed",
              })
            )
              this.publish(sessionId);
          });
      }
  }

  private patchAttachment(
    composer: ComposerPartition,
    localId: string,
    patch: Partial<PendingAttachment>,
  ): boolean {
    let found = false;
    for (const owner of attachmentOwners(composer)) {
      if (!owner.attachments.some((item) => item.localId === localId)) continue;
      found = true;
      owner.attachments = owner.attachments.map((item) =>
        item.localId === localId ? { ...item, ...patch } : item,
      );
    }
    return found;
  }

  discard(sessionId: string): void {
    const composer = this.composers.get(sessionId);
    if (composer) {
      for (const delivery of composer.deliveries.values())
        if (delivery.state === "sending") delivery.confirmation.abort();
      for (const owner of attachmentOwners(composer))
        this.releaseAttachments(owner.attachments);
      // Uploads still in flight retain this object. Emptying it makes their
      // completion path reclaim any host copy rather than resurrecting the
      // deleted partition.
      composer.attachments = [];
      composer.projectFiles = [];
      composer.deliveries.clear();
      this.composers.delete(sessionId);
    }
    deleteSessionDraft(sessionId);
    discardComposerHistory(sessionId);
  }

  async send(
    message: string,
    behavior?: "steer" | "followUp",
    onHandoff?: () => void,
    independent = false,
  ): Promise<PromptAcceptedResponse | false> {
    const { sessionId, transcriptViewId } = this.host.state();
    const api = this.host.api();
    const authorityId = this.host.authorityId();
    if (!api || !sessionId || !authorityId) return false;
    this.reconcileAuthority(authorityId);
    const composer = this.forSession(sessionId);
    // A matching in-flight request is a duplicate click, not a new message.
    // Different input may proceed while a previous Pi receipt is pending.
    if (
      !independent &&
      composer.attachments.some((item) => item.status === "uploading")
    ) {
      this.host.notify("warning", "Attachments are still uploading");
      return false;
    }
    if (
      !independent &&
      composer.attachments.some((item) => item.status === "error")
    ) {
      this.host.notify(
        "warning",
        "Retry or remove failed attachments before sending",
      );
      return false;
    }
    const included = independent ? [] : composer.attachments;
    if (
      message.trim().startsWith("!") &&
      (included.length > 0 || composer.projectFiles.length > 0)
    ) {
      this.host.notify(
        "warning",
        "Shell commands cannot include attachments or project-file references",
      );
      return false;
    }
    const attachmentCount = included.filter(
      (item) =>
        !(
          item.recalledArtifact?.type === "file" &&
          item.recalledArtifact.fileKind === "project"
        ),
    ).length;
    if (attachmentCount > MAX_ATTACHMENTS) {
      this.host.notify(
        "warning",
        `At most ${MAX_ATTACHMENTS} attachments per message`,
      );
      return false;
    }
    const attachmentIds = included
      .map((item) => item.uploadedId)
      .filter((id): id is string => Boolean(id));
    const recalled = included.filter(
      (
        item,
      ): item is PendingAttachment & {
        recalledArtifact: RecalledHistoryArtifact;
      } => Boolean(item.recalledArtifact),
    );
    const historyOwner = recalled[0]?.recalledArtifact;
    if (
      historyOwner &&
      recalled.some(
        (item) => item.recalledArtifact.scopeKey !== historyOwner.scopeKey,
      )
    ) {
      this.host.notify(
        "warning",
        "Recalled attachments belong to another branch",
      );
      return false;
    }
    const projectFiles = independent ? [] : composer.projectFiles;
    const recalledProjectCount = recalled.filter(
      (item) =>
        item.recalledArtifact.type === "file" &&
        item.recalledArtifact.fileKind === "project",
    ).length;
    if (projectFiles.length + recalledProjectCount > MAX_PROJECT_FILES) {
      this.host.notify(
        "warning",
        `At most ${MAX_PROJECT_FILES} project files per message`,
      );
      return false;
    }
    if (
      !message.trim() &&
      attachmentIds.length === 0 &&
      recalled.length === 0 &&
      projectFiles.length === 0
    ) {
      return false;
    }
    const deliveryContent = {
      sessionId,
      ...(transcriptViewId ? { expectedViewId: transcriptViewId } : {}),
      message,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(historyOwner
        ? {
            historyArtifacts: {
              viewId: historyOwner.viewId,
              incarnation: historyOwner.incarnation,
              effectiveLeafId: historyOwner.effectiveLeafId,
              imageReferences: recalled
                .filter((item) => item.recalledArtifact.type === "image")
                .map((item) => item.recalledArtifact.reference),
              fileReferences: recalled
                .filter((item) => item.recalledArtifact.type === "file")
                .map((item) => item.recalledArtifact.reference),
            },
          }
        : {}),
      ...(projectFiles.length > 0 ? { projectFiles } : {}),
      ...(behavior ? { behavior } : {}),
    };
    // A view or phase change cannot turn unknown delivery into a new
    // operation. Reobserve its original, exact payload.
    const signature = JSON.stringify({
      ...deliveryContent,
      expectedViewId: undefined,
      behavior: undefined,
    });
    const previous = [...composer.deliveries.values()].find(
      (delivery) =>
        delivery.state !== "refused" && delivery.signature === signature,
    );
    if (previous?.state === "sending") return false;
    const retained = previous?.state === "unknown" ? previous : undefined;
    if (retained && retained.request.authorityId !== authorityId) {
      if (retained.draft)
        composer.deliveries.set(retained.request.operationId, {
          state: "refused",
          draft: retained.draft,
        });
      else composer.deliveries.delete(retained.request.operationId);
      this.host.notifyVisible(
        sessionId,
        "The Host restarted before delivery was confirmed. Check the conversation before resending.",
      );
      return false;
    }
    const request = retained?.request ?? {
      operationId: globalThis.crypto.randomUUID(),
      authorityId,
      ...deliveryContent,
    };
    const beforeHandoff = sessionDraftRevision(sessionId);
    const record: DeliveryRecord = {
      request,
      message,
      postHandoffRevision: beforeHandoff,
      attachments: included,
      projectFiles,
      independent,
    };
    const confirmation = new AbortController();
    const operationId = request.operationId;
    const observation = {
      state: "sending",
      signature,
      record,
      confirmation,
    } as const;
    composer.deliveries.set(operationId, observation);
    const ownsTransport = () =>
      this.host.api() === api &&
      composer.deliveries.get(operationId) === observation;
    for (const item of included) {
      const staged = this.stagedFiles.get(item.localId);
      if (staged) {
        staged.submitted = true;
        staged.recovery.reset();
      }
    }
    if (!independent) {
      composer.attachments = [];
      composer.projectFiles = [];
    }
    onHandoff?.();
    if (!independent) {
      // Attachment-only handoffs still create a distinct draft revision.
      if (sessionDraftRevision(sessionId) === beforeHandoff)
        touchSessionDraft(sessionId);
      record.postHandoffRevision = sessionDraftRevision(sessionId);
    }
    this.publish(sessionId);
    try {
      const response = await api.prompt(
        request,
        confirmation.signal,
        Boolean(retained),
      );
      if (!ownsTransport()) return false;
      for (const item of record.attachments) {
        this.forgetStagedFile(item.localId);
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      return { accepted: true, historyEntry: response.historyEntry };
    } catch (error) {
      if (!ownsTransport()) return false;
      const rejection =
        error instanceof ApiError && !error.outcomeUnknown ? error : null;
      if (rejection) {
        for (const item of record.attachments) {
          const staged = this.stagedFiles.get(item.localId);
          if (staged)
            staged.submitted = [...composer.deliveries.values()].some(
              (other) =>
                other !== observation &&
                other.state !== "refused" &&
                item.uploadedId &&
                (other.state === "unknown"
                  ? other.request
                  : other.record.request
                ).attachmentIds?.includes(item.uploadedId),
            );
        }
      }
      if (rejection?.code === "PROMPT_RECOVERED") {
        // Both observers share a handoff. A late observer cannot undo a later
        // removal or send, even after the draft no longer contains the handle.
        if (rejection.recoveredAttachments) {
          this.restoreStagedAttachments(
            sessionId,
            rejection.recoveredAttachments,
            authorityId,
            rejection.recoveryId,
          );
          for (const item of record.attachments)
            if (item.kind === "image") {
              this.forgetStagedFile(item.localId);
              if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
            }
        }
        composer.attachments = [
          ...record.attachments.filter(
            (item) => !rejection.recoveredAttachments || item.kind !== "image",
          ),
          ...composer.attachments,
        ];
        composer.projectFiles = [
          ...new Set([...record.projectFiles, ...composer.projectFiles]),
        ];
        return false;
      }
      if (rejection?.code === "PROMPT_CLEARED") {
        this.releaseAttachments(record.attachments);
        return false;
      }
      if (rejection?.code === "ATTACHMENTS_EXPIRED") {
        record.attachments = record.attachments.map((item) =>
          item.uploadedId && rejection.matches?.includes(item.uploadedId)
            ? {
                ...item,
                status: this.stagedFiles.has(item.localId)
                  ? "uploading"
                  : "error",
                error: this.stagedFiles.has(item.localId)
                  ? undefined
                  : "This attachment is no longer available. Add it again.",
              }
            : item,
        );
      }
      this.settleDelivery(
        composer,
        signature,
        record,
        rejection ? "refused" : "unknown",
      );
      if (!independent) {
        this.restoreFailed(sessionId, composer, true);
        if (rejection?.code === "ATTACHMENTS_EXPIRED") this.resumeUploads();
      }
      if (rejection?.code === "PROMPT_ABORTED") return false;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
      } else
        (independent
          ? (_sessionId: string, text: string) =>
              this.host.notify("warning", text)
          : this.host.notifyVisible)(
          sessionId,
          rejection?.message ??
            (error instanceof ApiError &&
            error.code === "ATTACH_CONTROL_OUTCOME_UNKNOWN"
              ? "The attached Pi did not confirm delivery. Check its conversation before sending again."
              : "Message delivery is unconfirmed. Trying the same message again only checks its original receipt."),
        );
      return false;
    } finally {
      if (this.host.api() === api) {
        if (ownsTransport()) composer.deliveries.delete(operationId);
        this.prune(sessionId, composer);
        this.publish(sessionId);
      }
    }
  }

  private settleDelivery(
    composer: ComposerPartition,
    signature: string,
    record: DeliveryRecord,
    state: "unknown" | "refused",
  ): void {
    const id = record.request.operationId;
    const draft = record.independent ? undefined : record;
    composer.deliveries.delete(id);
    if (state === "unknown")
      composer.deliveries.set(id, {
        state,
        signature,
        request: record.request,
        draft,
      });
    else if (draft) composer.deliveries.set(id, { state, draft });
  }

  restoreFailedPrompt(sessionId: string): boolean {
    const composer = this.composers.get(sessionId);
    if (!composer) return false;
    const restored = this.restoreFailed(sessionId, composer, false);
    if (restored) {
      this.publish(sessionId);
      this.resumeUploads();
    }
    return restored;
  }

  private restoreFailed(
    sessionId: string,
    composer: ComposerPartition,
    automatic: boolean,
  ): boolean {
    const revision = sessionDraftRevision(sessionId);
    if (composer.attachments.length || composer.projectFiles.length)
      return false;
    for (const [id, delivery] of composer.deliveries) {
      if (delivery.state === "sending" || !delivery.draft) continue;
      const record = delivery.draft;
      if (automatic && record.postHandoffRevision !== revision) continue;
      if (!this.host.restoreDraftIfEmpty(sessionId, record.message))
        return false;
      if (delivery.state === "unknown")
        composer.deliveries.set(id, { ...delivery, draft: undefined });
      else composer.deliveries.delete(id);
      composer.attachments = record.attachments;
      composer.projectFiles = record.projectFiles;
      return true;
    }
    return false;
  }

  useHistoryEntry(
    scope: ComposerHistoryScope,
    entry: ComposerHistoryEntry,
  ): boolean {
    const { sessionId, transcriptViewId } = this.host.state();
    if (sessionId !== scope.sessionId || transcriptViewId !== scope.viewId)
      return false;
    const composer = this.forSession(sessionId);
    touchSessionDraft(sessionId);
    this.releaseAttachments(composer.attachments);
    const scopeKey = composerHistoryScopeKey(scope);
    composer.projectFiles = [];
    const owner = {
      viewId: scope.viewId,
      incarnation: scope.incarnation,
      effectiveLeafId: scope.effectiveLeafId,
      scopeKey,
    };
    composer.attachments = [
      ...entry.images.map<PendingAttachment>((image, index) => ({
        localId: `history:${scopeKey}:${image.reference}`,
        fileName: `Recalled image ${index + 1}`,
        mimeType: image.mimeType,
        size: image.size,
        kind: "image",
        status: "ready",
        recalledArtifact: {
          ...owner,
          type: "image",
          reference: image.reference,
        },
      })),
      ...entry.files.map<PendingAttachment>((file) => ({
        localId: `history:${scopeKey}:${file.reference}`,
        fileName: file.fileName,
        mimeType: "application/octet-stream",
        size: 0,
        kind: "file",
        status: "ready",
        recalledArtifact: {
          ...owner,
          type: "file",
          reference: file.reference,
          fileKind: file.kind,
        },
      })),
    ];
    this.prune(sessionId, composer);
    this.publish(sessionId);
    return true;
  }

  async addFiles(files: File[]): Promise<void> {
    const sessionId = this.host.state().sessionId;
    const api = this.host.api();
    const authorityId = this.host.authorityId();
    if (!api || !sessionId || !authorityId || files.length === 0) return;
    const composer = this.forSession(sessionId);
    const { accepted, warning } = selectAttachmentFiles(
      composer.attachments.filter(
        (item) =>
          !(
            item.recalledArtifact?.type === "file" &&
            item.recalledArtifact.fileKind === "project"
          ),
      ),
      files,
    );
    if (warning) this.host.notify("warning", warning);
    if (accepted.length === 0) return;

    const pending: PendingAttachment[] = accepted.map((file) => {
      const isImage = isImageMimeType(file.type);
      return {
        localId: crypto.randomUUID(),
        fileName: file.name || "pasted-image",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind: isSupportedPromptImageMimeType(file.type) ? "image" : "file",
        previewUrl: isImage ? URL.createObjectURL(file) : undefined,
        status: "uploading",
      };
    });
    touchSessionDraft(sessionId);
    composer.attachments = [...composer.attachments, ...pending];
    pending.forEach((item, index) =>
      this.stagedFiles.set(item.localId, {
        sessionId,
        file: accepted[index]!,
        recovery: new RecoveryBackoff(),
        submitted: false,
      }),
    );
    this.publish(sessionId);
    await this.uploadStaged(
      sessionId,
      pending.map((item) => item.localId),
    );
  }

  private editableAttachment(
    sessionId: string,
    localId: string,
  ): PendingAttachment | undefined {
    return this.composers
      .get(sessionId)
      ?.attachments.find((item) => item.localId === localId);
  }

  /** Only browser-held, unsent staging is replayable. Prompt delivery has its own identity. */
  private async uploadStaged(
    sessionId: string,
    localIds: string[],
  ): Promise<void> {
    const api = this.host.api();
    const authorityId = this.host.authorityId();
    const composer = this.composers.get(sessionId);
    if (!api || !authorityId || !composer) return;
    const pending = localIds.flatMap((localId) => {
      const staged = this.stagedFiles.get(localId);
      const item = this.editableAttachment(sessionId, localId);
      return staged && !staged.submitted && item && !this.uploads.has(localId)
        ? [{ item, staged }]
        : [];
    });
    if (!pending.length) return;
    const requestEpoch = this.requestEpoch;
    const upload = new AbortController();
    const ownsTransport = () =>
      this.host.api() === api &&
      this.host.authorityId() === authorityId &&
      this.requestEpoch === requestEpoch &&
      this.composers.get(sessionId) === composer;
    for (const { item, staged } of pending) {
      staged.recovery.cancel();
      this.uploads.set(item.localId, upload);
      this.patchAttachment(composer, item.localId, {
        status: "uploading",
        error: undefined,
        retryable: false,
      });
    }
    this.publish(sessionId);
    try {
      const { attachments: uploaded } = await api.uploadAttachments(
        pending.map(({ staged }) => staged.file),
        upload.signal,
      );
      if (!ownsTransport() || uploaded.length !== pending.length) {
        await Promise.all(
          uploaded.map((item) =>
            api.deleteAttachment(item.id).catch(() => undefined),
          ),
        );
        if (ownsTransport())
          throw new ApiError(
            502,
            "The attachment upload could not be verified",
            undefined,
            "INVALID_ATTACHMENT_UPLOAD",
          );
        return;
      }
      pending.forEach(({ item, staged }, index) => {
        const result = uploaded[index]!;
        if (
          !this.editableAttachment(sessionId, item.localId) ||
          this.stagedFiles.get(item.localId) !== staged
        ) {
          void api.deleteAttachment(result.id).catch(() => undefined);
          return;
        }
        staged.recovery.reset();
        this.patchAttachment(composer, item.localId, {
          status: "ready",
          error: undefined,
          retryable: false,
          uploadedId: result.id,
          uploadedAuthorityId: authorityId,
          fileName: result.fileName,
          kind: result.kind,
        });
      });
      this.publish(sessionId);
    } catch (error) {
      if (!ownsTransport()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return;
      }
      for (const { item, staged } of pending) {
        if (
          this.stagedFiles.get(item.localId) !== staged ||
          !this.editableAttachment(sessionId, item.localId)
        )
          continue;
        const recovering =
          isTransientFailure(error) &&
          !(
            error instanceof ApiError &&
            error.code === "INVALID_ATTACHMENT_UPLOAD"
          ) &&
          staged.recovery.schedule(() => {
            if (
              this.stagedFiles.get(item.localId) === staged &&
              !staged.submitted
            )
              void this.uploadStaged(sessionId, [item.localId]);
          });
        this.patchAttachment(
          composer,
          item.localId,
          recovering
            ? { status: "uploading", error: undefined, retryable: false }
            : {
                status: "error",
                retryable: true,
                error:
                  error instanceof ApiTransportError
                    ? "This file could not be uploaded. Retry without selecting it again."
                    : error instanceof Error
                      ? error.message
                      : "This file could not be uploaded.",
              },
        );
      }
      this.publish(sessionId);
    } finally {
      for (const { item } of pending)
        if (this.uploads.get(item.localId) === upload)
          this.uploads.delete(item.localId);
    }
  }

  retryAttachment(localId: string): Promise<void> {
    const sessionId = this.host.state().sessionId;
    const staged = this.stagedFiles.get(localId);
    if (
      !sessionId ||
      !staged ||
      staged.submitted ||
      staged.sessionId !== sessionId
    )
      return Promise.resolve();
    staged.recovery.reset();
    return this.uploadStaged(sessionId, [localId]);
  }

  /** A resumed transport restarts only unfinished staging in its original partition. */
  resumeUploads(): void {
    const batches = new Map<string, string[]>();
    for (const [localId, staged] of this.stagedFiles) {
      const item = this.editableAttachment(staged.sessionId, localId);
      if (
        staged.submitted ||
        item?.status !== "uploading" ||
        this.uploads.has(localId)
      )
        continue;
      const batch = batches.get(staged.sessionId) ?? [];
      batch.push(localId);
      batches.set(staged.sessionId, batch);
    }
    for (const [sessionId, localIds] of batches)
      void this.uploadStaged(sessionId, localIds);
  }

  private forgetStagedFile(localId: string): void {
    this.stagedFiles.get(localId)?.recovery.reset();
    this.stagedFiles.delete(localId);
  }

  private withdrawUpload(localId: string): void {
    this.forgetStagedFile(localId);
    const upload = this.uploads.get(localId);
    if (!upload) return;
    this.uploads.delete(localId);
    if (![...this.uploads.values()].includes(upload)) upload.abort();
  }

  removeAttachment(localId: string): void {
    const sessionId = this.host.state().sessionId;
    if (!sessionId) return;
    const composer = this.composers.get(sessionId);
    if (!composer) return;
    // Outgoing files are owned by their operation, not this editable partition.
    const target = composer.attachments.find(
      (item) => item.localId === localId,
    );
    if (target) {
      touchSessionDraft(sessionId);
      this.withdrawUpload(target.localId);
    }
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    composer.attachments = composer.attachments.filter(
      (item) => item.localId !== localId,
    );
    this.prune(sessionId, composer);
    this.publish(sessionId);
    // A withdrawn upload is unreferenced; reclaim its host cache file too.
    if (target?.uploadedId) {
      void this.host
        .api()
        ?.deleteAttachment(target.uploadedId)
        .catch(() => undefined);
    }
  }

  addProjectFile(path: string): void {
    const sessionId = this.host.state().sessionId;
    if (!sessionId || !path) return;
    const composer = this.forSession(sessionId);
    if (composer.projectFiles.includes(path)) return;
    const recalledProjectCount = composer.attachments.filter(
      (item) =>
        item.recalledArtifact?.type === "file" &&
        item.recalledArtifact.fileKind === "project",
    ).length;
    if (
      composer.projectFiles.length + recalledProjectCount >=
      MAX_PROJECT_FILES
    ) {
      this.host.notify(
        "warning",
        `At most ${MAX_PROJECT_FILES} project files per message`,
      );
      return;
    }
    touchSessionDraft(sessionId);
    composer.projectFiles = [...composer.projectFiles, path];
    this.publish(sessionId);
  }

  removeProjectFile(path: string): void {
    const sessionId = this.host.state().sessionId;
    if (!sessionId) return;
    const composer = this.composers.get(sessionId);
    if (!composer) return;
    if (composer.projectFiles.includes(path)) touchSessionDraft(sessionId);
    composer.projectFiles = composer.projectFiles.filter(
      (item) => item !== path,
    );
    this.prune(sessionId, composer);
    this.publish(sessionId);
  }

  private releaseAttachments(items: readonly PendingAttachment[]): void {
    for (const attachment of items) {
      this.withdrawUpload(attachment.localId);
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      if (attachment.uploadedId) {
        void this.host
          .api()
          ?.deleteAttachment(attachment.uploadedId)
          .catch(() => undefined);
      }
    }
  }

  private forSession(sessionId: string): ComposerPartition {
    let composer = this.composers.get(sessionId);
    if (!composer) {
      composer = {
        attachments: [],
        projectFiles: [],
        deliveries: new Map(),
      };
      this.composers.set(sessionId, composer);
    }
    return composer;
  }

  private prune(sessionId: string, composer: ComposerPartition): void {
    if (
      composer.deliveries.size === 0 &&
      composer.attachments.length === 0 &&
      composer.projectFiles.length === 0
    ) {
      if (this.composers.get(sessionId) === composer)
        this.composers.delete(sessionId);
    }
  }

  private publish(sessionId: string): void {
    if (this.host.state().sessionId !== sessionId) return;
    this.host.patch(this.slice(sessionId));
  }
}
