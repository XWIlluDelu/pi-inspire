import type { ResourceProbeResult } from "../../shared/contracts";
import {
  MAX_RESOURCE_PROBE_REFERENCES,
  type SessionResourceListResponse,
} from "../../shared/resource-references";
import { type Api, ApiError } from "../api";
import {
  classifiedResourceFailure,
  injectHtmlPreviewCsp,
  MAX_MEDIA_PREVIEW_BYTES,
  NOTEBOOK_PREVIEW_BYTES,
  type ResourcePreview,
  TEXT_PREVIEW_BYTES,
  unknownResourceAvailability,
} from "../resource-preview";

interface ResourceControllerState {
  sessionId: string | null;
  transcriptViewId: string | null;
  transcriptRevision: number;
  resourcesOpen: boolean;
  contextMode: "files" | "changes" | "branches";
  fileBrowserView: "browse" | "preview";
  selectedResourceReference: string | null;
  resourcePreview: ResourcePreview | null;
  resourceAvailability: Record<string, ResourceProbeResult>;
  resourceWorkspacePaths: Record<string, string>;
}

/** Resource-owned state only. AppStore retains cross-domain transactions; a
 * resource opening asks its host to prepare the Git surface without knowing
 * its fields or request implementation. */
interface ResourceControllerPatch {
  resourcesOpen?: boolean;
  contextMode?: "files" | "changes" | "branches";
  fileBrowserView?: "browse" | "preview";
  selectedResourceReference?: string | null;
  resourcePreview?: ResourcePreview | null;
  resourceAvailability?: Record<string, ResourceProbeResult>;
  resourceWorkspacePaths?: Record<string, string>;
}

interface ResourceControllerHost {
  state(): ResourceControllerState;
  patch(patch: ResourceControllerPatch): void;
  api(): Api | null;
  /** A resource request belongs to one browser transport/API generation, not
   * merely to a session/view/revision projection. */
  transportGeneration(): number;
  handleAuthFailure(): void;
  prepareGitForResourceOpen(contextMode: "files" | "changes"): void;
  selectWorkspacePath(workspacePath: string): void;
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
  private resourceProbeRequest: AbortController | null = null;
  private resourceProbeKey: string | null = null;
  private resourceProbedReferences = new Set<string>();

  constructor(private readonly host: ResourceControllerHost) {}

  cancelRequest(): void {
    this.resourceRequest?.abort();
    this.resourceRequest = null;
  }

