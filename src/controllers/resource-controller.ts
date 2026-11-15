import type { ResourceProbeResult } from "../../shared/contracts";
import {
  isEmbeddedImageReference,
  isLocalResourceReference,
  MAX_RESOURCE_PROBE_REFERENCES,
  type SessionResourceListResponse,
} from "../../shared/resource-references";
import { decodeTextPreview } from "../../shared/text-preview";
import { type Api, ApiError } from "../api";
import type { AppState } from "../app-state";
import {
  isTransientFailure,
  RecoveryBackoff,
  readScope,
} from "../recovery-backoff";
import {
  classifiedResourceFailure,
  injectHtmlPreviewCsp,
  inspectedPreview,
  MAX_MEDIA_PREVIEW_BYTES,
  NOTEBOOK_PREVIEW_BYTES,
  type ResourcePreview,
  TEXT_PREVIEW_BYTES,
  unknownResourceAvailability,
} from "../resource-preview";
import { transcriptProjectionKey } from "../transcript-projection-key";

type ResourceControllerState = Pick<
  AppState,
  | "sessionId"
  | "view"
  | "resourcesOpen"
  | "contextMode"
  | "resourceStanding"
  | "fileInspection"
  | "resourceTabs"
>;

type ResourceControllerPatch = Partial<
  Pick<
    ResourceControllerState,
    | "resourcesOpen"
    | "contextMode"
    | "fileInspection"
    | "resourceTabs"
    | "resourceStanding"
  >
>;

interface ResourceControllerHost {
  state(): ResourceControllerState;
  patch(patch: ResourceControllerPatch): void;
  api(): Api | null;
  handleAuthFailure(): void;
  saveDownload(url: string, name: string): void;
  revealWorkspacePath(workspacePath: string): void;
}

type ReadScope = ReturnType<typeof readScope>;
type ResourceRead = ReadScope & {
  api: Api;
  sessionId: string;
  viewId: string;
  revision: number;
};

/**
 * Owns one browser-facing resource lifecycle: revision-bound preflight,
 * opaque-handle preview, request cancellation, and temporary object URLs.
 * It deliberately owns no canonical app state: all reads and commits go
 * through the AppStore facade supplied by ResourceControllerHost.
 */
export class ResourceController {
  private previewObjectUrl: string | null = null;
  private resourceRequest: ReadScope | null = null;
  private documentImages = new AbortController();
  private downloads = new AbortController();
  private resourceProbeRequest: ReadScope | null = null;
  private resourceProbeKey: string | null = null;
  private probeRecovery = new RecoveryBackoff();
  private resourceProbedReferences = new Set<string>();

  constructor(private readonly host: ResourceControllerHost) {}

  cancelRequest(retainDocumentImages = false): void {
    this.resourceRequest?.abort();
    this.resourceRequest = null;
    if (!retainDocumentImages) {
      this.documentImages.abort();
      this.documentImages = new AbortController();
    }
    this.downloads.abort();
    this.downloads = new AbortController();
  }

  cancelProbes(clearStanding = false): void {
    this.probeRecovery.reset();
    this.resourceProbeRequest?.abort();
    this.resourceProbeRequest = null;
    this.resourceProbeKey = null;
    this.resourceProbedReferences.clear();
    if (clearStanding && Object.keys(this.host.state().resourceStanding).length)
      this.host.patch({ resourceStanding: {} });
  }

  /** Cancels resources without publishing an intermediate state. The caller
   * owns the encompassing session/view snapshot commit. */
  invalidate(): void {
    this.cancelRequest();
    this.cancelProbes();
    this.revokePreviewObjectUrl();
  }

  /** Retire content authority while retaining named-file navigation. A pane
   * gesture during bootstrap may persist these fields before restoration;
   * temporary empty tabs would overwrite the user's saved workbench. */
  invalidateForTransportReplacement(): void {
    this.invalidate();
    const { fileInspection, resourceTabs, resourcesOpen, contextMode } =
      this.host.state();
    this.host.patch({
      resourceStanding: {},
      resourceTabs: resourceTabs.filter(
        (tab) => !tab.reference.startsWith("pi-embedded://"),
      ),
      fileInspection: fileInspection.reference?.startsWith("pi-embedded://")
        ? { kind: "browse" }
        : fileInspection.kind === "file"
          ? {
              ...fileInspection,
              preview:
                resourcesOpen && contextMode === "files"
                  ? { status: "loading", reference: fileInspection.reference }
                  : null,
            }
          : fileInspection,
    });
  }

