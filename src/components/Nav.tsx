import {
  ChevronRight,
  ChevronUp,
  FileText,
  Folder,
  Inbox,
  Loader2,
  Pin,
  PinOff,
  Plus,
  Search,
  SearchX,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  projectNameFromCwd,
  type ProjectDirEntry,
  type SessionIndicator,
  type SessionSummary,
} from "../../shared/contracts";
import { store, useAppState } from "../store";
import { ScrollRail } from "./ScrollRail";
import { relativeTime } from "./Transcript";
import { Wordmark } from "./Wordmark";

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

/** Read-only explorer for the visible session's workspace. Collapsed it is a
 * single bar at the bottom of the nav; expanded it takes the lower half.
 * Levels come from the host's project index (same source as the composer's
 * file search), and clicking a file opens the session-bound preview. */
function WorkspaceExplorer() {
  const state = useAppState();
  const cwd = state.sessionId ? state.cwd : null;
  const [open, setOpen] = useState(false);
  const [levels, setLevels] = useState<Map<string, ProjectDirEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // The tree always reflects the visible session's workspace.
  useEffect(() => {
    setLevels(new Map());
    setExpanded(new Set());
  }, [cwd]);

  const load = (dir: string) => {
    // The listing resolves against whichever workspace the host has active
    // when it lands; drop it if this explorer no longer shows that one.
    const owner = cwd;
    void store.listProjectDirectory(dir).then((entries) => {
      if (store.getState().cwd !== owner) return;
      setLevels((previous) => new Map(previous).set(dir, entries));
    });
  };

  useEffect(() => {
    if (open && cwd !== null) load("");
    // the reset effect above clears levels on cwd change; reloading the root
    // on open/cwd keeps the visible tree fresh without polling
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cwd]);

  if (!cwd) return null;

  const toggleDir = (path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!levels.has(path)) load(path);
  };

  const renderLevel = (dir: string, depth: number): React.ReactNode => {
    const entries = levels.get(dir);
    const indent = { paddingLeft: `${12 + depth * 14}px` };
    if (!entries) return <div className="explorer__note" style={indent}>Loading…</div>;
    if (entries.length === 0) return <div className="explorer__note" style={indent}>Empty</div>;
    return entries.map((entry) => {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.type === "dir") {
        const isOpen = expanded.has(path);
        return (
          <Fragment key={path}>
            <button
              type="button"
              className="explorer__row"
              style={indent}
              aria-expanded={isOpen}
              onClick={() => toggleDir(path)}
            >
              <ChevronRight size={11} className={`chev ${isOpen ? "chev--open" : ""}`} aria-hidden />
              <Folder size={12} aria-hidden />
              <span className="explorer__name">{entry.name}</span>
            </button>
            {isOpen ? renderLevel(path, depth + 1) : null}
          </Fragment>
        );
      }
      return (
        <button
          key={path}
          type="button"
          className="explorer__row explorer__row--file"
          style={indent}
          title={path}
          onClick={() => void store.openResource(path)}
        >
          <FileText size={12} aria-hidden />
          <span className="explorer__name">{entry.name}</span>
        </button>
      );
    });
  };

  return (
    <section className={`explorer ${open ? "explorer--open" : ""}`} aria-label="Workspace files">
      <button
        type="button"
        className="explorer__header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={cwd}
      >
        <Folder size={13} aria-hidden />
        <span className="explorer__title">{state.project}</span>
        <ChevronUp size={12} className={`chev-flip ${open ? "chev-flip--open" : ""}`} aria-hidden />
      </button>
      {open ? <div className="explorer__tree">{renderLevel("", 0)}</div> : null}
    </section>
  );
}

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
        title={title}
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
          <span className="nav__row-name">{title}</span>
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
  onNewSession,
  onSelectSession,
}: {
  collapsed: boolean;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
}) {
  const state = useAppState();
  const navRef = useRef<HTMLElement>(null);

  if (collapsed) {
    return (
      <nav className="nav nav--rail" aria-label="Sessions">
        <div className="nav__brand-rail" title="insπre" aria-hidden>
          π
        </div>
        <button type="button" className="icon-button" onClick={onNewSession} title="New session" aria-label="New session">
          <Plus size={16} aria-hidden />
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
    <nav className="nav" aria-label="Sessions" ref={navRef}>
      <div className="nav__header">
        <Wordmark />
        {state.mock ? <span className="nav__mock">mock</span> : null}
      </div>
      <div className="nav__controls">
        <button type="button" className="button button--primary nav__new" onClick={onNewSession}>
          <Plus size={14} aria-hidden /> New session
        </button>
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
      </div>
      <div className="nav__list">
        {pinned.length > 0 ? (
          <section className="nav__group nav__group--pinned" aria-labelledby="nav-pinned-title">
            <h2 className="nav__group-title" id="nav-pinned-title">
              <Pin size={12} aria-hidden />
              <span className="nav__group-name">Pinned</span>
            </h2>
            {pinned.map((session) => (
              <SessionRow key={session.id} session={session} showProject onSelect={onSelectSession} />
            ))}
          </section>
        ) : null}
        {groups.map((group, groupIndex) => {
          const expanded = searching || !collapsedGroups.has(group.cwd);
          // A collapsed folder that hides the active session carries the
          // active highlight itself.
          const activeInside = group.sessions.some((session) => session.id === state.sessionId);
          const headingId = `nav-group-title-${groupIndex}`;
          return (
            <section className="nav__group" key={group.cwd} aria-labelledby={headingId}>
              <h2
                className={`nav__group-title ${!expanded && activeInside ? "nav__group-title--active" : ""}`}
                title={group.cwd}
                id={headingId}
              >
                <button
                  type="button"
                  className="nav__group-toggle"
                  aria-expanded={expanded}
                  disabled={searching}
                  onClick={() => store.toggleNavGroup(group.cwd)}
                >
                  <ChevronRight size={12} className={`chev ${expanded ? "chev--open" : ""}`} aria-hidden />
                  <Folder size={13} aria-hidden />
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
        {state.sessions.length === 0 ? (
          <div className="empty-state">
            {searching ? (
              <SearchX size={26} strokeWidth={1.5} aria-hidden />
            ) : (
              <Inbox size={26} strokeWidth={1.5} aria-hidden />
            )}
            <span className="empty-state__title">{searching ? "No sessions found" : "No sessions yet"}</span>
            <span className="empty-state__hint">
              {searching ? "Try a different keyword" : "Start a session to begin"}
            </span>
          </div>
        ) : null}
      </div>
      <WorkspaceExplorer />
      <ScrollRail container={navRef} scroller=".nav__list" variant="nav" />
      <ScrollRail container={navRef} scroller=".explorer__tree" variant="nav" />
    </nav>
  );
}
