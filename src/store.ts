import { useSyncExternalStore } from "react";
import {
  defaultPreferences,
  MAX_ATTACHMENTS,
  MAX_PROJECT_FILES,
  projectNameFromCwd,
  THINKING_LEVELS,
  type ActiveSnapshot,
  type InspirePreferences,
  type LaunchPreference,
  type RunState,
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

export interface AppState extends EventSlice {
  needsToken: boolean;
  connection: ConnectionState;
  bootstrapped: boolean;
  mock: boolean;
  prefs: InspirePreferences;
  sessionId: string | null;
  sessionName: string;
  cwd: string | null;
  project: string | null;
  model: { provider: string; id: string; name?: string } | null;
  thinkingLevel: string;
  availableModels: ModelOption[];
  commands: PiCommand[];
  stats: unknown;
  sessions: SessionSummary[];
  sessionQuery: string;
  attachments: PendingAttachment[];
  projectFiles: string[];
  error: string | null;
}

const NOTICE_TTL_MS = 8_000;

const initialState: AppState = {
  ...emptyEventSlice(),
  needsToken: false,
  connection: "connecting",
  bootstrapped: false,
  mock: false,
  prefs: defaultPreferences,
  sessionId: null,
  sessionName: "",
  cwd: null,
  project: null,
  model: null,
  thinkingLevel: "medium",
  availableModels: [],
  commands: [],
  stats: null,
  sessions: [],
  sessionQuery: "",
  attachments: [],
  projectFiles: [],
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
      stats: active?.stats ?? null,
      messages,
      streaming: Boolean(active?.isStreaming),
      runState: snapshot.runState,
      // Settled state replaces transient activity; dialog/notice surfaces stay.
      tools: {},
      retry: null,
      queue: IDLE_QUEUE,
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
      if (event.data) this.applySnapshot(event.data as ActiveSnapshot);
      return;
    }
    const before = this.state.notices.length;
    const { slice, settle, resync, changed } = reduceEvent(this.eventSlice(), this.settledKeys, event);
    for (const key of settle) this.settledKeys.add(key);
    if (changed) {
      this.set(slice);
      for (const notice of slice.notices.slice(before)) {
        this.noticeTimers.set(
          notice.id,
          setTimeout(() => this.dismissNotice(notice.id), NOTICE_TTL_MS),
        );
      }
    }
    if (resync) void this.resync();
  }

  /** Authoritative reconcile after stream settlement or reconnect. */
  private async resync(): Promise<void> {
    if (!this.api) return;
    try {
      this.applySnapshot(await this.api.snapshot());
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

  loadSessions = async (query: string): Promise<void> => {
    if (!this.api) return;
    try {
      const list = await this.api.sessions(query);
      this.set({ sessions: list.sessions });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.handleAuthFailure();
      else this.fail(error instanceof Error ? error.message : "Failed to list sessions");
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
    try {
      this.applySnapshot(await this.api.openSession(id));
      this.set({ error: null });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to open session");
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
    try {
      this.applySnapshot(await this.api.newSession(target, name));
      this.set({ error: null });
      void this.loadSessions(this.state.sessionQuery);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to create session");
    }
  };

  renameSession = async (name: string): Promise<boolean> => {
    if (!this.api || !name.trim()) return false;
    try {
      await this.api.renameSession(name.trim());
      this.set({ sessionName: name.trim(), error: null });
      void this.loadSessions(this.state.sessionQuery);
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to rename session");
      return false;
    }
  };

  // --- Prompting ---

  sendPrompt = async (message: string, behavior?: "steer" | "followUp"): Promise<boolean> => {
    if (!this.api) return false;
    if (this.state.attachments.some((item) => item.status === "uploading")) {
      this.fail("Attachments are still uploading");
      return false;
    }
    if (this.state.attachments.some((item) => item.status === "error")) {
      this.fail("Remove failed attachments before sending");
      return false;
    }
    const attachmentIds = this.state.attachments
      .map((item) => item.uploadedId)
      .filter((id): id is string => Boolean(id));
    const projectFiles = this.state.projectFiles;
    if (!message.trim() && attachmentIds.length === 0 && projectFiles.length === 0) return false;
    try {
      await this.api.prompt({
        message,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(projectFiles.length > 0 ? { projectFiles } : {}),
        behavior,
      });
      // Accepted: clear attachments and references. Failures keep everything.
      this.clearComposerArtifacts();
      this.set({ error: null });
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to send");
      return false;
    }
  };

  abort = async (): Promise<void> => {
    if (!this.api) return;
    try {
      await this.api.abort();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to abort");
    }
  };

  compact = async (customInstructions?: string): Promise<void> => {
    if (!this.api) return;
    try {
      await this.api.compact(customInstructions);
      this.set({ error: null });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to compact");
    }
  };

  setModel = async (provider: string, modelId: string): Promise<void> => {
    if (!this.api) return;
    try {
      await this.api.setModel(provider, modelId);
      await this.resync();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Failed to set model");
    }
  };

  setThinkingLevel = async (level: string): Promise<void> => {
    if (!this.api) return;
    const previous = this.state.thinkingLevel;
    this.set({ thinkingLevel: level });
    try {
      await this.api.setThinkingLevel(level);
    } catch (error) {
      // Truthful control: a rejected change cannot leave the UI claiming it.
      this.set({ thinkingLevel: previous });
      this.fail(error instanceof Error ? error.message : "Failed to set thinking level");
      void this.resync();
    }
  };

  // --- Composer attachments & project files ---

  addFiles = async (files: File[]): Promise<void> => {
    if (!this.api || files.length === 0) return;
    const room = MAX_ATTACHMENTS - this.state.attachments.length;
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
    this.set({ attachments: [...this.state.attachments, ...pending] });

    try {
      const { attachments: uploaded } = await this.api.uploadAttachments(accepted);
      this.set({
        attachments: this.state.attachments.map((item) => {
          const index = pending.findIndex((candidate) => candidate.localId === item.localId);
          const result = index >= 0 ? uploaded[index] : undefined;
          return result
            ? { ...item, status: "ready" as const, uploadedId: result.id, fileName: result.fileName, kind: result.kind }
            : item;
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      this.set({
        attachments: this.state.attachments.map((item) =>
          pending.some((candidate) => candidate.localId === item.localId)
            ? { ...item, status: "error" as const, error: message }
            : item,
        ),
      });
    }
  };

  removeAttachment = (localId: string): void => {
    const target = this.state.attachments.find((item) => item.localId === localId);
    if (target?.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(target.previewUrl);
    this.set({ attachments: this.state.attachments.filter((item) => item.localId !== localId) });
  };

  addProjectFile = (path: string): void => {
    if (!path || this.state.projectFiles.includes(path)) return;
    if (this.state.projectFiles.length >= MAX_PROJECT_FILES) {
      this.fail(`At most ${MAX_PROJECT_FILES} project files per message`);
      return;
    }
    this.set({ projectFiles: [...this.state.projectFiles, path] });
  };

  removeProjectFile = (path: string): void => {
    this.set({ projectFiles: this.state.projectFiles.filter((item) => item !== path) });
  };

  searchProjectFiles = async (query: string): Promise<ProjectFileResult[]> => {
    if (!this.api) return [];
    const result = await this.api.searchFiles(query);
    return result.files;
  };

  private clearComposerArtifacts(): void {
    for (const item of this.state.attachments) {
      if (item.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(item.previewUrl);
    }
    this.set({ attachments: [], projectFiles: [] });
  }

  // --- Extension UI ---

  respondExtensionUi = async (payload: Record<string, unknown>): Promise<void> => {
    if (!this.api) return;
    const requestId = this.state.extensionUi?.id;
    try {
      await this.api.respondExtensionUi(payload);
      if (requestId && payload.id === requestId) this.set({ extensionUi: null });
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

  private savePrefs(prefs: InspirePreferences): void {
    this.set({ prefs });
    void this.api?.savePreferences(prefs).catch(() => {
      // preference persistence is best-effort; local state already applied
    });
  }

  setTheme = (theme: ThemePreference): void => this.savePrefs({ ...this.state.prefs, theme });
  setLaunch = (launch: LaunchPreference): void => this.savePrefs({ ...this.state.prefs, launch });
  setReadingSerif = (readingSerif: boolean): void => this.savePrefs({ ...this.state.prefs, readingSerif });
  setThinkingVisibility = (value: VisibilityPreference): void =>
    this.savePrefs({ ...this.state.prefs, thinkingVisibility: value });
  setToolVisibility = (value: VisibilityPreference): void =>
    this.savePrefs({ ...this.state.prefs, toolVisibility: value });
}

export const store = new AppStore();

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
