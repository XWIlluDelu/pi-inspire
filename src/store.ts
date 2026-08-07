import { useSyncExternalStore } from "react";
import {
  defaultPreferences,
  MAX_ATTACHMENTS,
  MAX_PROJECT_FILES,
  MAX_SESSION_CWD_HYDRATION_CWDS,
  MAX_SESSION_ID_HYDRATION_IDS,
  MAX_SESSION_LIST_PAGE_SIZE,
  modelIdentityKey,
  projectNameFromCwd,
  THINKING_LEVELS,
  type ActiveSnapshot,
  type AssistantRoundDisplayPreference,
  type BranchTreeResponse,
  type CompletionAttentionPreference,
  type GitDiffResponse,
  type GitDiffSide,
  type GitFileChange,
  type GitStatusResponse,
  type HostDirListing,
  type HostRootsResponse,
  type InspirePreferences,
  type LaunchPreference,
  type ModelIdentity,
  type ModelOption,
  type NewSessionDefaults,
  type NewSessionOptions,
  type ProjectDirEntry,
  type ProjectDisplayPreference,
  projectionConflictSeverity,
  type ProjectionConflict,
  type ProjectionHealth,
  type ResourceDescriptor,
  type ResourceProbeResult,
  type RunState,
  type SessionDeleteDisposition,
  type SessionRuntimeStatus,
  type SessionSummary,
  type ThemePreference,
  type ToolVisibilityPreference,
  type VisibilityPreference,
} from "../shared/contracts";
import { messageFallbackCorrelation } from "../shared/message-identity";
import { deleteSessionDraft } from "./session-drafts";
import { ApiError, createApi, eventsUrl, type Api, type ProjectFileResult } from "./api";
import {
  asMessage,
  emptyEventSlice,
  messageKey,
  reduceEvent,
  type ActivityTool,
  type ChatMessage,
  type EventSlice,
  type ExtensionUiRequest,
  type Notice,
  type QueueInfo,
  type RetryInfo,
  type WireEvent,
} from "./events";

// Re-export the message model so existing component imports keep working.
export {
  asMessage,
  contentItems,
  isAbortableRunState,
  isBusyRunState,
  messageKey,
  messageText,
  toolResultText,
  type AssistantContent,
  type ChatMessage,
  type TextContent,
  type ThinkingContent,
  type ToolCallContent,
} from "./events";
export { THINKING_LEVELS };
export type { ActivityTool, ExtensionUiRequest, Notice, QueueInfo, RetryInfo, WireEvent } from "./events";

// --- Store state ---

export type ConnectionState = "connecting" | "open" | "reconnecting" | "offline";
export type ConnectionProblem =
  | { kind: "host-unreachable" }
  | { kind: "host-error"; message: string }
  | { kind: "stream-interrupted" }
  | null;

/** Text-like previews are range-capped; a body shorter than the file's
 * size marks the preview truncated. */
export const TEXT_PREVIEW_BYTES = 256 * 1024;
/** Blob-backed image/PDF/audio/video previews must fit in browser memory.
 * Fetch one sentinel byte beyond the limit so a same-inode file growth cannot
 * masquerade as a complete preview. */
export const MAX_MEDIA_PREVIEW_BYTES = 32 * 1024 * 1024;

/** In-document CSP injected into sandboxed HTML previews: no scripts (the
 * iframe sandbox enforces that too), no remote subresources. */
const HTML_PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'";

export function injectHtmlPreviewCsp(html: string): string {
  // Sandbox blocks script execution and privilege; the injected CSP removes
  // network reach and navigation primitives. Parse rather than regex-splice:
  // a fake "<head>" inside a comment must not choose the injection point.
  // parseFromString is inert — nothing loads or executes during parsing.
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const element of [...parsed.querySelectorAll("base")]) element.remove();
  for (const element of [...parsed.querySelectorAll("meta[http-equiv]")]) {
    if (/^refresh$/i.test(element.getAttribute("http-equiv") ?? "")) element.remove();
  }
  const meta = parsed.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", HTML_PREVIEW_CSP);
  parsed.head.insertBefore(meta, parsed.head.firstChild);
  return `<!DOCTYPE html>${parsed.documentElement.outerHTML}`;
}

export type GitDiffView =
  | { status: "loading"; pathId: string; side: GitDiffSide }
  | { status: "error"; pathId: string; side: GitDiffSide; message: string }
  | { status: "ready"; result: GitDiffResponse };

export type ResourcePreview =
  | { status: "loading"; reference: string }
  | { status: "error"; reference: string; message: string }
  /** A bare reference the host refused to guess about: the candidates it
   * found are offered for the user to choose. */
  | { status: "ambiguous"; reference: string; message: string; matches: string[] }
  | {
      status: "ready";
      reference: string;
      descriptor: ResourceDescriptor;
      /** Decoded text for text/markdown/html previews. */
      text?: string;
      truncated?: boolean;
      /** Object URL for binary-backed previews (image/pdf/audio/video/html). */
      objectUrl?: string;
      /** The descriptor remains inspectable even when its bytes are withheld. */
      contentUnavailable?: "too-large";
    };

function classifiedResourceFailure(reference: string, error: unknown): ResourceProbeResult | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 409 && error.matches) {
    return { reference, availability: "ambiguous", message: error.message, matches: error.matches };
  }
  if (error.status === 404) return { reference, availability: "missing", message: error.message };
  if (error.status === 403) return { reference, availability: "unavailable", message: error.message };
  if (error.status === 400) return { reference, availability: "invalid", message: error.message };
  return null;
}

export type { ModelOption } from "../shared/contracts";

export interface PiCommand {
  name: string;
  description?: string;
  /** Pi currently reports extension/prompt/skill. Keep unknown future sources
   * attributable instead of collapsing or rejecting them. */
  source?: string;
}

/** Context-window occupancy from Pi's session stats. `tokens`/`percent` are
 * null right after a compaction until the next assistant response reports
 * fresh usage; the whole value is null when Pi provides no usable stats. */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export function contextUsage(stats: unknown): ContextUsage | null {
  if (!stats || typeof stats !== "object") return null;
  const raw = (stats as { contextUsage?: unknown }).contextUsage;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const contextWindow =
    typeof record.contextWindow === "number" && Number.isFinite(record.contextWindow) && record.contextWindow > 0
      ? record.contextWindow
      : null;
  if (contextWindow === null) return null;
  const tokens = typeof record.tokens === "number" && Number.isFinite(record.tokens) ? record.tokens : null;
  const percent =
    typeof record.percent === "number" && Number.isFinite(record.percent)
      ? record.percent
      : tokens !== null
        ? (tokens / contextWindow) * 100
        : null;
  return { tokens, contextWindow, percent };
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
  error?: string;
}

/** One session's staged composer work; AppState.attachments/projectFiles/
 * sending mirror the visible session's partition. */
interface ComposerPartition {
  attachments: PendingAttachment[];
  projectFiles: string[];
  sending: boolean;
}

export interface AppState extends EventSlice {
  needsToken: boolean;
  connection: ConnectionState;
  connectionProblem: ConnectionProblem;
  bootstrapped: boolean;
  mock: boolean;
  /** Host-reported insπre version, shown on the settings page. */
  version: string;
  prefs: InspirePreferences;
  sessionId: string | null;
  sessionName: string;
  cwd: string | null;
  project: string | null;
  model: ModelOption | null;
  thinkingLevel: string;
  availableModels: ModelOption[];
  commands: PiCommand[];
  /** Context-window occupancy parsed from Pi's session stats at the
   * snapshot boundary; null when Pi provides no usable data. */
  contextUsage: ContextUsage | null;
  transcriptRevision: number;
  transcriptIncarnation: string | null;
  transcriptViewId: string | null;
  transcriptEffectiveLeafId: string | null;
  hasOlderMessages: boolean;
  olderMessagesCursor: string | null;
  loadingOlderMessages: boolean;
  olderMessagesError: string | null;
  projectionHealth: ProjectionHealth;
  projectionConflict: ProjectionConflict | null;
  projectionError: string | null;
  /** Global operation error. Projection conflicts use errorSeverity to
   * distinguish safe external attention from integrity failures. */
  errorSeverity: "error" | "warning";
  /** Rendered union of chronological catalog pages and separately hydrated
   * curated/live identities. Only the chronological pages advance the cursor. */
  sessions: SessionSummary[];
  sessionQuery: string;
  sessionListTotal: number;
  sessionListNextOffset: number;
  sessionListLoading: boolean;
  sessionListLoadingOlder: boolean;
  sessionListHydrating: boolean;
  /** Current operation, retained after failure so retry copy stays truthful. */
  sessionListOperation: "reset" | "older" | "refresh" | "preserve" | "hydrate" | null;
  sessionListError: string | null;
  /** Selection failures stay with the session navigation/start surface rather
   * than competing with transcript integrity errors in the topbar. */
  sessionActionError: string | null;
  /** Destructive-action failures stay inside the confirmation dialog. */
  sessionDeleteError: string | null;
  /** Authoritative per-session runtime status for every live session worker,
   * keyed by session id. Drives nav attention indicators. */
  sessionStatuses: Record<string, SessionRuntimeStatus>;
  /** Unseen terminal transitions currently contributing a title marker. */
  attentionSessionIds: string[];
  /** Session currently owned by the newest open operation, if any. */
  openingSessionId: string | null;
  /** The Hidden-row destructive action currently awaiting its host result. */
  deletingSessionId: string | null;
  /** The visible session's composer slice. Authoritative copies live in
   * per-session partitions inside the store; a session switch swaps the
   * slice, so staged work never leaks across sessions. */
  attachments: PendingAttachment[];
  projectFiles: string[];
  /** Prompt delivery in flight for the visible session: repeat sends are
   * refused and attachment withdrawals freeze, so a DELETE cannot race the
   * host resolving those same files into the outgoing message. */
  sending: boolean;
  /** Files/resources pane visibility (Ctrl+.). */
  resourcesOpen: boolean;
  contextMode: "files" | "changes" | "branches";
  detailMode: "file" | "diff";
  branchTree: BranchTreeResponse | null;
  branchTreeLoading: boolean;
  branchTreeError: string | null;
  branchActionId: string | null;
  /** Reference currently selected in the resources pane. */
  selectedResourceReference: string | null;
  resourcePreview: ResourcePreview | null;
  gitStatus: GitStatusResponse | null;
  gitStatusError: string | null;
  gitStatusLoading: boolean;
  gitStatusRefreshing: boolean;
  selectedGitPathId: string | null;
  selectedGitSide: GitDiffSide | null;
  gitDiff: GitDiffView | null;
  /** Preflight standing for the bounded Files-pane references. A textual
   * mention stays unverified until the host classifies it for this branch
   * view; only a successful resolve grants a separate content handle. */
  resourceAvailability: Record<string, ResourceProbeResult>;
  error: string | null;
}

const NOTICE_TTL_MS = 8_000;
const SESSION_PAGE_SIZE = 40;

const initialState: AppState = {
  ...emptyEventSlice(),
  needsToken: false,
  connection: "connecting",
  connectionProblem: null,
  bootstrapped: false,
  mock: false,
  version: "",
  prefs: defaultPreferences,
  sessionId: null,
  sessionName: "",
  cwd: null,
  project: null,
  model: null,
  thinkingLevel: "medium",
  availableModels: [],
  commands: [],
  contextUsage: null,
  transcriptRevision: 0,
  transcriptIncarnation: null,
  transcriptViewId: null,
  transcriptEffectiveLeafId: null,
  hasOlderMessages: false,
  olderMessagesCursor: null,
  loadingOlderMessages: false,
  olderMessagesError: null,
  projectionHealth: { status: "ok" },
  projectionConflict: null,
  projectionError: null,
  errorSeverity: "error",
  sessions: [],
  sessionQuery: "",
  sessionListTotal: 0,
  sessionListNextOffset: 0,
  sessionListLoading: false,
  sessionListLoadingOlder: false,
  sessionListHydrating: false,
  sessionListOperation: null,
  sessionListError: null,
  sessionActionError: null,
  sessionDeleteError: null,
  sessionStatuses: {},
  attentionSessionIds: [],
  openingSessionId: null,
  deletingSessionId: null,
  attachments: [],
  projectFiles: [],
  sending: false,
  resourcesOpen: false,
  contextMode: "files",
  detailMode: "file",
  branchTree: null,
  branchTreeLoading: false,
  branchTreeError: null,
  branchActionId: null,
  selectedResourceReference: null,
  resourcePreview: null,
  gitStatus: null,
  gitStatusError: null,
  gitStatusLoading: false,
  gitStatusRefreshing: false,
  selectedGitPathId: null,
  selectedGitSide: null,
  gitDiff: null,
  resourceAvailability: {},
  error: null,
};

type SessionHydrationOwner = { id: string; query: string; ticket: number };
type SessionListRetry =
  | { kind: "reset"; query: string }
  | { kind: "older"; query: string; offset: number }
  | { kind: "refresh"; query: string }
  | { kind: "preserve"; query: string; offset: number; total: number }
  | { kind: "hydrate"; owner: SessionHydrationOwner };