  private recordResolution(
    result: ResourceProbeResult,
    tabPatch?: ResourceControllerPatch,
  ): void {
    // A probe started before this resolve cannot overwrite its standing.
    const reference = result.reference;
    this.host.patch({
      ...tabPatch,
      resourceStanding: {
        ...this.host.state().resourceStanding,
        [reference]: result,
      },
    });
  }

  private viewRead(
    owns: (state: ResourceControllerState) => boolean = () => true,
    signal?: AbortSignal,
  ): ResourceRead | null {
    const api = this.host.api();
    const {
      sessionId,
      view: { viewId, incarnation, revision },
    } = this.host.state();
    if (!api || !sessionId || !viewId) return null;
    const scope = readScope(() => {
      const state = this.host.state();
      return (
        this.host.api() === api &&
        state.sessionId === sessionId &&
        state.view.viewId === viewId &&
        state.view.incarnation === incarnation &&
        owns(state)
      );
    }, signal);
    return { api, sessionId, viewId, revision, ...scope };
  }

  private authFailed(error: unknown, scope: ReadScope): boolean {
    if (
      !scope.current() ||
      !(error instanceof ApiError) ||
      error.status !== 401
    )
      return false;
    this.host.handleAuthFailure();
    return true;
  }

  /** Recent rows are a read of one selected transcript revision. */
  async loadSessionResources(
    signal?: AbortSignal,
  ): Promise<SessionResourceListResponse | null> {
    const revision = this.host.state().view.revision;
    const scope = this.viewRead(
      (state) => state.view.revision === revision,
      signal,
    );
    if (!scope) return null;
    const { api, sessionId, viewId } = scope;
    try {
      const response = await scope.read(
        (signal) => api.json("listResources", { body: { sessionId } }, signal),
        new RecoveryBackoff(),
      );
      if (
        response.sessionId === sessionId &&
        response.viewId === viewId &&
        response.revision === revision
      )
        return response;
      return null;
    } catch (error) {
      if (!scope.current() || this.authFailed(error, scope)) return null;
      throw error;
    }
  }

  /** Preflight every reference in explicitly loaded Files-pane pages. Each
   * failed batch is isolated: it never invalidates earlier verified batches,
   * and only its own references remain eligible for retry. */
  async probeResources(references: string[]): Promise<void> {
    const revision = this.host.state().view.revision;
    const request = this.viewRead((state) => state.view.revision === revision);
    if (!request) return;
    const { api, sessionId, viewId } = request;
    const unique = [...new Set(references)];
    const generationKey = JSON.stringify([sessionId, viewId, revision]);
    if (this.resourceProbeKey !== generationKey) {
      this.cancelProbes();
      this.resourceProbeKey = generationKey;
    }
    const pending = unique.filter(
      (reference) => !this.resourceProbedReferences.has(reference),
    );
    if (pending.length === 0) return;

    this.probeRecovery.cancel();
    this.resourceProbeRequest?.abort();
    this.resourceProbeRequest = request;
    let retryNeeded = false;
    try {
      for (
        let offset = 0;
        offset < pending.length;
        offset += MAX_RESOURCE_PROBE_REFERENCES
      ) {
        const batch = pending.slice(
          offset,
          offset + MAX_RESOURCE_PROBE_REFERENCES,
        );
        const before = new Map(
          batch.map((reference) => [
            reference,
            this.host.state().resourceStanding[reference],
          ]),
        );
        const stillUnchanged = (reference: string) =>
          before.get(reference) ===
          this.host.state().resourceStanding[reference];
        try {
          const response = await request.read((signal) =>
            api.json(
              "probeResources",
              { body: { sessionId, references: batch } },
              signal,
            ),
          );
          if (
            response.sessionId !== sessionId ||
            response.viewId !== viewId ||
            response.revision !== revision
          )
            return;
          const received = new Set<string>();
          const resourceStanding = { ...this.host.state().resourceStanding };
          for (const result of response.results) {
            if (
              !before.has(result.reference) ||
              received.has(result.reference) ||
              !stillUnchanged(result.reference)
            )
              continue;
            received.add(result.reference);
            resourceStanding[result.reference] = result;
          }
          for (const reference of batch) {
            if (!stillUnchanged(reference)) continue;
            if (received.has(reference)) {
              this.resourceProbedReferences.add(reference);
            } else {
              retryNeeded = true;
              if (!resourceStanding[reference])
                resourceStanding[reference] =
                  unknownResourceAvailability(reference);
            }
          }
          this.host.patch({ resourceStanding });
        } catch (error) {
          if (!request.current() || this.authFailed(error, request)) return;
          retryNeeded ||= isTransientFailure(error);
          // A failed observation cannot revoke the last confirmed file standing.
          const resourceStanding = { ...this.host.state().resourceStanding };
          for (const reference of batch) {
            if (stillUnchanged(reference) && !resourceStanding[reference])
              resourceStanding[reference] = unknownResourceAvailability(
                reference,
                error,
              );
          }
          this.host.patch({ resourceStanding });
        }
      }
      if (retryNeeded)
        this.probeRecovery.schedule(() => {
          if (this.resourceProbeKey === generationKey && request.current())
            void this.probeResources(unique);
        });
      else this.probeRecovery.reset();
    } finally {
      if (this.resourceProbeRequest === request)
        this.resourceProbeRequest = null;
    }
  }

