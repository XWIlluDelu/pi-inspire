export const VISIBILITY_PREFERENCES = ["dynamic", "expanded", "collapsed", "hidden"] as const;
export const TOOL_VISIBILITY_PREFERENCES = ["dynamic", "expanded", "collapsed", "compact", "hidden"] as const;
export const ASSISTANT_ROUND_DISPLAYS = ["details", "divider"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const MAX_ATTACHMENTS = 8;
export const MAX_PROJECT_FILES = 20;
export const MAX_SESSION_LIST_PAGE_SIZE = 100;
/** Session-list and fallback-heading text is bounded before responsive CSS
 * applies its viewport-dependent ellipsis. */
export const MAX_SESSION_DISPLAY_TITLE_CHARS = 120;
export const MAX_SESSION_ID_HYDRATION_IDS = 600;
export const MAX_SESSION_CWD_HYDRATION_CWDS = 100;

export type VisibilityPreference = (typeof VISIBILITY_PREFERENCES)[number];
export type ToolVisibilityPreference = (typeof TOOL_VISIBILITY_PREFERENCES)[number];
export type AssistantRoundDisplayPreference = (typeof ASSISTANT_ROUND_DISPLAYS)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThemePreference = "system" | "light" | "dark";
export type LaunchPreference = "welcome" | "continue";
export type ProjectDisplayPreference = "folder" | "path";
export type CompletionAttentionPreference = "off" | "title" | "desktop";
export interface ModelIdentity {
  provider: string;
  id: string;
}

/** Browser-safe projection of Pi model metadata. Request/auth fields never
 * cross the host boundary. */
export interface ModelOption extends ModelIdentity {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface NewSessionOptions {
  name?: string;
  model?: ModelIdentity;
  thinkingLevel?: ThinkingLevel;
}

/** Pi's resolved startup choice for a new session in one canonical workspace.
 * This is a preflight projection; the creating worker remains authoritative. */
export interface NewSessionDefaults {
  cwd: string;
  model: ModelOption | null;
  thinkingLevel: ThinkingLevel;
}

export function modelIdentityKey(model: Pick<ModelIdentity, "provider" | "id">): string {
  return JSON.stringify([model.provider, model.id]);
}
export type RunState = "idle" | "running" | "retrying" | "compacting" | "queued" | "aborted" | "failed" | "conflict";
/** Run states in which Pi owns an active or queued mutation. Browser controls
 * and host lifecycle/reclamation rules must use this one authority. */
export const BUSY_RUN_STATES = ["running", "retrying", "compacting", "queued"] as const;

export function isBusyRunState(runState: RunState): boolean {
  return (BUSY_RUN_STATES as readonly RunState[]).includes(runState);
}

/** Conflicts are not steerable busy work, but the recovery surface remains
 * abortable without widening the host's worker-busy ownership set. */
export function isAbortableRunState(runState: RunState): boolean {
  return isBusyRunState(runState) || runState === "conflict";
}

export type SessionIndicator = "running" | "completed" | "failed" | "attention";

export type ProjectionConflictKind =
  | "external-change"
  | "incomplete-persistence"
  | "projection-failure"
  | "outcome-unknown"
  | "fork-overflow";

/** External source movement is safe to display as attention only after the
 * worker has stopped; every other conflict represents an integrity or outcome
 * boundary that remains an error. */
export function projectionConflictSeverity(
  conflict: Pick<ProjectionConflict, "kind"> | null | undefined,
): "attention" | "error" {
  return conflict?.kind === "external-change" ? "attention" : "error";
}

export interface SessionRuntimeStatus {
  runState: RunState;
  indicator?: SessionIndicator;
}

export interface InspirePreferences {
  theme: ThemePreference;
  launch: LaunchPreference;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: ToolVisibilityPreference;
  /** Detailed preserves Pi's current per-message attribution verbatim; divider
   * replaces that whole row with one quiet visual boundary. */
  assistantRoundDisplay: AssistantRoundDisplayPreference;
  /** How the topbar shows the session's project location. */
  projectDisplay: ProjectDisplayPreference;
  /** Opt-in attention for terminal transitions that were not visible. */
  completionAttention: CompletionAttentionPreference;
  /** Successful model choices, newest first. This is ordering metadata only. */
  recentModelIds: ModelIdentity[];
  pinnedSessionIds: string[];
  /** Project directories pinned as a whole. Identity is the exact cwd, the
   * same identity navigation groups and collapse state already use. */
  pinnedProjectCwds: string[];
  /** Project directories moved into Hidden as complete folder groups. This is
   * independent of per-session hiding so restoration cannot erase it. */
  hiddenProjectCwds: string[];
  /** Sessions moved into the reversible Hidden group. Navigation metadata
   * only: nothing in Pi's session storage changes. */
  hiddenSessionIds: string[];
  navCollapsedGroups: string[];
}

export const defaultPreferences: InspirePreferences = {
  theme: "system",
  launch: "welcome",
  thinkingVisibility: "dynamic",
  toolVisibility: "dynamic",
  assistantRoundDisplay: "divider",
  projectDisplay: "folder",
  completionAttention: "off",
  recentModelIds: [],
  pinnedSessionIds: [],
  pinnedProjectCwds: [],
  hiddenProjectCwds: [],
  hiddenSessionIds: [],
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
  parentSessionId?: string;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
  offset: number;
  limit: number;
}

export type SessionDeleteDisposition = "trashed" | "deleted";

export interface SessionDeleteResponse {
  sessionId: string;
  disposition: SessionDeleteDisposition;
  /** The file deletion remains successful when navigation-metadata cleanup
   * fails; the browser keeps the warning visible instead of retrying a
   * destructive operation whose outcome is already known. */
  preferences?: InspirePreferences;
  preferenceCleanupFailed?: true;
}

export type ResourceKind = "image" | "html" | "pdf" | "markdown" | "text" | "audio" | "video" | "binary";

/** One entry of a workspace-explorer directory level. */
export interface ProjectDirEntry {
  name: string;
  type: "dir" | "file";
}

export type GitDeltaKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged";
export type GitDiffSide = "staged" | "unstaged";

/** Opaque Git identity. `id` is unpadded base64url of the exact raw
 * repository-relative pathname bytes; display strings never authorize a
 * command or filesystem read. */
export interface GitPathIdentity {
  id: string;
  display: string;
  utf8Path?: string;
  workspacePath?: string;
}

export interface GitDeltaFacet {
  kind: GitDeltaKind;
  originalPath?: GitPathIdentity;
}

export interface GitSubmoduleState {
  commitChanged: boolean;
  trackedModified: boolean;
  untracked: boolean;
}

export interface GitFileChange {
  path: GitPathIdentity;
  staged?: GitDeltaFacet;
  unstaged?: GitDeltaFacet;
  conflict?: { code: string };
  untracked: boolean;
  submodule?: GitSubmoduleState;
}

export interface GitChangeGroups {
  conflicted: string[];
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export type GitHead =
  | { kind: "branch"; name: string; oid: string }
  | { kind: "unborn"; name: string }
  | { kind: "detached"; oid: string };

export type GitStatusResponse =
  | { kind: "not-repository" }
  | {
      kind: "repository";
      head: GitHead;
      files: GitFileChange[];
      groups: GitChangeGroups;
      /** Total changed identities parsed before bounded projection. */
      total: number;
      /** True when `files` is only the first bounded projection. */
      truncated: boolean;
    };

export interface GitDiffLine {
  kind: "meta" | "hunk" | "context" | "add" | "delete";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

interface GitDiffBase {
  path: GitPathIdentity;
  side: GitDiffSide;
}

export type GitDiffResponse =
  | (GitDiffBase & { kind: "text"; lines: GitDiffLine[]; truncated: boolean; encodingLossy: boolean })
  | (GitDiffBase & { kind: "binary" })
  | (GitDiffBase & { kind: "submodule"; state: GitSubmoduleState })
  | (GitDiffBase & { kind: "conflict"; code: string })
  | (GitDiffBase & { kind: "empty"; reason: "no-changes" })
  | (GitDiffBase & { kind: "unsupported"; reason: "path-encoding" | "untracked-content" });

/** One subdirectory in the host directory picker. The host joins paths with
 * its own separator, so clients never do path arithmetic. */
export interface HostDirEntry {
  name: string;
  path: string;
}

/** Filesystem roots exposed by the host directory picker. POSIX hosts have
 * one `/` root; Windows hosts expose each currently readable drive root. */
export interface HostRootsResponse {
  roots: HostDirEntry[];
}

/** One level of the host filesystem, listed by the host process itself —
 * over SSH forwards or remote deployments this is always the machine
 * sessions actually run on. */
export interface HostDirListing {
  /** Absolute, symlink-resolved directory that was listed. */
  path: string;
  /** Absolute parent, or null at a filesystem root. */
  parent: string | null;
  /** Immediate subdirectories, sorted by name; dotted names stay hidden. */
  dirs: HostDirEntry[];
}

export interface ResourceDescriptor {
  id: string;
  sessionId: string;
  /** Opaque branch-view generation that authorized this handle. */
  viewId: string;
  reference: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ResourceKind;
}

export type ResourceAvailability = "available" | "missing" | "unavailable" | "ambiguous" | "invalid";

/** Lightweight preflight result for one bounded Files-pane reference. It
 * carries no resource handle and therefore grants no content access. */
export interface ResourceProbeResult {
  reference: string;
  availability: ResourceAvailability;
  message?: string;
  matches?: string[];
}

export interface ResourceProbeResponse {
  sessionId: string;
  viewId: string;
  results: ResourceProbeResult[];
}

const EXTENSION_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"] as const);
export const EXTENSION_ONE_WAY_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
export const MAX_EXTENSION_UI_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

interface ExtensionUiRequestBase {
  sessionId: string;
  id: string;
  title?: string;
  message?: string;
  /** Pi's positive timeout in milliseconds, bounded by the host. */
  timeout?: number;
  /** Host wall-clock deadline used by snapshots and the browser. */
  expiresAt?: number;
}

export interface SupportedExtensionUiRequest extends ExtensionUiRequestBase {
  method: "select" | "confirm" | "input" | "editor";
  unsupported?: false;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export interface UnsupportedExtensionUiRequest extends ExtensionUiRequestBase {
  method: string;
  unsupported: true;
  payload: unknown;
}

export type ExtensionUiRequest = SupportedExtensionUiRequest | UnsupportedExtensionUiRequest;

export interface GenericExtensionDisplay {
  id: string;
  method: string;
  attribution: string;
  payload: unknown;
}

export interface PendingQueues {
  steering: string[];
  followUp: string[];
}

export function emptyPendingQueues(): PendingQueues {
  return { steering: [], followUp: [] };
}

function extensionUiExpiry(event: Record<string, unknown>, now = Date.now()): { timeout?: number; expiresAt?: number } {
  const rawTimeout = typeof event.timeout === "number" && Number.isFinite(event.timeout) && event.timeout > 0
    ? Math.min(MAX_EXTENSION_UI_TIMEOUT_MS, Math.max(1, Math.floor(event.timeout)))
    : undefined;
  const rawExpiry = typeof event.expiresAt === "number" && Number.isFinite(event.expiresAt) && event.expiresAt > 0
    ? Math.floor(event.expiresAt)
    : undefined;
  const expiresAt = rawExpiry !== undefined
    ? Math.min(rawExpiry, now + MAX_EXTENSION_UI_TIMEOUT_MS)
    : rawTimeout !== undefined ? now + rawTimeout : undefined;
  return {
    ...(rawTimeout !== undefined ? { timeout: rawTimeout } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export function parseExtensionUiRequest(value: unknown): SupportedExtensionUiRequest | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  const id = typeof event.id === "string" ? event.id : "";
  const method = typeof event.method === "string" ? event.method : "";
  if (!sessionId || !id || !EXTENSION_DIALOG_METHODS.has(method as SupportedExtensionUiRequest["method"])) return null;
  return {
    sessionId,
    id,
    method: method as SupportedExtensionUiRequest["method"],
    title: typeof event.title === "string" ? event.title : undefined,
    message: typeof event.message === "string" ? event.message : undefined,
    ...extensionUiExpiry(event),
    options: Array.isArray(event.options) ? event.options.map(String) : undefined,
    placeholder: typeof event.placeholder === "string" ? event.placeholder : undefined,
    prefill: typeof event.prefill === "string" ? event.prefill : undefined,
  };
}

/** Unknown extension UI methods are conservatively response-bearing unless Pi
 * explicitly identifies them as one-way display output. This prevents a
 * future dialog promise from hanging while still giving future display
 * methods a generic, inspectable projection. */
export function parsePendingExtensionUiRequest(value: unknown): ExtensionUiRequest | null {
  const supported = parseExtensionUiRequest(value);
  if (supported) return supported;
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  const id = typeof event.id === "string" ? event.id : "";
  const method = typeof event.method === "string" ? event.method : "";
  if (!sessionId || !id || !method || EXTENSION_ONE_WAY_METHODS.has(method) || event.responseRequired === false) return null;
  return {
    sessionId,
    id,
    method,
    unsupported: true,
    title: typeof event.title === "string" ? event.title : undefined,
    message: typeof event.message === "string" ? event.message : undefined,
    ...extensionUiExpiry(event),
    payload: event,
  };
}

export interface ProjectionHealth {
  status: "ok" | "error";
  message?: string;
}

export interface TranscriptPage {
  sessionId: string;
  revision: number;
  /** Opaque runtime-owned branch-view generation; stable across same-branch appends. */
  viewId: string;
  /** Per-projection incarnation. Changes when the sole projection is reopened. */
  incarnation?: string;
  /** Oldest revision whose content is an append-only ancestor of this page. */
  appendFromRevision?: number;
  /** Branch view represented by this page; null is an empty session. */
  effectiveLeafId?: string | null;
  messages: unknown[];
  hasOlder: boolean;
  olderCursor: string | null;
}

export type BranchNodeRole = "user" | "assistant" | "tool" | "system" | "metadata";

export interface BranchTreeNode {
  id: string;
  parentId: string | null;
  depth: number;
  type: string;
  role: BranchNodeRole;
  label: string;
  snippet: string;
  timestamp: string;
  active: boolean;
  leaf: boolean;
  canSwitch: boolean;
  canEdit: boolean;
  canFork: boolean;
}

export interface BranchTreeResponse {
  sessionId: string;
  revision: number;
  incarnation: string;
  durableLeafId: string | null;
  effectiveLeafId: string | null;
  activePath: string[];
  nodes: BranchTreeNode[];
  truncated: boolean;
  health: ProjectionHealth;
}

export interface BranchNavigateRequest {
  sessionId: string;
  revision: number;
  targetId: string;
  mode: "switch" | "edit";
}

export interface BranchNavigateResponse {
  snapshot: ActiveSnapshot;
  editorText?: string;
}

export interface BranchForkRequest {
  sessionId: string;
  revision: number;
  targetId: string;
}

export interface BranchForkResponse {
  sessionId: string;
  snapshot: ActiveSnapshot;
  editorText: string;
}

export interface ProjectionConflict {
  /** Stable machine classification; the browser must not infer severity from
   * human-readable message text. */
  kind: ProjectionConflictKind;
  message: string;
  revision: number;
  /** Privacy-safe correlation for the host's bounded diagnostic records. */
  incidentId: string;
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
    /** Stable identity of the assistant message whose Pi turn is currently
     * executing, including its tool batch. Null before the next LLM call and
     * after agent settlement. */
    activeAssistantMessageKey?: string | null;
    isCompacting: boolean;
    /** Compatibility view of transcriptPage.messages; never a full history. */
    messages: unknown[];
    transcriptPage: TranscriptPage;
    projectionHealth: ProjectionHealth;
    projectionConflict?: ProjectionConflict | null;
    effectiveLeafId?: string | null;
    navigationLeased?: boolean;
    stats?: unknown;
    availableModels: unknown[];
    commands: unknown[];
  };
  runState: RunState;
  sessionStatuses: Record<string, SessionRuntimeStatus>;
  pendingExtensionUiRequests?: ExtensionUiRequest[];
  pendingQueues?: PendingQueues;
  extensionDisplays?: GenericExtensionDisplay[];
}

export interface BootstrapResponse {
  appName: "insπre";
  version: string;
  piVersion: string;
  mock: boolean;
  preferences: InspirePreferences;
  /** Configured models are available before any session owns a Pi worker. */
  availableModels: ModelOption[];
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
  /** Target session: writes never fall back to the host's current selection,
   * so a concurrent navigation cannot redirect a prompt. */
  sessionId: string;
  message: string;
  attachmentIds?: string[];
  projectFiles?: string[];
  behavior?: "steer" | "followUp";
}
