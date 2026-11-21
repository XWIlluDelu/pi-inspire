import {
  type InspirePreferences,
  projectNameFromCwd,
  type SessionSummary,
} from "../../shared/contracts";
import type { AppState } from "../app-state";

type HiddenDeletionState = Pick<
  AppState,
  | "openingSessionId"
  | "sessionQuery"
  | "sessionListLoading"
  | "sessionListLoadingOlder"
  | "sessionListHydrating"
  | "sessionListError"
  | "curationPending"
  | "clearingHidden"
  | "deletingSessionId"
>;

/** Hidden and each folder require a complete, settled selection.
 * Confirmed deletion ends active Pi instances; work does not disable it. */
export function hiddenDeletionBlockReason(
  sessions: readonly SessionSummary[],
  state: HiddenDeletionState,
): string | null {
  if (state.curationPending)
    return "Wait for the current navigation change to finish";
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
  if (sessions.some((session) => session.id === state.openingSessionId))
    return "Wait for these sessions to finish opening";
  return null;
}

export interface SessionGroup {
  cwd: string;
  /** Concise folder name (basename of cwd). */
  name: string;
  sessions: SessionSummary[];
}

function byRecency(left: SessionSummary, right: SessionSummary): number {
  return Date.parse(right.modified) - Date.parse(left.modified);
}

/** Group sessions by exact cwd identity. Groups sort by their newest session
 * descending; sessions within a group sort by modified descending. */
function groupSessionsByCwd(sessions: SessionSummary[]): SessionGroup[] {
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
      sessions: list.sort(byRecency),
    });
  }
  groups.sort((left, right) =>
    byRecency(left.sessions[0]!, right.sessions[0]!),
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

type FolderSection = {
  kind: "folder";
  group: SessionGroup;
  hidden: boolean;
};
type CatalogSection =
  | FolderSection
  | { kind: "pinned" | "needs-you" | "hidden"; sessions: SessionSummary[] };

export function sectionSessions(section: CatalogSection): SessionSummary[] {
  return section.kind === "folder" ? section.group.sessions : section.sessions;
}

interface Catalog {
  visible: SessionSummary[];
  all: CatalogSection[];
  hidden: CatalogSection[];
}

/** Hiding applies to every session-entry surface, not just the sidebar. */
export function visibleSessions(
  sessions: readonly SessionSummary[],
  curation: Pick<NavCuration, "hiddenProjectCwds" | "hiddenSessionIds">,
): SessionSummary[] {
  const hiddenCwds = new Set(curation.hiddenProjectCwds);
  const hiddenIds = new Set(curation.hiddenSessionIds);
  return sessions.filter(
    (session) => !hiddenCwds.has(session.cwd) && !hiddenIds.has(session.id),
  );
}

/** Hidden folder, hidden session, pinned session, then pinned folder. */
export function buildSessionCatalog(
  sessions: SessionSummary[],
  curation: NavCuration,
): Catalog {
  const pinnedIds = new Set(curation.pinnedSessionIds);
  const hiddenIds = new Set(curation.hiddenSessionIds);
  const pinnedCwds = new Set(curation.pinnedProjectCwds);
  const hiddenCwds = new Set(curation.hiddenProjectCwds);
  const visible = visibleSessions(sessions, curation);
  const groupSection = (
    group: SessionGroup,
    hidden = false,
  ): FolderSection => ({ kind: "folder", group, hidden });
  const folderSections = groupSessionsByCwd(
    visible.filter((session) => !pinnedIds.has(session.id)),
  ).map((group) => groupSection(group));
  return {
    visible,
    all: [
      {
        kind: "pinned",
        sessions: visible
          .filter((session) => pinnedIds.has(session.id))
          .sort(byRecency),
      },
      ...folderSections.filter(({ group }) => pinnedCwds.has(group.cwd)),
      ...folderSections.filter(({ group }) => !pinnedCwds.has(group.cwd)),
    ],
    hidden: [
      {
        kind: "hidden",
        sessions: sessions
          .filter(
            (session) =>
              !hiddenCwds.has(session.cwd) && hiddenIds.has(session.id),
          )
          .sort(byRecency),
      },
      ...groupSessionsByCwd(
        sessions.filter((session) => hiddenCwds.has(session.cwd)),
      ).map((group) => groupSection(group, true)),
    ],
  };
}
