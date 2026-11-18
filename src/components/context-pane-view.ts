import type { AppState } from "../app-state";

/** The contextual pane's shared projection. Child panes accept only the state
 * they render, so unrelated transcript/runtime updates do not redraw Files or
 * Changes through their parent. */
export type ContextPaneView = Pick<
  AppState,
  | "transportGeneration"
  | "sessionId"
  | "resourcesOpen"
  | "contextMode"
  | "fileInspection"
  | "resourceTabs"
  | "resourceStanding"
  | "workspaceQuery"
  | "cwd"
  | "gitStatus"
  | "gitStatusError"
  | "gitStatusPending"
  | "gitDiff"
> & { transcriptViewId: string | null; transcriptRevision: number };

export function selectContextPaneView(state: AppState): ContextPaneView {
  return {
    transportGeneration: state.transportGeneration,
    sessionId: state.sessionId,
    transcriptViewId: state.view.viewId,
    transcriptRevision: state.view.revision,
    resourcesOpen: state.resourcesOpen,
    contextMode: state.contextMode,
    fileInspection: state.fileInspection,
    resourceTabs: state.resourceTabs,
    resourceStanding: state.resourceStanding,
    workspaceQuery: state.workspaceQuery,
    cwd: state.cwd,
    gitStatus: state.gitStatus,
    gitStatusError: state.gitStatusError,
    gitStatusPending: state.gitStatusPending,
    gitDiff: state.gitDiff,
  };
}
