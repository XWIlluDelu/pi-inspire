import { MAX_PROJECT_FILES } from "../../shared/contracts";
import { selectAttachmentFiles } from "../attachment-selection";
import type { Api } from "../api";
import { deleteSessionDraft } from "../session-drafts";

export interface PendingAttachment {
  localId: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  previewUrl?: string;
  status: "uploading" | "ready" | "error";
  uploadedId?: string;
  error?: string;
}

export interface ComposerPartition {
  attachments: PendingAttachment[];
  projectFiles: string[];
  sending: boolean;
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
  transportGeneration(): number;
  patch(slice: ComposerSlice): void;
  notify(kind: "warning", text: string): void;
  clearVisibleError(sessionId: string): void;
  failVisible(sessionId: string, message: string): void;
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
    for (const [sessionId, composer] of this.composers) {
      composer.sending = false;
      composer.attachments = composer.attachments.map((item) =>
        item.status === "uploading"
          ? {
              ...item,
              status: "error",
              error: "Connection changed while uploading; add this file again",
            }
          : item,
      );
      this.prune(sessionId, composer);
    }
    const sessionId = this.host.state().sessionId;
    if (sessionId) this.publish(sessionId);
  }

  discard(sessionId: string): void {
    const composer = this.composers.get(sessionId);
    if (composer) {
      for (const attachment of composer.attachments) {
        if (
          attachment.previewUrl &&
          typeof URL.revokeObjectURL === "function"
        ) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        if (attachment.uploadedId) {
          void this.host
            .api()
            ?.deleteAttachment(attachment.uploadedId)
            .catch(() => undefined);
        }
      }
      // Uploads still in flight retain this object. Emptying it makes their
      // completion path reclaim any host copy rather than resurrecting the
      // deleted partition.
      composer.attachments = [];
      composer.projectFiles = [];
      composer.sending = false;
      this.composers.delete(sessionId);
    }
    deleteSessionDraft(sessionId);
  }

  async send(
    message: string,
    behavior?: "steer" | "followUp",
  ): Promise<boolean> {
    const sessionId = this.host.state().sessionId;
    const api = this.host.api();
    if (!api || !sessionId) return false;
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
    const attachmentIds = included
      .map((item) => item.uploadedId)
      .filter((id): id is string => Boolean(id));
    const projectFiles = composer.projectFiles;
    if (
      !message.trim() &&
      attachmentIds.length === 0 &&
      projectFiles.length === 0
    ) {
      return false;
    }
    composer.sending = true;
    this.publish(sessionId);
    try {
      await api.prompt({
        sessionId,
        message,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(projectFiles.length > 0 ? { projectFiles } : {}),
        behavior,
      });
      if (!ownsTransport()) return false;
      // Accepted: clear exactly what was delivered, from the owner session's
      // partition — never from whichever session is visible by now.
      // Artifacts staged while the request was in flight belong to the next
      // message. Failures keep everything.
      const sentIds = new Set(included.map((item) => item.localId));
      const sentPaths = new Set(projectFiles);
      for (const item of composer.attachments) {
        if (!sentIds.has(item.localId)) continue;
        if (item.previewUrl && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
      composer.attachments = composer.attachments.filter(
        (item) => !sentIds.has(item.localId),
      );
      composer.projectFiles = composer.projectFiles.filter(
        (path) => !sentPaths.has(path),
      );
      this.host.clearVisibleError(sessionId);
      return true;
    } catch (error) {
      if (!ownsTransport()) return false;
      // Keep failures attached to the session that sent the prompt. A switch
      // before the HTTP result arrives must not overwrite the new session's
      // visible error.
      this.host.failVisible(
        sessionId,
        error instanceof Error ? error.message : "Failed to send",
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
      composer.attachments,
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
        previewUrl:
          isImage && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(file)
            : undefined,
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
      composer.attachments = composer.attachments.map((item) => {
        const index = pending.findIndex(
          (candidate) => candidate.localId === item.localId,
        );
        const result = index >= 0 ? uploaded[index] : undefined;
        return result
          ? {
              ...item,
              status: "ready",
              uploadedId: result.id,
              fileName: result.fileName,
              kind: result.kind,
            }
          : item;
      });
      this.publish(sessionId);
      // An item removed while its upload was in flight never got a chance to
      // delete its host copy; reclaim it now.
      pending.forEach((candidate, index) => {
        const id = uploaded[index]?.id;
        if (
          id &&
          !composer.attachments.some(
            (item) => item.localId === candidate.localId,
          )
        ) {
          void api.deleteAttachment(id).catch(() => undefined);
        }
      });
    } catch (error) {
      if (!ownsTransport()) return;
      const message = error instanceof Error ? error.message : "Upload failed";
      composer.attachments = composer.attachments.map((item) =>
        pending.some((candidate) => candidate.localId === item.localId)
          ? { ...item, status: "error", error: message }
          : item,
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
    if (target?.previewUrl && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(target.previewUrl);
    }
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
    if (composer.projectFiles.length >= MAX_PROJECT_FILES) {
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

  private forSession(sessionId: string): ComposerPartition {
    let composer = this.composers.get(sessionId);
    if (!composer) {
      composer = { attachments: [], projectFiles: [], sending: false };
      this.composers.set(sessionId, composer);
    }
    return composer;
  }

  private prune(sessionId: string, composer: ComposerPartition): void {
    if (
      !composer.sending &&
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
