import { COMPOSER_HISTORY_IMAGE_REFERENCE } from "../../shared/composer-artifact-references";
import type { ResourceProbeResult } from "../../shared/contracts";
import {
  MAX_RESOURCE_PROBE_REFERENCES,
  type SessionResourceListResponse,
} from "../../shared/resource-references";
import { decodeTextPreview } from "../../shared/text-preview";
import { type Api, ApiError } from "../api";
import { isTransientFailure, RecoveryBackoff } from "../recovery-backoff";
import {
  classifiedResourceFailure,
  injectHtmlPreviewCsp,
  MAX_MEDIA_PREVIEW_BYTES,
  NOTEBOOK_PREVIEW_BYTES,
  type ResourceFileTab,
  type ResourcePreview,
  TEXT_PREVIEW_BYTES,
  unknownResourceAvailability,
} from "../resource-preview";
import { transcriptProjectionKey } from "../transcript-projection-key";

interface ResourceControllerState {
  sessionId: string | null;
  transcriptViewId: string | null;
  transcriptIncarnation: string | null;
  transcriptRevision: number;
  resourcesOpen: boolean;
  contextMode: "files" | "changes" | "branches" | "terminal";
  fileBrowserView: "browse" | "preview";
  selectedResourceReference: string | null;
  selectedResourceWorkspacePath: string | null;
  resourcePreview: ResourcePreview | null;
  resourceTabs: ResourceFileTab[];
  resourceAvailability: Record<string, ResourceProbeResult>;
  resourceWorkspacePaths: Record<string, string>;
}

/** Resource-owned state only. AppStore retains cross-domain transactions; a
 * resource opening asks its host to prepare the Git surface without knowing
 * its fields or request implementation. */
interface ResourceControllerPatch {
  resourcesOpen?: boolean;
  contextMode?: "files" | "changes" | "branches" | "terminal";
  fileBrowserView?: "browse" | "preview";
  selectedResourceReference?: string | null;
  selectedResourceWorkspacePath?: string | null;
  resourcePreview?: ResourcePreview | null;
  resourceTabs?: ResourceFileTab[];
  resourceAvailability?: Record<string, ResourceProbeResult>;
  resourceWorkspacePaths?: Record<string, string>;
}

function applyProbeResult(
  result: ResourceProbeResult,
  availability: Record<string, ResourceProbeResult>,
  workspacePaths: Record<string, string>,
): void {
  if (result.availability === "available") {
    delete availability[result.reference];
    if (result.workspacePath)
      workspacePaths[result.reference] = result.workspacePath;
    else delete workspacePaths[result.reference];
  } else {
    availability[result.reference] = result;
    delete workspacePaths[result.reference];
  }
}

interface ResourceControllerHost {
  state(): ResourceControllerState;
  patch(patch: ResourceControllerPatch): void;
  api(): Api | null;
  /** A resource request belongs to one browser transport/API generation, not
   * merely to a session/view/revision projection. */
  transportGeneration(): number;
  handleAuthFailure(): void;
  saveDownload(url: string, name: string): void;
  prepareGitForResourceOpen(contextMode: "files" | "changes"): () => boolean;
  selectWorkspacePath(workspacePath: string, reveal?: boolean): void;
}

/**
 * Owns one browser-facing resource lifecycle: revision-bound preflight,
 * opaque-handle preview, request cancellation, and temporary object URLs.
 * It deliberately owns no canonical app state: all reads and commits go
 * through the AppStore facade supplied by ResourceControllerHost.
 */
export class ResourceController {
  private previewObjectUrl: string | null = null;
  private resourceRequest: AbortController | null = null;
  private documentImageRequests = new Set<AbortController>();
  private downloadRequests = new Set<AbortController>();
  private resourceProbeRequest: AbortController | null = null;
  private resourceProbeKey: string | null = null;
  private probeRecovery = new RecoveryBackoff();
  private resourceProbedReferences = new Set<string>();
  private referenceGenerations = new Map<string, number>();