export class AppStore {
  private state: AppState = initialState;
  private listeners = new Set<() => void>();
  private api: Api | null = null;
  private authToken: string | null = null;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
  private settledKeys = new Set<string>();
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionBasePages: SessionSummary[] = [];
  private sessionHydration = new Map<string, SessionSummary>();
  private sessionLoadTicket = 0;
  private sessionOlderPromise: Promise<void> | null = null;
  private sessionListRetry: SessionListRetry | null = null;
  private sessionHydrationInFlight = new Set<string>();
  private noticeTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private autoContinued = false;
  private selectionGeneration = 0;
  /** Latest-wins guard for selection intent: openSession/newSession and every
   * authoritative WebSocket snapshot bump it, so a slower open/new HTTP
   * response cannot overwrite a newer selection the client already applied. */
  private selectionRequest = 0;
  /** The request that owns the visible opening marker. Stale completions may
   * never clear a newer owner. */
  private openingOwner: number | null = null;
  private resyncRequest = 0;
  private readyWhileOpening = new Map<string, number>();
  private previewObjectUrl: string | null = null;
  private resourceRequest: AbortController | null = null;
  private resourceProbeRequest: AbortController | null = null;
  private resourceProbeKey: string | null = null;
  private olderTranscriptRequest: AbortController | null = null;
  private gitStatusRequest: AbortController | null = null;
  private gitStatusPromise: Promise<void> | null = null;
  private gitRefreshQueued = false;
  private gitDiffRequest: AbortController | null = null;
  private gitSurfaces = new Set<string>();
  private gitRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private branchTreeRequest = 0;
  private branchActionRequest = 0;
  private transportGeneration = 0;
  /** Live operation kinds own their own terminal attention. Nested automatic
   * compaction must never consume the agent run that owns it. */
  private attentionArms = new Map<string, Set<"agent" | "compaction">>();
  private titleAttention = new Set<string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AppState => this.state;

