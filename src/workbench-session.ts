import { jsonRecord } from "../shared/json-record";
import type { AppState } from "./app-state";
import type { ResourceFileTab } from "./resource-preview";

// Browser-tab-local, origin-scoped navigation metadata, like composer drafts.
// Host process epochs may change on restart; paths are reauthorized on each read.
// No file bytes,
// renewable resource handles, or HTML execution grants belong in this record.
const PREFIX = "inspire:workbench:v1:";
const LAST_SESSION = `${PREFIX}last-session`;
const NAV_COLLAPSED = `${PREFIX}nav-collapsed`;
const NAV_DISCLOSURES = `${PREFIX}navigation-disclosures`;
const NAV_CATALOG = `${PREFIX}session-catalog`;
type NavigationDisclosure = "recentSessions";
export type SessionCatalogView = "all" | "needs-you" | "hidden";

export interface FileReadingState {
  source: { current: { top: number; left: number } | null; save?: () => void };
  rendered: { current: { top: number; left: number } | null };
  mode?: "source" | "preview";
  changes?: { top: number; left: number; activeChange: number | null };
  save?: () => void;
}

type SavedWorkbench = Pick<
  AppState,
  | "resourcesOpen"
  | "contextMode"
  | "fileInspection"
  | "resourceTabs"
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

function path(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function workbenchSessionKey(
  sessionId: string | null,
  cwd: string | null,
): string | null {
  return sessionId && cwd
    ? `${PREFIX}dock-v2:${JSON.stringify([sessionId, cwd])}`
    : null;
}

export function lastWorkbenchSession(): {
  sessionId: string | null;
} | null {
  const saved = jsonRecord(read(LAST_SESSION));
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

export function readSessionCatalogView(): SessionCatalogView {
  const view = read(NAV_CATALOG);
  return view === "needs-you" || view === "hidden" ? view : "all";
}

export function saveSessionCatalogView(view: SessionCatalogView): void {
  write(NAV_CATALOG, view);
}

export function readNavigationDisclosure(name: NavigationDisclosure): boolean {
  const value = jsonRecord(read(NAV_DISCLOSURES))?.[name];
  return value !== false;
}

export function saveNavigationDisclosure(
  name: NavigationDisclosure,
  open: boolean,
): void {
  write(NAV_DISCLOSURES, {
    ...jsonRecord(read(NAV_DISCLOSURES)),
    [name]: open,
  });
}

export function readWorkbench(key: string | null): SavedWorkbench | null {
  const saved = key ? jsonRecord(read(key)) : null;
  if (!saved || !Array.isArray(saved.resourceTabs)) return null;
  const tabs = new Map<string, ResourceFileTab>();
  for (const value of saved.resourceTabs) {
    const tab = jsonRecord(value);
    if (
      !tab ||
      !path(tab.reference) ||
      tab.reference.startsWith("pi-embedded://") ||
      tabs.has(tab.reference)
    )
      continue;
    const git = jsonRecord(tab.git);
    tabs.set(tab.reference, {
      reference: tab.reference,
      ...(path(tab.workspacePath) ? { workspacePath: tab.workspacePath } : {}),
      ...(tab.view === "changes" ? { view: "changes" } : {}),
      ...(git && path(git.pathId) && path(git.displayPath)
        ? {
            git: {
              pathId: git.pathId,
              displayPath: git.displayPath,
            },
          }
        : {}),
    });
  }
  const inspection = jsonRecord(saved.inspection);
  const selected = path(inspection?.reference)
    ? tabs.get(inspection.reference)
    : undefined;
  const contextMode = ["files", "changes", "terminal"].includes(
    String(saved.contextMode),
  )
    ? (saved.contextMode as AppState["contextMode"])
    : "files";
  return {
    resourcesOpen: saved.resourcesOpen === true,
    contextMode,
    fileInspection:
      selected && inspection?.kind === "file"
        ? {
            kind: "file",
            reference: selected.reference,
            workspacePath: selected.workspacePath,
            preview: null,
          }
        : { kind: "browse", reference: selected?.reference },
    resourceTabs: [...tabs.values()],
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
  "resourceTabs",
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
      previous.fileInspection.kind === state.fileInspection.kind &&
      previous.fileInspection.reference === state.fileInspection.reference &&
      SAVED_FIELDS.every((field) => previous[field] === state[field]))
  )
    return;
  write(key, {
    ...Object.fromEntries(SAVED_FIELDS.map((field) => [field, state[field]])),
    inspection: {
      kind: state.fileInspection.kind,
      reference: state.fileInspection.reference,
    },
    resourceTabs: state.resourceTabs.filter(
      (tab) => !tab.reference.startsWith("pi-embedded://"),
    ),
  });
}

function readingKey(key: string, reference: string): string {
  return `${key}:reading:${JSON.stringify(reference)}`;
}

function position(value: unknown): { top: number; left: number } | null {
  const offset = jsonRecord(value);
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
  const saved = storageKey ? jsonRecord(read(storageKey)) : null;
  const changePosition = (value: unknown): FileReadingState["changes"] => {
    const reading = jsonRecord(value);
    const offset = position(reading);
    return offset
      ? {
          ...offset,
          activeChange:
            typeof reading?.activeChange === "number" &&
            Number.isSafeInteger(reading.activeChange) &&
            reading.activeChange >= 0
              ? reading.activeChange
              : null,
        }
      : undefined;
  };
  const state: FileReadingState = {
    source: { current: position(saved?.source) },
    rendered: { current: position(saved?.rendered) },
    changes: changePosition(saved?.changes),
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