  constructor(private readonly host: ResourceControllerHost) {}

  cancelRequest(retainDocumentImages = false): void {
    this.resourceRequest?.abort();
    this.resourceRequest = null;
    if (!retainDocumentImages) {
      for (const request of this.documentImageRequests) request.abort();
      this.documentImageRequests.clear();
    }
    for (const request of this.downloadRequests) request.abort();
    this.downloadRequests.clear();
  }

  cancelProbes(clearStanding = false): void {
    this.probeRecovery.reset();
    this.resourceProbeRequest?.abort();
    this.resourceProbeRequest = null;
    this.resourceProbeKey = null;
    this.resourceProbedReferences.clear();
    this.referenceGenerations.clear();
    if (
      clearStanding &&
      (Object.keys(this.host.state().resourceAvailability).length > 0 ||
        Object.keys(this.host.state().resourceWorkspacePaths).length > 0)
    ) {
      this.host.patch({
        resourceAvailability: {},
        resourceWorkspacePaths: {},
      });
    }
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
    this.cancelRequest();
    this.cancelProbes(true);
    this.revokePreviewObjectUrl();
    const state = this.host.state();
    const reference = state.selectedResourceReference;
    const positional = reference?.startsWith("pi-embedded://");
    this.host.patch({
      resourceTabs: state.resourceTabs.filter(
        (tab) => !tab.reference.startsWith("pi-embedded://"),
      ),
      ...(positional
        ? {
            selectedResourceReference: null,
            selectedResourceWorkspacePath: null,
            fileBrowserView: "browse",
          }
        : {}),
      resourcePreview:
        !positional &&
        reference &&
        state.resourcesOpen &&
        state.contextMode === "files" &&
        state.fileBrowserView === "preview"
          ? { status: "loading", reference }
          : null,
    });
  }

  private ownsTransport(api: Api, generation: number): boolean {
    return (
      this.host.api() === api && this.host.transportGeneration() === generation
    );
  }

  private referenceGeneration(reference: string): number {
    return this.referenceGenerations.get(reference) ?? 0;
  }

  private advanceReferenceGeneration(reference: string): void {
    this.referenceGenerations.set(
      reference,
      this.referenceGeneration(reference) + 1,
    );
  }

  private recordAvailability(result: ResourceProbeResult): void {
    const state = this.host.state();
    const resourceAvailability = { ...state.resourceAvailability };
    const resourceWorkspacePaths = { ...state.resourceWorkspacePaths };
    applyProbeResult(result, resourceAvailability, resourceWorkspacePaths);
    this.host.patch({ resourceAvailability, resourceWorkspacePaths });
  }

  /** Load one bounded page from the reference projection for the currently
   * visible branch revision. The host returns labels and references only. */
  async loadSessionResources(
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<SessionResourceListResponse | null> {
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const {
      sessionId,
      transcriptViewId: viewId,
      transcriptRevision: revision,
    } = this.host.state();
    if (!api || !sessionId || !viewId) return null;
    try {
      const response = await api.listResources(sessionId, options);
      const current = this.host.state();
      if (
        !this.ownsTransport(api, transportGeneration) ||
        options.signal?.aborted ||
        current.sessionId !== sessionId ||
        current.transcriptViewId !== viewId ||
        current.transcriptRevision !== revision ||
        response.sessionId !== sessionId ||
        response.viewId !== viewId ||
        response.revision !== revision
      )
        return null;
      return response;
    } catch (error) {
      if (!this.ownsTransport(api, transportGeneration)) return null;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return null;
      }
      throw error;
    }
  }

