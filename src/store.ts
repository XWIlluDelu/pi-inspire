import { useSyncExternalStore } from "react";
import {
  defaultPreferences,
  MAX_ATTACHMENTS,
  MAX_PROJECT_FILES,
  projectNameFromCwd,
  THINKING_LEVELS,
  type ActiveSnapshot,
  type HostDirListing,
  type InspirePreferences,
  type LaunchPreference,
  type ProjectDirEntry,
  type ProjectDisplayPreference,
  type ResourceDescriptor,
  type RunState,
  type SessionRuntimeStatus,
  type SessionSummary,
  type ThemePreference,
  type VisibilityPreference,
} from "../shared/contracts";
import { ApiError, createApi, eventsUrl, type Api, type ProjectFileResult } from "./api";
import {
  asMessage,
  emptyEventSlice,
  IDLE_QUEUE,
  messageKey,
  reduceEvent,
  type ActivityTool,
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

export type ResourcePreview =
  | { status: "loading"; reference: string }
  | { status: "error"; reference: string; message: string }
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

export interface ModelOption {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface PiCommand {
  name: string;
  description?: string;
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
  bootstrapped: boolean;
  mock: boolean;
  /** Host-reported insπre version, shown on the settings page. */
  version: string;
  prefs: InspirePreferences;
  sessionId: string | null;
  sessionName: string;
  cwd: string | null;
  project: string | null;
  model: { provider: string; id: string; name?: string } | null;
  thinkingLevel: string;
  availableModels: ModelOption[];
  commands: PiCommand[];
  /** Context-window occupancy parsed from Pi's session stats at the
   * snapshot boundary; null when Pi provides no usable data. */
  contextUsage: ContextUsage | null;
  sessions: SessionSummary[];
  sessionQuery: string;
  /** Authoritative per-session runtime status for every live session worker,
   * keyed by session id. Drives nav attention indicators. */
  sessionStatuses: Record<string, SessionRuntimeStatus>;
  /** Session switch currently in flight; duplicate selections are ignored until it settles. */
  openingSessionId: string | null;
  /** The visible session's composer slice. Authoritative copies live in
   * per-session partitions inside the store; a session switch swaps the
   * slice, so staged work never leaks across sessions. */
  attachments: PendingAttachment[];
  projectFiles: string[];
  /** Prompt delivery in flight for the visible session: repeat sends are
   * refused and attachment withdrawals freeze, so a DELETE cannot race the
   * host resolving those same files into the outgoing message. */
  sending: boolean;
  /** Pin mutation in flight for this session id; the row stays truthful. */
  pinningSessionId: string | null;
  /** Files/resources pane visibility (Ctrl+.). */
  resourcesOpen: boolean;
  /** Reference currently selected in the resources pane. */
  selectedResourceReference: string | null;
  resourcePreview: ResourcePreview | null;
  error: string | null;
}

const NOTICE_TTL_MS = 8_000;

const initialState: AppState = {
  ...emptyEventSlice(),
  needsToken: false,
  connection: "connecting",
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
  sessions: [],
  sessionQuery: "",
  sessionStatuses: {},
  openingSessionId: null,
  attachments: [],
  projectFiles: [],
  sending: false,
  pinningSessionId: null,
  resourcesOpen: false,
  selectedResourceReference: null,
  resourcePreview: null,
  error: null,
};

export class AppStore {
  private state: AppState = initialState;
  private listeners = new Set<() => void>();
  private api: Api | null = null;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
  private settledKeys = new Set<string>();
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private autoContinued = false;
  private selectionGeneration = 0;
  /** Latest-wins guard for selection intent: openSession/newSession and every
   * authoritative WebSocket snapshot bump it, so a slower open/new HTTP
   * response cannot overwrite a newer selection the client already applied. */
  private selectionRequest = 0;
  private readyWhileOpening = new Set<string>();
  private previewObjectUrl: string | null = null;
  private resourceRequest: AbortController | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AppState => this.state;

  private set(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  private fail(message: string): void {
    this.set({ error: message });
  }

  dismissError = (): void => this.set({ error: null });

  private handleAuthFailure(): void {
    // Null the owned socket first so its close handler cannot schedule a
    // retry with the rejected token.
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.set({ needsToken: true, error: null, connection: "offline" });
  }

  // --- Bootstrap ---

  async init(token: string | null): Promise<void> {
    if (!token) {
      this.set({ needsToken: true, connection: "offline" });
      return;
    }
    this.api = createApi(token);
    try {
      const boot = await this.api.bootstrap();
      this.set({
        prefs: boot.preferences,
        mock: boot.mock,
        version: boot.version,
        bootstrapped: true,
        needsToken: false,
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
        this.set({ connection: "offline", error: error instanceof Error ? error.message : "Bootstrap failed" });
        this.scheduleReconnect(token);
      }
    }
  }

  // --- Snapshot & event reconciliation ---

  private applySnapshot(snapshot: ActiveSnapshot): void {
    const active = snapshot.active;
    const nextSessionId = active?.sessionId ?? null;
    const sessionChanged = nextSessionId !== this.state.sessionId;
    if (sessionChanged) {
      this.selectionGeneration += 1;
      // Previews are authorized against the owning session; a switch must not
      // leak the previous session's selection, transfer, or object URLs.
      this.cancelResourceRequest();
      this.revokePreviewObjectUrl();
    }
    const messages = (active?.messages ?? []).map(asMessage);
    this.settledKeys = new Set(messages.map(messageKey).filter((key): key is string => key !== null));
    const cwd = active?.cwd ?? null;
    this.set({
      sessionId: active?.sessionId ?? null,
      sessionName: active?.sessionName ?? "",
      cwd,
      project: cwd ? projectNameFromCwd(cwd) : null,
      model: (active?.model as AppState["model"]) ?? null,
      thinkingLevel: typeof active?.thinkingLevel === "string" ? active.thinkingLevel : this.state.thinkingLevel,
      availableModels: Array.isArray(active?.availableModels) ? (active.availableModels as ModelOption[]) : [],
      commands: Array.isArray(active?.commands) ? (active.commands as PiCommand[]) : [],
      contextUsage: contextUsage(active?.stats ?? null),
      messages,
      streaming: Boolean(active?.isStreaming),
      runState: snapshot.runState,
      // Wholesale replace: the host clears completion attention for the
      // session that was just viewed, so stale client state must not linger.
      sessionStatuses: snapshot.sessionStatuses ?? {},
      // Settled activity is rebuilt from the selected worker. A background
      // extension dialog is restored only when its owning session is viewed.
      tools: {},
      retry: null,
      queue: IDLE_QUEUE,
      extensionUi: snapshot.pendingExtensionUi ?? null,
      ...(sessionChanged
        ? {
            statuses: {},
            editorText: null,
            windowTitle: null,
            selectedResourceReference: null,
            resourcePreview: null,
            // Composer work belongs to its session; the switch swaps in the
            // destination's staged slice.
            ...this.composerSlice(nextSessionId),
          }
        : {}),
    });
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
      extensionUi: s.extensionUi,
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
        // open/new response still in flight so it cannot overwrite this.
        this.selectionRequest += 1;
        this.applySnapshot(event.data as ActiveSnapshot);
      }
      return;
    }

    // Every live event carries its authoritative per-session status; merge it
    // into the map before any transcript routing.
    const eventSessionId = typeof event.sessionId === "string" ? event.sessionId : null;
    const sessionStatuses = this.mergeSessionStatus(eventSessionId, event.sessionStatus);

    if (eventSessionId !== null && eventSessionId !== this.state.sessionId) {
      // Background session: its message/tool/notice deltas must never enter
      // the visible transcript and must not resync it. Only the status
      // changes; a settle refreshes the list so folder/time ordering catches
      // up. Unchanged statuses (token-level chatter) publish nothing.
      if (sessionStatuses) this.set({ sessionStatuses });
      if (event.type === "runtime_ready" && eventSessionId === this.state.openingSessionId) {
        this.readyWhileOpening.add(eventSessionId);
      }
      if (event.type === "runtime_error") this.readyWhileOpening.delete(eventSessionId);
      if (event.type === "agent_settled") void this.loadSessions(this.state.sessionQuery);
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
  ): Promise<void> {
    if (!this.api) return;
    try {
      const snapshot = await this.api.snapshot();
      const snapshotSessionId = snapshot.active?.sessionId ?? null;
      if (
        this.state.sessionId !== expectedSessionId ||
        this.selectionGeneration !== expectedGeneration ||
        snapshotSessionId !== expectedSessionId
      ) return;
      this.applySnapshot(snapshot);
      this.set({ error: null });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.handleAuthFailure();
    }
  }

  // --- WebSocket lifecycle ---

  private connect(token: string): void {
    this.socket?.close();
    this.set({ connection: this.state.bootstrapped ? "reconnecting" : "connecting" });
    const socket = new WebSocket(eventsUrl(token));
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.reconnectDelay = 1_000;
      // The host pushes an authoritative snapshot as the first frame, so no
      // redundant HTTP resync is needed here.
      this.set({ connection: "open" });
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
      this.set({ connection: "reconnecting" });
      this.scheduleReconnect(token);
    };
    socket.onerror = () => socket.close();
  }

  private scheduleReconnect(token: string): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    this.reconnectTimer = setTimeout(() => {
      void this.init(token);
    }, delay);
  }

  // --- Sessions ---

  /** Latest-wins ticket: a slower, earlier list response must not overwrite
   * the results of a newer query or refresh. */
  private sessionLoadTicket = 0;

  loadSessions = async (query: string): Promise<void> => {
    if (!this.api) return;
    const ticket = ++this.sessionLoadTicket;
    try {
      const list = await this.api.sessions(query);
      const sessions = this.withPinnedFlags(list.sessions);
      if (!query.trim()) {
        // Pinned sessions beyond the 40-result page must still surface in the
        // global Pinned section; fetch them explicitly and merge.
        const missing = this.state.prefs.pinnedSessionIds.filter((id) => !sessions.some((s) => s.id === id));
        if (missing.length > 0) {
          try {
            const extra = await this.api.sessionsByIds(missing);
            for (const session of this.withPinnedFlags(extra.sessions)) {
              if (!sessions.some((candidate) => candidate.id === session.id)) sessions.push(session);
            }
          } catch {
            // Best effort: the base page is already shown.
          }
        }
      }
      if (ticket !== this.sessionLoadTicket) return;
      this.set({ sessions });
    } catch (error) {
      if (ticket !== this.sessionLoadTicket) return; // a newer load owns the outcome
      if (error instanceof ApiError && error.status === 401) this.handleAuthFailure();
      else this.fail(error instanceof Error ? error.message : "Failed to list sessions");
    }
  };

  /** Pin state lives in preferences; summaries from the catalog are
   * normalized against it so rows render one authoritative flag. */
  private withPinnedFlags(sessions: SessionSummary[]): SessionSummary[] {
    const pinned = new Set(this.state.prefs.pinnedSessionIds);
    return sessions.map((session) => ({ ...session, pinned: pinned.has(session.id) }));
  }

  setSessionPinned = async (id: string, pinned: boolean): Promise<void> => {
    if (!this.api || this.state.pinningSessionId !== null) return;
    const previousPrefs = this.state.prefs;
    const previousSessions = this.state.sessions;
    const pinnedSessionIds = pinned
      ? [id, ...previousPrefs.pinnedSessionIds.filter((candidate) => candidate !== id)]
      : previousPrefs.pinnedSessionIds.filter((candidate) => candidate !== id);
    this.set({
      pinningSessionId: id,
      prefs: { ...previousPrefs, pinnedSessionIds },
      sessions: previousSessions.map((session) => (session.id === id ? { ...session, pinned } : session)),
    });
    try {
      // The pin endpoint persists the preference host-side and answers with
      // the stored preferences. Only the pin field is taken from the answer:
      // other fields may have newer local changes still queued for saving.
      const prefs = await this.api.setSessionPinned(id, pinned);
      this.set({ prefs: { ...this.state.prefs, pinnedSessionIds: prefs.pinnedSessionIds } });
      await this.loadSessions(this.state.sessionQuery);
    } catch (error) {
      // Truthful control: a rejected pin cannot leave the UI claiming it.
      // Only pin state rolls back; preferences edited while the request was
      // in flight (theme, visibility, …) keep their newer local values.
      const wasPinned = previousPrefs.pinnedSessionIds.includes(id);
      this.set({
        prefs: { ...this.state.prefs, pinnedSessionIds: previousPrefs.pinnedSessionIds },
        sessions: this.state.sessions.map((session) =>
          session.id === id ? { ...session, pinned: wasPinned } : session,
        ),
      });
      this.fail(error instanceof Error ? error.message : "Failed to update the pin");
    } finally {
      this.set({ pinningSessionId: null });
    }
  };

  searchSessions = (query: string): void => {
    this.set({ sessionQuery: query });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.loadSessions(query), 180);
  };

  refreshSessions = async (): Promise<void> => {
    if (!this.api) return;
    try {
      await this.api.refreshSessions();
      await this.loadSessions(this.state.sessionQuery);
      this.set({ error: null });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to refresh sessions");
    }
  };

  openSession = async (id: string): Promise<void> => {
    if (!this.api) return;
    if (this.state.openingSessionId) return; // one switch at a time
    if (id === this.state.sessionId) return; // already active: no-op
    const ticket = ++this.selectionRequest;
    this.set({ openingSessionId: id });
    try {
      const snapshot = await this.api.openSession(id);
      // A newer selection (another open/new, or an authoritative push) won the
      // race; this stale response must not reinstate its session.
      if (ticket !== this.selectionRequest) return;
      this.applySnapshot(snapshot);
      this.set({ error: null });
      if (this.readyWhileOpening.delete(id)) {
        void this.resync(id, this.selectionGeneration);
      }
    } catch (error) {
      if (ticket === this.selectionRequest) this.fail(error instanceof Error ? error.message : "Failed to open session");
    } finally {
      this.readyWhileOpening.delete(id);
      this.set({ openingSessionId: null });
    }
  };

  /** Creates a session. Never falls back to "/": without an active or explicit
   * project directory the caller must collect one (the welcome page does). */
  newSession = async (cwd?: string, name?: string): Promise<void> => {
    if (!this.api) return;
    const target = cwd?.trim() || this.state.cwd;
    if (!target) {
      this.fail("Enter a project directory to start a session");
      return;
    }
    const ticket = ++this.selectionRequest;
    try {
      const snapshot = await this.api.newSession(target, name);
      if (ticket !== this.selectionRequest) return; // superseded by a newer selection
      this.applySnapshot(snapshot);
      this.set({ error: null });
      void this.loadSessions(this.state.sessionQuery);
    } catch (error) {
      if (ticket === this.selectionRequest) this.fail(error instanceof Error ? error.message : "Failed to create session");
    }
  };

  renameSession = async (name: string): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId || !name.trim()) return false;
    try {
      await this.api.renameSession(sessionId, name.trim());
      // The response may return after a session switch; only the owning
      // session's visible title updates.
      if (this.state.sessionId === sessionId) this.set({ sessionName: name.trim(), error: null });
      void this.loadSessions(this.state.sessionQuery);
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to rename session");
      return false;
    }
  };

  // --- Prompting ---

  sendPrompt = async (message: string, behavior?: "steer" | "followUp"): Promise<boolean> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return false;
    const composer = this.composerFor(sessionId);
    if (composer.sending) return false;
    if (composer.attachments.some((item) => item.status === "uploading")) {
      this.fail("Attachments are still uploading");
      return false;
    }
    if (composer.attachments.some((item) => item.status === "error")) {
      this.fail("Remove failed attachments before sending");
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
      this.set({ error: null });
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to send");
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

  setModel = async (provider: string, modelId: string): Promise<void> => {
    const sessionId = this.state.sessionId;
    if (!this.api || !sessionId) return;
    try {
      await this.api.setModel(sessionId, provider, modelId);
      await this.resync();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to set model");
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
      this.fail(error instanceof Error ? error.message : "Failed to set thinking level");
    }
  };

  // --- Composer attachments & project files ---

  /** Authoritative per-session composer partitions; AppState carries only
   * the visible session's slice. */
  private readonly composers = new Map<string, ComposerPartition>();

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
    if (accepted.length < files.length) this.fail(`At most ${MAX_ATTACHMENTS} attachments per message`);
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
    if (composer.projectFiles.includes(path)) return;
    if (composer.projectFiles.length >= MAX_PROJECT_FILES) {
      this.fail(`At most ${MAX_PROJECT_FILES} project files per message`);
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

  /** One level of the host directory picker; the dialog renders failures. */
  browseHostDirs = async (path?: string): Promise<HostDirListing> => {
    if (!this.api) throw new Error("Not connected to the insπre host");
    return this.api.browseHostDirs(path);
  };

  // --- Extension UI ---

  respondExtensionUi = async (payload: Record<string, unknown>): Promise<void> => {
    if (!this.api) return;
    const request = this.state.extensionUi;
    if (!request || payload.id !== request.id) return;
    try {
      await this.api.respondExtensionUi({ ...payload, sessionId: request.sessionId });
      const current = this.state.extensionUi;
      if (current?.sessionId === request.sessionId && current.id === request.id) {
        this.set({ extensionUi: null });
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to answer the extension");
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

  private savePrefs(patch: Partial<InspirePreferences>): void {
    this.set({ prefs: { ...this.state.prefs, ...patch } });
    // Persistence stays best-effort; local state already applied.
    this.prefsWrites = this.prefsWrites
      .then(() => this.api?.savePreferences(patch))
      .catch(() => undefined);
  }

  setTheme = (theme: ThemePreference): void => this.savePrefs({ theme });
  setLaunch = (launch: LaunchPreference): void => this.savePrefs({ launch });
  setProjectDisplay = (projectDisplay: ProjectDisplayPreference): void => this.savePrefs({ projectDisplay });
  setThinkingVisibility = (thinkingVisibility: VisibilityPreference): void =>
    this.savePrefs({ thinkingVisibility });
  setToolVisibility = (toolVisibility: VisibilityPreference): void => this.savePrefs({ toolVisibility });

  toggleNavGroup = (cwd: string): void => {
    const current = this.state.prefs.navCollapsedGroups;
    const navCollapsedGroups = current.includes(cwd) ? current.filter((item) => item !== cwd) : [...current, cwd];
    this.savePrefs({ navCollapsedGroups });
  };

  // --- Files/resources pane ---

  setResourcesOpen = (resourcesOpen: boolean): void => {
    if (!resourcesOpen) this.clearResourceSelection();
    this.set({ resourcesOpen });
  };

  private cancelResourceRequest(): void {
    this.resourceRequest?.abort();
    this.resourceRequest = null;
  }

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

  /** Resolve a conversation reference through the authenticated host endpoint
   * and load its preview. Replaces any current preview and revokes its URL. */
  openResource = async (reference: string): Promise<void> => {
    if (!this.api) return;
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    this.cancelResourceRequest();
    const request = new AbortController();
    this.resourceRequest = request;
    this.revokePreviewObjectUrl();
    this.set({
      resourcesOpen: true,
      selectedResourceReference: reference,
      resourcePreview: { status: "loading", reference },
    });
    const stale = () =>
      this.resourceRequest !== request ||
      this.state.selectedResourceReference !== reference ||
      this.state.sessionId !== sessionId;
    try {
      const descriptor = await this.api.resolveResource(sessionId, reference, request.signal);
      if (stale()) return;
      if (descriptor.kind === "binary") {
        this.set({ resourcePreview: { status: "ready", reference, descriptor } });
        return;
      }
      const textLike = descriptor.kind === "text" || descriptor.kind === "markdown" || descriptor.kind === "html";
      if (!textLike && descriptor.size > MAX_MEDIA_PREVIEW_BYTES) {
        this.set({ resourcePreview: { status: "ready", reference, descriptor, contentUnavailable: "too-large" } });
        return;
      }
      const blob = await this.api.resourceContent(descriptor.id, sessionId, {
        byteLimit: textLike ? TEXT_PREVIEW_BYTES : MAX_MEDIA_PREVIEW_BYTES + 1,
        signal: request.signal,
      });
      if (stale()) return;
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
            descriptor,
            text,
            // A 206 also answers full-coverage ranges, so judge truncation
            // by what actually arrived against the file's stat size.
            truncated: blob.size < descriptor.size,
            ...(this.previewObjectUrl ? { objectUrl: this.previewObjectUrl } : {}),
          },
        });
        return;
      }
      if (blob.size > MAX_MEDIA_PREVIEW_BYTES) {
        this.set({ resourcePreview: { status: "ready", reference, descriptor, contentUnavailable: "too-large" } });
        return;
      }
      if (typeof URL.createObjectURL === "function") {
        this.previewObjectUrl = URL.createObjectURL(blob);
      }
      this.set({
        resourcePreview: {
          status: "ready",
          reference,
          descriptor,
          ...(this.previewObjectUrl ? { objectUrl: this.previewObjectUrl } : {}),
        },
      });
    } catch (error) {
      if (stale()) return;
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
}

export const store = new AppStore();

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
