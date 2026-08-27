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
  | "fileBrowserView"
  | "selectedResourceReference"
  | "selectedResourceWorkspacePath"
  | "resourcePreview"
  | "resourceAvailability"
  | "resourceWorkspacePaths"
  | "workspaceQuery"
  | "workspaceLoadingDirs"
  | "workspaceSearchLoading"
  | "project"
  | "cwd"
  | "gitStatus"
  | "gitStatusError"
  | "gitStatusLoading"
  | "gitStatusRefreshing"
  | "selectedGitPathId"
  | "selectedGitSide"
  | "gitDiff"
  | "branchTreeLoading"
>;

export function selectContextPaneView(state: AppState): ContextPaneView {
  return {
    transportGeneration: state.transportGeneration,
    sessionId: state.sessionId,
    transcriptViewId: state.transcriptViewId,
    transcriptRevision: state.transcriptRevision,
    resourcesOpen: state.resourcesOpen,
    contextMode: state.contextMode,
    fileBrowserView: state.fileBrowserView,
    selectedResourceReference: state.selectedResourceReference,
    selectedResourceWorkspacePath: state.selectedResourceWorkspacePath,
    resourcePreview: state.resourcePreview,
    resourceAvailability: state.resourceAvailability,
    resourceWorkspacePaths: state.resourceWorkspacePaths,
    workspaceQuery: state.workspaceQuery,
    workspaceLoadingDirs: state.workspaceLoadingDirs,
    workspaceSearchLoading: state.workspaceSearchLoading,
    project: state.project,
    cwd: state.cwd,
    gitStatus: state.gitStatus,
    gitStatusError: state.gitStatusError,
    gitStatusLoading: state.gitStatusLoading,
    gitStatusRefreshing: state.gitStatusRefreshing,
    selectedGitPathId: state.selectedGitPathId,
    selectedGitSide: state.selectedGitSide,
    gitDiff: state.gitDiff,
    branchTreeLoading: state.branchTreeLoading,
  };
}