  /** The returned lease captures the API that issued it, including cleanup
   * after a late response or a browser transport replacement. */
  async createHtmlPreview(): Promise<{ url: string; release: () => void }> {
    const api = this.host.api();
    const {
      sessionId,
      view: { viewId },
      fileInspection,
    } = this.host.state();
    const preview = inspectedPreview(fileInspection);
    if (
      !api ||
      !sessionId ||
      preview?.status !== "ready" ||
      preview.descriptor.kind !== "html" ||
      preview.text === undefined ||
      preview.refreshing ||
      preview.truncated
    )
      throw new Error(
        "Load the complete HTML file before enabling interaction",
      );
    const result = await api.json("createHtmlPreview", {
      params: { id: preview.descriptor.id },
      body: { sessionId, html: preview.text },
    });
    const release = () => {
      void api
        .json("deleteHtmlPreview", {
          params: { id: result.id },
          query: { sessionId },
        })
        .catch(() => undefined);
    };
    const current = this.host.state();
    if (
      this.host.api() !== api ||
      current.sessionId !== sessionId ||
      current.view.viewId !== viewId ||
      inspectedPreview(current.fileInspection) !== preview
    ) {
      release();
      throw new Error("The preview selection has changed");
    }
    return { url: result.url, release };
  }

  private revokePreviewObjectUrl(): void {
    if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
    this.previewObjectUrl = null;
  }

  private publishPreview(preview: ResourcePreview): void {
    const inspection = this.host.state().fileInspection;
    if (inspection.kind !== "file") return;
    this.revokePreviewObjectUrl();
    this.previewObjectUrl =
      preview.status === "ready" ? (preview.objectUrl ?? null) : null;
    this.host.patch({ fileInspection: { ...inspection, preview } });
  }

  clearSelection(keepHighlight = false): void {
    this.cancelRequest();
    this.revokePreviewObjectUrl();
    const inspection = this.host.state().fileInspection;
    if (
      inspection.kind === "browse" &&
      (keepHighlight || !inspection.reference)
    )
      return;
    this.host.patch({
      fileInspection: {
        kind: "browse",
        reference: keepHighlight ? inspection.reference : undefined,
      },
    });
  }

