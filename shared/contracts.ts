export const VISIBILITY_PREFERENCES = ["hidden", "collapsed", "expanded"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const MAX_ATTACHMENTS = 8;
export const MAX_PROJECT_FILES = 20;

export type VisibilityPreference = (typeof VISIBILITY_PREFERENCES)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThemePreference = "system" | "light" | "dark";
export type LaunchPreference = "welcome" | "continue";
export type RunState = "idle" | "running" | "retrying" | "compacting" | "queued" | "aborted" | "failed";

export interface InspirePreferences {
  theme: ThemePreference;
  launch: LaunchPreference;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: VisibilityPreference;
  readingSerif: boolean;
}

export const defaultPreferences: InspirePreferences = {
  theme: "system",
  launch: "welcome",
  thinkingVisibility: "collapsed",
  toolVisibility: "collapsed",
  readingSerif: false,
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
  parentSessionId?: string;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
  offset: number;
  limit: number;
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
