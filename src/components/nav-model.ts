import {
  type InspirePreferences,
  isBusyRunState,
  projectNameFromCwd,
  type SessionSummary,
} from "../../shared/contracts";
import type { AppState } from "../app-state";

type HiddenDeletionState = Pick<
  AppState,
  | "sessionId"
  | "openingSessionId"
  | "sessionStatuses"
  | "externalSessionActivities"
  | "sessionQuery"
  | "sessionListLoading"
  | "sessionListLoadingOlder"
  | "sessionListHydrating"
  | "sessionListError"
  | "clearingHidden"
  | "deletingSessionId"
>;

/** The drawer and each complete folder apply the same rules to their own set.
 * Activity in a different folder must not block an otherwise idle selection. */
export function hiddenDeletionBlockReason(
  sessions: readonly SessionSummary[],
  state: HiddenDeletionState,
): string | null {
  if (state.clearingHidden)
    return "Wait for the current Hidden deletion to finish";
  if (state.deletingSessionId !== null)
    return "Wait for the current session deletion to finish";
  if (state.sessionQuery.trim())
    return "Deletion is unavailable while searching";
  if (
    state.sessionListLoading ||
    state.sessionListLoadingOlder ||
    state.sessionListHydrating ||
    state.sessionListError !== null
  ) {
    return "Wait for Hidden sessions to finish loading";
  }
  if (sessions.some((session) => session.id === state.sessionId))
    return "Switch to another session before deleting";
  if (sessions.some((session) => session.id === state.openingSessionId))
    return "Wait for these sessions to finish opening";
  if (
    sessions.some(
      (session) => state.externalSessionActivities[session.id] !== undefined,
    )
  )
    return "Close the Pi terminal sessions before deleting";
  if (
    sessions.some((session) => {
      const status = state.sessionStatuses[session.id];
      return (
        status &&
        (isBusyRunState(status.runState) || status.runState === "conflict")
      );
    })
  )
    return "Wait for these sessions to finish working or resolve conflicts";
  return null;
}

export interface SessionGroup {
  cwd: string;
  /** Concise folder name (basename of cwd). */
  name: string;
  sessions: SessionSummary[];
}

/** Group sessions by exact cwd identity. Groups sort by their newest session
 * descending; sessions within a group sort by modified descending. */
export function groupSessionsByCwd(sessions: SessionSummary[]): SessionGroup[] {
  const byCwd = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const list = byCwd.get(session.cwd);
    if (list) list.push(session);
    else byCwd.set(session.cwd, [session]);
  }
  const groups: SessionGroup[] = [];
  for (const [cwd, list] of byCwd) {
    groups.push({
      cwd,
      name: projectNameFromCwd(cwd),
      sessions: [...list].sort(
        (a, b) => Date.parse(b.modified) - Date.parse(a.modified),
      ),
    });
  }
  groups.sort(
    (a, b) =>
      Date.parse(b.sessions[0]!.modified) - Date.parse(a.sessions[0]!.modified),
  );
  return groups;
}

/** The curated navigation identities, all of them preference-owned. */
export type NavCuration = Pick<
  InspirePreferences,
  | "pinnedSessionIds"
  | "pinnedProjectCwds"
  | "hiddenProjectCwds"
  | "hiddenSessionIds"
>;

interface NavSections {
  /** Individually pinned sessions across projects, newest activity first. */
  pinned: SessionSummary[];
  /** Groups whose folder is pinned, ordered like ordinary groups. */
  pinnedGroups: SessionGroup[];
  /** The remaining folders. */
  groups: SessionGroup[];
  /** Folders moved into Hidden as complete groups. */
  hiddenGroups: SessionGroup[];
  /** Individually hidden sessions outside hidden folders, newest first. */
  hidden: SessionSummary[];
}

/** Partition the list into navigation sections with one display owner per
 * session. A hidden folder outranks both session-level states; individual
 * hiding then outranks pinning, and an individual pin outranks a folder pin. */
export function splitNavSections(
  sessions: SessionSummary[],
  curation: NavCuration,
): NavSections {
  const pinnedIds = new Set(curation.pinnedSessionIds);
  const hiddenIds = new Set(curation.hiddenSessionIds);
  const pinnedCwds = new Set(curation.pinnedProjectCwds);
  const hiddenCwds = new Set(curation.hiddenProjectCwds);
  const byRecency = (a: SessionSummary, b: SessionSummary) =>
    Date.parse(b.modified) - Date.parse(a.modified);
  const visible = sessions.filter(
    (session) => !hiddenCwds.has(session.cwd) && !hiddenIds.has(session.id),
  );
  const groups = groupSessionsByCwd(
    visible.filter((session) => !pinnedIds.has(session.id)),
  );
  return {
    pinned: visible
      .filter((session) => pinnedIds.has(session.id))
      .sort(byRecency),
    pinnedGroups: groups.filter((group) => pinnedCwds.has(group.cwd)),
    groups: groups.filter((group) => !pinnedCwds.has(group.cwd)),
    hiddenGroups: groupSessionsByCwd(
      sessions.filter((session) => hiddenCwds.has(session.cwd)),
    ),
    hidden: sessions
      .filter(
        (session) => !hiddenCwds.has(session.cwd) && hiddenIds.has(session.id),
      )
      .sort(byRecency),
  };
}

export { parentSegment } from "../../shared/contracts";

/** Activity age compressed for the dense row's right column; the exact
 * timestamp stays available as that column's tooltip. */
export function compactAge(timestamp: string, now = Date.now()): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