  /** Preflight every reference in explicitly loaded Files-pane pages. Each
   * failed batch is isolated: it never invalidates earlier verified batches,
   * and only its own references remain eligible for retry. */
  async probeResources(references: string[]): Promise<void> {
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const {
      sessionId,
      transcriptViewId: viewId,
      transcriptRevision: revision,
    } = this.host.state();
    if (!api || !sessionId || !viewId) return;
    const unique = [...new Set(references)];
    const generationKey = JSON.stringify([sessionId, viewId, revision]);
    if (this.resourceProbeKey !== generationKey) {
      this.cancelProbes();
      this.resourceProbeKey = generationKey;
    }
    if (unique.length === 0) return;
    const pending = unique.filter(
      (reference) => !this.resourceProbedReferences.has(reference),
    );
    if (pending.length === 0) return;

    this.probeRecovery.cancel();
    this.resourceProbeRequest?.abort();
    const request = new AbortController();
    this.resourceProbeRequest = request;
    const stale = (): boolean => {
      const current = this.host.state();
      return (
        this.resourceProbeRequest !== request ||
        request.signal.aborted ||
        !this.ownsTransport(api, transportGeneration) ||
        current.sessionId !== sessionId ||
        current.transcriptViewId !== viewId ||
        current.transcriptRevision !== revision
      );
    };
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
        const generations = new Map(
          batch.map((reference) => [
            reference,
            this.referenceGeneration(reference),
          ]),
        );
        const generationIsCurrent = (reference: string): boolean =>
          generations.get(reference) === this.referenceGeneration(reference);
        try {
          const response = await api.probeResources(
            sessionId,
            batch,
            request.signal,
          );
          if (
            stale() ||
            response.sessionId !== sessionId ||
            response.viewId !== viewId ||
            response.revision !== revision
          )
            return;
          const expected = new Set(batch);
          const received = new Set<string>();
          const current = this.host.state();
          const resourceAvailability = { ...current.resourceAvailability };
          const resourceWorkspacePaths = {
            ...current.resourceWorkspacePaths,
          };
          for (const result of response.results) {
            if (
              !expected.has(result.reference) ||
              received.has(result.reference) ||
              !generationIsCurrent(result.reference)
            )
              continue;
            received.add(result.reference);
            applyProbeResult(
              result,
              resourceAvailability,
              resourceWorkspacePaths,
            );
          }
          for (const reference of batch) {
            if (!generationIsCurrent(reference)) continue;
            if (received.has(reference)) {
              this.resourceProbedReferences.add(reference);
            } else {
              retryNeeded = true;
              if (!resourceAvailability[reference])
                resourceAvailability[reference] =
                  unknownResourceAvailability(reference);
            }
          }
          this.host.patch({
            resourceAvailability,
            resourceWorkspacePaths,
          });
        } catch (error) {
          if (stale()) return;
          if (error instanceof ApiError && error.status === 401) {
            this.host.handleAuthFailure();
            return;
          }
          retryNeeded ||= isTransientFailure(error);
          // A failed observation cannot revoke the last confirmed file standing.
          const resourceAvailability = {
            ...this.host.state().resourceAvailability,
          };
          for (const reference of batch) {
            if (
              generationIsCurrent(reference) &&
              !resourceAvailability[reference]
            )
              resourceAvailability[reference] = unknownResourceAvailability(
                reference,
                error,
              );
          }
          this.host.patch({ resourceAvailability });
        }
      }
      if (retryNeeded)
        this.probeRecovery.schedule(() => {
          if (
            this.resourceProbeKey === generationKey &&
            this.ownsTransport(api, transportGeneration)
          )
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
    const generation = this.host.transportGeneration();
    const {
      sessionId,
      transcriptViewId,
      resourcePreview: preview,
    } = this.host.state();
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
    const result = await api.createHtmlPreview(
      preview.descriptor.id,
      sessionId,
      preview.text,
    );
    const release = () => {
      void api.deleteHtmlPreview(result.id, sessionId).catch(() => undefined);
    };
    const current = this.host.state();
    if (
      !this.ownsTransport(api, generation) ||
      current.sessionId !== sessionId ||
      current.transcriptViewId !== transcriptViewId ||
      current.resourcePreview !== preview
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
    this.revokePreviewObjectUrl();
    this.previewObjectUrl =
      preview.status === "ready" ? (preview.objectUrl ?? null) : null;
    this.host.patch({ resourcePreview: preview });
  }

  clearSelection(): void {
    this.cancelRequest();
    this.revokePreviewObjectUrl();
    const {
      selectedResourceReference,
      selectedResourceWorkspacePath,
      resourcePreview,
      fileBrowserView,
    } = this.host.state();
    if (
      selectedResourceReference === null &&
      selectedResourceWorkspacePath === null &&
      resourcePreview === null &&
      fileBrowserView === "browse"
    )
      return;
    this.host.patch({
      selectedResourceReference: null,
      selectedResourceWorkspacePath: null,
      resourcePreview: null,
      fileBrowserView: "browse",
    });
  }

  /** Load one Pi-persisted embedded image without selecting the Files pane.
   * Session, branch view, and projection incarnation are rechecked across both
   * authenticated requests so a late thumbnail cannot cross a rewrite. */
  async loadEmbeddedImage(
    sessionId: string,
    viewId: string,
    projectionKey: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<Blob> {
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    if (!api || !COMPOSER_HISTORY_IMAGE_REFERENCE.test(reference)) {
      throw new Error("The embedded image reference is invalid");
    }
    const stale = () => {
      const current = this.host.state();
      return (
        signal.aborted ||
        !this.ownsTransport(api, transportGeneration) ||
        current.sessionId !== sessionId ||
        current.transcriptViewId !== viewId ||
        transcriptProjectionKey(
          current.transcriptViewId,
          current.transcriptIncarnation,
        ) !== projectionKey
      );
    };
    const staleError = () =>
      Object.assign(new Error("The image request is no longer current"), {
        name: "AbortError",
      });
    try {
      const descriptor = await api.resolveResource(
        sessionId,
        reference,
        signal,
      );
      if (stale()) throw staleError();
      if (
        descriptor.sessionId !== sessionId ||
        descriptor.reference !== reference ||
        descriptor.kind !== "image" ||
        descriptor.viewId !== viewId
      ) {
        throw new Error(
          "The embedded image is unavailable in this conversation view",
        );
      }
      if (descriptor.size > MAX_MEDIA_PREVIEW_BYTES)
        throw new Error("The image is too large to preview");
      const content = await api.resourceContent(descriptor.id, sessionId, {
        byteLimit: MAX_MEDIA_PREVIEW_BYTES + 1,
        signal,
      });
      if (stale()) throw staleError();
      if (
        content.totalSize > MAX_MEDIA_PREVIEW_BYTES ||
        content.blob.size > MAX_MEDIA_PREVIEW_BYTES
      ) {
        throw new Error("The image is too large to preview");
      }
      return content.blob;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        this.ownsTransport(api, transportGeneration)
      ) {
        this.host.handleAuthFailure();
        throw error;
      }
      if (stale()) throw staleError();
      throw error;
    }
  }

  /** A document image is independently authorized by the ordinary resource
   * resolver. Reading a document grants no authority over its linked files. */
  async loadDocumentImage(
    documentId: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<Blob> {
    const api = this.host.api();
    const generation = this.host.transportGeneration();
    const { sessionId, transcriptViewId: viewId } = this.host.state();
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) request.abort();
    this.documentImageRequests.add(request);
    const checkCurrent = () => {
      const state = this.host.state();
      if (
        !api ||
        !sessionId ||
        !viewId ||
        request.signal.aborted ||
        !this.ownsTransport(api, generation) ||
        state.sessionId !== sessionId ||
        state.transcriptViewId !== viewId ||
        !state.resourcesOpen ||
        state.contextMode !== "files" ||
        state.fileBrowserView !== "preview" ||
        state.resourcePreview?.status !== "ready" ||
        state.resourcePreview.descriptor.id !== documentId
      )
        throw Object.assign(
          new Error("The document preview is no longer current"),
          { name: "AbortError" },
        );
    };
    try {
      checkCurrent();
      const descriptor = await api!.resolveResource(
        sessionId!,
        reference,
        request.signal,
      );
      checkCurrent();
      if (
        descriptor.sessionId !== sessionId ||
        descriptor.viewId !== viewId ||
        descriptor.kind !== "image" ||
        !/^image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(
          descriptor.mimeType,
        )
      )
        throw new Error("The reference is not a previewable image");
      if (descriptor.size > MAX_MEDIA_PREVIEW_BYTES)
        throw new Error("The image is too large to preview");
      const content = await api!.resourceContent(descriptor.id, sessionId!, {
        byteLimit: MAX_MEDIA_PREVIEW_BYTES + 1,
        signal: request.signal,
      });
      checkCurrent();
      if (
        content.totalSize > MAX_MEDIA_PREVIEW_BYTES ||
        content.blob.size > MAX_MEDIA_PREVIEW_BYTES
      )
        throw new Error("The image is too large to preview");
      if (
        content.blob.size !== content.totalSize ||
        content.blob.type !== descriptor.mimeType
      )
        throw new Error("The image content is unavailable");
      return content.blob;
    } catch (error) {
      checkCurrent();
      if (error instanceof ApiError && error.status === 401)
        this.host.handleAuthFailure();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      this.documentImageRequests.delete(request);
    }
  }

  /** Mint a single-file capability only while the selected preview still owns
   * the session/view/transport. The browser streams the complete original file. */
  async downloadResource(): Promise<void> {
    const api = this.host.api();
    const generation = this.host.transportGeneration();
    const {
      sessionId,
      transcriptViewId: viewId,
      resourcePreview: preview,
    } = this.host.state();
    if (!api || !sessionId || !viewId || preview?.status !== "ready") return;
    const { descriptor } = preview;
    const request = new AbortController();
    this.downloadRequests.add(request);
    const checkCurrent = () => {
      const state = this.host.state();
      if (
        request.signal.aborted ||
        !this.ownsTransport(api, generation) ||
        state.sessionId !== sessionId ||
        state.transcriptViewId !== viewId ||
        !state.resourcesOpen ||
        state.fileBrowserView !== "preview" ||
        state.resourcePreview?.status !== "ready" ||
        state.resourcePreview.descriptor.id !== descriptor.id
      )
        throw Object.assign(new Error("The file selection changed"), {
          name: "AbortError",
        });
    };
    try {
      checkCurrent();
      const grant = await api.resourceDownloadTicket(
        descriptor.id,
        sessionId,
        request.signal,
      );
      checkCurrent();
      if (!/^[A-Za-z0-9_-]{43}$/.test(grant.ticket))
        throw new Error("The Host returned an invalid download ticket");
      this.host.saveDownload(
        `/api/resource-downloads/${grant.ticket}`,
        descriptor.name,
      );
    } catch (error) {
      checkCurrent();
      if (error instanceof ApiError && error.status === 401)
        this.host.handleAuthFailure();
      throw error;
    } finally {
      this.downloadRequests.delete(request);
    }
  }

  /** Resolve a conversation reference through the authenticated host endpoint
   * and load its preview. Replaces any current preview and revokes its URL. */
  async openResource(
    reference: string,
    contextMode: "files" | "changes" = "files",
    knownWorkspacePath?: string,
  ): Promise<void> {
    const existing = this.host
      .state()
      .resourceTabs.find(
        (tab) =>
          tab.reference === reference ||
          (knownWorkspacePath !== undefined &&
            tab.workspacePath === knownWorkspacePath),
      );
    if (existing) reference = existing.reference;
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const {
      sessionId,
      transcriptViewId: viewId,
      resourcePreview: previous,
    } = this.host.state();
    if (!api || !sessionId || !viewId) return;
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
    const ownsWorkspaceSelection =
      this.host.prepareGitForResourceOpen(contextMode);
    const request = new AbortController();
    this.resourceRequest = request;
    if (!retained) this.revokePreviewObjectUrl();
    this.host.patch({
      resourcesOpen: true,
      contextMode: "files",
      fileBrowserView: "preview",
      selectedResourceReference: reference,
      selectedResourceWorkspacePath: knownWorkspacePath ?? null,
      resourceTabs: existing
        ? this.host.state().resourceTabs.map((tab) =>
            tab.reference === reference
              ? {
                  ...tab,
                  view: contextMode === "changes" ? "changes" : undefined,
                }
              : tab,
          )
        : [
            ...this.host.state().resourceTabs,
            {
              reference,
              ...(knownWorkspacePath
                ? { workspacePath: knownWorkspacePath }
                : {}),
              ...(contextMode === "changes"
                ? { view: "changes" as const }
                : {}),
            },
          ],
      resourcePreview: retained
        ? { ...retained, refreshing: true, refreshError: undefined }
        : { status: "loading", reference },
    });
    let descriptorResolved = false;
    const stale = () => {
      const current = this.host.state();
      return (
        this.resourceRequest !== request ||
        request.signal.aborted ||
        !this.ownsTransport(api, transportGeneration) ||
        current.selectedResourceReference !== reference ||
        current.sessionId !== sessionId ||
        current.transcriptViewId !== viewId
      );
    };
    const backoff = new RecoveryBackoff();
    // Retry transport reads, not validation failures or interactive HTML.
    const read = async <T>(perform: () => Promise<T>): Promise<T> => {
      while (!stale()) {
        try {
          return await perform();
        } catch (error) {
          if (
            !isTransientFailure(error) ||
            stale() ||
            !(await backoff.wait(request.signal))
          )
            throw error;
        }
      }
      throw Object.assign(new Error("The preview selection changed"), {
        name: "AbortError",
      });
    };
    try {
      const descriptor = await read(() =>
        api.resolveResource(
          sessionId,
          reference,
          request.signal,
          knownWorkspacePath,
        ),
      );
      if (stale()) return;
      // Bare filename recovery intentionally returns the canonical workspace
      // reference rather than echoing the shorthand, so session/view identity
      // — not textual equality — binds this response to the request.
      if (descriptor.sessionId !== sessionId || descriptor.viewId !== viewId) {
        throw new Error("The Host returned a resource for another selection");
      }
      if (descriptor.workspacePath) {
        this.host.patch({
          resourceTabs: this.host
            .state()
            .resourceTabs.map((tab) =>
              tab.reference === reference
                ? { ...tab, workspacePath: descriptor.workspacePath }
                : tab,
            ),
        });
      }
      // Resolution confirms or corrects preflight standing. Advance first so
      // an older probe cannot overwrite this result when it arrives later.
      descriptorResolved = true;
      this.advanceReferenceGeneration(reference);
      this.recordAvailability({
        reference,
        availability: "available",
        ...(descriptor.workspacePath
          ? { workspacePath: descriptor.workspacePath }
          : {}),
      });
      if (descriptor.workspacePath && ownsWorkspaceSelection())
        this.host.selectWorkspacePath(
          descriptor.workspacePath,
          descriptor.workspacePath !== knownWorkspacePath,
        );
      if (descriptor.kind === "binary") {
        this.publishPreview({ status: "ready", reference, descriptor });
        return;
      }
      const textLike =
        descriptor.kind === "text" ||
        descriptor.kind === "markdown" ||
        descriptor.kind === "notebook" ||
        descriptor.kind === "html";
      const svg = descriptor.mimeType === "image/svg+xml";
      if (!textLike && !svg && descriptor.size > MAX_MEDIA_PREVIEW_BYTES) {
        this.publishPreview({
          status: "ready",
          reference,
          descriptor,
          contentUnavailable: "too-large",
        });
        return;
      }
      const content = await read(() =>
        api.resourceContent(descriptor.id, sessionId, {
          byteLimit:
            descriptor.kind === "notebook"
              ? NOTEBOOK_PREVIEW_BYTES
              : textLike || (svg && descriptor.size > MAX_MEDIA_PREVIEW_BYTES)
                ? TEXT_PREVIEW_BYTES
                : MAX_MEDIA_PREVIEW_BYTES + 1,
          signal: request.signal,
        }),
      );
      if (stale()) return;
      const blob = content.blob;
      // Resolve metadata authorizes discovery only. Once bytes arrive, the
      // content response's current total is the sole size authority for both
      // the descriptor shown to the user and truncation decisions.
      const currentDescriptor =
        content.totalSize === descriptor.size
          ? descriptor
          : { ...descriptor, size: content.totalSize };
      if (textLike) {
        const text = decodeTextPreview(
          new Uint8Array(await blob.arrayBuffer()),
          blob.size < content.totalSize,
        );
        if (stale()) return;
        const objectUrl =
          descriptor.kind === "html"
            ? URL.createObjectURL(
                new Blob([injectHtmlPreviewCsp(text)], {
                  type: "text/html;charset=utf-8",
                }),
              )
            : undefined;
        this.publishPreview({
          status: "ready",
          reference,
          descriptor: currentDescriptor,
          text,
          // A 206 also answers full-coverage ranges; judge actual coverage.
          truncated: blob.size < content.totalSize,
          ...(objectUrl ? { objectUrl } : {}),
        });
        return;
      }
      const svgText = svg
        ? decodeTextPreview(
            new Uint8Array(
              await blob.slice(0, TEXT_PREVIEW_BYTES).arrayBuffer(),
            ),
            Math.min(blob.size, TEXT_PREVIEW_BYTES) < content.totalSize,
          )
        : undefined;
      if (stale()) return;
      if (
        content.totalSize > MAX_MEDIA_PREVIEW_BYTES ||
        blob.size > MAX_MEDIA_PREVIEW_BYTES
      ) {
        this.publishPreview({
          status: "ready",
          reference,
          descriptor: currentDescriptor,
          ...(svgText !== undefined ? { text: svgText, truncated: true } : {}),
          contentUnavailable: "too-large",
        });
        return;
      }
      const objectUrl =
        descriptor.kind === "pdf" ? undefined : URL.createObjectURL(blob);
      this.publishPreview({
        status: "ready",
        reference,
        descriptor: currentDescriptor,
        ...(descriptor.kind === "pdf" ? { pdfBlob: blob } : {}),
        ...(svgText !== undefined
          ? {
              text: svgText,
              truncated: content.totalSize > TEXT_PREVIEW_BYTES,
            }
          : {}),
        ...(objectUrl ? { objectUrl } : {}),
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        this.ownsTransport(api, transportGeneration)
      ) {
        this.host.handleAuthFailure();
        return;
      }
      if (stale()) return;
      const availability = descriptorResolved
        ? null
        : classifiedResourceFailure(reference, error);
      if (availability) {
        this.advanceReferenceGeneration(reference);
        this.recordAvailability(availability);
      }
      if (retained && isTransientFailure(error)) {
        this.host.patch({
          resourcePreview: {
            ...retained,
            refreshing: false,
            refreshError:
              error instanceof Error ? error.message : "Preview refresh failed",
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
          reference,
          message: error.message,
          matches: error.matches,
        });
        return;
      }
      this.publishPreview({
        status: "error",
        reference,
        message: error instanceof Error ? error.message : "Preview failed",
      });
    } finally {
      backoff.reset();
      if (this.resourceRequest === request) this.resourceRequest = null;
    }
  }
}