  private async readInlineImage(
    scope: ResourceRead,
    reference: string,
    source: "transcript" | "document",
  ): Promise<Blob> {
    const embedded =
      source === "transcript" && isEmbeddedImageReference(reference);
    const { api, sessionId, viewId } = scope;
    const descriptor = await scope.read((signal) =>
      api.json("resolveResource", { body: { sessionId, reference } }, signal),
    );
    if (
      descriptor.sessionId !== sessionId ||
      descriptor.viewId !== viewId ||
      descriptor.kind !== "image" ||
      (embedded && descriptor.reference !== reference) ||
      (source === "document" &&
        !/^image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(
          descriptor.mimeType,
        ))
    ) {
      throw new Error(
        source === "document"
          ? "The reference is not a previewable image"
          : "The image is unavailable in this conversation view",
      );
    }
    if (descriptor.size > MAX_MEDIA_PREVIEW_BYTES)
      throw new Error("The image is too large to preview");
    const content = await scope.read((signal) =>
      api.resourceContent(descriptor.id, sessionId, {
        byteLimit: MAX_MEDIA_PREVIEW_BYTES + 1,
        signal,
      }),
    );
    if (
      content.totalSize > MAX_MEDIA_PREVIEW_BYTES ||
      content.blob.size > MAX_MEDIA_PREVIEW_BYTES
    )
      throw new Error("The image is too large to preview");
    if (
      !embedded &&
      (content.blob.size !== content.totalSize ||
        content.blob.type !== descriptor.mimeType)
    )
      throw new Error("The image content is unavailable");
    return content.blob;
  }

