import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { z } from "zod";
import {
  type ComposerHistoryEntry,
  MAX_ATTACHMENTS,
  MAX_PROJECT_FILES,
  MAX_PROMPT_CHARS,
  type PromptAcceptedResponse,
  type PromptDeliveryRequest,
  type UploadedAttachment,
} from "../../shared/contracts";
import {
  type HostOperationIdentity,
  operationFingerprintSchema,
  promptFingerprintInput,
  promptObservationSchema,
  promptSchema,
} from "../../shared/host-operations";
import {
  isImageMimeType,
  isSupportedPromptImageMimeType,
} from "../../shared/image-types";
import { type Api, ApiError, ApiTransportError } from "../api";
import type { AppState } from "../app-state";
import { selectAttachmentFiles } from "../attachment-selection";
import {
  type ComposerHistoryScope,
  composerHistoryScopeKey,
  discardComposerHistory,
  rememberComposerHistory,
} from "../composer-history";
import { inputRejection, ReceiptRead } from "../operation-observer";
import { receiptStorage } from "../receipt-storage";
import { isTransientFailure, RecoveryBackoff } from "../recovery-backoff";
import {
  hasDraftInput,
  type SessionDraft,
  type SessionDrafts,
} from "../session-drafts";

interface RecalledHistoryArtifact {
  type: "image" | "file";
  reference: string;
  fileKind?: "attachment" | "project";
  scope: ComposerHistoryScope;
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
  /** A file staged in New has not been handed to an upload owner yet. */
  localFile?: File;
}

interface StagedFile {
  file: File;
  recovery: RecoveryBackoff;
  upload?: AbortController;
}

interface DeliveryRecord {
  sessionId: string;
  receipt: HostOperationIdentity & { fingerprint: string };
  message: string;
  attachments: PendingAttachment[];
  projectFiles: string[];
  status: "sending" | "unconfirmed" | "refused";
  confirmation: ReceiptRead<Api, PromptAcceptedResponse | false>;
  handoffRevision?: number;
  historyScope?: ComposerHistoryScope;
}

const DELIVERY_STORAGE = "inspire:composer-operations:v1:";
const MAX_SAVED_DELIVERIES = 16;
const savedDeliveries = promptObservationSchema
  .extend({
    fingerprint: operationFingerprintSchema,
    text: promptSchema.shape.message.optional(),
    projectFiles: promptSchema.shape.projectFiles,
    refused: z.literal(true).optional(),
  })
  .array()
  .max(MAX_SAVED_DELIVERIES);

const deliveryStorage = receiptStorage(
  MAX_SAVED_DELIVERIES * (6 * (MAX_PROMPT_CHARS + MAX_PROJECT_FILES * 4_096) + 256),
  savedDeliveries.parse,
  [],
);

interface ComposerControllerHost {
  state(): Pick<AppState, "sessionId" | "view">;
  drafts: SessionDrafts;
  api(): Api | null;
  authorityId(): string | null;
  notify(kind: "warning", text: string): void;
  notifyVisible(sessionId: string, message: string): void;
  handleAuthFailure(): void;
}

export function recalledInputAttachments(
  scope: ComposerHistoryScope,
  entry: ComposerHistoryEntry,
): PendingAttachment[] {
  const scopeKey = composerHistoryScopeKey(scope);
  return [
    ...entry.images.map<PendingAttachment>((image, index) => ({
      localId: `history:${scopeKey}:${image.reference}`,
      fileName: `Recalled image ${index + 1}`,
      mimeType: image.mimeType,
      size: image.size,
      kind: "image",
      status: "ready",
      recalledArtifact: {
        scope,
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
        scope,
        type: "file",
        reference: file.reference,
        fileKind: file.kind,
      },
    })),
  ];
}

/** Owns staging and delivery resources. Editors read the draft itself. */
export class ComposerController {
  /** An absent partition has not finished reading tab storage. */
  private readonly deliveries = new Map<string, Set<DeliveryRecord>>();
  private readonly listeners = new Set<() => void>();
  private readonly stagedFiles = new Map<string, StagedFile>();
  private recoveryAuthorityId: string | null = null;
  private readonly appliedRecoveryImages = new Map<string, Set<string>>();

