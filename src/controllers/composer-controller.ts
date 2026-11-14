import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
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
import { ReceiptRead } from "../operation-observer";
import { type ReceiptStorageIssue, receiptStorage } from "../receipt-storage";
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
  /** A file staged in New has not been handed to an upload owner yet. */
  localFile?: File;
}

interface StagedFile {
  sessionId: string;
  file: File;
  recovery: RecoveryBackoff;
  upload?: AbortController;
  /** Possibly delivered bytes must never enter automatic upload recovery. */
  submitted: boolean;
}

interface DeliveryRecord {
  sessionId: string;
  receipt: HostOperationIdentity & { fingerprint: string };
  message: string;
  attachments: PendingAttachment[];
  projectFiles: string[];
  /** Controls the available recovery action after observation. */
  recovery: "draft" | "previous" | "reloaded" | "palette";
  refused?: boolean;
  confirmation: ReceiptRead<Api, PromptAcceptedResponse | false>;
  handoffRevision?: number;
  historyScope?: ComposerHistoryScope;
}

const DELIVERY_STORAGE = "inspire:composer-operations:v1:";
const MAX_SAVED_DELIVERIES = 16;
const savedDeliveries = promptObservationSchema
  .extend({ fingerprint: operationFingerprintSchema })
  .array()
  .max(MAX_SAVED_DELIVERIES);

