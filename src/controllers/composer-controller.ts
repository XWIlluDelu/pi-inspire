import {
  type ComposerHistoryEntry,
  MAX_ATTACHMENTS,
  MAX_PROJECT_FILES,
  type PromptAcceptedResponse,
  type PromptDeliveryRequest,
} from "../../shared/contracts";
import { type Api, ApiError } from "../api";
import { selectAttachmentFiles } from "../attachment-selection";
import {
  type ComposerHistoryScope,
  composerHistoryScopeKey,
  discardComposerHistory,
} from "../composer-history";
import { deleteSessionDraft } from "../session-drafts";

interface RecalledHistoryArtifact {
  type: "image" | "file";
  reference: string;
  fileKind?: "attachment" | "project";
  viewId: string;
  incarnation: string | null;
  effectiveLeafId: string | null;
  scopeKey: string;
  preview: boolean;
}

export interface PendingAttachment {
  localId: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  previewUrl?: string;
  status: "uploading" | "ready" | "error";
  uploadedId?: string;
  recalledArtifact?: RecalledHistoryArtifact;
  error?: string;
}

interface ComposerArtifactDraft {
  scopeKey: string;
  attachments: PendingAttachment[];
  projectFiles: string[];
}

interface PendingPromptDelivery {
  signature: string;
  request: PromptDeliveryRequest;
}

export interface ComposerPartition {
  attachments: PendingAttachment[];
  projectFiles: string[];
  sending: boolean;
  historyDraft: ComposerArtifactDraft | null;
  /** Retained only after an acceptance-unknown transport result. */
  pendingDelivery: PendingPromptDelivery | null;
}

interface ComposerControllerState {
  sessionId: string | null;
}

export type ComposerSlice = Pick<
  ComposerPartition,
  "attachments" | "projectFiles" | "sending"
>;

interface ComposerControllerHost {
  state(): ComposerControllerState;
  api(): Api | null;
  authorityId(): string | null;
  transportGeneration(): number;
  patch(slice: ComposerSlice): void;
  notify(kind: "warning", text: string): void;
  clearVisibleError(sessionId: string): void;
  failVisible(sessionId: string, message: string): void;
  handleAuthFailure(): void;
}

/**
 * Owns per-session staged attachments, project files, and prompt delivery.
 * AppStore remains the canonical browser snapshot and commits this controller's
 * visible slice only when its session owns the active composer.
 */
export class ComposerController {
  private readonly composers = new Map<string, ComposerPartition>();
  private requestEpoch = 0;

  constructor(private readonly host: ComposerControllerHost) {}

  slice(sessionId: string | null): ComposerSlice {
    const composer = sessionId ? this.composers.get(sessionId) : undefined;
    return composer
      ? {
          attachments: composer.attachments,
          projectFiles: composer.projectFiles,
          sending: composer.sending,
        }
      : { attachments: [], projectFiles: [], sending: false };
  }

  invalidateForTransportReplacement(): void {
    this.requestEpoch += 1;
    let deliveryOutcomeUnknown = false;
    for (const [sessionId, composer] of this.composers) {
      deliveryOutcomeUnknown ||= composer.sending;
      composer.sending = false;
      const invalidateUploads = (items: PendingAttachment[]) =>
        items.map((item) =>
          item.status === "uploading"
            ? {
                ...item,
                status: "error" as const,
                error:
                  "Connection changed while uploading; add this file again",
              }
            : item,
        );
      composer.attachments = invalidateUploads(composer.attachments);
      if (composer.historyDraft)
        composer.historyDraft.attachments = invalidateUploads(
          composer.historyDraft.attachments,
        );
      this.prune(sessionId, composer);
    }
    const sessionId = this.host.state().sessionId;
    if (sessionId) this.publish(sessionId);
    if (deliveryOutcomeUnknown)
      this.host.notify(
        "warning",
        "Connection changed while sending. Retry keeps the same delivery identity while this Host is unchanged; after a Host restart, check the conversation first.",
      );
  }