  constructor(private readonly host: ComposerControllerHost) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  failedDeliveryCount(sessionId: string | null): number {
    return this.recordsFor(sessionId).filter((record) => record.status === "refused").length;
  }

  private recordsFor(sessionId: string | null): DeliveryRecord[] {
    return Array.from(this.deliveries.get(sessionId ?? "") ?? []);
  }

  private *allDeliveries() {
    for (const records of this.deliveries.values()) yield* records;
  }

  loadDeliveries(sessionId: string): void {
    if (this.deliveries.has(sessionId)) return;
    const saved = deliveryStorage.read(DELIVERY_STORAGE + sessionId);
    if (saved.issue === "storage") return;
    const records = new Set<DeliveryRecord>();
    this.deliveries.set(sessionId, records);
    const operations = saved.value ?? [];
    if (!saved.issue && !operations.length) return;
    const ids = new Set(operations.map(({ operationId }) => operationId));
    if (
      saved.issue ||
      ids.size !== operations.length ||
      [...this.allDeliveries()].some((record) => ids.has(record.receipt.operationId))
    ) {
      this.persist(sessionId);
      return;
    }
    const { revision } = this.host.drafts.get(sessionId);
    for (const { text, projectFiles = [], refused, ...receipt } of operations) {
      records.add({
        sessionId,
        receipt,
        message: text ?? "",
        attachments: [],
        projectFiles,
        status: refused ? "refused" : "unconfirmed",
        handoffRevision: text === undefined ? undefined : revision,
        confirmation: new ReceiptRead(),
      });
    }
    for (const record of records)
      if (record.status === "refused") this.settleDelivery(record, true);
    this.resumeDeliveries(sessionId);
  }

