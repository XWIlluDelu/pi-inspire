import {
  type HiddenClearResponse,
  type InspirePreferences,
  type SessionDeleteDisposition,
} from "../../shared/contracts";
import { ApiError, type Api } from "../api";
import type { AppState } from "../app-state";

interface SessionManagementHost {
  state(): AppState;
  patch(patch: Partial<AppState>): void;
  api(): Api | null;
  transportGeneration(): number;
  notify(kind: "info" | "warning" | "error", text: string): void;
  handleAuthFailure(): void;
  refreshLoadedSessions(): Promise<void>;
  preserveLoadedSessions(
    query: string,
    offset: number,
    total: number,
  ): Promise<void>;
  forgetSessions(sessionIds: ReadonlySet<string>): AppState["sessionStatuses"];
  flushPreferences(): Promise<unknown>;
  capturePreferenceOwners(): ReadonlyMap<keyof InspirePreferences, number>;
  reconcilePreferences(
    authoritative: InspirePreferences,
    owners: ReadonlyMap<keyof InspirePreferences, number>,
  ): InspirePreferences;
}

/** Owns session metadata edits and destructive Hidden workflows, including
 * transport fencing, preference-write ordering, and committed-result repair. */
export class SessionManagementController {
  private readonly latestRename = new Map<string, symbol>();

  constructor(private readonly host: SessionManagementHost) {}

  invalidateForTransportReplacement(): void {
    this.latestRename.clear();
  }