  discard(sessionId: string): void {
    const composer = this.composers.get(sessionId);
    if (composer) {
      this.releaseAttachments(composer.attachments);
      if (composer.historyDraft)
        this.releaseAttachments(composer.historyDraft.attachments);
      // Uploads still in flight retain this object. Emptying it makes their
      // completion path reclaim any host copy rather than resurrecting the
      // deleted partition.
      composer.attachments = [];
      composer.projectFiles = [];
      composer.sending = false;
      composer.historyDraft = null;
      composer.pendingDelivery = null;
      this.composers.delete(sessionId);
    }
    deleteSessionDraft(sessionId);
    discardComposerHistory(sessionId);
  }

  async send(
    message: string,
    behavior?: "steer" | "followUp",
  ): Promise<PromptAcceptedResponse | false> {
    const sessionId = this.host.state().sessionId;
    const api = this.host.api();
    const authorityId = this.host.authorityId();
    if (!api || !sessionId || !authorityId) return false;
    const generation = this.host.transportGeneration();
    const requestEpoch = this.requestEpoch;
    const ownsTransport = (): boolean =>
      this.host.api() === api &&
      this.host.transportGeneration() === generation &&
      this.requestEpoch === requestEpoch;
    const composer = this.forSession(sessionId);
    if (composer.sending) return false;
    if (composer.attachments.some((item) => item.status === "uploading")) {
      this.host.notify("warning", "Attachments are still uploading");
      return false;
    }
    if (composer.attachments.some((item) => item.status === "error")) {
      this.host.notify("warning", "Remove failed attachments before sending");
      return false;
    }
    const included = composer.attachments;
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
    const projectFiles = composer.projectFiles;
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
    const signature = JSON.stringify(deliveryContent);
    if (
      composer.pendingDelivery?.signature === signature &&
      composer.pendingDelivery.request.authorityId !== authorityId
    ) {
      // A restarted Host cannot answer the old operation. Fail closed once so
      // an ordinary Retry cannot turn an unknown outcome into a duplicate.
      composer.pendingDelivery = null;
      this.host.failVisible(
        sessionId,
        "The Host restarted after this message had an unknown delivery outcome. Check the conversation before sending it again.",
      );
      this.publish(sessionId);
      return false;
    }
    const retained =
      composer.pendingDelivery?.signature === signature
        ? composer.pendingDelivery
        : null;
    const delivery: PendingPromptDelivery = retained ?? {
      signature,
      request: {
        operationId: globalThis.crypto.randomUUID(),
        authorityId,
        ...deliveryContent,
      },
    };
    composer.pendingDelivery = delivery;
    composer.sending = true;
    this.publish(sessionId);
    try {
      const response = await api.prompt(delivery.request);
      if (!ownsTransport()) return false;
      // Accepted: clear exactly what was delivered, from the owner session's
      // partition — never from whichever session is visible by now.
      // Artifacts staged while the request was in flight belong to the next
      // message. Failures keep everything.
      const sentIds = new Set(included.map((item) => item.localId));
      const sentPaths = new Set(projectFiles);
      for (const item of composer.attachments) {
        if (!sentIds.has(item.localId)) continue;
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      composer.attachments = composer.attachments.filter(
        (item) => !sentIds.has(item.localId),
      );
      composer.projectFiles = composer.projectFiles.filter(
        (path) => !sentPaths.has(path),
      );
      this.releaseHistoryDraft(composer);
      composer.pendingDelivery = null;
      this.host.clearVisibleError(sessionId);
      return {
        accepted: true,
        historyEntry: response.historyEntry,
      };
    } catch (error) {
      if (!ownsTransport()) return false;
      this.commitHistoryDraft(composer);
      const acceptanceUnknown =
        !(error instanceof ApiError) ||
        error.edge === "ssh-reverse" ||
        ((error.status === 408 || error.status >= 500) &&
          error.authorityId !== authorityId);
      if (error instanceof ApiError && !acceptanceUnknown) {
        // An application response is a definitive refusal. Reusing its
        // operation is unnecessary; a changed Host also cannot resolve it.
        composer.pendingDelivery = null;
        if (error.status === 401) {
          composer.sending = false;
          this.host.handleAuthFailure();
          return false;
        }
      }
      // Keep failures attached to the session that sent the prompt. Transport,
      // marked-edge, and unowned timeout/5xx failures retain the operation so
      // an unchanged Host can answer a retry without delivering twice.
      this.host.failVisible(
        sessionId,
        acceptanceUnknown
          ? "INSΠRE could not confirm whether Pi accepted this message. Retry sends the same delivery safely while this Host remains running."
          : error instanceof Error
            ? error.message
            : "Failed to send",
      );
      return false;
    } finally {
      if (ownsTransport()) {
        composer.sending = false;
        this.prune(sessionId, composer);
        this.publish(sessionId);
      }
    }
  }

  previewHistoryEntry(
    scope: ComposerHistoryScope,
    entry: ComposerHistoryEntry | null,
  ): void {
    if (this.host.state().sessionId !== scope.sessionId) return;
    const composer = this.forSession(scope.sessionId);
    if (composer.sending) return;
    if (!entry) {
      this.restoreHistoryDraft(composer);
      this.prune(scope.sessionId, composer);
      this.publish(scope.sessionId);
      return;
    }

    const scopeKey = composerHistoryScopeKey(scope);
    if (composer.historyDraft?.scopeKey !== scopeKey) {
      this.restoreHistoryDraft(composer);
      composer.historyDraft = {
        scopeKey,
        attachments: composer.attachments,
        projectFiles: composer.projectFiles,
      };
    } else {
      this.releaseAttachments(
        composer.attachments.filter((item) => !item.recalledArtifact),
      );
    }
    composer.projectFiles = [];
    const owner = {
      viewId: scope.viewId,
      incarnation: scope.incarnation,
      effectiveLeafId: scope.effectiveLeafId,
      scopeKey,
      preview: true,
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
    this.publish(scope.sessionId);
  }

  commitHistoryPreview(scope: ComposerHistoryScope): void {
    const composer = this.composers.get(scope.sessionId);
    if (!composer || composer.sending) return;
    const scopeKey = composerHistoryScopeKey(scope);
    if (composer.historyDraft?.scopeKey !== scopeKey) return;
    this.commitHistoryDraft(composer);
    this.publish(scope.sessionId);
  }

  cancelHistoryPreview(sessionId: string): void {
    const composer = this.composers.get(sessionId);
    if (!composer || composer.sending) return;
    this.restoreHistoryDraft(composer);
    this.prune(sessionId, composer);
    this.publish(sessionId);
  }

  async addFiles(files: File[]): Promise<void> {
    const sessionId = this.host.state().sessionId;
    const api = this.host.api();
    if (!api || !sessionId || files.length === 0) return;
    const generation = this.host.transportGeneration();
    const requestEpoch = this.requestEpoch;
    const ownsTransport = (): boolean =>
      this.host.api() === api &&
      this.host.transportGeneration() === generation &&
      this.requestEpoch === requestEpoch;
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
      const isImage = /^image\//i.test(file.type);
      return {
        localId: crypto.randomUUID(),
        fileName: file.name || "pasted-image",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind: isImage ? "image" : "file",
        previewUrl: isImage ? URL.createObjectURL(file) : undefined,
        status: "uploading",
      };
    });
    composer.attachments = [...composer.attachments, ...pending];
    this.publish(sessionId);

    try {
      const { attachments: uploaded } = await api.uploadAttachments(accepted);
      if (!ownsTransport()) {
        await Promise.all(
          uploaded.map((item) =>
            api.deleteAttachment(item.id).catch(() => undefined),
          ),
        );
        return;
      }
      if (uploaded.length !== pending.length) {
        await Promise.all(
          uploaded.map((item) =>
            api.deleteAttachment(item.id).catch(() => undefined),
          ),
        );
        throw new Error("The Host returned an invalid attachment upload");
      }
      const applyUploaded = (items: PendingAttachment[]) =>
        items.map((item) => {
          const index = pending.findIndex(
            (candidate) => candidate.localId === item.localId,
          );
          const result = index >= 0 ? uploaded[index] : undefined;
          return result
            ? {
                ...item,
                status: "ready" as const,
                uploadedId: result.id,
                fileName: result.fileName,
                kind: result.kind,
              }
            : item;
        });
      composer.attachments = applyUploaded(composer.attachments);
      if (composer.historyDraft)
        composer.historyDraft.attachments = applyUploaded(
          composer.historyDraft.attachments,
        );
      this.publish(sessionId);
      // An item removed while its upload was in flight never got a chance to
      // delete its host copy; reclaim it now.
      pending.forEach((candidate, index) => {
        const id = uploaded[index]?.id;
        if (
          id &&
          !composer.attachments.some(
            (item) => item.localId === candidate.localId,
          ) &&
          !composer.historyDraft?.attachments.some(
            (item) => item.localId === candidate.localId,
          )
        ) {
          void api.deleteAttachment(id).catch(() => undefined);
        }
      });
    } catch (error) {
      if (!ownsTransport()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return;
      }
      const message = error instanceof Error ? error.message : "Upload failed";
      const failPending = (items: PendingAttachment[]) =>
        items.map((item) =>
          pending.some((candidate) => candidate.localId === item.localId)
            ? { ...item, status: "error" as const, error: message }
            : item,
        );
      composer.attachments = failPending(composer.attachments);
      if (composer.historyDraft)
        composer.historyDraft.attachments = failPending(
          composer.historyDraft.attachments,
        );
      this.publish(sessionId);
    }
  }