const deliveryStorage = receiptStorage(
  MAX_SAVED_DELIVERIES * 256,
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

/** Owns staging and delivery resources. Editors read the draft itself. */
export class ComposerController {
  private readonly deliveries = new Map<string, DeliveryRecord>();
  /** Absence means this session's receipt storage has not been read yet. */
  private readonly storageState = new Map<
    string,
    ReceiptStorageIssue | "unread" | null
  >();
  private readonly listeners = new Set<() => void>();
  private deliveryVersion = 0;
  private readonly stagedFiles = new Map<string, StagedFile>();
  private recoveryAuthorityId: string | null = null;
  private readonly appliedRecoveryImages = new Map<string, Set<string>>();

  constructor(private readonly host: ComposerControllerHost) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getDeliveryVersion = () => this.deliveryVersion;

  deliveryState = (sessionId: string | null) => ({
    failedCount: this.deliveriesFor(sessionId, "draft").length,
    storageIssue: sessionId ? this.storageIssue(sessionId) : undefined,
    reloaded: this.reloadedDelivery(sessionId)?.receipt.operationId,
    previous: this.deliveriesFor(sessionId, "previous")[0]?.receipt.operationId,
  });

  private storageIssue(sessionId: string): ReceiptStorageIssue | undefined {
    const issue = this.storageState.get(sessionId);
    return issue === "unread" ? "storage" : (issue ?? undefined);
  }

  private reloadedDelivery(
    sessionId: string | null,
  ): DeliveryRecord | undefined {
    return this.deliveriesFor(sessionId).find(
      ({ recovery }) => recovery === "reloaded",
    );
  }

  private deliveriesFor(
    sessionId: string | null,
    recovery?: DeliveryRecord["recovery"],
  ) {
    return [...this.deliveries.values()].filter(
      (record) =>
        record.sessionId === sessionId &&
        (recovery === undefined ||
          (record.recovery === recovery &&
            !record.confirmation.pending &&
            (recovery !== "draft" || !this.isLinked(record)))),
    );
  }

  loadDeliveries(sessionId: string): void {
    const previous = this.storageState.get(sessionId);
    if (previous !== undefined && previous !== "unread") return;
    const saved = deliveryStorage.read(DELIVERY_STORAGE + sessionId);
    const operations = saved.value ?? [];
    const ids = new Set(operations.map(({ operationId }) => operationId));
    const issue =
      saved.issue ??
      (ids.size !== operations.length ||
      [...ids].some((id) => this.deliveries.has(id))
        ? "format"
        : null);
    this.storageState.set(sessionId, issue === "storage" ? "unread" : issue);
    if (!issue)
      for (const receipt of operations)
        this.deliveries.set(receipt.operationId, {
          sessionId,
          receipt,
          message: "",
          attachments: [],
          projectFiles: [],
          recovery: "reloaded",
          confirmation: new ReceiptRead(),
        });
    if (issue || operations.length || previous === "unread") this.publish();
  }

  private persist(sessionId: string): boolean {
    try {
      const issue = this.storageState.get(sessionId);
      if (issue === "format" || issue === "unread") return false;
      const operations = this.deliveriesFor(sessionId)
        .filter(({ refused }) => !refused)
        .map(({ receipt }) => receipt);
      if (operations.length > MAX_SAVED_DELIVERIES) {
        this.host.notifyVisible(
          sessionId,
          "Check earlier delivery receipts before sending more prompts.",
        );
        return false;
      }
      deliveryStorage.write(
        DELIVERY_STORAGE + sessionId,
        operations.length ? operations : null,
      );
      this.storageState.set(sessionId, null);
      return true;
    } catch {
      this.storageState.set(sessionId, "storage");
      return false;
    }
  }

  private publish(): void {
    this.deliveryVersion += 1;
    for (const listener of this.listeners) listener();
  }

  invalidateForTransportReplacement(): void {
    for (const staged of this.stagedFiles.values()) {
      staged.upload?.abort();
      staged.upload = undefined;
      staged.recovery.reset();
    }
    let deliveryOutcomeUnknown = false;
    for (const record of this.deliveries.values()) {
      if (!record.confirmation.pending) continue;
      deliveryOutcomeUnknown = true;
      this.settleDelivery(record);
    }
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
    const draft = this.host.drafts.get(sessionId);
    const api = this.host.api();
    const currentAuthority = this.host.authorityId();
    const known = new Set(
      draft.attachments
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
    for (const record of this.deliveriesFor(sessionId)) {
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
    for (const [id, record] of this.deliveries) {
      if (record.sessionId !== sessionId) continue;
      record.confirmation.cancel();
      for (const item of record.attachments)
        attachments.set(item.localId, item);
      this.deliveries.delete(id);
    }
    this.releaseAttachments([...attachments.values()]);
    this.storageState.set(sessionId, null);
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
    if (this.reloadedDelivery(sessionId)) {
      this.host.notifyVisible(
        sessionId,
        "Check or stop tracking the prompt from before this tab reloaded.",
      );
      return false;
    }
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
      this.deliveriesFor(sessionId).find(
        (record) => record.recovery === "palette" && record.message === message,
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
    const fingerprint = bytesToHex(sha256(promptFingerprintInput(request)));
    const record: DeliveryRecord = {
      sessionId,
      receipt: { operationId: identity.operationId, authorityId, fingerprint },
      message: editorDraft?.text ?? message,
      attachments: included,
      projectFiles,
      recovery: independent ? "palette" : "draft",
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
    this.deliveries.set(request.operationId, record);
    if (!this.persist(sessionId)) {
      this.deliveries.delete(request.operationId);
      this.publish();
      const message =
        "The prompt could not be tracked in this tab. Check previous delivery records before sending.";
      if (independent) this.host.notify("warning", message);
      else this.host.notifyVisible(sessionId, message);
      return false;
    }
    for (const item of record.attachments) {
      const staged = this.stagedFiles.get(item.localId);
      if (staged) {
        staged.submitted = true;
        staged.recovery.reset();
      }
    }
    if (!independent)
      record.handoffRevision = this.host.drafts.update(sessionId, {
        text: editorDraft ? "" : draft.text,
        attachments: [],
        projectFiles: [],
      }).revision;
    return this.observe(record, request);
  }

  private isLinked(record: DeliveryRecord): boolean {
    return (
      this.host.drafts.get(record.sessionId).intentId ===
      record.receipt.operationId
    );
  }

  private async observe(
    record: DeliveryRecord,
    request?: PromptDeliveryRequest,
  ): Promise<PromptAcceptedResponse | false> {
    const { sessionId, receipt } = record;
    const { authorityId, operationId, fingerprint } = receipt;
    const api = this.host.api();
    if (!api || record.confirmation.pending || record.refused) return false;
    if (this.host.authorityId() !== authorityId) {
      this.host.notifyVisible(
        sessionId,
        "The Host restarted before delivery was confirmed. Check the conversation before starting a new input.",
      );
      return false;
    }
    return record.confirmation.observe(api, async (signal) => {
      const ownsTransport = () =>
        !signal.aborted &&
        this.host.api() === api &&
        this.deliveries.get(operationId) === record;
      try {
        const response = request
          ? await api.prompt(request, signal, fingerprint)
          : await api.observePrompt(receipt, signal);
        if (!ownsTransport()) return false;
        if (record.historyScope)
          rememberComposerHistory(
            record.historyScope,
            response.historyEntry ?? {
              text: record.message.trim(),
              images: [],
              files: [],
            },
          );
        this.finishDelivery(record, "accepted");
        return { accepted: true, historyEntry: response.historyEntry };
      } catch (error) {
        if (!ownsTransport()) return false;
        const rejection =
          error instanceof ApiError && !error.outcomeUnknown ? error : null;
        if (rejection) {
          for (const item of record.attachments) {
            const staged = this.stagedFiles.get(item.localId);
            if (staged) staged.submitted = false;
          }
        }
        if (rejection?.code === "PROMPT_RECOVERED")
          return this.returnDelivery(record, rejection);
        if (rejection?.code === "PROMPT_CLEARED")
          return this.finishDelivery(record, "cleared");
        if (rejection?.code === "ATTACHMENTS_EXPIRED") {
          for (const item of record.attachments) {
            if (
              !item.uploadedId ||
              !rejection.matches?.includes(item.uploadedId)
            )
              continue;
            this.patchAttachment(
              sessionId,
              item.localId,
              this.stagedFiles.has(item.localId)
                ? { status: "uploading" }
                : {
                    status: "error",
                    error:
                      "This attachment is no longer available. Add it again.",
                  },
            );
          }
        }
        this.settleDelivery(record, Boolean(rejection));
        if (rejection?.code === "ATTACHMENTS_EXPIRED") this.resumeUploads();
        if (rejection?.code === "PROMPT_ABORTED") return false;
        if (error instanceof ApiError && error.status === 401) {
          this.host.handleAuthFailure();
        } else {
          const message =
            rejection?.message ??
            (error instanceof ApiError &&
            error.code === "ATTACH_CONTROL_OUTCOME_UNKNOWN"
              ? "The attached Pi did not confirm delivery. Check its conversation before sending again."
              : "Message delivery is unconfirmed. Retry checks its original receipt.");
          if (record.recovery === "palette")
            this.host.notify("warning", message);
          else this.host.notifyVisible(sessionId, message);
        }
        return false;
      }
    });
  }

  private returnDelivery(record: DeliveryRecord, receipt: ApiError): false {
    if (record.recovery === "previous")
      return this.finishDelivery(record, "accepted");
    const {
      sessionId,
      attachments: returned,
      receipt: { authorityId },
    } = record;
    const superseded = receipt.recoveredAttachments
      ? returned.filter((item) => item.kind === "image")
      : [];
    const draft = this.host.drafts.get(sessionId);
    const attachments = new Map(
      [...returned, ...draft.attachments].map((item) => [item.localId, item]),
    );
    for (const item of superseded) {
      attachments.delete(item.localId);
      this.retireFile(item);
    }
    this.host.drafts.update(sessionId, {
      attachments: [...attachments.values()],
      projectFiles: this.isLinked(record)
        ? draft.projectFiles
        : [...new Set([...record.projectFiles, ...draft.projectFiles])],
    });
    if (receipt.recoveredAttachments)
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
    const {
      sessionId,
      attachments,
      receipt: { operationId },
    } = record;
    if (this.isLinked(record)) {
      const draft = this.host.drafts.get(sessionId);
      const ids = new Set(record.attachments.map((item) => item.localId));
      const untouched = draft.revision === record.handoffRevision;
      this.host.drafts.update(sessionId, {
        intentId: undefined,
        ...(outcome === "returned"
          ? {}
          : {
              text: untouched ? "" : draft.text,
              attachments: draft.attachments.filter(
                (item) => !ids.has(item.localId),
              ),
              projectFiles:
                draft.projectFiles === record.projectFiles
                  ? []
                  : draft.projectFiles,
            }),
      });
    }
    if (outcome === "cleared") this.releaseAttachments(attachments);
    if (outcome === "accepted")
      for (const item of attachments) this.retireFile(item);
    this.deliveries.delete(operationId);
    this.persist(sessionId);
    this.publish();
    return false;
  }

  private settleDelivery(record: DeliveryRecord, refused = false): void {
    const {
      sessionId,
      receipt: { operationId },
    } = record;
    record.confirmation.cancel();
    const draft = this.host.drafts.get(sessionId);
    if (this.isLinked(record)) {
      if (refused) this.host.drafts.update(sessionId, { intentId: undefined });
    } else if (record.recovery === "draft") {
      if (refused) record.refused = true;
      if (
        !draft.intentId &&
        draft.revision === record.handoffRevision &&
        !hasDraftInput(draft)
      )
        this.restore(record);
    } else if (refused) {
      this.finishDelivery(record, "cleared");
      return;
    }
    if (refused) {
      if (!record.refused) this.deliveries.delete(operationId);
      this.persist(sessionId);
    }
    this.publish();
  }

  retryIfTracking(sessionId: string) {
    const record = this.currentDelivery(sessionId);
    if (record) return this.observe(record);
  }

  async retryPrevious(sessionId: string): Promise<void> {
    const record = this.deliveriesFor(sessionId, "previous")[0];
    if (record && (await this.observe(record)))
      this.host.notifyVisible(sessionId, "The original prompt was accepted.");
  }

  private forget(record: DeliveryRecord): void {
    this.deliveries.delete(record.receipt.operationId);
    if (!this.persist(record.sessionId))
      this.deliveries.set(record.receipt.operationId, record);
    else for (const item of record.attachments) this.retireFile(item);
    this.publish();
  }

  forgetPrevious(sessionId: string): void {
    const record = this.deliveriesFor(sessionId, "previous")[0];
    if (record) this.forget(record);
  }

  detach(sessionId: string): void {
    const draft = this.host.drafts.get(sessionId);
    const record = this.currentDelivery(sessionId);
    if (!record || record.confirmation.pending) return;
    if (record.recovery === "reloaded") return this.forget(record);
    const submittedIds = new Set(
      record.attachments.map((item) => item.localId),
    );
    // Keep the previous request for inspection. Files already sent to a
    // possibly completed operation need fresh staging before another send.
    record.recovery = "previous";
    const attachments = draft.attachments.flatMap((item) => {
      if (!submittedIds.has(item.localId)) return [item];
      const file = this.stagedFiles.get(item.localId)?.file;
      if (!file && !item.recalledArtifact) return [];
      const localId = crypto.randomUUID();
      if (file) this.stage(sessionId, localId, file);
      return [
        {
          ...item,
          localId,
          previewUrl:
            file && item.previewUrl ? URL.createObjectURL(file) : undefined,
          uploadedId: undefined,
          uploadedAuthorityId: undefined,
          status: file ? ("uploading" as const) : ("ready" as const),
          error: undefined,
        },
      ];
    });
    if (attachments.length < draft.attachments.length) {
      this.host.notifyVisible(
        sessionId,
        "Re-add attachments whose original bytes are no longer in this tab.",
      );
    }
    this.host.drafts.update(sessionId, { intentId: undefined, attachments });
    this.publish();
    this.resumeUploads();
  }

  private currentDelivery(sessionId: string): DeliveryRecord | undefined {
    const { intentId } = this.host.drafts.get(sessionId);
    return intentId
      ? this.deliveries.get(intentId)
      : this.reloadedDelivery(sessionId);
  }

  restoreFailedPrompt(sessionId: string): boolean {
    const draft = this.host.drafts.get(sessionId);
    if (draft.intentId || hasDraftInput(draft)) return false;
    const record = this.deliveriesFor(sessionId, "draft")[0];
    if (!record) return false;
    this.restore(record);
    this.publish();
    this.resumeUploads();
    return true;
  }

  private restore(record: DeliveryRecord): void {
    const {
      sessionId,
      receipt: { operationId },
    } = record;
    record.handoffRevision = this.host.drafts.update(sessionId, {
      text: record.message,
      attachments: record.attachments,
      projectFiles: record.projectFiles,
      intentId: record.refused ? undefined : operationId,
    }).revision;
    if (record.refused) this.deliveries.delete(operationId);
  }

  forgetUnsupportedDeliveries(sessionId: string): void {
    if (this.storageState.get(sessionId) !== "format") return;
    this.storageState.set(sessionId, null);
    this.persist(sessionId);
    this.publish();
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
    const linked = draft.intentId
      ? this.deliveries.get(draft.intentId)
      : undefined;
    if (linked?.confirmation.pending) return false;
    this.releaseAttachments(
      draft.attachments.filter(
        (item) =>
          !linked?.attachments.some(
            (candidate) => candidate.localId === item.localId,
          ),
      ),
    );
    if (linked) linked.recovery = "previous";
    const scopeKey = composerHistoryScopeKey(scope);
    const owner = {
      viewId: scope.viewId,
      incarnation: scope.incarnation,
      effectiveLeafId: scope.effectiveLeafId,
      scopeKey,
    };
    const attachments = [
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
    this.host.drafts.update(sessionId, {
      attachments,
      projectFiles: [],
      text: entry.text,
      intentId: undefined,
    });
    if (linked) this.publish();
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
        this.stage(sessionId, item.localId, accepted[index]!),
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

  private stage(sessionId: string, localId: string, file: File): void {
    this.stagedFiles.set(localId, {
      sessionId,
      file,
      recovery: new RecoveryBackoff(),
      submitted: false,
    });
  }

  /** Keep any newer start draft and make the original input available before upload. */
  transferStart(sessionId: string, start: SessionDraft): Promise<void> {
    const current = this.host.drafts.get(null);
    const clear = current.revision === start.revision;
    const attachments = start.attachments.map((item): PendingAttachment => {
      const file = item.localFile!;
      const localId = clear ? item.localId : crypto.randomUUID();
      this.stage(sessionId, localId, file);
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
      return staged && !staged.submitted && item && !staged.upload
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
            if (
              this.stagedFiles.get(item.localId) === staged &&
              !staged.submitted
            )
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
      if (staged.submitted || item?.status !== "uploading" || staged.upload)
        continue;
      const batch = batches.get(staged.sessionId) ?? [];
      batch.push(localId);
      batches.set(staged.sessionId, batch);
    }
    for (const [sessionId, localIds] of batches)
      void this.uploadStaged(sessionId, localIds);
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
    const linked = draft.intentId
      ? this.deliveries.get(draft.intentId)
      : undefined;
    if (linked?.attachments.some((item) => item.localId === localId)) {
      linked.attachments = linked.attachments.filter(
        (item) => item.localId !== localId,
      );
      this.retireFile(target);
    } else this.releaseAttachments([target]);
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