  private set(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  private fail(message: string, severity: "error" | "warning" = "error"): void {
    this.set({ error: message, errorSeverity: severity });
  }

  private notify(kind: Notice["kind"], text: string): void {
    const id = this.state.nextNoticeId;
    this.set({
      notices: [...this.state.notices, { id, kind, text }],
      nextNoticeId: id + 1,
    });
    this.noticeTimers.set(id, setTimeout(() => this.dismissNotice(id), NOTICE_TTL_MS));
  }

  private isForeground(): boolean {
    return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
  }

  private publishTitleAttention(): void {
    const attentionSessionIds = [...this.titleAttention];
    if (
      attentionSessionIds.length === this.state.attentionSessionIds.length &&
      attentionSessionIds.every((id, index) => id === this.state.attentionSessionIds[index])
    ) return;
    this.set({ attentionSessionIds });
  }

  private clearAttentionFor(sessionId: string | null): void {
    if (!sessionId || !this.titleAttention.delete(sessionId)) return;
    this.publishTitleAttention();
  }

  /** Called from the window focus/visibility boundary. Viewing the owning
   * selected session acknowledges its title attention. */
  acknowledgeVisibleSession = (): void => {
    if (this.isForeground()) this.clearAttentionFor(this.state.sessionId);
  };

  private armAttention(sessionId: string, kind: "agent" | "compaction"): void {
    const arms = this.attentionArms.get(sessionId) ?? new Set<"agent" | "compaction">();
    arms.add(kind);
    this.attentionArms.set(sessionId, arms);
  }

  private hasAttentionArm(sessionId: string, kind: "agent" | "compaction"): boolean {
    return this.attentionArms.get(sessionId)?.has(kind) ?? false;
  }

  private consumeAttentionArm(sessionId: string, kind: "agent" | "compaction"): boolean {
    const arms = this.attentionArms.get(sessionId);
    if (!arms?.delete(kind)) return false;
    if (arms.size === 0) this.attentionArms.delete(sessionId);
    return true;
  }

  /** Snapshots never create attention ownership, but they are authoritative
   * evidence that an observed live operation either still exists or ended
   * outside this socket's event stream. */
  private reconcileAttentionArms(sessionStatuses: Readonly<Record<string, SessionRuntimeStatus>>): void {
    const liveAgentStates = new Set(["running", "retrying", "queued", "compacting"]);
    for (const [sessionId, arms] of this.attentionArms) {
      const runState = sessionStatuses[sessionId]?.runState;
      if (!runState) {
        this.attentionArms.delete(sessionId);
        continue;
      }
      if (arms.has("agent") && !liveAgentStates.has(runState)) arms.delete("agent");
      if (arms.has("compaction") && runState !== "compacting") arms.delete("compaction");
      if (arms.size === 0) this.attentionArms.delete(sessionId);
    }
  }

  private statusOutcome(event: WireEvent): "completed" | "failed" | "aborted" {
    const status = event.sessionStatus as Partial<SessionRuntimeStatus> | undefined;
    if (event.type === "runtime_error" || status?.runState === "failed" || status?.runState === "conflict") return "failed";
    if (status?.runState === "aborted") return "aborted";
    return "completed";
  }

  private compactionOutcome(event: WireEvent): "completed" | "failed" | "aborted" {
    if (event.aborted === true) return "aborted";
    if (typeof event.errorMessage === "string" && event.errorMessage.trim()) return "failed";
    if (event.result === undefined || event.result === null) return "failed";
    return this.statusOutcome(event);
  }

  private attendToOutcome(sessionId: string, outcome: "completed" | "failed" | "aborted"): void {
    const foregroundOwner = sessionId === this.state.sessionId && this.isForeground();
    if (foregroundOwner || this.state.prefs.completionAttention === "off") return;
    if (this.state.prefs.completionAttention === "title") {
      this.titleAttention.add(sessionId);
      this.publishTitleAttention();
      return;
    }
    if (this.state.prefs.completionAttention !== "desktop") return;
    const NotificationApi = typeof window !== "undefined" ? window.Notification : undefined;
    if (!NotificationApi || NotificationApi.permission !== "granted") return;
    const project = this.state.sessions.find((candidate) => candidate.id === sessionId)?.project;
    const title = outcome === "completed" ? "Task completed" : outcome === "aborted" ? "Task aborted" : "Task failed";
    // A catalog title can be the first prompt. OS-visible fields therefore use
    // only fixed copy, opaque session identity, and cwd-derived project data.
    const body = project ? `Project: ${project}` : "Pi task";
    try {
      const notification = new NotificationApi(title, { body, tag: `inspire-task:${sessionId}:${outcome}` });
      notification.onclick = () => {
        window.focus();
        if (this.state.sessionId !== sessionId) void this.openSession(sessionId);
        else this.acknowledgeVisibleSession();
        notification.close();
      };
    } catch {
      this.notify("warning", "Desktop notifications are unavailable in this browser context");
    }
  }

  dismissError = (): void => this.set({ error: null, errorSeverity: "error" });

  /** Replace the visible composer's text through the same nonce channel used
   * by branch editing. The welcome flow uses this only after Pi assigns the
   * new session identity, preserving its first message if upload/send fails. */
  replaceComposerText = (text: string): void => {
    this.set({ editorText: { text, nonce: (this.state.editorText?.nonce ?? 0) + 1 } });
  };

  private handleAuthFailure(): void {
    // Null the owned socket first so its close handler cannot schedule a
    // retry with the rejected token.
    const socket = this.socket;
    this.socket = null;
    this.transportGeneration += 1;
    this.attentionArms.clear();
    socket?.close();
    this.authToken = null;
    this.set({ needsToken: true, error: null, connection: "offline", connectionProblem: null });
  }

  // --- Bootstrap ---

  private invalidateBranchForSelectionIntent(): void {
    this.branchTreeRequest += 1;
    this.branchActionRequest += 1;
    this.set({
      branchTreeLoading: false,
      branchActionId: null,
      branchTreeError: this.state.branchTree ? "Branch history is stale — reload after the session selection settles" : null,
    });
  }

  private claimOpening(owner: number, sessionId: string | null): void {
    this.readyWhileOpening.clear();
    this.openingOwner = owner;
    this.set({ openingSessionId: sessionId });
  }

  private releaseOpening(owner?: number): void {
    if (owner !== undefined && this.openingOwner !== owner) return;
    this.readyWhileOpening.clear();
    this.openingOwner = null;
    if (this.state.openingSessionId !== null) this.set({ openingSessionId: null });
  }

  async init(token: string | null = this.authToken): Promise<void> {
    this.authToken = token;
    this.api = createApi(token);
    this.transportGeneration += 1;
    try {
      const boot = await this.api.bootstrap();
      this.confirmedPrefs = boot.preferences;
      this.set({
        prefs: boot.preferences,
        mock: boot.mock,
        version: boot.version,
        availableModels: Array.isArray(boot.availableModels) ? boot.availableModels : [],
        bootstrapped: true,
        needsToken: false,
        connectionProblem: null,
      });
      this.applySnapshot(boot.snapshot);
      this.connect(token);
      void this.loadSessions(this.state.sessionQuery).then(() => {
        // The remembered launch preference applies once per store lifetime so
        // reconnects never hijack a deliberate navigation.
        if (this.autoContinued) return;
        this.autoContinued = true;
        if (boot.preferences.launch === "continue" && !this.state.sessionId) {
          const previous = this.state.sessions[0];
          if (previous) void this.openSession(previous.id);
        }
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
      } else {
        this.set({
          connection: "offline",
          connectionProblem: error instanceof ApiError
            ? { kind: "host-error", message: error.message }
            : { kind: "host-unreachable" },
          error: null,
          errorSeverity: "error",
        });
        this.scheduleReconnect(token);
      }
    }
  }

  // --- Snapshot & event reconciliation ---

  private applySnapshot(snapshot: ActiveSnapshot, mode: "replace" | "preserve" = "preserve"): void {
    const active = snapshot.active;
    const nextSessionId = active?.sessionId ?? null;
    const sessionChanged = nextSessionId !== this.state.sessionId;
    const page = active?.transcriptPage;
    const nextViewId = page ? (page.viewId ?? `legacy-view:${page.incarnation ?? nextSessionId ?? "none"}`) : null;
    const nextEffectiveLeafId = page?.effectiveLeafId ?? active?.effectiveLeafId ?? null;
    const viewChanged = Boolean(
      !sessionChanged && nextSessionId && (
        (nextViewId && nextViewId !== this.state.transcriptViewId) ||
        nextEffectiveLeafId !== this.state.transcriptEffectiveLeafId
      ),
    );
    if (sessionChanged || viewChanged) {
      this.selectionGeneration += 1;
      this.branchTreeRequest += 1;
      this.branchActionRequest += 1;
      // Conversation-derived previews and older-page requests are authorized
      // against one opaque branch view, not merely a session id.
      this.cancelResourceRequest();
      this.cancelResourceProbes();
      this.revokePreviewObjectUrl();
      this.olderTranscriptRequest?.abort();
      this.olderTranscriptRequest = null;
      if (sessionChanged) this.cancelGitRequests();
    }
    const newestMessages = (page?.messages ?? active?.messages ?? []).map(asMessage);
    const historyCompatible = Boolean(
      mode === "preserve" &&
      !sessionChanged &&
      !viewChanged &&
      page &&
      nextViewId === this.state.transcriptViewId &&
      page.incarnation &&
      page.incarnation === this.state.transcriptIncarnation &&
      (
        (
          page.revision === this.state.transcriptRevision &&
          (
            this.state.hasOlderMessages !== Boolean(page.hasOlder) ||
            this.state.olderMessagesCursor !== (page.olderCursor ?? null)
          )
        ) ||
        (
          page.revision > this.state.transcriptRevision &&
          (page.appendFromRevision ?? page.revision) <= this.state.transcriptRevision
        )
      ),
    );
    let messages = newestMessages;
    if (historyCompatible) {
      const newestKeys = new Set(newestMessages.map((message) => messageKey(message) ?? JSON.stringify(message)));
      const persistedCorrelations = new Map<string, number>();
      for (const message of newestMessages) {
        const record = message as ChatMessage & { __inspireMessageId?: unknown };
        if (typeof record.__inspireMessageId !== "string") continue;
        const key = messageFallbackCorrelation(message);
        if (key) persistedCorrelations.set(key, (persistedCorrelations.get(key) ?? 0) + 1);
      }
      messages = [
        ...this.state.messages.filter((message) => {
          const key = messageKey(message) ?? JSON.stringify(message);
          if (newestKeys.has(key)) return false;
          const record = message as ChatMessage & { __inspireLiveId?: unknown };
          if (typeof record.__inspireLiveId !== "string") return true;
          const correlation = messageFallbackCorrelation(message);
          if (!correlation) return true;
          const count = persistedCorrelations.get(correlation) ?? 0;
          if (count === 0) return true;
          persistedCorrelations.set(correlation, count - 1);
          return false;
        }),
        ...newestMessages,
      ];
    }
    this.settledKeys = new Set(messages.map(messageKey).filter((key): key is string => key !== null));
    const cwd = active?.cwd ?? null;
    const projectionHealth = active?.projectionHealth ?? { status: "ok" as const };
    const projectionConflict = active?.projectionConflict ?? null;
    const projectionError = projectionConflict?.message ??
      (projectionHealth.status === "error" ? projectionHealth.message ?? "Session projection failed" : null);
    const projectionSeverity = projectionConflictSeverity(projectionConflict) === "attention" ? "warning" : "error";
    const clearedProjectionError = !projectionError && this.state.error === this.state.projectionError;
    const sessionStatuses = snapshot.sessionStatuses ?? {};
    this.reconcileAttentionArms(sessionStatuses);
    this.set({
      sessionId: active?.sessionId ?? null,
      sessionName: active?.sessionName ?? "",
      cwd,
      project: cwd ? projectNameFromCwd(cwd) : null,
      model: (active?.model as AppState["model"]) ?? null,
      thinkingLevel: typeof active?.thinkingLevel === "string" ? active.thinkingLevel : this.state.thinkingLevel,
      availableModels: active && Array.isArray(active.availableModels) && active.availableModels.length > 0
        ? (active.availableModels as ModelOption[])
        : this.state.availableModels,
      commands: Array.isArray(active?.commands) ? (active.commands as PiCommand[]) : [],
      contextUsage: contextUsage(active?.stats ?? null),
      messages,
      transcriptRevision: page?.revision ?? 0,
      transcriptIncarnation: page?.incarnation ?? null,
      transcriptViewId: nextViewId,
      transcriptEffectiveLeafId: nextEffectiveLeafId,
      hasOlderMessages: historyCompatible ? this.state.hasOlderMessages : Boolean(page?.hasOlder),
      olderMessagesCursor: historyCompatible ? this.state.olderMessagesCursor : (page?.olderCursor ?? null),
      loadingOlderMessages: false,
      olderMessagesError: historyCompatible ? this.state.olderMessagesError : null,
      projectionHealth,
      projectionConflict,
      projectionError,
      ...(projectionError
        ? { error: projectionError, errorSeverity: projectionSeverity }
        : clearedProjectionError ? { error: null, errorSeverity: "error" } : {}),
      streaming: Boolean(active?.isStreaming),
      runState: active?.projectionConflict ? "conflict" : snapshot.runState,
      // Wholesale replace: the host clears completion attention for the
      // session that was just viewed, so stale client state must not linger.
      sessionStatuses,
      sessionActionError: null,
      // Settled activity is rebuilt from the selected worker. Background
      // extension dialogs are restored in Pi request order when their owning
      // session is viewed.
      tools: {},
      retry: null,
      queue: {
        steering: Array.isArray(snapshot.pendingQueues?.steering)
          ? snapshot.pendingQueues.steering.filter((item): item is string => typeof item === "string")
          : [],
        followUp: Array.isArray(snapshot.pendingQueues?.followUp)
          ? snapshot.pendingQueues.followUp.filter((item): item is string => typeof item === "string")
          : [],
      },
      extensionUiRequests: Array.isArray(snapshot.pendingExtensionUiRequests)
        ? snapshot.pendingExtensionUiRequests
        : [],
      extensionUiRespondingId: sessionChanged || viewChanged ? null : this.state.extensionUiRespondingId,
      extensionDisplays: Array.isArray(snapshot.extensionDisplays) ? snapshot.extensionDisplays : [],
      ...(sessionChanged
        ? {
            statuses: {},
            editorText: null,
            windowTitle: null,
            contextMode: "files",
            detailMode: "file",
            branchTree: null,
            branchTreeLoading: false,
            branchTreeError: null,
            branchActionId: null,
            selectedResourceReference: null,
            resourcePreview: null,
            gitStatus: null,
            gitStatusError: null,
            gitStatusLoading: false,
            gitStatusRefreshing: false,
            selectedGitPathId: null,
            selectedGitSide: null,
            gitDiff: null,
            resourceAvailability: {},
            // Composer work belongs to its session; the switch swaps in the
            // destination's staged slice.
            ...this.composerSlice(nextSessionId),
          }
        : viewChanged
          ? {
              branchTreeLoading: false,
              branchTreeError: this.state.branchTree ? "Branch history is stale — refresh to use branch actions" : null,
              branchActionId: null,
              selectedResourceReference: null,
              resourcePreview: null,
              resourceAvailability: {},
            }
          : {}),
    });
    // Snapshots restore projection only. Attention is armed exclusively by
    // live lifecycle events, never by bootstrap/reconnect status.
    if (nextSessionId && this.isForeground()) this.clearAttentionFor(nextSessionId);
    if (sessionChanged && nextSessionId && this.gitSurfaces.size > 0) void this.refreshGitStatus();
  }

  private eventSlice(): EventSlice {
    const s = this.state;
    return {
      messages: s.messages,
      streaming: s.streaming,
      runState: s.runState,
      tools: s.tools,
      retry: s.retry,
      queue: s.queue,
      extensionUiRequests: s.extensionUiRequests,
      extensionUiRespondingId: s.extensionUiRespondingId,
      extensionDisplays: s.extensionDisplays,
      notices: s.notices,
      statuses: s.statuses,
      editorText: s.editorText,
      windowTitle: s.windowTitle,
      nextNoticeId: s.nextNoticeId,
    };
  }

  private applyEvent(event: WireEvent): void {
    if (event.type === "snapshot") {
      if (event.data) {
        // An authoritative push is the newest selection truth: invalidate any
        // open/new response still in flight so it cannot overwrite this. The
        // push also immediately releases the old opening marker; stale
        // finally blocks are fenced by their operation owner.
        this.selectionRequest += 1;
        this.releaseOpening();
        const snapshot = event.data as ActiveSnapshot;
        this.applySnapshot(snapshot);
        if (snapshot.active?.sessionId) this.ensureSessionVisible(snapshot.active.sessionId);
      }
      return;
    }

    // Every live event carries its authoritative per-session status; merge it
    // into the map before any transcript routing.
    const eventSessionId = typeof event.sessionId === "string" ? event.sessionId : null;
    if (eventSessionId) this.ensureSessionVisible(eventSessionId);
    const priorRunState = eventSessionId ? this.state.sessionStatuses[eventSessionId]?.runState : undefined;
    const sessionStatuses = this.mergeSessionStatus(eventSessionId, event.sessionStatus);
    if (eventSessionId) {
      if (event.type === "agent_start" || event.type === "auto_retry_start") {
        this.armAttention(eventSessionId, "agent");
      } else if (event.type === "compaction_start") {
        const nestedInAgent = this.hasAttentionArm(eventSessionId, "agent") ||
          priorRunState === "running" || priorRunState === "retrying" || priorRunState === "queued";
        if (event.reason === "manual" && !nestedInAgent) this.armAttention(eventSessionId, "compaction");
      } else if (event.type === "compaction_end") {
        if (this.consumeAttentionArm(eventSessionId, "compaction")) {
          this.attendToOutcome(eventSessionId, this.compactionOutcome(event));
        }
      } else if (event.type === "agent_settled") {
        if (this.consumeAttentionArm(eventSessionId, "agent")) {
          this.attendToOutcome(eventSessionId, this.statusOutcome(event));
        }
      } else if (event.type === "runtime_error") {
        const armed = this.consumeAttentionArm(eventSessionId, "agent") ||
          this.consumeAttentionArm(eventSessionId, "compaction");
        // Runtime death terminates every operation owned by this worker.
        this.attentionArms.delete(eventSessionId);
        if (armed) this.attendToOutcome(eventSessionId, "failed");
      }
    }

    if (eventSessionId !== null && eventSessionId !== this.state.sessionId) {
      // Background session: its message/tool/notice deltas must never enter
      // the visible transcript and must not resync it. Only the status
      // changes; a settle refreshes the list so folder/time ordering catches
      // up. Unchanged statuses (token-level chatter) publish nothing.
      if (sessionStatuses) this.set({ sessionStatuses });
      if (event.type === "runtime_ready" && eventSessionId === this.state.openingSessionId && this.openingOwner !== null) {
        this.readyWhileOpening.set(eventSessionId, this.openingOwner);
      }
      if (event.type === "runtime_error") this.readyWhileOpening.delete(eventSessionId);
      if (event.type === "agent_settled") void this.refreshLoadedSessions();
      return;
    }

    if (event.type === "tool_execution_end" && this.gitSurfaces.size > 0) {
      void this.refreshGitStatus();
    }

    if (event.type === "session_projection_changed") {
      const rawHealth = event.health as Partial<ProjectionHealth> | undefined;
      const health: ProjectionHealth = rawHealth?.status === "error"
        ? { status: "error", ...(typeof rawHealth.message === "string" ? { message: rawHealth.message } : {}) }
        : rawHealth?.status === "ok" ? { status: "ok" } : this.state.projectionHealth;
      const conflict = event.conflict === null
        ? null
        : event.conflict && typeof event.conflict === "object"
          ? event.conflict as ProjectionConflict
          : this.state.projectionConflict;
      const projectionError = conflict?.message ??
        (health.status === "error" ? health.message ?? "Session projection failed" : null);
      const projectionSeverity = projectionConflictSeverity(conflict) === "attention" ? "warning" : "error";
      const clearedProjectionError = !projectionError && this.state.error === this.state.projectionError;
      this.set({
        ...(sessionStatuses ? { sessionStatuses } : {}),
        ...(this.state.branchTree ? { branchTreeError: "Branch history is stale — refresh to use branch actions" } : {}),
        projectionHealth: health,
        projectionConflict: conflict,
        projectionError,
        ...(projectionError
          ? { error: projectionError, errorSeverity: projectionSeverity }
          : clearedProjectionError ? { error: null, errorSeverity: "error" } : {}),
      });
      const revision = typeof event.revision === "number" ? event.revision : undefined;
      void this.resync(eventSessionId ?? this.state.sessionId, this.selectionGeneration, revision);
      return;
    }

    if (event.type === "session_projection_conflict") {
      if (sessionStatuses) this.set({ sessionStatuses });
      const conflict = event.conflict as ProjectionConflict | undefined;
      if (typeof conflict?.message === "string") {
        this.set({
          projectionConflict: conflict,
          projectionError: conflict.message,
          runState: "conflict",
          error: conflict.message,
          errorSeverity: projectionConflictSeverity(conflict) === "attention" ? "warning" : "error",
        });
      }
      return;
    }

    // An unopened session is shown from its read-only Pi-file preview while
    // extensions initialize off the critical path. Replace that preview with
    // the worker's live state as soon as its own runtime becomes ready.
    if (event.type === "runtime_ready") {
      if (sessionStatuses) this.set({ sessionStatuses });
      void this.resync(eventSessionId, this.selectionGeneration);
      return;
    }

    const before = this.state.notices.length;
    const { slice, settle, resync, changed } = reduceEvent(this.eventSlice(), this.settledKeys, event);
    for (const key of settle) this.settledKeys.add(key);
    if (changed) {
      this.set(sessionStatuses ? { ...slice, sessionStatuses } : slice);
      for (const notice of slice.notices.slice(before)) {
        this.noticeTimers.set(
          notice.id,
          setTimeout(() => this.dismissNotice(notice.id), NOTICE_TTL_MS),
        );
      }
    } else if (sessionStatuses) {
      this.set({ sessionStatuses });
    }
    if (resync) void this.resync(eventSessionId ?? this.state.sessionId, this.selectionGeneration);
  }

  /** Merge an event's sessionStatus into the map; null when nothing changed. */
  private mergeSessionStatus(
    sessionId: string | null,
    status: unknown,
  ): Record<string, SessionRuntimeStatus> | null {
    if (!sessionId || !status || typeof status !== "object") return null;
    const record = status as Partial<SessionRuntimeStatus>;
    if (typeof record.runState !== "string") return null;
    const next: SessionRuntimeStatus = {
      runState: record.runState as RunState,
      ...(record.indicator ? { indicator: record.indicator } : {}),
    };
    const existing = this.state.sessionStatuses[sessionId];
    if (existing && existing.runState === next.runState && existing.indicator === next.indicator) return null;
    return { ...this.state.sessionStatuses, [sessionId]: next };
  }

  /** Authoritative reconcile after stream settlement or reconnect. */
  private async resync(
    expectedSessionId = this.state.sessionId,
    expectedGeneration = this.selectionGeneration,
    minimumRevision?: number,
    preserveAppendHistory = true,
  ): Promise<void> {
    if (!this.api) return;
    const request = ++this.resyncRequest;
    try {
      const snapshot = await this.api.snapshot();
      const snapshotSessionId = snapshot.active?.sessionId ?? null;
      const page = snapshot.active?.transcriptPage;
      if (
        request !== this.resyncRequest ||
        this.state.sessionId !== expectedSessionId ||
        this.selectionGeneration !== expectedGeneration ||
        snapshotSessionId !== expectedSessionId ||
        (minimumRevision !== undefined && (page?.revision ?? -1) < minimumRevision) ||
        (
          page?.incarnation &&
          page.incarnation === this.state.transcriptIncarnation &&
          page.revision < this.state.transcriptRevision
        )
      ) return;
      this.applySnapshot(snapshot, preserveAppendHistory ? "preserve" : "replace");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
      } else {
        const currentProjectionError = this.state.projectionError;
        this.fail(
          currentProjectionError ??
            (error instanceof Error ? `Failed to refresh session: ${error.message}` : "Failed to refresh session"),
          currentProjectionError && projectionConflictSeverity(this.state.projectionConflict) === "error"
            ? "error"
            : "warning",
        );
      }
    }
  }

  loadOlderMessages = async (): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const cursor = this.state.olderMessagesCursor;
    const revision = this.state.transcriptRevision;
    const viewId = this.state.transcriptViewId;
    const effectiveLeafId = this.state.transcriptEffectiveLeafId;
    const generation = this.selectionGeneration;
    if (!this.api || !sessionId || !cursor || !viewId || this.state.loadingOlderMessages) return false;
    const request = new AbortController();
    this.olderTranscriptRequest = request;
    this.set({ loadingOlderMessages: true, olderMessagesError: null });
    try {
      const page = await this.api.olderTranscript(sessionId, cursor, request.signal);
      if (
        this.state.sessionId !== sessionId ||
        this.selectionGeneration !== generation ||
        this.state.transcriptRevision !== revision ||
        this.state.transcriptViewId !== viewId ||
        this.state.transcriptEffectiveLeafId !== effectiveLeafId ||
        page.sessionId !== sessionId ||
        page.revision !== revision ||
        (page.viewId ?? viewId) !== viewId ||
        (page.effectiveLeafId ?? effectiveLeafId) !== effectiveLeafId
      ) return false;
      const existing = new Set(this.state.messages.map((message) => messageKey(message) ?? JSON.stringify(message)));
      const older = page.messages.map(asMessage).filter((message) => {
        const key = messageKey(message) ?? JSON.stringify(message);
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      for (const message of older) {
        const key = messageKey(message);
        if (key) this.settledKeys.add(key);
      }
      this.set({
        messages: [...older, ...this.state.messages],
        hasOlderMessages: page.hasOlder,
        olderMessagesCursor: page.olderCursor,
        olderMessagesError: null,
        error: this.state.projectionError,
      });
      return true;
    } catch (error) {
      if (request.signal.aborted || this.selectionGeneration !== generation || this.state.transcriptViewId !== viewId) {
        return false;
      }
      if (error instanceof ApiError && error.status === 409) {
        await this.resync(sessionId, generation, undefined, false);
      } else if (error instanceof ApiError && error.status === 401) {
        this.handleAuthFailure();
      } else {
        this.set({
          olderMessagesError: error instanceof Error ? error.message : "Failed to load earlier messages",
          ...(this.state.projectionError ? { error: this.state.projectionError } : {}),
        });
      }
      return false;
    } finally {
      if (this.olderTranscriptRequest === request) this.olderTranscriptRequest = null;
      if (
        this.state.sessionId === sessionId && this.selectionGeneration === generation &&
        this.state.transcriptViewId === viewId
      ) this.set({ loadingOlderMessages: false });
    }
  };

  // --- WebSocket lifecycle ---

  private connect(token: string | null): void {
    if (this.socket) {
      // Replacing a transport forfeits any operation evidence owned by it.
      this.attentionArms.clear();
      this.socket.close();
    }
    this.set({ connection: this.state.bootstrapped ? "reconnecting" : "connecting" });
    const socket = new WebSocket(eventsUrl(token));
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.reconnectDelay = 1_000;
      // The host pushes an authoritative snapshot as the first frame, so no
      // redundant HTTP resync is needed here.
      this.set({ connection: "open", connectionProblem: null });
    };
    socket.onmessage = (frame) => {
      if (this.socket !== socket) return;
      try {
        this.applyEvent(JSON.parse(String(frame.data)) as WireEvent);
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      // A later terminal event cannot be correlated across a lost stream.
      // The reconnect snapshot may remove stale state but must not recreate
      // ownership from historical active status.
      this.attentionArms.clear();
      this.branchTreeRequest += 1;
      this.branchActionRequest += 1;
      this.set({
        connection: "reconnecting",
        connectionProblem: { kind: "stream-interrupted" },
        branchTreeLoading: false,
        branchActionId: null,
        branchTreeError: this.state.branchTree ? "Branch history is stale — refresh after reconnecting" : null,
      });
      this.scheduleReconnect(token);
    };
    socket.onerror = () => socket.close();
  }

  private scheduleReconnect(token: string | null): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    this.reconnectTimer = setTimeout(() => {
      void this.init(token);
    }, delay);
  }

  retryConnection = (): void => {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = 1_000;
    void this.init(this.authToken);
  };

  // --- Sessions ---

  /** Publish the display union without letting curated/live hydration alter
   * the chronological cursor. Base rows always retain server order. */
  private publishSessionUnion(): void {
    const sessions: SessionSummary[] = [];
    const seen = new Set<string>();
    for (const session of this.sessionBasePages) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
    if (!this.state.sessionQuery.trim()) {
      for (const session of this.sessionHydration.values()) {
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        sessions.push(session);
      }
    }
    this.set({ sessions });
  }

  private curationIds(prefs: InspirePreferences): Set<string> {
    return new Set([...prefs.pinnedSessionIds, ...prefs.hiddenSessionIds]);
  }

  private hydrationFailure(kind: "session ids" | "curated folders", error: unknown): Error {
    const message = error instanceof Error ? error.message : "Unknown hydration failure";
    if (error instanceof ApiError) {
      return new ApiError(error.status, `Failed to hydrate ${kind}: ${message}`, error.matches);
    }
    return new Error(`Failed to hydrate ${kind}: ${message}`);
  }

  /** Hydration is a separate atomic union. During an optimistic preference
   * write, rows owned by the last confirmed curation remain until the host
   * accepts or rejects the patch. Every request stays within its route cap. */
  private async hydrateSessionUnion(
    base: readonly SessionSummary[],
    prefs: InspirePreferences,
    isCurrent: () => boolean,
  ): Promise<Map<string, SessionSummary> | null> {
    if (!this.api) return new Map();
    if (!isCurrent()) return null;
    const ids = this.curationIds(prefs);
    for (const id of this.curationIds(this.confirmedPrefs)) ids.add(id);
    if (this.state.sessionId) ids.add(this.state.sessionId);
    for (const id of Object.keys(this.state.sessionStatuses)) ids.add(id);
    const cwds = new Set([
      ...prefs.pinnedProjectCwds,
      ...prefs.hiddenProjectCwds,
      ...this.confirmedPrefs.pinnedProjectCwds,
      ...this.confirmedPrefs.hiddenProjectCwds,
    ]);
    const baseIds = new Set(base.map((session) => session.id));
    const hydration = new Map<string, SessionSummary>();
    for (const session of this.sessionHydration.values()) {
      if ((ids.has(session.id) || cwds.has(session.cwd)) && !baseIds.has(session.id)) {
        hydration.set(session.id, session);
      }
    }

    const missingIds = [...ids].filter((id) => !baseIds.has(id) && !hydration.has(id));
    for (let index = 0; index < missingIds.length; index += MAX_SESSION_ID_HYDRATION_IDS) {
      if (!isCurrent()) return null;
      const chunk = missingIds.slice(index, index + MAX_SESSION_ID_HYDRATION_IDS);
      try {
        const response = await this.api.sessionsByIds(chunk);
        if (!isCurrent()) return null;
        for (const session of response.sessions) {
          if (!baseIds.has(session.id)) hydration.set(session.id, session);
        }
      } catch (error) {
        throw this.hydrationFailure("session ids", error);
      }
    }

    const wantedCwds = [...cwds];
    for (let index = 0; index < wantedCwds.length; index += MAX_SESSION_CWD_HYDRATION_CWDS) {
      if (!isCurrent()) return null;
      const chunk = wantedCwds.slice(index, index + MAX_SESSION_CWD_HYDRATION_CWDS);
      try {
        const response = await this.api.sessionsByCwds(chunk);
        if (!isCurrent()) return null;
        for (const session of response.sessions) {
          if (!baseIds.has(session.id)) hydration.set(session.id, session);
        }
      } catch (error) {
        throw this.hydrationFailure("curated folders", error);
      }
    }
    return hydration;
  }

  private async requestSessionReset(
    query: string,
    ticket: number,
    preserveOffset = 0,
    preserveTotal = 0,
    operation: "reset" | "preserve" = "reset",
  ): Promise<void> {
    if (!this.api) return;
    try {
      const rows: SessionSummary[] = [];
      let page = await this.api.sessions(query, 0, preserveOffset > 0
        ? Math.min(MAX_SESSION_LIST_PAGE_SIZE, Math.max(1, preserveOffset))
        : SESSION_PAGE_SIZE);
      rows.push(...page.sessions);
      let nextOffset = page.offset + page.sessions.length;
      let total = page.total;
      if (ticket !== this.sessionLoadTicket || query !== this.state.sessionQuery) return;
      // New sessions inserted ahead of the old cursor must not displace an
      // already loaded row. Consume the positive total delta as well as the
      // prior extent; deletions simply stop at the new total.
      const targetOffset = preserveOffset > 0
        ? Math.min(total, preserveOffset + Math.max(0, total - preserveTotal))
        : 0;
      // A background settlement refreshes every already-consumed base row.
      // It therefore preserves the loaded extent without pretending a new
      // offset-zero page can safely describe an older cursor.
      while (targetOffset > 0 && nextOffset < targetOffset && nextOffset < total) {
        if (ticket !== this.sessionLoadTicket || query !== this.state.sessionQuery) return;
        const priorOffset = nextOffset;
        page = await this.api.sessions(
          query,
          nextOffset,
          Math.min(MAX_SESSION_LIST_PAGE_SIZE, targetOffset - nextOffset),
        );
        if (ticket !== this.sessionLoadTicket || query !== this.state.sessionQuery) return;
        rows.push(...page.sessions);
        nextOffset = page.offset + page.sessions.length;
        total = page.total;
        if (nextOffset <= priorOffset) {
          throw new Error(`Session refresh stopped at ${nextOffset} before the preserved extent ${targetOffset}`);
        }
      }
      if (ticket !== this.sessionLoadTicket || query !== this.state.sessionQuery) return;
      const prefs = this.state.prefs;
      const hydration = query.trim()
        ? new Map<string, SessionSummary>()
        : await this.hydrateSessionUnion(
            rows,
            prefs,
            () => ticket === this.sessionLoadTicket && query === this.state.sessionQuery,
          );
      if (!hydration || ticket !== this.sessionLoadTicket || query !== this.state.sessionQuery) return;
      const deduped: SessionSummary[] = [];
      const seen = new Set<string>();
      for (const session of rows) {
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        deduped.push(session);
      }
      this.sessionBasePages = deduped;
      this.sessionHydration = hydration;
      this.sessionListRetry = null;
      this.set({
        sessionListTotal: total,
        sessionListNextOffset: nextOffset,
        sessionListLoading: false,
        sessionListLoadingOlder: false,
        sessionListOperation: null,
        sessionListError: null,
      });
      this.publishSessionUnion();
    } catch (error) {
      if (ticket !== this.sessionLoadTicket || query !== this.state.sessionQuery) return;
      if (error instanceof ApiError && error.status === 401) {
        this.sessionListRetry = null;
        this.set({ sessionListLoading: false, sessionListLoadingOlder: false, sessionListOperation: null });
        this.handleAuthFailure();
        return;
      }
      this.sessionListRetry = operation === "preserve"
        ? { kind: "preserve", query, offset: preserveOffset, total: preserveTotal }
        : { kind: "reset", query };
      this.set({
        sessionListLoading: false,
        sessionListLoadingOlder: false,
        sessionListOperation: operation,
        sessionListError: error instanceof Error ? error.message : "Failed to list sessions",
      });
    }
  }

  /** Reset/latest-wins list load. Prior confirmed rows remain visible until
   * the replacement page and its curation hydration are both owned. */
  loadSessions = (query: string): Promise<void> => {
    if (!this.api) return Promise.resolve();
    const queryChanged = query !== this.state.sessionQuery;
    const ticket = ++this.sessionLoadTicket;
    // The prior append is now obsolete. It may still finish on the wire, but
    // it must neither block nor coalesce with this generation's append.
    this.sessionOlderPromise = null;
    this.sessionListRetry = null;
    if (queryChanged) this.sessionBasePages = [];
    this.set({
      ...(queryChanged
        ? {
            sessionQuery: query,
            sessions: query.trim() ? [] : [...this.sessionHydration.values()],
            sessionListTotal: 0,
            sessionListNextOffset: 0,
          }
        : {}),
      sessionListLoading: true,
      sessionListLoadingOlder: false,
      sessionListHydrating: false,
      sessionListOperation: "reset",
      sessionListError: null,
    });
    return this.requestSessionReset(query, ticket);
  };

  private preserveLoadedSessions = (
    query: string,
    preserveOffset: number,
    preserveTotal: number,
  ): Promise<void> => {
    if (!this.api || query !== this.state.sessionQuery) return Promise.resolve();
    const ticket = ++this.sessionLoadTicket;
    this.sessionOlderPromise = null;
    this.sessionListRetry = null;
    this.set({
      sessionListLoading: true,
      sessionListLoadingOlder: false,
      sessionListHydrating: false,
      sessionListOperation: "preserve",
      sessionListError: null,
    });
    return this.requestSessionReset(query, ticket, preserveOffset, preserveTotal, "preserve");
  };

  /** Background runtime hints preserve the consumed chronological extent by
   * refetching that extent from offset zero under one atomic generation. */
  private refreshLoadedSessions = (): Promise<void> => this.preserveLoadedSessions(
    this.state.sessionQuery,
    this.state.sessionListNextOffset,
    this.state.sessionListTotal,
  );

  loadOlderSessions = (retry?: Extract<SessionListRetry, { kind: "older" }>): Promise<void> => {
    if (!this.api) return Promise.resolve();
    if (retry && (retry.query !== this.state.sessionQuery || retry.offset !== this.state.sessionListNextOffset)) {
      if (this.sessionListRetry === retry) this.sessionListRetry = null;
      return Promise.resolve();
    }
    if (this.sessionOlderPromise) return this.sessionOlderPromise;
    if (this.state.sessionListLoading || this.state.sessionListLoadingOlder) return Promise.resolve();
    const offset = retry?.offset ?? this.state.sessionListNextOffset;
    if (offset >= this.state.sessionListTotal && !retry) return Promise.resolve();
    const query = retry?.query ?? this.state.sessionQuery;
    const ticket = ++this.sessionLoadTicket;
    this.sessionListRetry = null;
    this.set({
      sessionListLoadingOlder: true,
      sessionListHydrating: false,
      sessionListOperation: "older",
      sessionListError: null,
    });
    const request = (async () => {
      try {
        const page = await this.api!.sessions(query, offset, SESSION_PAGE_SIZE);
        if (ticket !== this.sessionLoadTicket || query !== this.state.sessionQuery) return;
        const seen = new Set(this.sessionBasePages.map((session) => session.id));
        const appended = [...this.sessionBasePages];
        for (const session of page.sessions) {
          if (seen.has(session.id)) continue;
          seen.add(session.id);
          appended.push(session);
        }
        this.sessionBasePages = appended;
        this.sessionListRetry = null;
        this.set({
          sessionListTotal: page.total,
          // Consumed server rows, including duplicate identities, own the
          // cursor. Rendered/union length is deliberately irrelevant.
          sessionListNextOffset: page.offset + page.sessions.length,
          sessionListLoadingOlder: false,
          sessionListOperation: null,
          sessionListError: null,
        });
        this.publishSessionUnion();
      } catch (error) {
        if (ticket !== this.sessionLoadTicket || query !== this.state.sessionQuery) return;
        if (error instanceof ApiError && error.status === 401) {
          this.sessionListRetry = null;
          this.set({ sessionListLoadingOlder: false, sessionListOperation: null });
          this.handleAuthFailure();
          return;
        }
        this.sessionListRetry = { kind: "older", query, offset };
        this.set({
          sessionListLoadingOlder: false,
          sessionListOperation: "older",
          sessionListError: error instanceof Error ? error.message : "Failed to load older sessions",
        });
      }
    })();
    const tracked = request.finally(() => {
      if (this.sessionOlderPromise === tracked) this.sessionOlderPromise = null;
    });
    this.sessionOlderPromise = tracked;
    return tracked;
  };

  private clearSessionHydrationRetry(): void {
    if (this.sessionListRetry?.kind === "hydrate") this.sessionListRetry = null;
  }

  private hydrationOwnerIsCurrent(owner: SessionHydrationOwner): boolean {
    const stillOwned = this.state.sessionId === owner.id || Object.hasOwn(this.state.sessionStatuses, owner.id);
    return stillOwned && !owner.query.trim() && owner.query === this.state.sessionQuery && owner.ticket === this.sessionLoadTicket;
  }

  private hydrationRetryMatches(owner: SessionHydrationOwner): boolean {
    const retry = this.sessionListRetry;
    return retry?.kind === "hydrate" && retry.owner.id === owner.id &&
      retry.owner.query === owner.query && retry.owner.ticket === owner.ticket;
  }

  private hydrateVisibleSession(
    owner: SessionHydrationOwner,
    retrying = false,
  ): Promise<void> {
    if (
      !this.api ||
      owner.query.trim() ||
      owner.query !== this.state.sessionQuery ||
      owner.ticket !== this.sessionLoadTicket ||
      (retrying && !this.hydrationOwnerIsCurrent(owner))
    ) return Promise.resolve();
    if (this.sessionBasePages.some((session) => session.id === owner.id) || this.sessionHydration.has(owner.id)) {
      if (this.hydrationRetryMatches(owner)) {
        this.clearSessionHydrationRetry();
        this.set({ sessionListHydrating: false, sessionListOperation: null, sessionListError: null });
      }
      return Promise.resolve();
    }
    if (this.sessionHydrationInFlight.has(owner.id)) return Promise.resolve();
    this.sessionHydrationInFlight.add(owner.id);
    if (retrying) {
      this.set({ sessionListHydrating: true, sessionListOperation: "hydrate", sessionListError: null });
    }
    const request = (async () => {
      try {
        const { sessions } = await this.api!.sessionsByIds([owner.id]);
        if (!this.hydrationOwnerIsCurrent(owner)) return;
        const session = sessions.find((candidate) => candidate.id === owner.id);
        if (!session) throw new Error("Session is not yet available in the catalog");
        if (!this.sessionBasePages.some((candidate) => candidate.id === owner.id)) {
          this.sessionHydration.set(owner.id, session);
        }
        const ownsHydrationRetry = this.hydrationRetryMatches(owner);
        if (ownsHydrationRetry) {
          this.clearSessionHydrationRetry();
          this.set({ sessionListHydrating: false, sessionListOperation: null, sessionListError: null });
        } else if (retrying) {
          this.set({ sessionListHydrating: false });
        }
        this.publishSessionUnion();
      } catch (error) {
        if (!this.hydrationOwnerIsCurrent(owner) || this.state.sessionListLoading || this.state.sessionListLoadingOlder) return;
        if (error instanceof ApiError && error.status === 401) {
          this.clearSessionHydrationRetry();
          this.set({ sessionListHydrating: false, sessionListOperation: null, sessionListError: null });
          this.handleAuthFailure();
          return;
        }
        this.sessionListRetry = { kind: "hydrate", owner };
        this.set({
          sessionListHydrating: false,
          sessionListOperation: "hydrate",
          sessionListError: this.hydrationFailure("session ids", error).message,
        });
      } finally {
        this.sessionHydrationInFlight.delete(owner.id);
      }
    })();
    return request;
  }

  private ensureSessionVisible(id: string): void {
    if (!this.api || this.state.sessionQuery.trim()) return;
    const owner = { id, query: this.state.sessionQuery, ticket: this.sessionLoadTicket };
    void this.hydrateVisibleSession(owner);
  }

  retrySessionList = (): Promise<void> => {
    const retry = this.sessionListRetry;
    if (!retry) return this.loadSessions(this.state.sessionQuery);
    switch (retry.kind) {
      case "older": return this.loadOlderSessions(retry);
      case "refresh": return this.refreshSessions(retry.query);
      case "preserve": return this.preserveLoadedSessions(retry.query, retry.offset, retry.total);
      case "reset": return this.loadSessions(retry.query);
      case "hydrate":
        if (!this.hydrationOwnerIsCurrent(retry.owner)) {
          this.clearSessionHydrationRetry();
          this.set({ sessionListHydrating: false, sessionListOperation: null, sessionListError: null });
          return Promise.resolve();
        }
        return this.hydrateVisibleSession(retry.owner, true);
    }
  };

  searchSessions = (query: string): void => {
    // Query ownership changes synchronously, before the debounce. Old-query
    // pages cannot remain rendered or win while the user is typing.
    ++this.sessionLoadTicket;
    this.sessionOlderPromise = null;
    this.sessionListRetry = null;
    this.sessionBasePages = [];
    this.set({
      sessionQuery: query,
      sessions: query.trim() ? [] : [...this.sessionHydration.values()],
      sessionListTotal: 0,
      sessionListNextOffset: 0,
      sessionListLoading: true,
      sessionListLoadingOlder: false,
      sessionListHydrating: false,
      sessionListOperation: "reset",
      sessionListError: null,
    });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.loadSessions(query), 180);
  };