  removeAttachment(localId: string): void {
    const sessionId = this.host.state().sessionId;
    if (!sessionId) return;
    const composer = this.composers.get(sessionId);
    if (!composer || composer.sending) return;
    // Frozen while a prompt is delivering: the host may be resolving these
    // very files into the outgoing message.
    const target = composer.attachments.find(
      (item) => item.localId === localId,
    );
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
    if (composer.sending || composer.projectFiles.includes(path)) return;
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
    composer.projectFiles = [...composer.projectFiles, path];
    this.publish(sessionId);
  }

  removeProjectFile(path: string): void {
    const sessionId = this.host.state().sessionId;
    if (!sessionId) return;
    const composer = this.composers.get(sessionId);
    if (!composer || composer.sending) return;
    // Frozen while delivering: a sent path removed and re-added mid-flight
    // would otherwise be swept by the delivery's scoped clear.
    composer.projectFiles = composer.projectFiles.filter(
      (item) => item !== path,
    );
    this.prune(sessionId, composer);
    this.publish(sessionId);
  }

  private releaseAttachments(items: readonly PendingAttachment[]): void {
    for (const attachment of items) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      if (attachment.uploadedId) {
        void this.host
          .api()
          ?.deleteAttachment(attachment.uploadedId)
          .catch(() => undefined);
      }
    }
  }

  private releaseHistoryDraft(composer: ComposerPartition): void {
    if (!composer.historyDraft) return;
    this.releaseAttachments(composer.historyDraft.attachments);
    composer.historyDraft = null;
  }

  private restoreHistoryDraft(composer: ComposerPartition): void {
    const draft = composer.historyDraft;
    if (!draft) return;
    this.releaseAttachments(
      composer.attachments.filter((item) => !item.recalledArtifact),
    );
    composer.attachments = draft.attachments;
    composer.projectFiles = draft.projectFiles;
    composer.historyDraft = null;
  }

  private commitHistoryDraft(composer: ComposerPartition): void {
    if (!composer.historyDraft) return;
    this.releaseHistoryDraft(composer);
    composer.attachments = composer.attachments.map((item) =>
      item.recalledArtifact?.preview
        ? {
            ...item,
            recalledArtifact: { ...item.recalledArtifact, preview: false },
          }
        : item,
    );
  }

  private forSession(sessionId: string): ComposerPartition {
    let composer = this.composers.get(sessionId);
    if (!composer) {
      composer = {
        attachments: [],
        projectFiles: [],
        sending: false,
        historyDraft: null,
        pendingDelivery: null,
      };
      this.composers.set(sessionId, composer);
    }
    return composer;
  }

  private prune(sessionId: string, composer: ComposerPartition): void {
    if (
      !composer.sending &&
      !composer.historyDraft &&
      !composer.pendingDelivery &&
      composer.attachments.length === 0 &&
      composer.projectFiles.length === 0
    ) {
      this.composers.delete(sessionId);
    }
  }

  private publish(sessionId: string): void {
    if (this.host.state().sessionId !== sessionId) return;
    this.host.patch(this.slice(sessionId));
  }
}
