import { Download, GitBranch, GitFork, Pencil } from "lucide-react";
import { isAbortableRunState, type SessionActionId } from "../shared/contracts";
import { userMessageTitle } from "../shared/user-message";
import {
  type AppState,
  type NativeCommandUiRequest,
  selectedRunState,
} from "./app-state";
import { branchCopiesBlocked } from "./controllers/branch-controller";
import { store } from "./store";

export const sessionActions = {
  rename: { title: "Rename session", command: "name", icon: Pencil },
  "copy-id": { title: "Copy session ID", command: null, icon: null },
  clone: { title: "Clone current branch", command: "clone", icon: GitBranch },
  "switch-branch": { title: "Switch branch…", command: "tree", icon: GitFork },
  export: { title: "Export session…", command: "export", icon: Download },
} as const satisfies Record<
  SessionActionId,
  { title: string; command: string | null; icon: typeof Pencil | null }
>;

export function sessionActionAvailable(id: SessionActionId, state: AppState) {
  return (
    Boolean(state.sessionId) &&
    (id === "rename"
      ? !state.readOnlyReason
      : id !== "clone" || !branchCopiesBlocked(state))
  );
}

interface SessionActionControls {
  rename: (sessionId: string, name: string) => void;
  export: () => void;
  renameName?: (state: AppState) => string;
  copyId?: () => void;
  closeMenu?: (restoreFocus?: boolean) => void;
}

export function runSessionAction(
  id: SessionActionId,
  sessionId: string,
  controls: SessionActionControls,
) {
  const state = store.getState();
  if (state.sessionId !== sessionId || !sessionActionAvailable(id, state))
    return false;
  if (id === "copy-id") controls.copyId?.();
  else if (id === "clone") {
    const trigger = document.activeElement;
    void store.cloneCurrentBranch().then((cloned) => {
      if (cloned)
        controls.closeMenu?.(
          document.activeElement === trigger ||
            document.activeElement === document.body,
        );
    });
  } else {
    controls.closeMenu?.(id !== "switch-branch");
    if (id === "rename")
      controls.rename(
        sessionId,
        controls.renameName?.(state) ?? state.sessionName,
      );
    if (id === "switch-branch") store.openHistory();
    if (id === "export") controls.export();
  }
  return true;
}

export function canStop(state: AppState) {
  return isAbortableRunState(selectedRunState(state)) || state.live.bashRunning;
}

export function runStop(sessionId: string | null): boolean {
  const state = store.getState();
  if (!sessionId || state.sessionId !== sessionId || !canStop(state))
    return false;
  void store.abort();
  return true;
}

export function sessionPresentationName(state: AppState): string {
  return sessionHeading(
    state.sessionName,
    state.sessions.find((session) => session.id === state.sessionId)?.title,
    state.live.messages,
    !state.view.hasOlder,
  );
}

export type WorkbenchDestination = Exclude<
  NativeCommandUiRequest["action"],
  "model" | "thinking"
>;
export type WorkbenchDestinations = Record<
  WorkbenchDestination,
  (request?: NativeCommandUiRequest) => void
>;

/** Prefer explicit metadata and the catalog. A complete short transcript covers the first catalog refresh. */
export function sessionHeading(
  sessionName: string,
  catalogTitle: string | undefined,
  messages: readonly { role: string; content?: unknown }[],
  transcriptStartsAtRoot: boolean,
): string {
  const explicit = sessionName.trim();
  if (explicit) return explicit;
  const catalog = catalogTitle?.trim();
  if (catalog && catalog !== "Untitled session" && catalog !== "New session")
    return catalog;
  if (transcriptStartsAtRoot) {
    for (const message of messages) {
      if (message.role !== "user") continue;
      const title = userMessageTitle(message.content);
      if (title) return title;
    }
  }
  return "New session";
}