  renameSession = async (sessionId: string, name: string): Promise<boolean> => {
    const api = this.host.api();
    if (!api || !sessionId || !name.trim()) return false;
    const transportGeneration = this.host.transportGeneration();
    const request = Symbol(sessionId);
    this.latestRename.set(sessionId, request);
    const ownsRequest = (): boolean =>
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration &&
      this.latestRename.get(sessionId) === request;
    const trimmedName = name.trim();
    try {
      await api.renameSession(sessionId, trimmedName);
      if (!ownsRequest()) return false;
      // The response may return after a session switch; only the owning
      // session's visible title updates.
      if (this.host.state().sessionId === sessionId)
        this.host.patch({ sessionName: trimmedName });
      void this.host.refreshLoadedSessions();
      return true;
    } catch (error) {
      if (!ownsRequest()) return false;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
        return false;
      }
      // A background rename must not surface its failure over another visible
      // session. The caller still receives false for its owning editor.
      if (this.host.state().sessionId === sessionId) {
        this.host.notify(
          "warning",
          error instanceof Error ? error.message : "Failed to rename session",
        );
      }
      return false;
    } finally {
      if (this.latestRename.get(sessionId) === request)
        this.latestRename.delete(sessionId);
    }
  };

  clearSessionDeleteError = (): void =>
    this.host.patch({ sessionDeleteError: null });

  private forgetDeletedSessions(
    sessionIds: ReadonlySet<string>,
  ): AppState["sessionStatuses"] {
    return this.host.forgetSessions(sessionIds);
  }

  private preferencesWithoutSessions(
    sessionIds: ReadonlySet<string>,
  ): InspirePreferences {
    return {
      ...this.host.state().prefs,
      pinnedSessionIds: this.host
        .state()
        .prefs.pinnedSessionIds.filter((id) => !sessionIds.has(id)),
      hiddenSessionIds: this.host
        .state()
        .prefs.hiddenSessionIds.filter((id) => !sessionIds.has(id)),
    };
  }

  deleteSession = async (
    sessionId: string,
  ): Promise<SessionDeleteDisposition | null> => {
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const ownsTransport = (): boolean =>
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration;
    const session = this.host
      .state()
      .sessions.find((candidate) => candidate.id === sessionId);
    const hidden =
      this.host.state().prefs.hiddenSessionIds.includes(sessionId) ||
      (session !== undefined &&
        this.host.state().prefs.hiddenProjectCwds.includes(session.cwd));
    if (
      !api ||
      this.host.state().deletingSessionId ||
      this.host.state().clearingHidden ||
      sessionId === this.host.state().sessionId ||
      !hidden
    )
      return null;
    const preserveQuery = this.host.state().sessionQuery;
    const preserveOffset = this.host.state().sessionListNextOffset;
    const preserveTotal = this.host.state().sessionListTotal;
    this.host.patch({ deletingSessionId: sessionId, sessionDeleteError: null });
    try {
      // Hiding is an optimistic preference write. Fence it before DELETE so a
      // late PATCH cannot resurrect the deleted id in durable navigation data.
      await this.host.flushPreferences();
      if (!ownsTransport()) return null;
      const current = this.host
        .state()
        .sessions.find((candidate) => candidate.id === sessionId);
      const stillHidden =
        this.host.state().prefs.hiddenSessionIds.includes(sessionId) ||
        (current !== undefined &&
          this.host.state().prefs.hiddenProjectCwds.includes(current.cwd));
      if (!stillHidden) {
        this.host.patch({
          sessionDeleteError:
            "The session must remain in Hidden before it can be deleted",
        });
        return null;
      }
      const preferenceOwners = this.host.capturePreferenceOwners();
      const result = await api.deleteSession(sessionId);
      if (!ownsTransport()) return null;
      const deleted = new Set([sessionId]);
      const sessionStatuses = this.forgetDeletedSessions(deleted);
      const prefs = result.preferences
        ? this.host.reconcilePreferences(result.preferences, preferenceOwners)
        : this.preferencesWithoutSessions(deleted);
      this.host.patch({ prefs, sessionStatuses });
      this.host.notify(
        "info",
        result.disposition === "trashed"
          ? "Session moved to Trash"
          : "Session permanently deleted",
      );
      if (result.preferenceCleanupFailed) {
        this.host.notify(
          "warning",
          "Session was deleted, but its navigation metadata could not be saved",
        );
      }
      // Rebuild the already-consumed chronological extent under one fresh
      // generation. The optimistic row removal keeps the destructive result
      // immediate while offset-based pagination is repaired authoritatively.
      void this.host.preserveLoadedSessions(
        preserveQuery,
        preserveOffset,
        preserveTotal,
      );
      return result.disposition;
    } catch (error) {
      if (!ownsTransport()) return null;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
      } else {
        this.host.patch({
          sessionDeleteError:
            error instanceof Error ? error.message : "Failed to delete session",
        });
      }
      return null;
    } finally {
      if (ownsTransport() && this.host.state().deletingSessionId === sessionId)
        this.host.patch({ deletingSessionId: null });
    }
  };

  clearHiddenSessions = async (
    sessionIds: string[],
  ): Promise<HiddenClearResponse | null> => {
    const api = this.host.api();
    const transportGeneration = this.host.transportGeneration();
    const ownsTransport = (): boolean =>
      this.host.api() === api &&
      this.host.transportGeneration() === transportGeneration;
    if (
      !api ||
      sessionIds.length === 0 ||
      this.host.state().deletingSessionId ||
      this.host.state().clearingHidden ||
      this.host.state().sessionQuery.trim() ||
      this.host.state().sessionListLoading ||
      this.host.state().sessionListLoadingOlder ||
      this.host.state().sessionListHydrating ||
      this.host.state().sessionListError
    )
      return null;
    const preserveQuery = this.host.state().sessionQuery;
    const preserveOffset = this.host.state().sessionListNextOffset;
    const preserveTotal = this.host.state().sessionListTotal;
    this.host.patch({ clearingHidden: true, sessionDeleteError: null });
    try {
      // Hiding is optimistic. Fence every outstanding curation write before
      // confirming that the reviewed ids still represent the complete Hidden
      // selection sent to the host.
      await this.host.flushPreferences();
      if (!ownsTransport()) return null;
      const hiddenSessionIds = [...this.host.state().prefs.hiddenSessionIds];
      const hiddenProjectCwds = [...this.host.state().prefs.hiddenProjectCwds];
      const individualIds = new Set(hiddenSessionIds);
      const projectCwds = new Set(hiddenProjectCwds);
      const currentIds = this.host
        .state()
        .sessions.filter(
          (session) =>
            individualIds.has(session.id) || projectCwds.has(session.cwd),
        )
        .map((session) => session.id);
      const reviewed = new Set(sessionIds);
      if (
        reviewed.size !== sessionIds.length ||
        currentIds.length !== reviewed.size ||
        currentIds.some((sessionId) => !reviewed.has(sessionId))
      ) {
        this.host.patch({
          sessionDeleteError: "Hidden changed; review it before clearing",
        });
        return null;
      }

      const preferenceOwners = this.host.capturePreferenceOwners();
      const result = await api.clearHiddenSessions(sessionIds);
      if (!ownsTransport()) return null;
      const deleted = new Set(
        result.deleted.map((session) => session.sessionId),
      );
      const sessionStatuses = this.forgetDeletedSessions(deleted);
      const remainingPrefs = this.preferencesWithoutSessions(deleted);
      const fallbackPrefs = result.failure
        ? remainingPrefs
        : {
            ...remainingPrefs,
            hiddenSessionIds: remainingPrefs.hiddenSessionIds.filter(
              (sessionId) => !individualIds.has(sessionId),
            ),
            pinnedProjectCwds: remainingPrefs.pinnedProjectCwds.filter(
              (cwd) => !projectCwds.has(cwd),
            ),
            hiddenProjectCwds: remainingPrefs.hiddenProjectCwds.filter(
              (cwd) => !projectCwds.has(cwd),
            ),
            navCollapsedGroups: remainingPrefs.navCollapsedGroups.filter(
              (cwd) => !projectCwds.has(cwd),
            ),
          };
      const prefs = result.preferences
        ? this.host.reconcilePreferences(result.preferences, preferenceOwners)
        : fallbackPrefs;
      this.host.patch({ prefs, sessionStatuses });

      if (result.deleted.length > 0) {
        const count = result.deleted.length;
        const allTrashed = result.deleted.every(
          (session) => session.disposition === "trashed",
        );
        this.host.notify(
          "info",
          allTrashed
            ? `${count} ${count === 1 ? "session" : "sessions"} moved to Trash`
            : `${count} ${count === 1 ? "session" : "sessions"} deleted`,
        );
        void this.host.preserveLoadedSessions(
          preserveQuery,
          preserveOffset,
          preserveTotal,
        );
      }
      if (result.preferenceCleanupFailed) {
        this.host.notify(
          "warning",
          "Sessions were deleted, but their navigation metadata could not be saved",
        );
      }
      if (result.failure) {
        this.host.patch({
          sessionDeleteError: `Deleted ${result.deleted.length} ${result.deleted.length === 1 ? "session" : "sessions"}; stopped at ${result.failure.sessionId}: ${result.failure.message}`,
        });
      }
      return result;
    } catch (error) {
      if (!ownsTransport()) return null;
      if (error instanceof ApiError && error.status === 401) {
        this.host.handleAuthFailure();
      } else {
        this.host.patch({
          sessionDeleteError:
            error instanceof Error ? error.message : "Failed to clear Hidden",
        });
      }
      return null;
    } finally {
      if (ownsTransport()) this.host.patch({ clearingHidden: false });
    }
  };
}