  cancelProbes(clearStanding = false): void {
    this.resourceProbeRequest?.abort();
    this.resourceProbeRequest = null;
    this.resourceProbeKey = null;
    this.resourceProbedReferences.clear();
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

  /** A new pairing/bootstrap may retain the same session projection but it
   * cannot inherit requests or blob content authorized under the old API.
   * Clear that transient authority before the new transport becomes live. */
  invalidateForTransportReplacement(): void {
    this.cancelProbes(true);
    this.clearSelection();
  }

  private ownsTransport(api: Api, generation: number): boolean {
    return (
      this.host.api() === api && this.host.transportGeneration() === generation
    );
  }

  private recordAvailability(result: ResourceProbeResult): void {
    const state = this.host.state();
    const resourceAvailability = { ...state.resourceAvailability };
    const resourceWorkspacePaths = { ...state.resourceWorkspacePaths };
    if (result.availability === "available") {
      delete resourceAvailability[result.reference];
      if (result.workspacePath)
        resourceWorkspacePaths[result.reference] = result.workspacePath;
      else delete resourceWorkspacePaths[result.reference];
    } else {
      resourceAvailability[result.reference] = result;
      delete resourceWorkspacePaths[result.reference];
    }
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
      if (
        Object.keys(this.host.state().resourceAvailability).length > 0 ||
        Object.keys(this.host.state().resourceWorkspacePaths).length > 0
      ) {
        this.host.patch({
          resourceAvailability: {},
          resourceWorkspacePaths: {},
        });
      }
    }
    if (unique.length === 0) return;
    const pending = unique.filter(
      (reference) => !this.resourceProbedReferences.has(reference),
    );
    if (pending.length === 0) return;

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
              received.has(result.reference)
            )
              continue;
            received.add(result.reference);
            if (result.availability === "available") {
              delete resourceAvailability[result.reference];
              if (result.workspacePath)
                resourceWorkspacePaths[result.reference] = result.workspacePath;
              else delete resourceWorkspacePaths[result.reference];
            } else {
              resourceAvailability[result.reference] = result;
              delete resourceWorkspacePaths[result.reference];
            }
          }
          for (const reference of batch) {
            if (received.has(reference)) {
              this.resourceProbedReferences.add(reference);
            } else {
              resourceAvailability[reference] =
                unknownResourceAvailability(reference);
              delete resourceWorkspacePaths[reference];
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
          const current = this.host.state();
          const resourceAvailability = { ...current.resourceAvailability };
          const resourceWorkspacePaths = {
            ...current.resourceWorkspacePaths,
          };
          for (const reference of batch) {
            resourceAvailability[reference] = unknownResourceAvailability(
              reference,
              error,
            );
            delete resourceWorkspacePaths[reference];
          }
          this.host.patch({
            resourceAvailability,
            resourceWorkspacePaths,
          });
        }
      }
    } finally {
      if (this.resourceProbeRequest === request)
        this.resourceProbeRequest = null;
    }
  }

  private revokePreviewObjectUrl(): void {
    if (this.previewObjectUrl && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(this.previewObjectUrl);
    }
    this.previewObjectUrl = null;
  }

  clearSelection(): void {
    this.cancelRequest();
    this.revokePreviewObjectUrl();
    const { selectedResourceReference, resourcePreview, fileBrowserView } =
      this.host.state();
    if (
      selectedResourceReference === null &&
      resourcePreview === null &&
      fileBrowserView === "browse"
    )
      return;
    this.host.patch({
      selectedResourceReference: null,
      resourcePreview: null,
      fileBrowserView: "browse",
    });
  }

  /** Load one Pi-persisted embedded image without selecting the Files pane.
   * The session and branch-view identity are rechecked across both authenticated
   * requests so a late thumbnail can never cross a navigation boundary. */
  async loadEmbeddedImage(
    sessionId: string,
    viewId: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<Blob> {
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    if (!api || !/^pi-embedded:\/\/\d+\/\d+$/.test(reference)) {
      throw new Error("The embedded image reference is invalid");
    }
    const stale = () => {
      const current = this.host.state();
      return (
        signal.aborted ||
        !this.ownsTransport(api, transportGeneration) ||
        current.sessionId !== sessionId ||
        current.transcriptViewId !== viewId
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
      if (descriptor.kind !== "image" || descriptor.viewId !== viewId) {
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
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        throw error;
      }
      if (stale()) throw staleError();
      throw error;
    }
  }

  /** Resolve a conversation reference through the authenticated host endpoint
   * and load its preview. Replaces any current preview and revokes its URL. */
  async openResource(
    reference: string,
    contextMode: "files" | "changes" = "files",
  ): Promise<void> {
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const { sessionId, transcriptViewId: viewId } = this.host.state();
    if (!api || !sessionId || !viewId) return;
    this.cancelRequest();
    this.host.prepareGitForResourceOpen(contextMode);
    const request = new AbortController();
    this.resourceRequest = request;
    this.revokePreviewObjectUrl();
    this.host.patch({
      resourcesOpen: true,
      contextMode,
      fileBrowserView: "preview",
      selectedResourceReference: reference,
      resourcePreview: { status: "loading", reference },
    });
    const stale = () => {
      const current = this.host.state();
      return (
        this.resourceRequest !== request ||
        !this.ownsTransport(api, transportGeneration) ||
        current.selectedResourceReference !== reference ||
        current.sessionId !== sessionId ||
        current.transcriptViewId !== viewId
      );
    };
    let resolvedReference = false;
    try {
      const descriptor = await api.resolveResource(
        sessionId,
        reference,
        request.signal,
      );
      if (stale() || (descriptor.viewId ?? viewId) !== viewId) return;
      // Resolution confirms or corrects preflight standing. A later transfer
      // failure leaves this availability intact.
      resolvedReference = true;
      this.recordAvailability({
        reference,
        availability: "available",
        ...(descriptor.workspacePath
          ? { workspacePath: descriptor.workspacePath }
          : {}),
      });
      if (descriptor.workspacePath)
        this.host.selectWorkspacePath(descriptor.workspacePath);
      if (descriptor.kind === "binary") {
        this.host.patch({
          resourcePreview: { status: "ready", reference, descriptor },
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
        this.host.patch({
          resourcePreview: {
            status: "ready",
            reference,
            descriptor,
            contentUnavailable: "too-large",
          },
        });
        return;
      }
      const content = await api.resourceContent(descriptor.id, sessionId, {
        byteLimit:
          descriptor.kind === "notebook"
            ? NOTEBOOK_PREVIEW_BYTES
            : textLike || (svg && descriptor.size > MAX_MEDIA_PREVIEW_BYTES)
              ? TEXT_PREVIEW_BYTES
              : MAX_MEDIA_PREVIEW_BYTES + 1,
        signal: request.signal,
      });
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
        const text = await blob.text();
        if (stale()) return;
        if (
          descriptor.kind === "html" &&
          typeof URL.createObjectURL === "function"
        ) {
          this.previewObjectUrl = URL.createObjectURL(
            new Blob([injectHtmlPreviewCsp(text)], { type: "text/html" }),
          );
        }
        this.host.patch({
          resourcePreview: {
            status: "ready",
            reference,
            descriptor: currentDescriptor,
            text,
            // A 206 also answers full-coverage ranges, so judge truncation
            // by what actually arrived against the transfer's current total.
            truncated: blob.size < content.totalSize,
            ...(this.previewObjectUrl
              ? { objectUrl: this.previewObjectUrl }
              : {}),
          },
        });
        return;
      }
      const svgText = svg
        ? await blob.slice(0, TEXT_PREVIEW_BYTES).text()
        : undefined;
      if (stale()) return;
      if (
        content.totalSize > MAX_MEDIA_PREVIEW_BYTES ||
        blob.size > MAX_MEDIA_PREVIEW_BYTES
      ) {
        this.host.patch({
          resourcePreview: {
            status: "ready",
            reference,
            descriptor: currentDescriptor,
            ...(svgText !== undefined
              ? { text: svgText, truncated: true }
              : {}),
            contentUnavailable: "too-large",
          },
        });
        return;
      }
      if (typeof URL.createObjectURL === "function") {
        this.previewObjectUrl = URL.createObjectURL(blob);
      }
      this.host.patch({
        resourcePreview: {
          status: "ready",
          reference,
          descriptor: currentDescriptor,
          ...(svgText !== undefined
            ? {
                text: svgText,
                truncated: content.totalSize > TEXT_PREVIEW_BYTES,
              }
            : {}),
          ...(this.previewObjectUrl
            ? { objectUrl: this.previewObjectUrl }
            : {}),
        },
      });
    } catch (error) {
      if (stale()) return;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return;
      }
      const availability = resolvedReference
        ? null
        : classifiedResourceFailure(reference, error);
      if (availability) this.recordAvailability(availability);
      if (
        error instanceof ApiError &&
        error.matches &&
        error.matches.length > 0
      ) {
        this.host.patch({
          resourcePreview: {
            status: "ambiguous",
            reference,
            message: error.message,
            matches: error.matches,
          },
        });
        return;
      }
      this.host.patch({
        resourcePreview: {
          status: "error",
          reference,
          message: error instanceof Error ? error.message : "Preview failed",
        },
      });
    } finally {
      if (this.resourceRequest === request) this.resourceRequest = null;
    }
  }
}
