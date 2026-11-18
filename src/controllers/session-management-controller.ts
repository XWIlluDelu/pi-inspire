import {
  type PreferencePublication,
  type SessionDeleteDisposition,
  type SessionDeletionRequest,
  type SessionDeletionResponse,
} from "../../shared/contracts";
import { type Api, ApiError } from "../api";
import type { AppState } from "../app-state";

interface SessionManagementHost {
  state(): AppState;
  patch(patch: Partial<AppState>): void;
  api(): Api | null;
  authorityId(): string | null;
  notify(kind: "info" | "warning" | "error", text: string): void;
  handleAuthFailure(): void;
  refreshLoadedSessions(): Promise<void>;
  preserveLoadedSessions(
    query: string,
    offset: number,
    total: number,
  ): Promise<void>;
  forgetSessions(sessionIds: ReadonlySet<string>): void;
  pauseSessionReads(sessionIds: ReadonlySet<string>): () => void;
  publishPreferences(publication: PreferencePublication): void;
}

export type CommandChangeResult =
  | { status: "success"; message?: string }
  | { status: "error"; message: string }
  | { status: "stale" };

/** Owns session metadata edits and destructive Hidden workflows, including
 * transport fencing, preference-write ordering, and committed-result repair. */
export class SessionManagementController {
  private readonly latestRename = new Map<string, symbol>();

  constructor(private readonly host: SessionManagementHost) {}

  invalidateForTransportReplacement(): void {
    this.latestRename.clear();
  }

  renameSession = async (sessionId: string, name: string): Promise<boolean> => {
    const result = await this.renameSessionResult(sessionId, name);
    if (result.status === "error" && this.host.state().sessionId === sessionId)
      this.host.notify("warning", result.message);
    return result.status === "success";
  };

  renameSessionResult = async (
    sessionId: string,
    name: string,
  ): Promise<CommandChangeResult> => {
    const api = this.host.api();
    if (!api || !sessionId || !name.trim()) return { status: "stale" };
    const request = Symbol(sessionId);
    this.latestRename.set(sessionId, request);
    const ownsRequest = (): boolean =>
      this.host.api() === api && this.latestRename.get(sessionId) === request;
    const trimmedName = name.trim();
    try {
      await api.json("renameSession", {
        body: { sessionId, name: trimmedName },
      });
      if (!ownsRequest()) return { status: "stale" };
      // The response may return after a session switch; only the owning
      // session's visible title updates.
      if (this.host.state().sessionId === sessionId)
        this.host.patch({ sessionName: trimmedName });
      void this.host.refreshLoadedSessions();
      return { status: "success" };
    } catch (error) {
      if (!ownsRequest()) return { status: "stale" };
      if (error instanceof ApiError && error.status === 401)
        this.host.handleAuthFailure();
      return {
        status: "error",
        message:
          error instanceof Error ? error.message : "Failed to rename session",
      };
    } finally {
      if (this.latestRename.get(sessionId) === request)
        this.latestRename.delete(sessionId);
    }
  };

  clearSessionDeleteError = (): void =>
    this.host.patch({
      sessionDeleteError: null,
      sessionDeleteReviewRequired: false,
    });

  private needsFreshReview(error: unknown): boolean {
    return (
      error instanceof ApiError &&
      [
        "SESSION_NOT_FOUND",
        "SESSION_FILE_MISSING",
        "SESSION_CATALOG_STALE",
        "HIDDEN_SELECTION_CHANGED",
        "SESSION_CATALOG_INCOMPLETE",
      ].includes(error.code ?? "")
    );
  }

  /** Rebuild metadata and the consumed list, but never repeat destructive I/O.
   * Local preference edits made during this read retain their field ownership. */
  private async refreshDeletionReview(
    api: Api,
    ownsTransport: () => boolean,
    extent: readonly [query: string, offset: number, total: number],
  ): Promise<void> {
    this.host.patch({ sessionDeleteReviewRequired: true });
    try {
      const [preferences] = await Promise.all([
        api.json("preferences", {}),
        api.json("refreshSessions", {}),
      ]);
      if (!ownsTransport()) return;
      this.host.publishPreferences(preferences);
      await this.host.preserveLoadedSessions(...extent);
    } catch (error) {
      if (!ownsTransport()) return;
      if (error instanceof ApiError && error.status === 401)
        this.host.handleAuthFailure();
      else
        this.host.notify(
          "warning",
          "Could not refresh Hidden. Refresh the session list before confirming again.",
        );
    }
  }