  refreshSessions = async (retryQuery = this.state.sessionQuery): Promise<void> => {
    if (!this.api) return;
    if (retryQuery !== this.state.sessionQuery) {
      if (this.sessionListRetry?.kind === "refresh" && this.sessionListRetry.query === retryQuery) this.sessionListRetry = null;
      return;
    }
    const query = retryQuery;
    const ticket = ++this.sessionLoadTicket;
    this.sessionOlderPromise = null;
    this.sessionListRetry = null;
    this.set({
      sessionListLoading: true,
      sessionListLoadingOlder: false,
      sessionListHydrating: false,
      sessionListOperation: "refresh",
      sessionListError: null,
    });
    try {
      await this.api.refreshSessions();
      if (ticket !== this.sessionLoadTicket || query !== this.state.sessionQuery) return;
      await this.requestSessionReset(query, ticket);
    } catch (error) {
      if (ticket !== this.sessionLoadTicket || query !== this.state.sessionQuery) return;
      if (error instanceof ApiError && error.status === 401) {
        this.set({ sessionListLoading: false, sessionListOperation: null });
        this.handleAuthFailure();
      } else {
        this.sessionListRetry = { kind: "refresh", query };
        this.set({
          sessionListLoading: false,
          sessionListOperation: "refresh",
          sessionListError: error instanceof Error ? error.message : "Failed to refresh sessions",
        });
      }
    }
  };

