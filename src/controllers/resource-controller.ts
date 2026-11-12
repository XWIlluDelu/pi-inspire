import type { ResourceProbeResult } from "../../shared/contracts";
import {
  isEmbeddedImageReference,
  isLocalResourceReference,
  MAX_RESOURCE_PROBE_REFERENCES,
  type SessionResourceListResponse,
} from "../../shared/resource-references";
import { decodeTextPreview } from "../../shared/text-preview";
import { type Api, ApiError } from "../api";
import { isTransientFailure, RecoveryBackoff } from "../recovery-backoff";
import {
  classifiedResourceFailure,
  type FileInspectionState,
  injectHtmlPreviewCsp,
  inspectedPreview,
  MAX_MEDIA_PREVIEW_BYTES,
  NOTEBOOK_PREVIEW_BYTES,
  type ResourcePreview,
  TEXT_PREVIEW_BYTES,
  unknownResourceAvailability,
} from "../resource-preview";
import { transcriptProjectionKey } from "../transcript-projection-key";

interface ResourceControllerState extends FileInspectionState {
  sessionId: string | null;
  transcriptViewId: string | null;
  transcriptIncarnation: string | null;
  transcriptRevision: number;
  resourcesOpen: boolean;
  contextMode: "files" | "changes" | "branches" | "terminal";
  resourceStanding: Record<string, ResourceProbeResult>;
}

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

