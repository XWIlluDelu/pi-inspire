import type { GitDiffSide } from "../shared/contracts";
import type { AppState } from "./app-state";
import type { ResourceFileTab } from "./resource-preview";

// Browser-tab-local, origin-scoped navigation metadata, like composer drafts.
// Host process epochs may change on restart; paths are reauthorized on each read.
// No file bytes,
// renewable resource handles, or HTML execution grants belong in this record.
const PREFIX = "inspire:workbench:v1:";
const LAST_SESSION = `${PREFIX}last-session`;
const NAV_COLLAPSED = `${PREFIX}nav-collapsed`;

export interface FileReadingState {
  source: { current: { top: number; left: number } | null; save?: () => void };
  rendered: { current: { top: number; left: number } | null };
  mode?: "source" | "preview";
  changes?: Partial<
    Record<
      GitDiffSide,
      { top: number; left: number; activeChange: number | null }
    >
  >;
  save?: () => void;
}

type SavedWorkbench = Pick<
  AppState,
  | "resourcesOpen"
  | "contextMode"
  | "fileBrowserView"
  | "resourceTabs"
  | "selectedResourceReference"
  | "selectedResourceWorkspacePath"
  | "workspaceQuery"
  | "workspaceExpandedDirs"
  | "workspaceShowHidden"
>;

function read(key: string): unknown {
  try {
    return JSON.parse(window.sessionStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Refused or full storage must not interrupt ordinary navigation.
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function path(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function workbenchSessionKey(
  sessionId: string | null,
  cwd: string | null,
): string | null {
  return sessionId && cwd
    ? `${PREFIX}${JSON.stringify([sessionId, cwd])}`
    : null;
}

export function lastWorkbenchSession(): {
  sessionId: string | null;
} | null {
  const saved = record(read(LAST_SESSION));
  return saved && (saved.sessionId === null || path(saved.sessionId))
    ? { sessionId: saved.sessionId }
    : null;
}

export function rememberWorkbenchSession(sessionId: string | null): void {
  write(LAST_SESSION, { sessionId });
}

export function readNavCollapsed(): boolean {
  return read(NAV_COLLAPSED) === true;
}

export function saveNavCollapsed(collapsed: boolean): void {
  write(NAV_COLLAPSED, collapsed);
}

export function readWorkbench(key: string | null): SavedWorkbench | null {
  const saved = key ? record(read(key)) : null;
  if (!saved || !Array.isArray(saved.resourceTabs)) return null;
  const resourceTabs: ResourceFileTab[] = [];
  for (const value of saved.resourceTabs) {
    const tab = record(value);
    if (
      !tab ||
      !path(tab.reference) ||
      tab.reference.startsWith("pi-embedded://") ||
      resourceTabs.some((previous) => previous.reference === tab.reference)
    )
      continue;
    const git = record(tab.git);
    resourceTabs.push({
      reference: tab.reference,
      ...(path(tab.workspacePath) ? { workspacePath: tab.workspacePath } : {}),
      ...(tab.view === "changes" ? { view: "changes" } : {}),
      ...(git &&
      path(git.pathId) &&
      (git.side === "staged" || git.side === "unstaged") &&
      path(git.displayPath)
        ? {
            git: {
              pathId: git.pathId,
              side: git.side,
              displayPath: git.displayPath,
            },
          }
        : {}),
    });
  }
  const selected = resourceTabs.find(
    (tab) => tab.reference === saved.selectedResourceReference,
  );
  const contextMode = ["files", "changes", "branches", "terminal"].includes(
    String(saved.contextMode),
  )
    ? (saved.contextMode as AppState["contextMode"])
    : "files";
  return {
    resourcesOpen: saved.resourcesOpen === true,
    contextMode,
    fileBrowserView:
      selected && saved.fileBrowserView === "preview" ? "preview" : "browse",
    resourceTabs,
    selectedResourceReference: selected?.reference ?? null,
    selectedResourceWorkspacePath: selected?.workspacePath ?? null,
    workspaceQuery:
      typeof saved.workspaceQuery === "string" ? saved.workspaceQuery : "",
    workspaceExpandedDirs: Array.isArray(saved.workspaceExpandedDirs)
      ? saved.workspaceExpandedDirs.filter(path)
      : [],
    workspaceShowHidden: saved.workspaceShowHidden === true,
  };
}

const SAVED_FIELDS = [
  "resourcesOpen",
  "contextMode",
  "fileBrowserView",
  "resourceTabs",
  "selectedResourceReference",
  "selectedResourceWorkspacePath",
  "workspaceQuery",
  "workspaceExpandedDirs",
  "workspaceShowHidden",
] as const;

export function saveWorkbench(
  key: string | null,
  state: AppState,
  previous?: AppState,
): void {
  if (
    !key ||
    (previous &&
      SAVED_FIELDS.every((field) => previous[field] === state[field]))
  )
    return;
  const saved = Object.fromEntries(
    SAVED_FIELDS.map((field) => [field, state[field]]),
  );
  saved.resourceTabs = state.resourceTabs.filter(
    (tab) => !tab.reference.startsWith("pi-embedded://"),
  );
  write(key, saved);
}

function readingKey(key: string, reference: string): string {
  return `${key}:reading:${JSON.stringify(reference)}`;
}

function position(value: unknown): { top: number; left: number } | null {
  const offset = record(value);
  return offset &&
    typeof offset.top === "number" &&
    Number.isFinite(offset.top) &&
    offset.top >= 0 &&
    typeof offset.left === "number" &&
    Number.isFinite(offset.left) &&
    offset.left >= 0
    ? { top: offset.top, left: offset.left }
    : null;
}

export function readFileReading(
  key: string | null,
  reference: string,
): FileReadingState {
  const storageKey =
    key && !reference.startsWith("pi-embedded://")
      ? readingKey(key, reference)
      : null;
  const saved = storageKey ? record(read(storageKey)) : null;
  const savedChanges = record(saved?.changes);
  const changes: NonNullable<FileReadingState["changes"]> = {};
  for (const side of ["staged", "unstaged"] as const) {
    const reading = record(savedChanges?.[side]);
    const offset = position(reading);
    if (offset)
      changes[side] = {
        ...offset,
        activeChange:
          typeof reading?.activeChange === "number" &&
          Number.isSafeInteger(reading.activeChange) &&
          reading.activeChange >= 0
            ? reading.activeChange
            : null,
      };
  }
  const state: FileReadingState = {
    source: { current: position(saved?.source) },
    rendered: { current: position(saved?.rendered) },
    changes,
    ...(saved?.mode === "source" || saved?.mode === "preview"
      ? { mode: saved.mode }
      : {}),
    save: () => {
      if (storageKey)
        write(storageKey, {
          source: state.source.current,
          rendered: state.rendered.current,
          mode: state.mode,
          changes: state.changes,
        });
    },
  };
  state.source.save = state.save;
  return state;
}

export function forgetFileReading(key: string | null, reference: string): void {
  if (key) write(readingKey(key, reference), null);
}