  openSession = async (id: string): Promise<void> => {
    if (!this.api) return;
    // Re-selecting the already visible session is a no-op only when there is no
    // older operation to supersede. A newer intent must be able to invalidate
    // an in-flight open even when it points at the current session.
    if (id === this.state.sessionId && this.openingOwner === null) return;
    if (id === this.state.openingSessionId) return; // duplicate pending target
    this.invalidateBranchForSelectionIntent();
    this.set({ sessionActionError: null });
    const ticket = ++this.selectionRequest;
    this.claimOpening(ticket, id);
    try {
      const snapshot = await this.api.openSession(id);
      // A newer selection (another open/new, or an authoritative push) won the
      // race; this stale response must not reinstate its session.
      if (ticket !== this.selectionRequest || this.openingOwner !== ticket) return;
      this.applySnapshot(snapshot);
      this.ensureSessionVisible(id);
      this.set({ sessionActionError: null });
      if (this.readyWhileOpening.get(id) === ticket) {
        this.readyWhileOpening.delete(id);
        void this.resync(id, this.selectionGeneration);
      }
    } catch (error) {
      if (ticket === this.selectionRequest && this.openingOwner === ticket) {
        this.set({ sessionActionError: error instanceof Error ? error.message : "Failed to open session" });
      }
    } finally {
      if (this.readyWhileOpening.get(id) === ticket) this.readyWhileOpening.delete(id);
      this.releaseOpening(ticket);
    }
  };

  /** Creates a session. Never falls back to "/": without an active or explicit
   * project directory the caller must collect one (the welcome page does). */
  newSession = async (cwd?: string, nameOrOptions: string | NewSessionOptions = {}): Promise<string | null> => {
    if (!this.api) return null;
    const options = typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions;
    const target = cwd?.trim() || this.state.cwd;
    if (!target) {
      this.notify("warning", "Enter a project directory to start a session");
      return null;
    }
    this.invalidateBranchForSelectionIntent();
    this.set({ sessionActionError: null });
    const ticket = ++this.selectionRequest;
    // A new-session intent supersedes any opener immediately. There is no
    // destination id to show until the host returns the new session identity,
    // but the old opening owner must not remain visible during that handoff.
    this.claimOpening(ticket, null);
    try {
      const snapshot = await this.api.newSession(target, options);
      if (ticket !== this.selectionRequest || this.openingOwner !== ticket) return null; // superseded by a newer selection
      this.applySnapshot(snapshot);
      const sessionId = snapshot.active?.sessionId ?? null;
      if (sessionId) this.ensureSessionVisible(sessionId);
      if (options.model) this.rememberModel(options.model);
      this.set({ sessionActionError: null });
      void this.refreshLoadedSessions();
      return sessionId;
    } catch (error) {
      if (ticket === this.selectionRequest && this.openingOwner === ticket) {
        this.set({ sessionActionError: error instanceof Error ? error.message : "Failed to create session" });
      }
      return null;
    } finally {
      this.releaseOpening(ticket);
    }
  };

  renameSession = async (sessionId: string, name: string): Promise<boolean> => {
    if (!this.api || !sessionId || !name.trim()) return false;
    const trimmedName = name.trim();
    try {
      await this.api.renameSession(sessionId, trimmedName);
      // The response may return after a session switch; only the owning
      // session's visible title updates.
      if (this.state.sessionId === sessionId) this.set({ sessionName: trimmedName });
      void this.refreshLoadedSessions();
      return true;
    } catch (error) {
      // A background rename must not surface its failure over another visible
      // session. The caller still receives false for its owning editor.
      if (this.state.sessionId === sessionId) {
        this.notify("warning", error instanceof Error ? error.message : "Failed to rename session");
      }
      return false;
    }
  };

  clearSessionDeleteError = (): void => this.set({ sessionDeleteError: null });

  deleteSession = async (sessionId: string): Promise<SessionDeleteDisposition | null> => {
    if (
      !this.api || this.state.deletingSessionId || sessionId === this.state.sessionId ||
      !this.state.prefs.hiddenSessionIds.includes(sessionId)
    ) return null;
    const preserveQuery = this.state.sessionQuery;
    const preserveOffset = this.state.sessionListNextOffset;
    const preserveTotal = this.state.sessionListTotal;
    this.set({ deletingSessionId: sessionId, sessionDeleteError: null });
    try {
      // Hiding is an optimistic preference write. Fence it before DELETE so a
      // late PATCH cannot resurrect the deleted id in durable navigation data.
      await this.prefsWrites;
      if (!this.state.prefs.hiddenSessionIds.includes(sessionId)) {
        this.set({ sessionDeleteError: "The session must remain in Hidden before it can be deleted" });
        return null;
      }
      const result = await this.api.deleteSession(sessionId);
      this.sessionBasePages = this.sessionBasePages.filter((session) => session.id !== sessionId);
      this.sessionHydration.delete(sessionId);
      this.sessionHydrationInFlight.delete(sessionId);
      this.attentionArms.delete(sessionId);
      this.titleAttention.delete(sessionId);
      this.publishTitleAttention();
      const sessionStatuses = { ...this.state.sessionStatuses };
      delete sessionStatuses[sessionId];

      const fallbackPrefs = {
        ...this.state.prefs,
        pinnedSessionIds: this.state.prefs.pinnedSessionIds.filter((id) => id !== sessionId),
        hiddenSessionIds: this.state.prefs.hiddenSessionIds.filter((id) => id !== sessionId),
      };
      const prefs = result.preferences ?? fallbackPrefs;
      if (result.preferences) this.confirmedPrefs = result.preferences;
      this.discardSessionComposer(sessionId);
      this.set({ prefs, sessionStatuses });
      this.publishSessionUnion();
      this.notify("info", result.disposition === "trashed" ? "Session moved to Trash" : "Session permanently deleted");
      if (result.preferenceCleanupFailed) {
        this.notify("warning", "Session was deleted, but its navigation metadata could not be saved");
      }
      // Rebuild the already-consumed chronological extent under one fresh
      // generation. The optimistic row removal keeps the destructive result
      // immediate while offset-based pagination is repaired authoritatively.
      void this.preserveLoadedSessions(preserveQuery, preserveOffset, preserveTotal);
      return result.disposition;
    } catch (error) {
      this.set({ sessionDeleteError: error instanceof Error ? error.message : "Failed to delete session" });
      return null;
    } finally {
      if (this.state.deletingSessionId === sessionId) this.set({ deletingSessionId: null });
    }
  };