  /** Read an image for the owning transcript without selecting the Files pane. */
  async loadTranscriptImage(
    sessionId: string,
    viewId: string,
    projectionKey: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<Blob> {
    if (!isLocalResourceReference(reference) || /^[\\/]{2}/.test(reference))
      throw new Error("The transcript image reference is unavailable");
    const scope = this.viewRead(
      (state) =>
        state.sessionId === sessionId &&
        state.view.viewId === viewId &&
        transcriptProjectionKey(state.view.viewId, state.view.incarnation) ===
          projectionKey,
      signal,
    );
    if (!scope)
      throw new DOMException(
        "The transcript image owner changed",
        "AbortError",
      );
    return this.readAuthorized(scope, (owner) =>
      this.readInlineImage(owner, reference, "transcript"),
    );
  }

  /** Both image reads and download tickets are bound to the current file. */
  private async readSelectedFile<T>(
    documentId: string,
    signal: AbortSignal,
    ownsPane: (state: ResourceControllerState) => boolean,
    perform: (owner: ResourceRead) => Promise<T>,
  ): Promise<T> {
    const scope = this.viewRead((state) => {
      const preview = inspectedPreview(state.fileInspection);
      return (
        state.resourcesOpen &&
        ownsPane(state) &&
        preview?.status === "ready" &&
        preview.descriptor.id === documentId
      );
    }, signal);
    if (!scope)
      throw new DOMException("The file selection changed", "AbortError");
    return this.readAuthorized(scope, perform);
  }

  private async readAuthorized<T>(
    scope: ResourceRead,
    perform: (owner: ResourceRead) => Promise<T>,
  ): Promise<T> {
    try {
      scope.check();
      return await perform(scope);
    } catch (error) {
      scope.check();
      this.authFailed(error, scope);
      throw error;
    }
  }

  /** A linked image needs its own resource authorization. */
  loadDocumentImage(
    documentId: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<Blob> {
    return this.readSelectedFile(
      documentId,
      AbortSignal.any([this.documentImages.signal, signal]),
      (state) => state.contextMode === "files",
      (owner) => this.readInlineImage(owner, reference, "document"),
    );
  }

  async downloadResource(): Promise<void> {
    const {
      sessionId,
      view: { viewId },
      fileInspection,
    } = this.host.state();
    const preview = inspectedPreview(fileInspection);
    if (
      !this.host.api() ||
      !sessionId ||
      !viewId ||
      preview?.status !== "ready"
    )
      return;
    const { descriptor } = preview;
    await this.readSelectedFile(
      descriptor.id,
      this.downloads.signal,
      () => true,
      async (owner) => {
        const grant = await owner.read((signal) =>
          owner.api.json(
            "resourceDownloadTicket",
            {
              params: { id: descriptor.id },
              body: { sessionId: owner.sessionId },
            },
            signal,
          ),
        );
        if (!/^[A-Za-z0-9_-]{43}$/.test(grant.ticket))
          throw new Error("The Host returned an invalid download ticket");
        this.host.saveDownload(
          `/api/resource-downloads/${grant.ticket}`,
          descriptor.name,
        );
      },
    );
  }

  /** Resolve a conversation reference through the authenticated host endpoint
   * and load its preview. Replaces any current preview and revokes its URL. */
  async openResource(
    requestedReference: string,
    contextMode: "files" | "changes" = "files",
    knownWorkspacePath?: string,
    sourceLine?: number,
  ): Promise<void> {
    const existing = this.host
      .state()
      .resourceTabs.find(
        (tab) =>
          tab.reference === requestedReference ||
          (knownWorkspacePath !== undefined &&
            tab.workspacePath === knownWorkspacePath),
      );
    const reference = existing?.reference ?? requestedReference;
    let tabReference = reference;
    const tabView = contextMode === "changes" ? "changes" : undefined;
    const request = this.viewRead(
      ({ fileInspection }) =>
        fileInspection.kind === "file" &&
        fileInspection.reference === tabReference,
    );
    if (!request) return;
    const { api, sessionId, viewId } = request;
    const previous = inspectedPreview(this.host.state().fileInspection);
    const retained =
      previous?.status === "ready" &&
      previous.reference === reference &&
      previous.descriptor.sessionId === sessionId &&
      previous.descriptor.viewId === viewId &&
      (knownWorkspacePath === undefined ||
        knownWorkspacePath === previous.descriptor.workspacePath)
        ? previous
        : null;
    this.cancelRequest(Boolean(retained));
    this.resourceRequest = request;
    if (!retained) this.revokePreviewObjectUrl();
    this.host.patch({
      resourcesOpen: true,
      contextMode: "files",
      fileInspection: {
        kind: "file",
        reference,
        workspacePath: knownWorkspacePath,
        preview: retained
          ? { ...retained, refreshing: true, refreshError: undefined }
          : { status: "loading", reference },
      },
      resourceTabs: existing
        ? this.host
            .state()
            .resourceTabs.map((tab) =>
              tab.reference === reference ? { ...tab, view: tabView } : tab,
            )
        : [
            ...this.host.state().resourceTabs,
            {
              reference,
              ...(knownWorkspacePath
                ? { workspacePath: knownWorkspacePath }
                : {}),
              ...(tabView ? { view: tabView } : {}),
            },
          ],
    });
    let descriptorResolved = false;
    const backoff = new RecoveryBackoff();
    try {
      const descriptor = await request.read(
        (signal) =>
          api.json(
            "resolveResource",
            {
              body: { sessionId, reference, workspacePath: knownWorkspacePath },
            },
            signal,
          ),
        backoff,
      );
      // Bare filename recovery intentionally returns the canonical workspace
      // reference rather than echoing the shorthand, so session/view identity
      // — not textual equality — binds this response to the request.
      if (descriptor.sessionId !== sessionId || descriptor.viewId !== viewId) {
        throw new Error("The Host returned a resource for another selection");
      }
      descriptorResolved = true;
      const workspacePath = descriptor.workspacePath;
      let tabPatch: ResourceControllerPatch | undefined;
      if (workspacePath) {
        const { resourceTabs } = this.host.state();
        const view = resourceTabs.find(
          (tab) => tab.reference === reference,
        )?.view;
        // A direct conversation link can learn its canonical path only after
        // the loading tab was opened. Reuse the earlier tab once confirmed.
        const reusable = existing?.workspacePath
          ? undefined
          : resourceTabs.find(
              (tab) =>
                tab.reference !== reference &&
                tab.workspacePath === workspacePath,
            );
        if (reusable) tabReference = reusable.reference;
        tabPatch = {
          fileInspection: {
            kind: "file",
            reference: tabReference,
            workspacePath,
            preview: reusable
              ? { status: "loading", reference: tabReference }
              : inspectedPreview(this.host.state().fileInspection),
          },
          resourceTabs: resourceTabs
            .filter((tab) => !reusable || tab.reference !== reference)
            .map((tab) =>
              tab.reference === tabReference
                ? { ...tab, workspacePath, view }
                : tab,
            ),
        };
      }
      this.recordResolution(
        {
          reference,
          availability: "available",
          ...(workspacePath ? { workspacePath } : {}),
        },
        tabPatch,
      );
      if (!request.current()) return;
      if (workspacePath && workspacePath !== knownWorkspacePath)
        this.host.revealWorkspacePath(workspacePath);
      const { kind } = descriptor;
      const ready = {
        status: "ready" as const,
        reference: tabReference,
        descriptor,
      };
      const textLike =
        kind === "text" ||
        kind === "markdown" ||
        kind === "notebook" ||
        kind === "html";
      const svg = descriptor.mimeType === "image/svg+xml";
      if (kind === "binary") {
        this.publishPreview(ready);
        return;
      }
      if (!textLike && !svg && descriptor.size > MAX_MEDIA_PREVIEW_BYTES) {
        this.publishPreview({ ...ready, contentUnavailable: "too-large" });
        return;
      }
      const textLimit =
        kind === "notebook" ? NOTEBOOK_PREVIEW_BYTES : TEXT_PREVIEW_BYTES;
      const content = await request.read(
        (signal) =>
          api.resourceContent(descriptor.id, sessionId, {
            byteLimit:
              textLike || (svg && descriptor.size > MAX_MEDIA_PREVIEW_BYTES)
                ? textLimit
                : MAX_MEDIA_PREVIEW_BYTES + 1,
            signal,
          }),
        backoff,
      );
      const { blob, totalSize } = content;
      const textBlob = textLike ? blob : svg ? blob.slice(0, textLimit) : null;
      const truncated = Boolean(textBlob && textBlob.size < totalSize);
      const text = textBlob
        ? decodeTextPreview(
            new Uint8Array(await textBlob.arrayBuffer()),
            truncated,
          )
        : undefined;
      if (!request.current()) return;
      const tooLarge =
        !textLike &&
        (totalSize > MAX_MEDIA_PREVIEW_BYTES ||
          blob.size > MAX_MEDIA_PREVIEW_BYTES);
      const html =
        kind === "html" && text !== undefined
          ? new Blob([injectHtmlPreviewCsp(text)], {
              type: "text/html;charset=utf-8",
            })
          : null;
      const objectUrl = html
        ? URL.createObjectURL(html)
        : !tooLarge && !textLike && kind !== "pdf"
          ? URL.createObjectURL(blob)
          : undefined;
      // Resolve metadata authorizes discovery only. Once bytes arrive, the
      // content response's current total is the sole size authority for both
      // the descriptor shown to the user and truncation decisions.
      this.publishPreview({
        ...ready,
        descriptor:
          totalSize === descriptor.size
            ? descriptor
            : { ...descriptor, size: totalSize },
        ...(sourceLine !== undefined
          ? { sourceJump: { line: sourceLine } }
          : {}),
        ...(textBlob ? { text, truncated: truncated || tooLarge } : {}),
        ...(tooLarge ? { contentUnavailable: "too-large" } : {}),
        ...(objectUrl ? { objectUrl } : {}),
        ...(!tooLarge && kind === "pdf" ? { pdfBlob: blob } : {}),
      });
    } catch (error) {
      if (!request.current() || this.authFailed(error, request)) return;
      const availability = descriptorResolved
        ? null
        : classifiedResourceFailure(reference, error);
      if (availability) this.recordResolution(availability);
      if (retained && isTransientFailure(error)) {
        const inspection = this.host.state().fileInspection;
        if (inspection.kind === "file")
          this.host.patch({
            fileInspection: {
              ...inspection,
              preview: {
                ...retained,
                refreshing: false,
                refreshError:
                  error instanceof Error
                    ? error.message
                    : "Preview refresh failed",
              },
            },
          });
        return;
      }
      if (
        error instanceof ApiError &&
        error.matches &&
        error.matches.length > 0
      ) {
        this.publishPreview({
          status: "ambiguous",
          reference: tabReference,
          message: error.message,
          matches: error.matches,
        });
        return;
      }
      this.publishPreview({
        status: "error",
        reference: tabReference,
        message: error instanceof Error ? error.message : "Preview failed",
      });
    } finally {
      backoff.reset();
      if (this.resourceRequest === request) this.resourceRequest = null;
    }
  }
}
