export const VISIBILITY_PREFERENCES = ["hidden", "collapsed", "expanded"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const MAX_ATTACHMENTS = 8;
export const MAX_PROJECT_FILES = 20;

export type VisibilityPreference = (typeof VISIBILITY_PREFERENCES)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThemePreference = "system" | "light" | "dark";
export type LaunchPreference = "welcome" | "continue";
export type RunState = "idle" | "running" | "retrying" | "compacting" | "queued" | "aborted" | "failed";
export type SessionIndicator = "running" | "completed" | "failed";

export interface SessionRuntimeStatus {
  runState: RunState;
  indicator?: SessionIndicator;
}

export interface InspirePreferences {
  theme: ThemePreference;
  launch: LaunchPreference;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: VisibilityPreference;
  readingSerif: boolean;
  pinnedSessionIds: string[];
  navCollapsedGroups: string[];
}

export const defaultPreferences: InspirePreferences = {
  theme: "system",
  launch: "welcome",
  thinkingVisibility: "collapsed",
  toolVisibility: "collapsed",
  readingSerif: false,
  pinnedSessionIds: [],
  navCollapsedGroups: [],
};

export function projectNameFromCwd(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || cwd || "Unknown project";
}


export interface SessionSummary {
  id: string;
  cwd: string;
  project: string;
  title: string;
  created: string;
  modified: string;
  messageCount: number;
  pinned?: boolean;
  parentSessionId?: string;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
  offset: number;
  limit: number;
}

export type ResourceKind = "image" | "html" | "pdf" | "markdown" | "text" | "audio" | "video" | "binary";

export interface ResourceDescriptor {
  id: string;
  sessionId: string;
  reference: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ResourceKind;
}

const EXTENSION_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"] as const);

export interface ExtensionUiRequest {
  sessionId: string;
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export function parseExtensionUiRequest(value: unknown): ExtensionUiRequest | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  const id = typeof event.id === "string" ? event.id : "";
  const method = typeof event.method === "string" ? event.method : "";
  if (!sessionId || !id || !EXTENSION_DIALOG_METHODS.has(method as ExtensionUiRequest["method"])) return null;
  return {
    sessionId,
    id,
    method: method as ExtensionUiRequest["method"],
    title: typeof event.title === "string" ? event.title : undefined,
    message: typeof event.message === "string" ? event.message : undefined,
    options: Array.isArray(event.options) ? event.options.map(String) : undefined,
    placeholder: typeof event.placeholder === "string" ? event.placeholder : undefined,
    prefill: typeof event.prefill === "string" ? event.prefill : undefined,
  };
}

export interface ActiveSnapshot {
  active: null | {
    sessionId: string;
    sessionFile?: string;
    sessionName?: string;
    cwd: string;
    model: unknown;
    thinkingLevel: string;
    isStreaming: boolean;
    isCompacting: boolean;
    messages: unknown[];
    stats?: unknown;
    availableModels: unknown[];
    commands: unknown[];
  };
  runState: RunState;
  sessionStatuses: Record<string, SessionRuntimeStatus>;
  pendingExtensionUi?: ExtensionUiRequest | null;
}

export interface BootstrapResponse {
  appName: "insπre";
  version: string;
  piVersion: string;
  mock: boolean;
  preferences: InspirePreferences;
  snapshot: ActiveSnapshot;
}

export interface UploadedAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  previewDataUrl?: string;
}

export interface PromptRequest {
  message: string;
  attachmentIds?: string[];
  projectFiles?: string[];
  behavior?: "steer" | "followUp";
}