  deleteSession = async (
    sessionId: string,
  ): Promise<SessionDeleteDisposition | null> =>
    (await this.deleteReviewed({ scope: "session", sessionId }))?.deleted[0]
      ?.disposition ?? null;

  clearHiddenSessions = (sessionIds: string[], projectCwd?: string) =>
    this.deleteReviewed({ scope: "hidden", sessionIds, projectCwd });

  private async deleteReviewed(
    request: SessionDeletionRequest,
  ): Promise<SessionDeletionResponse | null> {
    const api = this.host.api();
    const state = this.host.state();
    if (
      !api ||
      state.deletingSessionId ||
      state.clearingHidden ||
      state.sessionDeleteReviewRequired ||
      state.curationPending
    )
      return null;

    const { prefs, sessions } = state;
    const single = request.scope === "session";
    const ids = new Set(single ? [request.sessionId] : request.sessionIds);
    if (single) {
      const session = sessions.find(({ id }) => id === request.sessionId);
      if (
        !prefs.hiddenSessionIds.includes(request.sessionId) &&
        !(session && prefs.hiddenProjectCwds.includes(session.cwd))
      )
        return null;
    } else if (
      ids.size === 0 ||
      state.sessionQuery.trim() ||
      state.sessionListLoading ||
      state.sessionListLoadingOlder ||
      state.sessionListHydrating ||
      state.sessionListError ||
      state.sessionListIssues.length
    ) {
      return null;
    }
    const extent = [
      state.sessionQuery,
      state.sessionListNextOffset,
      state.sessionListTotal,
    ] as const;
    const ownsTransport = () => this.host.api() === api;
    this.host.patch({
      deletingSessionId: single ? request.sessionId : null,
      clearingHidden: !single,
      sessionDeleteError: null,
    });
    let resumeReads: (() => void) | undefined;
    try {
      if (!single) {
        const current = sessions.filter(({ id, cwd }) =>
          request.projectCwd === undefined
            ? prefs.hiddenSessionIds.includes(id) ||
              prefs.hiddenProjectCwds.includes(cwd)
            : request.projectCwd === cwd &&
              prefs.hiddenProjectCwds.includes(cwd),
        );
        if (
          ids.size !== request.sessionIds.length ||
          current.length !== ids.size ||
          current.some(({ id }) => !ids.has(id))
        ) {
          throw new ApiError(
            409,
            "Hidden changed; review it before clearing",
            undefined,
            "HIDDEN_SELECTION_CHANGED",
          );
        }
      }
      resumeReads = this.host.pauseSessionReads(ids);
      const result = await api.json("deleteSessions", { body: request });
      if (!ownsTransport()) return null;
      const { deleted, failure, navigation } = result;
      if (deleted.length) {
        this.host.forgetSessions(
          new Set(deleted.map(({ sessionId }) => sessionId)),
        );
        const subject = single
          ? "Session"
          : `${deleted.length} ${deleted.length === 1 ? "session" : "sessions"}`;
        const action = deleted.every(
          ({ disposition }) => disposition === "trashed",
        )
          ? "moved to Trash"
          : single
            ? "permanently deleted"
            : "deleted";
        this.host.notify("info", `${subject} ${action}`);
      }
      if (navigation.kind === "unavailable")
        this.host.notify("warning", navigation.reason);
      else if (navigation.authorityId === this.host.authorityId())
        this.host.publishPreferences(navigation);
      if (failure) {
        this.host.patch({
          sessionDeleteError: `Deleted ${deleted.length} ${deleted.length === 1 ? "session" : "sessions"}; stopped at ${failure.sessionId}: ${failure.message}`,
        });
        await this.refreshDeletionReview(api, ownsTransport, extent);
      } else if (deleted.length)
        void this.host.preserveLoadedSessions(...extent);
      return result;
    } catch (error) {
      if (!ownsTransport()) return null;
      if (error instanceof ApiError && error.status === 401)
        this.host.handleAuthFailure();
      else {
        this.host.patch({
          sessionDeleteError:
            error instanceof Error
              ? error.message
              : single
                ? "Failed to delete session"
                : "Failed to clear Hidden",
        });
        if (this.needsFreshReview(error))
          await this.refreshDeletionReview(api, ownsTransport, extent);
      }
      return null;
    } finally {
      if (ownsTransport())
        this.host.patch({ deletingSessionId: null, clearingHidden: false });
      resumeReads?.();
    }
  }
}