  // --- Prompting ---

  sendPrompt = async (message: string, behavior?: "steer" | "followUp"): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return false;
    const composer = this.composerFor(sessionId);
    if (composer.sending) return false;
    if (composer.attachments.some((item) => item.status === "uploading")) {
      this.notify("warning", "Attachments are still uploading");
      return false;
    }
    if (composer.attachments.some((item) => item.status === "error")) {
      this.notify("warning", "Remove failed attachments before sending");
      return false;
    }
    const included = composer.attachments;
    const attachmentIds = included
      .map((item) => item.uploadedId)
      .filter((id): id is string => Boolean(id));
    const projectFiles = composer.projectFiles;
    if (!message.trim() && attachmentIds.length === 0 && projectFiles.length === 0) return false;
    composer.sending = true;
    this.publishComposer(sessionId);
    try {
      await this.api.prompt({
        sessionId,
        message,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(projectFiles.length > 0 ? { projectFiles } : {}),
        behavior,
      });
      // Accepted: clear exactly what was delivered, from the owner session's
      // partition — never from whichever session is visible by now.
      // Artifacts staged while the request was in flight belong to the next
      // message. Failures keep everything.
      const sentIds = new Set(included.map((item) => item.localId));
      const sentPaths = new Set(projectFiles);
      for (const item of composer.attachments) {
        if (!sentIds.has(item.localId)) continue;
        if (item.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(item.previewUrl);
      }
      composer.attachments = composer.attachments.filter((item) => !sentIds.has(item.localId));
      composer.projectFiles = composer.projectFiles.filter((path) => !sentPaths.has(path));
      // A background completion may clear only an error owned by its visible
      // session; another session's alert is an independent surface.
      if (this.state.sessionId === sessionId) this.set({ error: null });
      return true;
    } catch (error) {
      // Keep failures attached to the session that sent the prompt. A switch
      // before the HTTP result arrives must not overwrite the new session's
      // visible error.
      if (this.state.sessionId === sessionId) {
        this.fail(error instanceof Error ? error.message : "Failed to send");
      }
      return false;
    } finally {
      composer.sending = false;
      this.pruneComposer(sessionId, composer);
      this.publishComposer(sessionId);
    }
  };