interface ImageReadOwner {
  api: Api;
  sessionId: string;
  viewId: string;
  signal: AbortSignal;
  checkCurrent(): void;
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
    this.cancelRequest();
    this.cancelProbes(true);
    this.revokePreviewObjectUrl();
    const { fileInspection, resourceTabs, resourcesOpen, contextMode } =
      this.host.state();
    this.host.patch({
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

  private referenceGeneration(reference: string): number {
    return this.referenceGenerations.get(reference) ?? 0;
  }

  private recordResolution(
    result: ResourceProbeResult,
    tabPatch?: ResourceControllerPatch,
  ): void {
    // A probe started before this resolve cannot overwrite its standing.
    const reference = result.reference;
    this.referenceGenerations.set(
      reference,
      this.referenceGeneration(reference) + 1,
    );
    this.host.patch({
      ...tabPatch,
      resourceStanding: {
        ...this.host.state().resourceStanding,
        [reference]: result,
      },
    });
  }

  /** Load the reference page for the currently visible branch revision.
   * The host returns labels and references only. */
  async loadSessionResources(
    signal?: AbortSignal,
  ): Promise<SessionResourceListResponse | null> {
    const api = this.host.api();
    const {
      sessionId,
      transcriptViewId: viewId,
      transcriptRevision: revision,
    } = this.host.state();
    if (!api || !sessionId || !viewId) return null;
    try {
      const response = await api.listResources(sessionId, signal);
      const current = this.host.state();
      if (
        this.host.api() !== api ||
        signal?.aborted ||
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
      if (this.host.api() !== api) return null;
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
    const ownsProjection = (): boolean => {
      const current = this.host.state();
      return (
        this.host.api() === api &&
        current.sessionId === sessionId &&
        current.transcriptViewId === viewId &&
        current.transcriptRevision === revision
      );
    };
    const stale = () =>
      this.resourceProbeRequest !== request ||
      request.signal.aborted ||
      !ownsProjection();
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
          const resourceStanding = { ...this.host.state().resourceStanding };
          for (const result of response.results) {
            if (
              !expected.has(result.reference) ||
              received.has(result.reference) ||
              !generationIsCurrent(result.reference)
            )
              continue;
            received.add(result.reference);
            resourceStanding[result.reference] = result;
          }
          for (const reference of batch) {
            if (!generationIsCurrent(reference)) continue;
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
          if (stale()) return;
          if (error instanceof ApiError && error.status === 401) {
            this.host.handleAuthFailure();
            return;
          }
          retryNeeded ||= isTransientFailure(error);
          // A failed observation cannot revoke the last confirmed file standing.
          const resourceStanding = { ...this.host.state().resourceStanding };
          for (const reference of batch) {
            if (generationIsCurrent(reference) && !resourceStanding[reference])
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
          if (this.resourceProbeKey === generationKey && ownsProjection())
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
    const { sessionId, transcriptViewId, fileInspection } = this.host.state();
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
      this.host.api() !== api ||
      current.sessionId !== sessionId ||
      current.transcriptViewId !== transcriptViewId ||
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
    { api, sessionId, viewId, signal, checkCurrent }: ImageReadOwner,
    reference: string,
    source: "transcript" | "document",
  ): Promise<Blob> {
    const embedded =
      source === "transcript" && isEmbeddedImageReference(reference);
    checkCurrent();
    const descriptor = await api.resolveResource(sessionId, reference, signal);
    checkCurrent();
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
    const content = await api.resourceContent(descriptor.id, sessionId, {
      byteLimit: MAX_MEDIA_PREVIEW_BYTES + 1,
      signal,
    });
    checkCurrent();
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
    const api = this.host.api();
    if (
      !api ||
      !isLocalResourceReference(reference) ||
      /^[\\/]{2}/.test(reference)
    ) {
      throw new Error("The transcript image reference is unavailable");
    }
    const checkCurrent = () => {
      const current = this.host.state();
      if (
        signal.aborted ||
        this.host.api() !== api ||
        current.sessionId !== sessionId ||
        current.transcriptViewId !== viewId ||
        transcriptProjectionKey(
          current.transcriptViewId,
          current.transcriptIncarnation,
        ) !== projectionKey
      )
        throw Object.assign(
          new Error("The image request is no longer current"),
          {
            name: "AbortError",
          },
        );
    };
    try {
      return await this.readInlineImage(
        { api, sessionId, viewId, signal, checkCurrent },
        reference,
        "transcript",
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        this.host.api() === api
      ) {
        this.host.handleAuthFailure();
        throw error;
      }
      checkCurrent();
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
    const { sessionId, transcriptViewId: viewId } = this.host.state();
    const retired = () =>
      Object.assign(new Error("The document preview is no longer current"), {
        name: "AbortError",
      });
    if (!api || !sessionId || !viewId) throw retired();
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) request.abort();
    this.documentImageRequests.add(request);
    const checkCurrent = () => {
      const state = this.host.state();
      if (
        request.signal.aborted ||
        this.host.api() !== api ||
        state.sessionId !== sessionId ||
        state.transcriptViewId !== viewId ||
        !state.resourcesOpen ||
        state.contextMode !== "files" ||
        state.fileInspection.kind !== "file" ||
        state.fileInspection.preview?.status !== "ready" ||
        state.fileInspection.preview.descriptor.id !== documentId
      )
        throw retired();
    };
    try {
      return await this.readInlineImage(
        { api, sessionId, viewId, signal: request.signal, checkCurrent },
        reference,
        "document",
      );
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
    const {
      sessionId,
      transcriptViewId: viewId,
      fileInspection,
    } = this.host.state();
    const preview = inspectedPreview(fileInspection);
    if (!api || !sessionId || !viewId || preview?.status !== "ready") return;
    const { descriptor } = preview;
    const request = new AbortController();
    this.downloadRequests.add(request);
    const checkCurrent = () => {
      const state = this.host.state();
      if (
        request.signal.aborted ||
        this.host.api() !== api ||
        state.sessionId !== sessionId ||
        state.transcriptViewId !== viewId ||
        !state.resourcesOpen ||
        state.fileInspection.kind !== "file" ||
        state.fileInspection.preview?.status !== "ready" ||
        state.fileInspection.preview.descriptor.id !== descriptor.id
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
    const api = this.host.api();
    const {
      sessionId,
      transcriptViewId: viewId,
      fileInspection,
    } = this.host.state();
    const previous = inspectedPreview(fileInspection);
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
    const request = new AbortController();
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
    const stale = () => {
      const current = this.host.state();
      return (
        this.resourceRequest !== request ||
        request.signal.aborted ||
        this.host.api() !== api ||
        current.fileInspection.kind !== "file" ||
        current.fileInspection.reference !== tabReference ||
        current.sessionId !== sessionId ||
        current.transcriptViewId !== viewId
      );
    };
    const backoff = new RecoveryBackoff();
    try {
      const descriptor = await backoff.read(
        () =>
          api.resolveResource(
            sessionId,
            reference,
            request.signal,
            knownWorkspacePath,
          ),
        request.signal,
        () => !stale(),
      );
      if (stale()) return;
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
      if (stale()) return;
      if (workspacePath && workspacePath !== knownWorkspacePath)
        this.host.revealWorkspacePath(workspacePath);
      if (descriptor.kind === "binary") {
        this.publishPreview({
          status: "ready",
          reference: tabReference,
          descriptor,
        });
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
          reference: tabReference,
          descriptor,
          contentUnavailable: "too-large",
        });
        return;
      }
      const content = await backoff.read(
        () =>
          api.resourceContent(descriptor.id, sessionId, {
            byteLimit:
              descriptor.kind === "notebook"
                ? NOTEBOOK_PREVIEW_BYTES
                : textLike || (svg && descriptor.size > MAX_MEDIA_PREVIEW_BYTES)
                  ? TEXT_PREVIEW_BYTES
                  : MAX_MEDIA_PREVIEW_BYTES + 1,
            signal: request.signal,
          }),
        request.signal,
        () => !stale(),
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
      const ready = {
        status: "ready" as const,
        reference: tabReference,
        descriptor: currentDescriptor,
        ...(sourceLine !== undefined
          ? { sourceJump: { line: sourceLine } }
          : {}),
      };
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
          ...ready,
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
          ...ready,
          ...(svgText !== undefined ? { text: svgText, truncated: true } : {}),
          contentUnavailable: "too-large",
        });
        return;
      }
      const objectUrl =
        descriptor.kind === "pdf" ? undefined : URL.createObjectURL(blob);
      this.publishPreview({
        ...ready,
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
        this.host.api() === api
      ) {
        this.host.handleAuthFailure();
        return;
      }
      if (stale()) return;
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
