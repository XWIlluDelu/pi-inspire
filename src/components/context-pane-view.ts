import type { AppState } from "../app-state";

/** The contextual pane's shared projection. Child panes accept only the state
 * they render, so unrelated transcript/runtime updates do not redraw Files or
 * Changes through their parent. */
export type ContextPaneView = Pick<
  AppState,
  | "transportGeneration"
  | "sessionId"
  | "transcriptViewId"
  | "transcriptRevision"
  | "resourcesOpen"
  | "contextMode"
  | "fileInspection"
  | "resourceTabs"
  | "resourceStanding"
  | "workspaceQuery"
  | "workspaceLoadingDirs"
  | "workspaceSearchLoading"
  | "cwd"
  | "gitStatus"
  | "gitStatusError"
  | "gitStatusLoading"
  | "gitStatusRefreshing"
  | "gitDiff"
  | "branchTreeLoading"
  | "branchActionId"
>;

export function selectContextPaneView(state: AppState): ContextPaneView {
  return {
    transportGeneration: state.transportGeneration,
    sessionId: state.sessionId,
    transcriptViewId: state.transcriptViewId,
    transcriptRevision: state.transcriptRevision,
    resourcesOpen: state.resourcesOpen,
    contextMode: state.contextMode,
    fileInspection: state.fileInspection,
    resourceTabs: state.resourceTabs,
    resourceStanding: state.resourceStanding,
    workspaceQuery: state.workspaceQuery,
    workspaceLoadingDirs: state.workspaceLoadingDirs,
    workspaceSearchLoading: state.workspaceSearchLoading,
    cwd: state.cwd,
    gitStatus: state.gitStatus,
    gitStatusError: state.gitStatusError,
    gitStatusLoading: state.gitStatusLoading,
    gitStatusRefreshing: state.gitStatusRefreshing,
    gitDiff: state.gitDiff,
    branchTreeLoading: state.branchTreeLoading,
    branchActionId: state.branchActionId,
  };
}