  private persist(sessionId: string): boolean {
    const partition = this.deliveries.get(sessionId);
    if (!partition) return false;
    try {
      const records = [...partition];
      let retired: DeliveryRecord | undefined;
      if (records.length > MAX_SAVED_DELIVERIES) {
        const index = records.findIndex(
          (record) => record.status === "unconfirmed" &&
            record.handoffRevision === undefined && !record.confirmation.pending,
        );
        if (index === -1) return false;
        [retired] = records.splice(index, 1);
      }
      const operations = records.map(
        ({ receipt, message, projectFiles, status, handoffRevision }) => ({
          ...receipt,
          ...(handoffRevision !== undefined
            ? { text: message, projectFiles, refused: status === "refused" || undefined }
            : {}),
        }),
      );
      deliveryStorage.write(DELIVERY_STORAGE + sessionId, operations.length ? operations : null);
      if (retired) partition.delete(retired);
      return true;
    } catch {
      return false;
    }
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  invalidateForTransportReplacement(): void {
    for (const staged of this.stagedFiles.values()) {
      staged.upload?.abort();
      staged.upload = undefined;
      staged.recovery.reset();
    }
    for (const record of this.allDeliveries()) {
      if (!record.confirmation.pending) continue;
      this.settleDelivery(record);
    }
  }

  /** Upload handles belong to one Host process, unlike a dropped event socket.
   * Include hidden partitions and saved/failed drafts so restoring them cannot
   * resurrect a ready-looking handle from a retired Host. */
  reconcileAuthority(authorityId: string): void {
    if (this.recoveryAuthorityId === authorityId) return;
    this.appliedRecoveryImages.clear();
    this.recoveryAuthorityId = authorityId;
    const reconcile = (item: PendingAttachment): PendingAttachment => {
      if (
        !item.uploadedId ||
        item.status === "error" ||
        item.uploadedAuthorityId === authorityId
      )
        return item;
      const staged = this.stagedFiles.get(item.localId);
      if (staged) {
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
    };
    for (const [sessionId] of this.host.drafts.entries())
      this.updateAttachments(sessionId, reconcile);
  }

  /** The receipt transfers handles, not a browser queue. Preserve every image
   * and the existing draft even when their combined count exceeds send limits. */
  restoreStagedAttachments(
    sessionId: string,
    attachments: UploadedAttachment[],
    authorityId: string | null,
    recoveryId?: string,
  ): void {
    if (!attachments.length) return;
    const draft = this.host.drafts.get(sessionId);
    const api = this.host.api();
    const currentAuthority = this.host.authorityId();
    let applied: Set<string> | undefined;
    if (recoveryId && authorityId === currentAuthority) {
      const key = JSON.stringify([authorityId, sessionId, recoveryId]);
      applied = this.appliedRecoveryImages.get(key) ?? new Set();
      this.appliedRecoveryImages.set(key, applied);
    }
    const known = new Set(
      draft.attachments
        .filter((item) => item.uploadedAuthorityId === authorityId)
        .map((item) => item.uploadedId),
    );
    const pending: PendingAttachment[] = attachments
      .filter((item) => {
        if (applied?.has(item.id)) return false;
        applied?.add(item.id);
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
    if (pending.length)
      this.host.drafts.update(sessionId, {
        attachments: [...pending, ...draft.attachments],
      });
    if (!api || authorityId !== currentAuthority) return;
    for (const item of pending)
      if (item.kind === "image") {
        void api
          .attachmentPreview(item.uploadedId!)
          .then((blob) => {
            if (this.host.authorityId() !== authorityId) return;
            const previewUrl = URL.createObjectURL(blob);
            if (
              !this.patchAttachment(sessionId, item.localId, {
                previewUrl,
                previewLoading: false,
              })
            )
              URL.revokeObjectURL(previewUrl);
          })
          .catch((error) => {
            if (this.host.authorityId() !== authorityId) return;
            this.patchAttachment(sessionId, item.localId, {
              previewLoading: false,
              error:
                error instanceof Error ? error.message : "Image preview failed",
            });
          });
      }
  }

  private updateAttachments(
    sessionId: string | null,
    update: (item: PendingAttachment) => PendingAttachment,
  ): boolean {
    const draft = this.host.drafts.get(sessionId);
    const attachments = draft.attachments.map(update);
    let changed = attachments.some(
      (item, index) => item !== draft.attachments[index],
    );
    if (changed) this.host.drafts.update(sessionId, { attachments }, false);
    for (const record of this.recordsFor(sessionId)) {
      const current = record.attachments;
      record.attachments = current.map(update);
      changed ||= record.attachments.some(
        (item, index) => item !== current[index],
      );
    }
    return changed;
  }

  private patchAttachment(
    sessionId: string,
    localId: string,
    patch: Partial<PendingAttachment>,
  ): boolean {
    return this.updateAttachments(sessionId, (item) =>
      item.localId === localId ? { ...item, ...patch } : item,
    );
  }

  discard(sessionId: string): void {
    const attachments = new Map(
      this.host.drafts
        .get(sessionId)
        .attachments.map((item) => [item.localId, item]),
    );
    this.host.drafts.clear(sessionId);
    for (const record of this.recordsFor(sessionId)) {
      record.confirmation.cancel();
      for (const item of record.attachments)
        attachments.set(item.localId, item);
    }
    this.releaseAttachments([...attachments.values()]);
    this.deliveries.set(sessionId, new Set());
    this.persist(sessionId);
    this.publish();
    discardComposerHistory(sessionId);
  }

  async send(
    message: string,
    behavior?: "steer" | "followUp",
    editorDraft?: SessionDraft,
    independent = false,
  ): Promise<PromptAcceptedResponse | false> {
    const {
      sessionId,
      view: {
        viewId: transcriptViewId,
        incarnation: transcriptIncarnation,
        effectiveLeafId: transcriptEffectiveLeafId,
        composerHistoryVersion,
      },
    } = this.host.state();
    const api = this.host.api();
    const authorityId = this.host.authorityId();
    if (!api || !sessionId || !authorityId) return false;
    if (message.length > MAX_PROMPT_CHARS) {
      this.host.notifyVisible(sessionId, "The message is too long to send.");
      return false;
    }
    this.loadDeliveries(sessionId);
    this.reconcileAuthority(authorityId);
    const draft = this.host.drafts.get(sessionId);
    const included = independent ? [] : draft.attachments;
    const blocked = included.find((item) => item.status !== "ready");
    if (blocked) {
      this.host.notify(
        "warning",
        blocked.status === "uploading"
          ? "Attachments are still uploading"
          : "Retry or remove failed attachments before sending",
      );
      return false;
    }
    const projectFiles = independent ? [] : draft.projectFiles;
    if (
      message.trim().startsWith("!") &&
      (included.length > 0 || projectFiles.length > 0)
    ) {
      this.host.notify(
        "warning",
        "Shell commands cannot include attachments or project-file references",
      );
      return false;
    }
    const recalledProjects = included.filter(isRecalledProject).length;
    const attachmentCount = included.length - recalledProjects;
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
    const recalled = included.flatMap(({ recalledArtifact }) =>
      recalledArtifact ? [recalledArtifact] : [],
    );
    const historyOwner = recalled[0]?.scope;
    if (
      historyOwner &&
      recalled.some(
        ({ scope }) =>
          scope !== historyOwner &&
          composerHistoryScopeKey(scope) !==
            composerHistoryScopeKey(historyOwner),
      )
    ) {
      this.host.notify(
        "warning",
        "Recalled attachments belong to another branch",
      );
      return false;
    }
    if (projectFiles.length + recalledProjects > MAX_PROJECT_FILES) {
      this.host.notify(
        "warning",
        `At most ${MAX_PROJECT_FILES} project files per message`,
      );
      return false;
    }
    if (
      !message.trim() &&
      !attachmentIds.length &&
      !recalled.length &&
      !projectFiles.length
    ) {
      return false;
    }
    const previous =
      independent &&
      this.recordsFor(sessionId).find(
        (record) =>
          record.status === "sending" &&
          record.handoffRevision === undefined &&
          record.message === message,
      );
    if (previous) return this.observe(previous);
    const identity = {
      operationId: globalThis.crypto.randomUUID(),
      authorityId,
      sessionId,
    };
    const request = {
      ...identity,
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
                .filter((item) => item.type === "image")
                .map((item) => item.reference),
              fileReferences: recalled
                .filter((item) => item.type === "file")
                .map((item) => item.reference),
            },
          }
        : {}),
      ...(projectFiles.length > 0 ? { projectFiles } : {}),
      ...(behavior ? { behavior } : {}),
    };
    const fingerprint = bytesToHex(sha256(promptFingerprintInput(request)));
    const record: DeliveryRecord = {
      sessionId,
      receipt: { operationId: identity.operationId, authorityId, fingerprint },
      message: editorDraft?.text ?? message,
      attachments: included,
      projectFiles,
      status: "sending",
      handoffRevision: independent ? undefined : draft.revision,
      confirmation: new ReceiptRead(),
      historyScope:
        !independent && transcriptViewId && composerHistoryVersion
          ? {
              sessionId,
              viewId: transcriptViewId,
              incarnation: transcriptIncarnation ?? null,
              effectiveLeafId: transcriptEffectiveLeafId ?? null,
              historyVersion: composerHistoryVersion,
            }
          : undefined,
    };
    const partition = this.deliveries.get(sessionId);
    partition?.add(record);
    if (!this.persist(sessionId)) {
      partition?.delete(record);
      const message = independent
        ? "Couldn't send the message from this tab."
        : "Couldn't send from this tab. Your message is still in the editor.";
      if (independent) this.host.notify("warning", message);
      else this.host.notifyVisible(sessionId, message);
      return false;
    }
    if (!independent)
      record.handoffRevision = this.host.drafts.update(sessionId, {
        text: editorDraft ? "" : draft.text,
        attachments: [],
        projectFiles: [],
      }).revision;
    return this.observe(record, request);
  }

  private async observe(
    record: DeliveryRecord,
    request?: PromptDeliveryRequest,
  ): Promise<PromptAcceptedResponse | false> {
    const { sessionId, receipt } = record;
    const { authorityId, fingerprint } = receipt;
    const api = this.host.api();
    if (
      !api ||
      this.host.authorityId() !== authorityId ||
      record.confirmation.pending ||
      record.status === "refused"
    ) return false;
    return record.confirmation.observe(api, async (signal) => {
      const ownsTransport = () =>
        !signal.aborted &&
        this.host.api() === api &&
        this.deliveries.get(sessionId)?.has(record);
      try {
        if (request) await api.prompt(request, signal, fingerprint);
        else await api.observePrompt(receipt, signal);
        if (!ownsTransport()) return false;
        // Saved material stays in the native reader. A recent shortcut must
        // never silently turn a message with attachments into a text-only draft.
        if (
          record.historyScope &&
          !record.attachments.length &&
          !record.projectFiles.length
        )
          rememberComposerHistory(record.historyScope, {
            text: record.message.trim(),
            images: [],
            files: [],
          });
        this.finishDelivery(record, "accepted");
        return { accepted: true };
      } catch (error) {
        if (!ownsTransport()) return false;
        const rejection = inputRejection(error);
        if (rejection?.code === "PROMPT_RECOVERED")
          return this.returnDelivery(record, rejection);
        if (rejection?.code === "PROMPT_CLEARED")
          return this.finishDelivery(record, "cleared");
        if (rejection?.code === "ATTACHMENTS_EXPIRED") {
          for (const item of record.attachments) {
            if (!item.uploadedId || !rejection.matches?.includes(item.uploadedId))
              continue;
            this.patchAttachment(
              sessionId, item.localId,
              this.stagedFiles.has(item.localId)
                ? { status: "uploading" }
                : { status: "error", error: "This attachment is no longer available. Add it again." },
            );
          }
        }
        this.settleDelivery(record, Boolean(rejection));
        if (rejection?.code === "ATTACHMENTS_EXPIRED") this.resumeUploads();
        if (rejection?.code === "PROMPT_ABORTED") return false;
        if (error instanceof ApiError && error.status === 401) {
          this.host.handleAuthFailure();
        } else if (request && rejection) {
          if (record.handoffRevision === undefined) this.host.notify("warning", rejection.message);
          else this.host.notifyVisible(sessionId, rejection.message);
        }
        return false;
      }
    });
  }

  private returnDelivery(record: DeliveryRecord, receipt: ApiError): false {
    const { sessionId, receipt: { authorityId } } = record;
    const retained = record.attachments.filter((item) => {
      if (!receipt.recoveredAttachments || item.kind !== "image") return true;
      this.retireFile(item);
      return false;
    });
    if (retained.length || record.projectFiles.length) {
      const draft = this.host.drafts.get(sessionId);
      const attachments = new Map(
        [...retained, ...draft.attachments].map((item) => [item.localId, item]),
      );
      this.host.drafts.update(sessionId, {
        attachments: [...attachments.values()],
        projectFiles: [...new Set([...record.projectFiles, ...draft.projectFiles])],
      });
    }
    // Reloaded receipts retain text and paths only. The original tab owns the
    // live attachment handoff, including its record of already removed handles.
    if (receipt.recoveredAttachments && retained.length < record.attachments.length)
      this.restoreStagedAttachments(
        sessionId,
        receipt.recoveredAttachments,
        authorityId,
        receipt.recoveryId,
      );
    return this.finishDelivery(record, "returned");
  }

  private finishDelivery(
    record: DeliveryRecord,
    outcome: "accepted" | "returned" | "cleared",
  ): false {
    const { sessionId, attachments } = record;
    if (outcome === "cleared") this.releaseAttachments(attachments);
    if (outcome === "accepted")
      for (const item of attachments) this.retireFile(item);
    this.deliveries.get(sessionId)?.delete(record);
    this.persist(sessionId);
    return false;
  }

  private settleDelivery(record: DeliveryRecord, refused = false): void {
    const { sessionId, handoffRevision } = record;
    record.confirmation.cancel();
    if (!refused) {
      record.status = "unconfirmed";
      return;
    }
    if (handoffRevision === undefined) {
      this.finishDelivery(record, "cleared");
      return;
    }
    record.status = "refused";
    const draft = this.host.drafts.get(sessionId);
    if (draft.revision === handoffRevision && !hasDraftInput(draft))
      this.restore(record);
    this.persist(sessionId);
    this.publish();
  }

  resumeDeliveries(sessionId?: string): void {
    const authorityId = this.host.authorityId();
    if (!authorityId || !this.host.api()) return;
    const records = sessionId === undefined ? this.allDeliveries() : this.recordsFor(sessionId);
    for (const record of records) {
      if (record.status !== "unconfirmed" || record.confirmation.pending) continue;
      if (record.receipt.authorityId === authorityId) {
        void this.observe(record);
      } else {
        this.settleDelivery(record, true);
        this.resumeUploads();
      }
    }
  }

  restoreFailedPrompt(sessionId: string | null): boolean {
    if (!sessionId || hasDraftInput(this.host.drafts.get(sessionId))) return false;
    const record = this.recordsFor(sessionId).find((record) => record.status === "refused");
    if (!record) return false;
    this.restore(record);
    this.persist(sessionId);
    this.publish();
    this.resumeUploads();
    return true;
  }

  private restore(record: DeliveryRecord): void {
    this.deliveries.get(record.sessionId)?.delete(record);
    this.host.drafts.update(record.sessionId, {
      text: record.message,
      attachments: record.attachments,
      projectFiles: record.projectFiles,
    });
  }

  useHistoryEntry(
    scope: ComposerHistoryScope,
    entry: ComposerHistoryEntry,
  ): boolean {
    const {
      sessionId,
      view: { viewId: transcriptViewId },
    } = this.host.state();
    if (sessionId !== scope.sessionId || transcriptViewId !== scope.viewId)
      return false;
    const draft = this.host.drafts.get(sessionId);
    this.releaseAttachments(draft.attachments);
    const attachments = recalledInputAttachments(scope, entry);
    this.host.drafts.update(sessionId, {
      attachments,
      projectFiles: [],
      text: entry.text,
    });
    return true;
  }

  addFiles(
    files: File[],
    sessionId = this.host.state().sessionId,
  ): Promise<void> {
    const draft = this.host.drafts.get(sessionId);
    const { accepted, warning } = selectAttachmentFiles(
      draft.attachments.filter((item) => !isRecalledProject(item)),
      files,
    );
    if (warning) this.host.notify("warning", warning);
    if (!accepted.length) return Promise.resolve();

    const pending: PendingAttachment[] = accepted.map((file) => {
      const isImage = isImageMimeType(file.type);
      return {
        localId: crypto.randomUUID(),
        fileName: file.name || "pasted-image",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind: isSupportedPromptImageMimeType(file.type) ? "image" : "file",
        previewUrl: isImage ? URL.createObjectURL(file) : undefined,
        status: sessionId ? "uploading" : "ready",
        ...(sessionId === null ? { localFile: file } : {}),
      };
    });
    if (sessionId)
      pending.forEach((item, index) =>
        this.stage(item.localId, accepted[index]!),
      );
    this.host.drafts.update(sessionId, {
      attachments: [...draft.attachments, ...pending],
    });
    return sessionId
      ? this.uploadStaged(
          sessionId,
          pending.map((item) => item.localId),
        )
      : Promise.resolve();
  }

  private stage(localId: string, file: File): void {
    this.stagedFiles.set(localId, {
      file,
      recovery: new RecoveryBackoff(),
    });
  }

  /** Keep any newer start draft and make the original input available before upload. */
  transferStart(sessionId: string, start: SessionDraft): Promise<void> {
    const current = this.host.drafts.get(null);
    const clear = current.revision === start.revision;
    const attachments = start.attachments.map((item): PendingAttachment => {
      const file = item.localFile!;
      const localId = clear ? item.localId : crypto.randomUUID();
      this.stage(localId, file);
      return {
        ...item,
        localId,
        localFile: undefined,
        previewUrl:
          !clear && item.previewUrl
            ? URL.createObjectURL(file)
            : item.previewUrl,
        status: "uploading",
      };
    });
    const draft = this.host.drafts.get(sessionId);
    this.host.drafts.update(sessionId, {
      text: draft.text
        ? [start.text, draft.text].filter(Boolean).join("\n\n")
        : start.text,
      attachments: [...attachments, ...draft.attachments],
      projectFiles: [
        ...new Set([...start.projectFiles, ...draft.projectFiles]),
      ],
    });
    if (clear) this.host.drafts.clear(null);
    return this.uploadStaged(
      sessionId,
      attachments.map((item) => item.localId),
    );
  }

  private editableAttachment(
    sessionId: string,
    localId: string,
  ): PendingAttachment | undefined {
    return this.host.drafts
      .get(sessionId)
      .attachments.find((item) => item.localId === localId);
  }

  /** Only browser-held, unsent staging is replayable. Prompt delivery has its own identity. */
  private async uploadStaged(
    sessionId: string,
    localIds: string[],
  ): Promise<void> {
    const api = this.host.api();
    const authorityId = this.host.authorityId();
    if (!api || !authorityId) return;
    const pending = localIds.flatMap((localId) => {
      const staged = this.stagedFiles.get(localId);
      const item = this.editableAttachment(sessionId, localId);
      return staged && item && !staged.upload
        ? [{ item, staged }]
        : [];
    });
    if (!pending.length) return;
    const upload = new AbortController();
    const ownsTransport = () =>
      this.host.api() === api &&
      this.host.authorityId() === authorityId &&
      !upload.signal.aborted;
    for (const { item, staged } of pending) {
      staged.recovery.cancel();
      staged.upload = upload;
      this.patchAttachment(sessionId, item.localId, {
        status: "uploading",
        error: undefined,
        retryable: false,
      });
    }
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
        this.patchAttachment(sessionId, item.localId, {
          status: "ready",
          error: undefined,
          retryable: false,
          uploadedId: result.id,
          uploadedAuthorityId: authorityId,
          fileName: result.fileName,
          kind: result.kind,
        });
      });
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
            void this.uploadStaged(sessionId, [item.localId]);
          });
        this.patchAttachment(
          sessionId,
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
    } finally {
      for (const { staged } of pending)
        if (staged.upload === upload) staged.upload = undefined;
    }
  }

  retryAttachment = (localId: string): Promise<void> => {
    const sessionId = this.host.state().sessionId;
    const staged = this.stagedFiles.get(localId);
    if (
      !sessionId ||
      !staged ||
      !this.editableAttachment(sessionId, localId)
    )
      return Promise.resolve();
    staged.recovery.reset();
    return this.uploadStaged(sessionId, [localId]);
  };

  /** A resumed transport restarts only unfinished staging in its original partition. */
  resumeUploads(): void {
    for (const [sessionId, draft] of this.host.drafts.entries()) {
      if (!sessionId) continue;
      const pending = draft.attachments
        .filter((item) => item.status === "uploading")
        .map((item) => item.localId);
      if (pending.length) void this.uploadStaged(sessionId, pending);
    }
  }

  private retireFile({ localId, previewUrl }: PendingAttachment): void {
    const staged = this.stagedFiles.get(localId);
    const upload = staged?.upload;
    staged?.recovery.reset();
    this.stagedFiles.delete(localId);
    if (
      upload &&
      ![...this.stagedFiles.values()].some((staged) => staged.upload === upload)
    )
      upload.abort();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }

  removeAttachment(
    localId: string,
    sessionId = this.host.state().sessionId,
  ): void {
    const draft = this.host.drafts.get(sessionId);
    const target = draft.attachments.find((item) => item.localId === localId);
    if (!target) return;
    this.releaseAttachments([target]);
    const attachments = draft.attachments.filter(
      (item) => item.localId !== localId,
    );
    this.host.drafts.update(sessionId, { attachments });
  }

  addProjectFile(
    path: string,
    sessionId = this.host.state().sessionId,
    workspaceCwd?: string,
  ): void {
    if (!path) return;
    const draft = this.host.drafts.get(sessionId);
    const root = workspaceCwd ?? draft.workspaceCwd;
    const paths = root === draft.workspaceCwd ? draft.projectFiles : [];
    if (paths.includes(path)) return;
    const recalledProjectCount =
      draft.attachments.filter(isRecalledProject).length;
    if (paths.length + recalledProjectCount >= MAX_PROJECT_FILES) {
      this.host.notify(
        "warning",
        `At most ${MAX_PROJECT_FILES} project files per message`,
      );
      return;
    }
    this.host.drafts.update(sessionId, {
      projectFiles: [...paths, path],
      workspaceCwd: root,
    });
  }

  removeProjectFile(
    path: string,
    sessionId = this.host.state().sessionId,
  ): void {
    const draft = this.host.drafts.get(sessionId);
    if (!draft.projectFiles.includes(path)) return;
    const projectFiles = draft.projectFiles.filter((item) => item !== path);
    this.host.drafts.update(sessionId, {
      projectFiles,
      workspaceCwd: projectFiles.length ? draft.workspaceCwd : undefined,
    });
  }

  private releaseAttachments(items: readonly PendingAttachment[]): void {
    for (const attachment of items) {
      this.retireFile(attachment);
      if (
        attachment.uploadedId &&
        attachment.uploadedAuthorityId === this.host.authorityId()
      ) {
        void this.host
          .api()
          ?.deleteAttachment(attachment.uploadedId)
          .catch(() => undefined);
      }
    }
  }
}

function isRecalledProject(item: PendingAttachment): boolean {
  return item.recalledArtifact?.fileKind === "project";
}
