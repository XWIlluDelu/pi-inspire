import {
  ChevronDown,
  ChevronRight,
  Folder,
  Loader2,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { projectNameFromCwd, type SessionIndicator, type SessionSummary } from "../../shared/contracts";
import { store, useAppState } from "../store";
import { relativeTime } from "./Transcript";

export interface SessionGroup {
  cwd: string;
  /** Concise folder name (basename of cwd). */
  name: string;
  sessions: SessionSummary[];
}

/** Group sessions by exact cwd identity. Groups sort by their newest session
 * descending; sessions within a group sort by modified descending. Search
 * results group the same way. */
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
      sessions: [...list].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)),
    });
  }
  groups.sort((a, b) => Date.parse(b.sessions[0]!.modified) - Date.parse(a.sessions[0]!.modified));
  return groups;
}

export interface NavSections {
  /** All pinned sessions across projects, newest activity first. */
  pinned: SessionSummary[];
  /** Unpinned sessions only, grouped by cwd with the usual sort rules. */
  groups: SessionGroup[];
}

/** Split the list into the global Pinned section and per-cwd groups. A pinned
 * session appears only in the Pinned section, never duplicated in its folder. */
export function splitNavSections(sessions: SessionSummary[]): NavSections {
  const pinned = sessions
    .filter((session) => session.pinned)
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  return { pinned, groups: groupSessionsByCwd(sessions.filter((session) => !session.pinned)) };
}

/** Second-to-last path segment, shown inline only when folder names collide. */
function parentSegment(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2]! : "";
}

const INDICATOR_LABELS: Record<SessionIndicator, string> = {
  running: "Working",
  completed: "Completed",
  failed: "Failed",
};

