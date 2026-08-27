import {
  type InspirePreferences,
  projectNameFromCwd,
  type SessionSummary,
} from "../../shared/contracts";

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

/** Second-to-last path segment, shown inline only when folder names collide. */
export function parentSegment(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2]! : "";
}

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