  abort = async (): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return;
    try {
      await this.api.abort(sessionId);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to abort");
    }
  };

  private rememberModel(model: ModelIdentity): void {
    const recentModelIds = [
      model,
      ...this.state.prefs.recentModelIds.filter((candidate) => modelIdentityKey(candidate) !== modelIdentityKey(model)),
    ].slice(0, 8);
    this.savePrefs({ recentModelIds });
  }

  setModel = async (provider: string, modelId: string): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return;
    try {
      await this.api.setModel(sessionId, provider, modelId);
      // Recency records only successful runtime changes. Keep unavailable
      // identities in the source preference; the picker filters its display.
      this.rememberModel({ provider, id: modelId });
      await this.resync(sessionId, this.selectionGeneration);
    } catch (error) {
      this.notify("warning", error instanceof Error ? error.message : "Failed to set model");
    }
  };

  setThinkingLevel = async (level: string): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return;
    const previous = this.state.thinkingLevel;
    this.set({ thinkingLevel: level });
    try {
      await this.api.setThinkingLevel(sessionId, level);
    } catch (error) {
      // Truthful control: a rejected change cannot leave the UI claiming it —
      // but only roll back if that session is still visible. After a switch
      // the visible level belongs to another session and must stay untouched.
      if (this.state.sessionId === sessionId) {
        this.set({ thinkingLevel: previous });
        void this.resync();
      }
      this.notify("warning", error instanceof Error ? error.message : "Failed to set thinking level");
    }
  };

  // --- Composer attachments & project files ---

  /** Authoritative per-session composer partitions; AppState carries only
   * the visible session's slice. */
  private readonly composers = new Map<string, ComposerPartition>();

  private discardSessionComposer(sessionId: string): void {
    const composer = this.composers.get(sessionId);
    if (composer) {
      for (const attachment of composer.attachments) {
        if (attachment.previewUrl && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        if (attachment.uploadedId) void this.api?.deleteAttachment(attachment.uploadedId).catch(() => undefined);
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

  private composerFor(sessionId: string): ComposerPartition {
    let composer = this.composers.get(sessionId);
    if (!composer) {
      composer = { attachments: [], projectFiles: [], sending: false };
      this.composers.set(sessionId, composer);
    }
    return composer;
  }

  private composerSlice(sessionId: string | null): Pick<AppState, "attachments" | "projectFiles" | "sending"> {
    const composer = sessionId ? this.composers.get(sessionId) : undefined;
    return composer
      ? { attachments: composer.attachments, projectFiles: composer.projectFiles, sending: composer.sending }
      : { attachments: [], projectFiles: [], sending: false };
  }

  private pruneComposer(sessionId: string, composer: ComposerPartition): void {
    if (!composer.sending && composer.attachments.length === 0 && composer.projectFiles.length === 0) {
      this.composers.delete(sessionId);
    }
  }

  /** Republish a partition into visible state when it belongs to the
   * visible session; background sessions' staged work stays put. */
  private publishComposer(sessionId: string): void {
    if (this.state.sessionId !== sessionId) return;
    this.set(this.composerSlice(sessionId));
  }

  addFiles = async (files: File[]): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId || files.length === 0) return;
    const composer = this.composerFor(sessionId);
    const room = MAX_ATTACHMENTS - composer.attachments.length;
    const accepted = files.slice(0, Math.max(0, room));
    if (accepted.length < files.length) this.notify("warning", `At most ${MAX_ATTACHMENTS} attachments per message`);
    if (accepted.length === 0) return;

    const pending: PendingAttachment[] = accepted.map((file) => {
      const isImage = /^image\//i.test(file.type);
      return {
        localId: crypto.randomUUID(),
        fileName: file.name || "pasted-image",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind: isImage ? ("image" as const) : ("file" as const),
        previewUrl:
          isImage && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined,
        status: "uploading" as const,
      };
    });
    composer.attachments = [...composer.attachments, ...pending];
    this.publishComposer(sessionId);

    try {
      const { attachments: uploaded } = await this.api.uploadAttachments(accepted);
      composer.attachments = composer.attachments.map((item) => {
        const index = pending.findIndex((candidate) => candidate.localId === item.localId);
        const result = index >= 0 ? uploaded[index] : undefined;
        return result
          ? { ...item, status: "ready" as const, uploadedId: result.id, fileName: result.fileName, kind: result.kind }
          : item;
      });
      this.publishComposer(sessionId);
      // An item removed while its upload was in flight never got a chance to
      // delete its host copy; reclaim it now.
      pending.forEach((candidate, index) => {
        const id = uploaded[index]?.id;
        if (id && !composer.attachments.some((item) => item.localId === candidate.localId)) {
          void this.api?.deleteAttachment(id).catch(() => undefined);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      composer.attachments = composer.attachments.map((item) =>
        pending.some((candidate) => candidate.localId === item.localId)
          ? { ...item, status: "error" as const, error: message }
          : item,
      );
      this.publishComposer(sessionId);
    }
  };

  removeAttachment = (localId: string): void => {
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    const composer = this.composers.get(sessionId);
    if (!composer) return;
    // Frozen while a prompt is delivering: the host may be resolving these
    // very files into the outgoing message.
    if (composer.sending) return;
    const target = composer.attachments.find((item) => item.localId === localId);
    if (target?.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(target.previewUrl);
    composer.attachments = composer.attachments.filter((item) => item.localId !== localId);
    this.pruneComposer(sessionId, composer);
    this.publishComposer(sessionId);
    // A withdrawn upload is unreferenced; reclaim its host cache file too.
    if (target?.uploadedId) void this.api?.deleteAttachment(target.uploadedId).catch(() => undefined);
  };

  addProjectFile = (path: string): void => {
    const sessionId = this.state.sessionId;
    if (!sessionId || !path) return;
    const composer = this.composerFor(sessionId);
    if (composer.sending || composer.projectFiles.includes(path)) return;
    if (composer.projectFiles.length >= MAX_PROJECT_FILES) {
      this.notify("warning", `At most ${MAX_PROJECT_FILES} project files per message`);
      return;
    }
    composer.projectFiles = [...composer.projectFiles, path];
    this.publishComposer(sessionId);
  };

  removeProjectFile = (path: string): void => {
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    const composer = this.composers.get(sessionId);
    if (!composer) return;
    // Frozen while delivering: a sent path removed and re-added mid-flight
    // would otherwise be swept by the delivery's scoped clear.
    if (composer.sending) return;
    composer.projectFiles = composer.projectFiles.filter((item) => item !== path);
    this.pruneComposer(sessionId, composer);
    this.publishComposer(sessionId);
  };

  searchProjectFiles = async (query: string): Promise<ProjectFileResult[]> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return [];
    const result = await this.api.searchFiles(sessionId, query);
    return result.files;
  };

  resolveNewSessionDefaults = async (cwd: string): Promise<NewSessionDefaults> => {
    if (!this.api) throw new Error("Not connected to the insπre host");
    return this.api.newSessionDefaults(cwd);
  };

  searchNewSessionProjectFiles = async (cwd: string, query: string): Promise<ProjectFileResult[]> => {
    if (!this.api) return [];
    const result = await this.api.searchNewSessionFiles(cwd, query);
    return result.files.map((file) => ({ ...file, workspaceCwd: result.cwd }));
  };

  /** One level of the workspace explorer; failures read as an empty level. */
  listProjectDirectory = async (dir: string): Promise<ProjectDirEntry[]> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return [];
    try {
      return (await this.api.listFiles(sessionId, dir)).entries;
    } catch {
      return [];
    }
  };

  /** Filesystem roots for cross-volume navigation in the host picker. */
  browseHostRoots = async (): Promise<HostRootsResponse> => {
    if (!this.api) throw new Error("Not connected to the insπre host");
    return this.api.browseHostRoots();
  };

  /** One level of the host directory picker; the dialog renders failures. */
  browseHostDirs = async (path?: string): Promise<HostDirListing> => {
    if (!this.api) throw new Error("Not connected to the insπre host");
    return this.api.browseHostDirs(path);
  };

  // --- Extension UI ---

  respondExtensionUi = async (payload: Record<string, unknown>): Promise<void> => {
    if (!this.api || this.state.extensionUiRespondingId) return;
    const request = this.state.extensionUiRequests[0];
    if (!request || payload.id !== request.id) return;
    this.set({ extensionUiRespondingId: request.id });
    try {
      await this.api.respondExtensionUi({ ...payload, sessionId: request.sessionId });
      if (this.state.sessionId === request.sessionId) {
        this.set({
          extensionUiRequests: this.state.extensionUiRequests.filter((candidate) => candidate.id !== request.id),
        });
      }
    } catch (error) {
      // Expiry, settle, replacement, or a successful duplicate response may
      // remove the owning request before the HTTP result arrives. That stale
      // completion must not turn a later dialog into a global error.
      if (
        this.state.sessionId === request.sessionId &&
        this.state.extensionUiRequests.some((candidate) => candidate.id === request.id)
      ) {
        this.fail(error instanceof Error ? error.message : "Failed to answer the extension");
      }
    } finally {
      if (this.state.extensionUiRespondingId === request.id) this.set({ extensionUiRespondingId: null });
    }
  };

  dismissNotice = (id: number): void => {
    const timer = this.noticeTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.noticeTimers.delete(id);
    }
    if (!this.state.notices.some((notice) => notice.id === id)) return;
    this.set({ notices: this.state.notices.filter((notice) => notice.id !== id) });
  };

  // --- Preferences ---

  /** Preference writes queue behind one another so field patches reach the
   * host in the order the user made them; each patch carries only its own
   * fields, so out-of-order arrival can no longer resurrect stale values. */
  private prefsWrites: Promise<unknown> = Promise.resolve();
  /** The last preferences the host confirmed. Rollback restores from here
   * rather than from whatever was on screen when a write started: with two
   * refused writes in a row, that earlier screen value was itself never
   * persisted, and restoring it would show a preference no reload can keep. */
  private confirmedPrefs: InspirePreferences = defaultPreferences;

  private isCurationPatch(patch: Partial<InspirePreferences>): boolean {
    return "pinnedSessionIds" in patch || "hiddenSessionIds" in patch || "pinnedProjectCwds" in patch || "hiddenProjectCwds" in patch;
  }

  private curationChanged(): void {
    if (!this.api) return;
    // Relevant preference changes own a new reset generation. Until it lands,
    // the previous rendered union (including confirmed curated rows) remains.
    void this.loadSessions(this.state.sessionQuery);
  }

  private savePrefs(patch: Partial<InspirePreferences>): void {
    const curationPatch = this.isCurationPatch(patch);
    this.set({ prefs: { ...this.state.prefs, ...patch } });
    if (curationPatch) this.curationChanged();
    this.prefsWrites = this.prefsWrites
      .then(async () => {
        if (!this.api) return;
        await this.api.savePreferences(patch);
        this.confirmedPrefs = { ...this.confirmedPrefs, ...patch };
        if (curationPatch) this.curationChanged();
      })
      .catch((error: unknown) => {
        // Truthful control: a refused write cannot leave a control claiming
        // its change. Only fields still carrying this patch's value roll
        // back — anything a newer local edit has replaced belongs to that
        // edit and its own write.
        const stale = (Object.keys(patch) as Array<keyof InspirePreferences>).filter(
          (field) => this.state.prefs[field] === patch[field],
        );
        if (stale.length > 0) {
          const restored = Object.fromEntries(
            stale.map((field) => [field, this.confirmedPrefs[field]]),
          ) as Partial<InspirePreferences>;
          this.set({ prefs: { ...this.state.prefs, ...restored } });
        }
        if (curationPatch) this.curationChanged();
        this.notify("warning", error instanceof Error ? error.message : "Failed to save the preference");
      });
  }

  setTheme = (theme: ThemePreference): void => this.savePrefs({ theme });
  setLaunch = (launch: LaunchPreference): void => this.savePrefs({ launch });
  setCompletionAttention = async (completionAttention: CompletionAttentionPreference): Promise<boolean> => {
    if (completionAttention === "desktop") {
      const NotificationApi = typeof window !== "undefined" ? window.Notification : undefined;
      if (!NotificationApi) {
        this.notify("warning", "Desktop notifications are not supported by this browser");
        return false;
      }
      let permission = NotificationApi.permission;
      if (permission !== "granted") {
        try {
          // This method is called directly from the Settings selection gesture;
          // never request permission during bootstrap or background events.
          permission = await NotificationApi.requestPermission();
        } catch {
          this.notify("warning", "The browser could not request notification permission");
          return false;
        }
      }
      if (permission !== "granted") {
        this.notify("warning", permission === "denied" ? "Desktop notification permission was denied" : "Desktop notification permission was not granted");
        return false;
      }
    }
    if (completionAttention !== "title") {
      this.titleAttention.clear();
      this.publishTitleAttention();
    }
    this.savePrefs({ completionAttention });
    return true;
  };
  setProjectDisplay = (projectDisplay: ProjectDisplayPreference): void => this.savePrefs({ projectDisplay });
  setThinkingVisibility = (thinkingVisibility: VisibilityPreference): void =>
    this.savePrefs({ thinkingVisibility });
  setToolVisibility = (toolVisibility: ToolVisibilityPreference): void => this.savePrefs({ toolVisibility });
  setAssistantRoundDisplay = (assistantRoundDisplay: AssistantRoundDisplayPreference): void =>
    this.savePrefs({ assistantRoundDisplay });

  toggleNavGroup = (cwd: string): void => {
    const current = this.state.prefs.navCollapsedGroups;
    const navCollapsedGroups = current.includes(cwd) ? current.filter((item) => item !== cwd) : [...current, cwd];
    this.savePrefs({ navCollapsedGroups });
  };

  /** Pin and Hidden are mutually exclusive, and both are one patch: the two
   * identity lists move together so navigation can never file a session in
   * two sections at once. */
  toggleSessionPin = (id: string): void => {
    const { pinnedSessionIds, hiddenSessionIds } = this.state.prefs;
    const pinned = pinnedSessionIds.includes(id);
    this.savePrefs({
      pinnedSessionIds: pinned
        ? pinnedSessionIds.filter((candidate) => candidate !== id)
        : [id, ...pinnedSessionIds],
      ...(!pinned && hiddenSessionIds.includes(id)
        ? { hiddenSessionIds: hiddenSessionIds.filter((candidate) => candidate !== id) }
        : {}),
    });
  };

  toggleSessionHidden = (id: string): void => {
    const { pinnedSessionIds, hiddenSessionIds } = this.state.prefs;
    const hidden = hiddenSessionIds.includes(id);
    this.savePrefs({
      hiddenSessionIds: hidden
        ? hiddenSessionIds.filter((candidate) => candidate !== id)
        : [id, ...hiddenSessionIds],
      ...(!hidden && pinnedSessionIds.includes(id)
        ? { pinnedSessionIds: pinnedSessionIds.filter((candidate) => candidate !== id) }
        : {}),
    });
  };

  /** Folder pin/Hidden state uses the exact cwd identity navigation already
   * groups by. The two states are mutually exclusive without touching any
   * per-session curation. */
  toggleProjectPin = (cwd: string): void => {
    const { pinnedProjectCwds, hiddenProjectCwds } = this.state.prefs;
    const pinned = pinnedProjectCwds.includes(cwd);
    this.savePrefs({
      pinnedProjectCwds: pinned
        ? pinnedProjectCwds.filter((item) => item !== cwd)
        : [cwd, ...pinnedProjectCwds],
      ...(!pinned && hiddenProjectCwds.includes(cwd)
        ? { hiddenProjectCwds: hiddenProjectCwds.filter((item) => item !== cwd) }
        : {}),
    });
  };

  toggleProjectHidden = (cwd: string): void => {
    const { pinnedProjectCwds, hiddenProjectCwds } = this.state.prefs;
    const hidden = hiddenProjectCwds.includes(cwd);
    this.savePrefs({
      hiddenProjectCwds: hidden
        ? hiddenProjectCwds.filter((item) => item !== cwd)
        : [cwd, ...hiddenProjectCwds],
      ...(!hidden && pinnedProjectCwds.includes(cwd)
        ? { pinnedProjectCwds: pinnedProjectCwds.filter((item) => item !== cwd) }
        : {}),
    });
  };

  // --- Files/resources pane ---

  setResourcesOpen = (resourcesOpen: boolean): void => {
    if (!resourcesOpen) {
      this.clearResourceSelection();
      this.cancelGitDiffRequest();
      this.set({ selectedGitPathId: null, selectedGitSide: null, gitDiff: null });
    }
    this.set({ resourcesOpen });
  };

  setContextMode = (contextMode: "files" | "changes" | "branches"): void => {
    this.set({ contextMode, detailMode: contextMode === "changes" ? "diff" : "file" });
    if (contextMode === "changes") void this.refreshGitStatus();
    if (contextMode === "branches") void this.loadBranchTree();
  };

  private ownsBranchView(ticket: {
    sessionId: string;
    generation: number;
    viewId: string | null;
    effectiveLeafId: string | null;
    selectionRequest: number;
  }): boolean {
    return this.state.sessionId === ticket.sessionId &&
      this.selectionGeneration === ticket.generation &&
      this.state.transcriptViewId === ticket.viewId &&
      this.state.transcriptEffectiveLeafId === ticket.effectiveLeafId &&
      this.selectionRequest === ticket.selectionRequest;
  }

  loadBranchTree = async (): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId || this.state.branchTreeLoading) return;
    const request = ++this.branchTreeRequest;
    const transportGeneration = this.transportGeneration;
    const ticket = {
      sessionId,
      generation: this.selectionGeneration,
      viewId: this.state.transcriptViewId,
      effectiveLeafId: this.state.transcriptEffectiveLeafId,
      selectionRequest: this.selectionRequest,
    };
    this.set({ branchTreeLoading: true, branchTreeError: null });
    try {
      const tree = await this.api.branchTree(sessionId);
      if (request !== this.branchTreeRequest || !this.ownsBranchView(ticket)) return;
      if (tree.sessionId !== ticket.sessionId || tree.effectiveLeafId !== ticket.effectiveLeafId) {
        this.set({ branchTreeError: "Branch history belongs to a different view — refresh the session before using branch actions" });
        return;
      }
      this.set({ branchTree: tree, branchTreeError: null });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (transportGeneration === this.transportGeneration) this.handleAuthFailure();
        return;
      }
      if (request !== this.branchTreeRequest || !this.ownsBranchView(ticket)) return;
      this.set({ branchTreeError: error instanceof Error ? error.message : "Failed to load branch history" });
    } finally {
      if (request === this.branchTreeRequest && this.ownsBranchView(ticket)) this.set({ branchTreeLoading: false });
    }
  };

  private branchActionsBlocked(): boolean {
    return Boolean(
      this.state.branchActionId ||
      this.state.branchTreeLoading ||
      this.state.branchTreeError ||
      this.state.branchTree?.health.status === "error" ||
      this.state.projectionHealth.status === "error" ||
      this.state.projectionConflict
    );
  }

  navigateBranch = async (targetId: string, mode: "switch" | "edit"): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const tree = this.state.branchTree;
    if (!this.api || !sessionId || !tree || this.branchActionsBlocked()) return false;
    const actionId = `${mode}:${targetId}`;
    const actionRequest = ++this.branchActionRequest;
    const transportGeneration = this.transportGeneration;
    const ticket = {
      sessionId,
      generation: this.selectionGeneration,
      viewId: this.state.transcriptViewId,
      effectiveLeafId: this.state.transcriptEffectiveLeafId,
      selectionRequest: this.selectionRequest,
    };
    const owns = (): boolean => actionRequest === this.branchActionRequest && this.ownsBranchView(ticket);
    this.set({ branchActionId: actionId, branchTreeError: null });
    try {
      const response = await this.api.navigateBranch({ sessionId, revision: tree.revision, targetId, mode });
      if (!owns()) return false;
      this.applySnapshot(response.snapshot);
      if (response.editorText !== undefined) {
        this.set({ editorText: { text: response.editorText, nonce: (this.state.editorText?.nonce ?? 0) + 1 } });
      }
      await this.loadBranchTree();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (transportGeneration === this.transportGeneration) this.handleAuthFailure();
        return false;
      }
      if (!owns()) return false;
      const message = error instanceof Error ? error.message : "Branch navigation failed";
      this.set({ branchTreeError: message });
      return false;
    } finally {
      if (owns() && this.state.branchActionId === actionId) this.set({ branchActionId: null });
    }
  };

  /** Fork directly from a settled transcript input. The tree is still the
   * revision/capability authority; the bubble supplies only its owning entry
   * id and never bypasses the normal branch validation path. */
  forkFromEntry = async (targetId: string): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    if (!sessionId || !targetId) return false;
    await this.loadBranchTree();
    if (this.state.sessionId !== sessionId) return false;
    const node = this.state.branchTree?.nodes.find((candidate) => candidate.id === targetId);
    if (!node?.canFork) {
      this.notify("warning", this.state.branchTreeError ?? "That input is no longer available to fork");
      return false;
    }
    const forked = await this.forkBranch(targetId);
    if (!forked && this.state.sessionId === sessionId) {
      this.notify("warning", this.state.branchTreeError ?? "Fork failed");
    }
    return forked;
  };

  forkBranch = async (targetId: string): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    const tree = this.state.branchTree;
    if (!this.api || !sessionId || !tree || this.branchActionsBlocked()) return false;
    const actionId = `fork:${targetId}`;
    const selectionRequest = ++this.selectionRequest;
    const actionRequest = ++this.branchActionRequest;
    const transportGeneration = this.transportGeneration;
    const ticket = {
      sessionId,
      generation: this.selectionGeneration,
      viewId: this.state.transcriptViewId,
      effectiveLeafId: this.state.transcriptEffectiveLeafId,
      selectionRequest,
    };
    const owns = (): boolean => actionRequest === this.branchActionRequest && this.ownsBranchView(ticket);
    this.set({ branchActionId: actionId, branchTreeError: null });
    try {
      const response = await this.api.forkBranch({ sessionId, revision: tree.revision, targetId });
      if (!owns()) return false;
      this.applySnapshot(response.snapshot);
      this.ensureSessionVisible(response.sessionId);
      this.set({ editorText: { text: response.editorText, nonce: (this.state.editorText?.nonce ?? 0) + 1 } });
      void this.refreshLoadedSessions();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (transportGeneration === this.transportGeneration) this.handleAuthFailure();
        return false;
      }
      if (!owns()) return false;
      const message = error instanceof Error ? error.message : "Fork failed";
      this.set({ branchTreeError: message });
      return false;
    } finally {
      if (owns() && this.state.branchActionId === actionId) this.set({ branchActionId: null });
    }
  };

  setGitSurfaceVisible = (surface: string, visible: boolean): void => {
    if (visible) this.gitSurfaces.add(surface);
    else this.gitSurfaces.delete(surface);
    if (this.gitSurfaces.size > 0) {
      if (!this.gitRefreshTimer) {
        this.gitRefreshTimer = setInterval(() => void this.refreshGitStatus(), 4_000);
      }
      void this.refreshGitStatus();
    } else {
      if (this.gitRefreshTimer) clearInterval(this.gitRefreshTimer);
      this.gitRefreshTimer = null;
      this.gitRefreshQueued = false;
      this.gitStatusRequest?.abort();
      this.gitStatusRequest = null;
      if (this.state.gitStatusLoading || this.state.gitStatusRefreshing) {
        this.set({ gitStatusLoading: false, gitStatusRefreshing: false });
      }
    }
  };

  refreshGitStatus = (): Promise<void> => {
    if (!this.api || !this.state.sessionId) return Promise.resolve();
    if (this.gitStatusPromise) {
      this.gitRefreshQueued = true;
      return this.gitStatusPromise;
    }
    this.gitStatusPromise = this.runGitStatusRefresh().finally(() => {
      this.gitStatusPromise = null;
    });
    return this.gitStatusPromise;
  };

  private async runGitStatusRefresh(): Promise<void> {
    do {
      this.gitRefreshQueued = false;
      const sessionId = this.state.sessionId;
      const generation = this.selectionGeneration;
      if (!this.api || !sessionId) return;
      const request = new AbortController();
      this.gitStatusRequest = request;
      this.set({
        gitStatusLoading: this.state.gitStatus === null,
        gitStatusRefreshing: this.state.gitStatus !== null,
      });
      try {
        const status = await this.api.gitStatus(sessionId, request.signal);
        if (
          this.gitStatusRequest !== request ||
          request.signal.aborted ||
          this.state.sessionId !== sessionId ||
          this.selectionGeneration !== generation
        ) continue;
        const selectedExists = status.kind === "repository" && status.files.some((file) =>
          file.path.id === this.state.selectedGitPathId && (
            file.conflict ||
            (this.state.selectedGitSide === "staged" ? file.staged : file.unstaged || file.untracked)
          ),
        );
        const selectedPathId = this.state.selectedGitPathId;
        const selectedSide = this.state.selectedGitSide;
        const refreshSelectedDiff = Boolean(
          selectedExists && selectedPathId && selectedSide &&
          this.state.resourcesOpen && this.state.contextMode === "changes" && this.state.detailMode === "diff",
        );
        this.set({
          gitStatus: status,
          gitStatusError: null,
          ...(!selectedExists && selectedPathId
            ? { selectedGitPathId: null, selectedGitSide: null, gitDiff: null }
            : {}),
        });
        if (refreshSelectedDiff) void this.openGitDiff(selectedPathId!, selectedSide!);
      } catch (error) {
        if (
          this.gitStatusRequest !== request ||
          request.signal.aborted ||
          this.state.sessionId !== sessionId ||
          this.selectionGeneration !== generation
        ) continue;
        this.set({ gitStatusError: error instanceof Error ? error.message : "Git status refresh failed" });
      } finally {
        if (this.gitStatusRequest === request) {
          this.gitStatusRequest = null;
          this.set({ gitStatusLoading: false, gitStatusRefreshing: false });
        }
      }
    } while (this.gitRefreshQueued && this.gitSurfaces.size > 0);
  }

  openGitDiff = async (pathId: string, requestedSide?: GitDiffSide): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return;
    let status = this.state.gitStatus;
    if (!status) {
      await this.refreshGitStatus();
      status = this.state.gitStatus;
    }
    if (!status || status.kind !== "repository") return;
    const change = status.files.find((candidate) => candidate.path.id === pathId);
    if (!change) return;
    const side = requestedSide ?? (change.unstaged || change.untracked || change.conflict ? "unstaged" : "staged");
    this.cancelGitDiffRequest();
    this.cancelResourceRequest();
    const request = new AbortController();
    this.gitDiffRequest = request;
    const generation = this.selectionGeneration;
    this.set({
      resourcesOpen: true,
      contextMode: "changes",
      detailMode: "diff",
      selectedGitPathId: pathId,
      selectedGitSide: side,
      gitDiff: { status: "loading", pathId, side },
    });
    try {
      const result = await this.api.gitDiff(sessionId, pathId, side, request.signal);
      if (
        this.gitDiffRequest !== request || request.signal.aborted ||
        this.state.sessionId !== sessionId || this.selectionGeneration !== generation ||
        this.state.selectedGitPathId !== pathId || this.state.selectedGitSide !== side
      ) return;
      this.set({ gitDiff: { status: "ready", result } });
    } catch (error) {
      if (
        this.gitDiffRequest !== request || request.signal.aborted ||
        this.state.sessionId !== sessionId || this.selectionGeneration !== generation ||
        this.state.selectedGitPathId !== pathId || this.state.selectedGitSide !== side
      ) return;
      this.set({
        gitDiff: { status: "error", pathId, side, message: error instanceof Error ? error.message : "Diff failed" },
      });
    } finally {
      if (this.gitDiffRequest === request) this.gitDiffRequest = null;
    }
  };

  setGitDiffSide = (side: GitDiffSide): void => {
    const pathId = this.state.selectedGitPathId;
    if (pathId && side !== this.state.selectedGitSide) void this.openGitDiff(pathId, side);
  };

  private cancelGitDiffRequest(): void {
    this.gitDiffRequest?.abort();
    this.gitDiffRequest = null;
  }

  private cancelGitRequests(): void {
    this.gitRefreshQueued = false;
    this.gitStatusRequest?.abort();
    this.gitStatusRequest = null;
    this.cancelGitDiffRequest();
  }

  private cancelResourceRequest(): void {
    this.resourceRequest?.abort();
    this.resourceRequest = null;
  }

  cancelResourceProbes = (): void => {
    this.resourceProbeRequest?.abort();
    this.resourceProbeRequest = null;
    this.resourceProbeKey = null;
  };

  private recordResourceAvailability(result: ResourceProbeResult): void {
    const resourceAvailability = { ...this.state.resourceAvailability };
    if (result.availability === "available") delete resourceAvailability[result.reference];
    else resourceAvailability[result.reference] = result;
    this.set({ resourceAvailability });
  }

  /** Preflight only the bounded Files-pane projection. The host returns
   * standing, not content handles; repeated message updates with the same
   * reference set reuse the completed result. */
  probeResources = async (references: string[]): Promise<void> => {
    const sessionId = this.state.sessionId;
    const viewId = this.state.transcriptViewId;
    if (!this.api || !sessionId || !viewId) return;
    const unique = [...new Set(references)].slice(0, 16);
    const key = JSON.stringify([sessionId, viewId, unique]);
    if (this.resourceProbeKey === key) return;
    this.cancelResourceProbes();
    this.resourceProbeKey = key;
    if (unique.length === 0) {
      if (Object.keys(this.state.resourceAvailability).length > 0) this.set({ resourceAvailability: {} });
      return;
    }
    const request = new AbortController();
    this.resourceProbeRequest = request;
    let completed = false;
    try {
      const response = await this.api.probeResources(sessionId, unique, request.signal);
      if (
        this.resourceProbeRequest !== request || request.signal.aborted ||
        this.state.sessionId !== sessionId || this.state.transcriptViewId !== viewId ||
        response.sessionId !== sessionId || response.viewId !== viewId
      ) return;
      const expected = new Set(unique);
      this.set({
        resourceAvailability: Object.fromEntries(
          response.results
            .filter((result) => expected.has(result.reference) && result.availability !== "available")
            .map((result) => [result.reference, result]),
        ),
      });
      completed = true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.handleAuthFailure();
    } finally {
      if (this.resourceProbeRequest === request) {
        this.resourceProbeRequest = null;
        if (!completed) this.resourceProbeKey = null;
      }
    }
  };

  private revokePreviewObjectUrl(): void {
    if (this.previewObjectUrl && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(this.previewObjectUrl);
    }
    this.previewObjectUrl = null;
  }

  clearResourceSelection = (): void => {
    this.cancelResourceRequest();
    this.revokePreviewObjectUrl();
    if (this.state.selectedResourceReference === null && this.state.resourcePreview === null) return;
    this.set({ selectedResourceReference: null, resourcePreview: null });
  };

  private resolveReference(
    sessionId: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<ResourceDescriptor> {
    return this.api!.resolveResource(sessionId, reference, signal);
  }

  /** Load one Pi-persisted embedded image without selecting the Files pane.
   * The session and branch-view identity are rechecked across both authenticated
   * requests so a late thumbnail can never cross a navigation boundary. */
  loadEmbeddedImage = async (
    sessionId: string,
    viewId: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<Blob> => {
    if (!this.api || !/^pi-embedded:\/\/\d+\/\d+$/.test(reference)) {
      throw new Error("The embedded image reference is invalid");
    }
    const stale = () => signal.aborted || this.state.sessionId !== sessionId || this.state.transcriptViewId !== viewId;
    const descriptor = await this.api.resolveResource(sessionId, reference, signal);
    if (stale()) throw Object.assign(new Error("The image request is no longer current"), { name: "AbortError" });
    if (descriptor.kind !== "image" || (descriptor.viewId !== undefined && descriptor.viewId !== viewId)) {
      throw new Error("The embedded image is unavailable in this conversation view");
    }
    if (descriptor.size > MAX_MEDIA_PREVIEW_BYTES) throw new Error("The image is too large to preview");
    const content = await this.api.resourceContent(descriptor.id, sessionId, {
      byteLimit: MAX_MEDIA_PREVIEW_BYTES + 1,
      signal,
    });
    if (stale()) throw Object.assign(new Error("The image request is no longer current"), { name: "AbortError" });
    if (content.totalSize > MAX_MEDIA_PREVIEW_BYTES || content.blob.size > MAX_MEDIA_PREVIEW_BYTES) {
      throw new Error("The image is too large to preview");
    }
    return content.blob;
  };

  /** Resolve a conversation reference through the authenticated host endpoint
   * and load its preview. Replaces any current preview and revokes its URL. */
  openResource = async (reference: string, contextMode: "files" | "changes" = "files"): Promise<void> => {
    if (!this.api) return;
    const sessionId = this.state.sessionId;
    const viewId = this.state.transcriptViewId;
    if (!sessionId || !viewId) return;
    this.cancelResourceRequest();
    this.cancelGitDiffRequest();
    const request = new AbortController();
    this.resourceRequest = request;
    this.revokePreviewObjectUrl();
    this.set({
      resourcesOpen: true,
      contextMode,
      detailMode: "file",
      selectedResourceReference: reference,
      resourcePreview: { status: "loading", reference },
      ...(contextMode === "files" ? { selectedGitPathId: null, selectedGitSide: null, gitDiff: null } : {}),
    });
    const stale = () =>
      this.resourceRequest !== request ||
      this.state.selectedResourceReference !== reference ||
      this.state.sessionId !== sessionId ||
      this.state.transcriptViewId !== viewId;
    let resolvedReference = false;
    try {
      const descriptor = await this.resolveReference(sessionId, reference, request.signal);
      if (stale() || (descriptor.viewId ?? viewId) !== viewId) return;
      // Resolution confirms or corrects preflight standing. A later transfer
      // failure leaves this availability intact.
      resolvedReference = true;
      this.recordResourceAvailability({ reference, availability: "available" });
      if (descriptor.kind === "binary") {
        this.set({ resourcePreview: { status: "ready", reference, descriptor } });
        return;
      }
      const textLike = descriptor.kind === "text" || descriptor.kind === "markdown" || descriptor.kind === "html";
      if (!textLike && descriptor.size > MAX_MEDIA_PREVIEW_BYTES) {
        this.set({ resourcePreview: { status: "ready", reference, descriptor, contentUnavailable: "too-large" } });
        return;
      }
      const content = await this.api.resourceContent(descriptor.id, sessionId, {
        byteLimit: textLike ? TEXT_PREVIEW_BYTES : MAX_MEDIA_PREVIEW_BYTES + 1,
        signal: request.signal,
      });
      if (stale()) return;
      const blob = content.blob;
      // Resolve metadata authorizes discovery only. Once bytes arrive, the
      // content response's current total is the sole size authority for both
      // the descriptor shown to the user and truncation decisions.
      const currentDescriptor = content.totalSize === descriptor.size
        ? descriptor
        : { ...descriptor, size: content.totalSize };
      if (textLike) {
        const text = await blob.text();
        if (stale()) return;
        if (descriptor.kind === "html" && typeof URL.createObjectURL === "function") {
          this.previewObjectUrl = URL.createObjectURL(
            new Blob([injectHtmlPreviewCsp(text)], { type: "text/html" }),
          );
        }
        this.set({
          resourcePreview: {
            status: "ready",
            reference,
            descriptor: currentDescriptor,
            text,
            // A 206 also answers full-coverage ranges, so judge truncation
            // by what actually arrived against the transfer's current total.
            truncated: blob.size < content.totalSize,
            ...(this.previewObjectUrl ? { objectUrl: this.previewObjectUrl } : {}),
          },
        });
        return;
      }
      if (content.totalSize > MAX_MEDIA_PREVIEW_BYTES || blob.size > MAX_MEDIA_PREVIEW_BYTES) {
        this.set({ resourcePreview: { status: "ready", reference, descriptor: currentDescriptor, contentUnavailable: "too-large" } });
        return;
      }
      if (typeof URL.createObjectURL === "function") {
        this.previewObjectUrl = URL.createObjectURL(blob);
      }
      this.set({
        resourcePreview: {
          status: "ready",
          reference,
          descriptor: currentDescriptor,
          ...(this.previewObjectUrl ? { objectUrl: this.previewObjectUrl } : {}),
        },
      });
    } catch (error) {
      if (stale()) return;
      const availability = resolvedReference ? null : classifiedResourceFailure(reference, error);
      if (availability) this.recordResourceAvailability(availability);
      if (error instanceof ApiError && error.matches && error.matches.length > 0) {
        this.set({
          resourcePreview: { status: "ambiguous", reference, message: error.message, matches: error.matches },
        });
        return;
      }
      this.set({
        resourcePreview: {
          status: "error",
          reference,
          message: error instanceof Error ? error.message : "Preview failed",
        },
      });
    } finally {
      if (this.resourceRequest === request) this.resourceRequest = null;
    }
  };

  openGitFile = async (pathId: string): Promise<void> => {
    const status = this.state.gitStatus;
    if (!status || status.kind !== "repository") return;
    const change = status.files.find((candidate) => candidate.path.id === pathId);
    const workingTreeDeleted = change?.unstaged?.kind === "deleted" ||
      (change?.staged?.kind === "deleted" && !change.unstaged && !change.untracked);
    if (!change?.path.workspacePath || !change.path.utf8Path || workingTreeDeleted) return;
    await this.openResource(change.path.workspacePath, "changes");
  };
}

export function gitChangeForWorkspacePath(
  status: GitStatusResponse | null,
  workspacePath: string,
): GitFileChange | undefined {
  if (!status || status.kind !== "repository") return undefined;
  return status.files.find((file) => file.path.workspacePath === workspacePath);
}

export const store = new AppStore();

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