function SessionRow({
  session,
  showProject = false,
  onSelect,
}: {
  session: SessionSummary;
  showProject?: boolean;
  onSelect: (id: string) => void;
}) {
  const state = useAppState();
  const active = session.id === state.sessionId;
  const opening = state.openingSessionId === session.id;
  const pinned = Boolean(session.pinned);
  const pinning = state.pinningSessionId === session.id;
  const indicator = state.sessionStatuses[session.id]?.indicator;
  // Yellow stays on while a session works, including the visible one; green
  // and red are unseen-completion attention and clear once the row is viewed.
  const attention =
    indicator === "completed" || indicator === "failed" ? (active ? null : indicator) : (indicator ?? null);
  const title = session.title || "Untitled session";
  return (
    <div
      className={`nav__row ${active ? "nav__row--active" : ""} ${pinned ? "nav__row--pinned" : ""}`}
    >
      <button
        type="button"
        className="nav__row-main"
        onClick={() => onSelect(session.id)}
        disabled={state.openingSessionId !== null}
        aria-busy={opening}
      >
        <span className="nav__row-title">
          {opening ? (
            <Loader2 size={12} className="spin" aria-label="Opening session" />
          ) : attention ? (
            <span
              className={`nav__row-dot nav__row-dot--${attention}`}
              role="img"
              aria-label={INDICATOR_LABELS[attention]}
              title={INDICATOR_LABELS[attention]}
            />
          ) : null}
          {pinned ? <Pin size={11} className="nav__row-pin-glyph" aria-hidden /> : null}
          {title}
        </span>
        <span className="nav__row-meta">
          {showProject ? <span className="nav__row-project">{projectNameFromCwd(session.cwd)}</span> : null}
          {relativeTime(session.modified)}
        </span>
      </button>
      <button
        type="button"
        className="nav__row-pin"
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin "${title}"` : `Pin "${title}"`}
        title={pinned ? "Unpin session" : "Pin session"}
        disabled={state.pinningSessionId !== null}
        onClick={(event) => {
          event.stopPropagation();
          void store.setSessionPinned(session.id, !pinned);
        }}
      >
        {pinning ? (
          <Loader2 size={12} className="spin" aria-hidden />
        ) : pinned ? (
          <PinOff size={12} aria-hidden />
        ) : (
          <Pin size={12} aria-hidden />
        )}
      </button>
    </div>
  );
}

export function Nav({
  collapsed,
  onOpenSettings,
  onNewSession,
  onSelectSession,
}: {
  collapsed: boolean;
  onOpenSettings: () => void;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
}) {
  const state = useAppState();

  if (collapsed) {
    return (
      <nav className="nav nav--rail" aria-label="Sessions">
        <div className="nav__brand nav__brand--rail" title="insπre">
          π
        </div>
        <button type="button" className="icon-button" onClick={onNewSession} title="New session" aria-label="New session">
          <Plus size={16} aria-hidden />
        </button>
        <span className="nav__rail-spacer" />
        <button type="button" className="icon-button" onClick={onOpenSettings} title="Settings" aria-label="Open settings">
          <SettingsIcon size={16} aria-hidden />
        </button>
      </nav>
    );
  }

  const { pinned, groups } = splitNavSections(state.sessions);
  const nameCounts = new Map<string, number>();
  for (const group of groups) nameCounts.set(group.name, (nameCounts.get(group.name) ?? 0) + 1);
  const collapsedGroups = new Set(state.prefs.navCollapsedGroups);
  // Active search must never hide results inside a collapsed folder.
  const searching = state.sessionQuery.trim() !== "";

  return (
    <nav className="nav" aria-label="Sessions">
      <div className="nav__brand">
        <span className="wordmark">insπre</span>
        {state.mock ? <span className="nav__mock">mock</span> : null}
      </div>
      <button type="button" className="button button--primary nav__new" onClick={onNewSession}>
        <Plus size={14} aria-hidden /> New session
      </button>
      <div className="nav__search-row">
        <label className="nav__search">
          <Search size={13} aria-hidden />
          <input
            type="search"
            placeholder="Search sessions"
            aria-label="Search sessions"
            value={state.sessionQuery}
            onChange={(event) => store.searchSessions(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="icon-button"
          onClick={() => void store.refreshSessions()}
          title="Refresh session list"
          aria-label="Refresh session list"
        >
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      <div className="nav__list">
        {pinned.length > 0 ? (
          <section className="nav__group nav__group--pinned" aria-labelledby="nav-pinned-title">
            <h2 className="nav__group-title" id="nav-pinned-title">
              <Pin size={11} aria-hidden />
              <span className="nav__group-name">Pinned</span>
            </h2>
            {pinned.map((session) => (
              <SessionRow key={session.id} session={session} showProject onSelect={onSelectSession} />
            ))}
          </section>
        ) : null}
        {groups.map((group, groupIndex) => {
          // The active session's group is never hidden behind a collapse.
          const expanded =
            searching ||
            !collapsedGroups.has(group.cwd) ||
            group.sessions.some((session) => session.id === state.sessionId);
          const headingId = `nav-group-title-${groupIndex}`;
          return (
            <section className="nav__group" key={group.cwd} aria-labelledby={headingId}>
              <h2 className="nav__group-title" title={group.cwd} id={headingId}>
                <button
                  type="button"
                  className="nav__group-toggle"
                  aria-expanded={expanded}
                  disabled={searching}
                  onClick={() => store.toggleNavGroup(group.cwd)}
                >
                  {expanded ? (
                    <ChevronDown size={11} aria-hidden />
                  ) : (
                    <ChevronRight size={11} aria-hidden />
                  )}
                  <Folder size={11} aria-hidden />
                  <span className="nav__group-name">{group.name}</span>
                  {(nameCounts.get(group.name) ?? 0) > 1 ? (
                    <span className="nav__group-context">{parentSegment(group.cwd)}</span>
                  ) : null}
                  <span className="nav__group-count" aria-hidden>
                    {group.sessions.length}
                  </span>
                </button>
              </h2>
              {expanded
                ? group.sessions.map((session) => (
                    <SessionRow key={session.id} session={session} onSelect={onSelectSession} />
                  ))
                : null}
            </section>
          );
        })}
        {state.sessions.length === 0 ? <div className="nav__empty">No sessions found</div> : null}
      </div>
      <div className="nav__footer">
        <button type="button" className="button nav__settings" onClick={onOpenSettings}>
          <SettingsIcon size={14} aria-hidden /> Settings
        </button>
      </div>
    </nav>
  );
}
