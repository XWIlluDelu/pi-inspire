import {
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  FileText,
  Folder,
  Inbox,
  Loader2,
  Pin,
  PinOff,
  Plus,
  Search,
  SearchX,
  Trash2,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  isBusyRunState,
  projectNameFromCwd,
  type InspirePreferences,
  type ProjectDirEntry,
  type SessionIndicator,
  type SessionSummary,
} from "../../shared/contracts";
import { presentGitFacet } from "../git-presentation";
import { gitChangeForWorkspacePath, store, useAppState } from "../store";
import { ScrollRail } from "./ScrollRail";
import { SessionDeleteDialog } from "./SessionDeleteDialog";
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

/** The curated navigation identities, all of them preference-owned. */
export type NavCuration = Pick<
  InspirePreferences,
  "pinnedSessionIds" | "pinnedProjectCwds" | "hiddenProjectCwds" | "hiddenSessionIds"
>;

export interface NavSections {
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
export function splitNavSections(sessions: SessionSummary[], curation: NavCuration): NavSections {
  const pinnedIds = new Set(curation.pinnedSessionIds);
  const hiddenIds = new Set(curation.hiddenSessionIds);
  const pinnedCwds = new Set(curation.pinnedProjectCwds);
  const hiddenCwds = new Set(curation.hiddenProjectCwds);
  const byRecency = (a: SessionSummary, b: SessionSummary) => Date.parse(b.modified) - Date.parse(a.modified);
  const visible = sessions.filter((session) => !hiddenCwds.has(session.cwd) && !hiddenIds.has(session.id));
  const groups = groupSessionsByCwd(visible.filter((session) => !pinnedIds.has(session.id)));
  return {
    pinned: visible.filter((session) => pinnedIds.has(session.id)).sort(byRecency),
    pinnedGroups: groups.filter((group) => pinnedCwds.has(group.cwd)),
    groups: groups.filter((group) => !pinnedCwds.has(group.cwd)),
    hiddenGroups: groupSessionsByCwd(sessions.filter((session) => hiddenCwds.has(session.cwd))),
    hidden: sessions
      .filter((session) => !hiddenCwds.has(session.cwd) && hiddenIds.has(session.id))
      .sort(byRecency),
  };
}

/** Second-to-last path segment, shown inline only when folder names collide. */
function parentSegment(cwd: string): string {
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
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const INDICATOR_LABELS: Record<SessionIndicator, string> = {
  running: "Working",
  completed: "Completed",
  failed: "Failed",
  attention: "Needs recovery",
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
    store.setGitSurfaceVisible("workspace-explorer", open && cwd !== null);
    return () => store.setGitSurfaceVisible("workspace-explorer", false);
  }, [open, cwd]);

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
      const change = presentGitFacet(gitChangeForWorkspacePath(state.gitStatus, path));
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
          {change ? <span className="git-mark" aria-label={change.label} title={change.label}>{change.mark}</span> : null}
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

/** One dense session line: the title at the left and one number at the right —
 * the activity age, in a fixed column the curation actions take over on hover
 * or focus. The message count is a tooltip fact, not a second number fighting
 * for the same edge. */
function SessionRow({
  session,
  showProject = false,
  onSelect,
  onDelete,
}: {
  session: SessionSummary;
  showProject?: boolean;
  onSelect: (id: string) => void;
  onDelete?: (session: SessionSummary) => void;
}) {
  const state = useAppState();
  const active = session.id === state.sessionId;
  const opening = state.openingSessionId === session.id;
  const pinned = state.prefs.pinnedSessionIds.includes(session.id);
  const individuallyHidden = state.prefs.hiddenSessionIds.includes(session.id);
  const projectHidden = state.prefs.hiddenProjectCwds.includes(session.cwd);
  const hidden = individuallyHidden || projectHidden;
  const runtimeStatus = state.sessionStatuses[session.id];
  const indicator = runtimeStatus?.indicator;
  const conflicted = runtimeStatus?.runState === "conflict";
  const busy = runtimeStatus ? isBusyRunState(runtimeStatus.runState) : false;
  const deleteDisabled = active || opening || busy || conflicted || state.deletingSessionId !== null;
  const deleteTitle = active
    ? "Switch to another session before deleting"
    : conflicted
      ? "Resolve the session conflict before deleting"
      : busy
        ? "Wait for this session to finish working"
        : opening
          ? "Wait for this session to finish opening"
          : "Delete session";
  // Yellow stays on while a session works or needs external-change recovery,
  // including the visible one; green and red are unseen completion attention
  // and clear once the row is viewed.
  const attention =
    indicator === "completed" || indicator === "failed" ? (active ? null : indicator) : (indicator ?? null);
  const title = session.title || "New session";
  return (
    <div className={`nav__row ${active ? "nav__row--active" : ""}`}>
      <button
        type="button"
        className="nav__row-main"
        onClick={() => onSelect(session.id)}
        disabled={opening}
        aria-busy={opening}
        title={`${title} · ${session.messageCount} messages`}
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
          {showProject ? (
            <span className="nav__row-project">{projectNameFromCwd(session.cwd)}</span>
          ) : null}
          <span className="nav__row-age" title={new Date(session.modified).toLocaleString()}>
            {compactAge(session.modified)}
          </span>
        </span>
      </button>
      <div className="nav__row-actions">
        {hidden ? (
          <>
            {projectHidden ? <span className="nav__row-action-spacer" aria-hidden /> : (
              <button
                type="button"
                className="nav__row-action"
                aria-label={`Restore "${title}"`}
                title="Move back out of Hidden"
                onClick={() => store.toggleSessionHidden(session.id)}
              >
                <Eye size={12} aria-hidden />
              </button>
            )}
            <button
              type="button"
              className="nav__row-action nav__row-action--danger"
              aria-label={`Delete "${title}"`}
              title={deleteTitle}
              disabled={deleteDisabled}
              onClick={() => onDelete?.(session)}
            >
              <Trash2 size={12} aria-hidden />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="nav__row-action"
              aria-pressed={pinned}
              aria-label={pinned ? `Unpin "${title}"` : `Pin "${title}"`}
              title={pinned ? "Unpin session" : "Pin session"}
              onClick={() => store.toggleSessionPin(session.id)}
            >
              {pinned ? <PinOff size={12} aria-hidden /> : <Pin size={12} aria-hidden />}
            </button>
            <button
              type="button"
              className="nav__row-action"
              aria-label={`Hide "${title}"`}
              title="Hide session"
              onClick={() => store.toggleSessionHidden(session.id)}
            >
              <EyeOff size={12} aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** One folder group. Its main row owns the whole collapse hit target while
 * the same fixed right column as a session row owns Pin/Hide or Restore. */
function ProjectGroup({
  group,
  headingId,
  searching,
  showContext,
  hidden = false,
  onSelectSession,
  onDeleteSession,
}: {
  group: SessionGroup;
  headingId: string;
  searching: boolean;
  showContext: boolean;
  hidden?: boolean;
  onSelectSession: (id: string) => void;
  onDeleteSession?: (session: SessionSummary) => void;
}) {
  const state = useAppState();
  // Active search must never hide results inside a collapsed folder.
  const expanded = searching || !state.prefs.navCollapsedGroups.includes(group.cwd);
  const pinned = state.prefs.pinnedProjectCwds.includes(group.cwd);
  // A collapsed folder that hides the active session carries the active
  // highlight itself.
  const activeInside = group.sessions.some((session) => session.id === state.sessionId);
  return (
    <section
      className={`nav__group ${pinned ? "nav__group--pinned-folder" : ""} ${hidden ? "nav__group--hidden-folder" : ""}`}
      aria-labelledby={headingId}
    >
      <h2
        className={`nav__group-title nav__group-title--folder ${!expanded && activeInside ? "nav__group-title--active" : ""}`}
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
          <ChevronRight size={13} className={`chev ${expanded ? "chev--open" : ""}`} aria-hidden />
          <Folder size={14} aria-hidden />
          <span className="nav__group-name">{group.name}</span>
          {showContext ? <span className="nav__group-context">{parentSegment(group.cwd)}</span> : null}
          <span className="nav__group-count" aria-hidden>{group.sessions.length}</span>
        </button>
        <span className="nav__group-actions">
          {hidden ? (
            <>
              <button
                type="button"
                className="nav__row-action"
                aria-label={`Restore folder ${group.name}`}
                title="Move folder back out of Hidden"
                onClick={() => store.toggleProjectHidden(group.cwd)}
              >
                <Eye size={12} aria-hidden />
              </button>
              <span className="nav__row-action-spacer" aria-hidden />
            </>
          ) : (
            <>
              <button
                type="button"
                className="nav__row-action"
                aria-pressed={pinned}
                aria-label={pinned ? `Unpin folder ${group.name}` : `Pin folder ${group.name}`}
                title={pinned ? "Unpin folder" : "Pin folder"}
                onClick={() => store.toggleProjectPin(group.cwd)}
              >
                {pinned ? <PinOff size={12} aria-hidden /> : <Pin size={12} aria-hidden />}
              </button>
              <button
                type="button"
                className="nav__row-action"
                aria-label={`Hide folder ${group.name}`}
                title="Hide folder"
                onClick={() => store.toggleProjectHidden(group.cwd)}
              >
                <EyeOff size={12} aria-hidden />
              </button>
            </>
          )}
        </span>
      </h2>
      {expanded
        ? group.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onSelect={onSelectSession}
              onDelete={hidden ? onDeleteSession : undefined}
            />
          ))
        : null}
    </section>
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
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<SessionSummary | null>(null);

  if (collapsed) {
    return (
      <nav className="nav nav--rail" aria-label="Sessions">
        <button
          type="button"
          className="nav__brand-rail"
          onClick={onNewSession}
          title="New session"
          aria-label="New session"
        >
          <span className="nav__brand-icon nav__brand-icon--rail" aria-hidden />
        </button>
      </nav>
    );
  }

  const { pinned, pinnedGroups, groups, hiddenGroups, hidden } = splitNavSections(state.sessions, state.prefs);
  const folders = [...pinnedGroups, ...groups];
  const allFolders = [...folders, ...hiddenGroups];
  const nameCounts = new Map<string, number>();
  for (const group of allFolders) nameCounts.set(group.name, (nameCounts.get(group.name) ?? 0) + 1);
  const searching = state.sessionQuery.trim() !== "";
  const shownBaseRows = Math.min(state.sessionListNextOffset, state.sessionListTotal);
  const hasOlderSessions = state.sessionListNextOffset < state.sessionListTotal;
  const sessionListBusy = state.sessionListLoading || state.sessionListLoadingOlder || state.sessionListHydrating;
  const retrySessionLabel = state.sessionListOperation === "hydrate"
    ? "Retry session hydration"
    : state.sessionListOperation === "preserve"
      ? "Retry refreshing loaded sessions"
      : state.sessionListOperation === "refresh"
        ? "Retry refreshing sessions"
        : state.sessionListOperation === "older"
          ? "Retry loading older sessions"
          : "Retry loading sessions";
  const loadingSessionLabel = state.sessionListOperation === "hydrate"
    ? "Hydrating session…"
    : state.sessionListOperation === "preserve"
      ? "Refreshing loaded sessions…"
      : state.sessionListOperation === "refresh"
        ? "Refreshing sessions…"
        : state.sessionListOperation === "older"
          ? "Loading older sessions…"
          : "Loading sessions…";
  // Hidden is a curation drawer, not a browsing group: it opens on demand and
  // starts closed again next time. Search reveals matches inside it without
  // reclassifying them out of Hidden.
  const hiddenExpanded = searching || hiddenOpen;
  const hiddenCount = hidden.length + hiddenGroups.reduce((total, group) => total + group.sessions.length, 0);

  return (
    <nav className="nav" aria-label="Sessions" ref={navRef}>
      <div className="nav__header">
        <button
          type="button"
          className="nav__brand-new"
          onClick={onNewSession}
          aria-label="New session"
        >
          <span className="nav__brand-icon" aria-hidden />
          <Wordmark />
          <span className="nav__brand-action"><Plus size={13} aria-hidden /> New session</span>
        </button>
        {state.mock ? <span className="nav__mock">mock</span> : null}
      </div>
      <div className="nav__controls">
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
      {state.sessionActionError ? (
        <p className="nav__error" role="alert">{state.sessionActionError}</p>
      ) : null}
      <div className="nav__list">
        {pinned.length > 0 ? (
          <section className="nav__group nav__group--pinned" aria-labelledby="nav-pinned-title">
            <h2 className="nav__group-title" id="nav-pinned-title">
              <Pin size={14} aria-hidden />
              <span className="nav__group-name">Pinned</span>
              <span className="nav__group-count" aria-hidden>
                {pinned.length}
              </span>
            </h2>
            {pinned.map((session) => (
              <SessionRow key={session.id} session={session} showProject onSelect={onSelectSession} />
            ))}
          </section>
        ) : null}
        {folders.map((group, groupIndex) => (
          <ProjectGroup
            key={group.cwd}
            group={group}
            headingId={`nav-group-title-${groupIndex}`}
            searching={searching}
            showContext={(nameCounts.get(group.name) ?? 0) > 1}
            onSelectSession={onSelectSession}
          />
        ))}
        {hasOlderSessions || sessionListBusy || state.sessionListError ? (
          <div className="nav__pagination">
            <span className="nav__pagination-status" role="status" aria-live="polite">
              Showing {shownBaseRows} of {state.sessionListTotal}
              {state.sessionListError ? ` · ${state.sessionListError}` : ""}
            </span>
            {state.sessionListError ? (
              <button type="button" className="nav__pagination-button" onClick={() => void store.retrySessionList()}>
                {retrySessionLabel}
              </button>
            ) : sessionListBusy ? (
              <button type="button" className="nav__pagination-button" disabled aria-busy="true">
                <Loader2 size={12} className="spin" aria-hidden />
                {loadingSessionLabel}
              </button>
            ) : hasOlderSessions ? (
              <button type="button" className="nav__pagination-button" onClick={() => void store.loadOlderSessions()}>
                Load older sessions
              </button>
            ) : null}
          </div>
        ) : null}
        {hiddenCount > 0 ? (
          <section className="nav__group nav__group--hidden" aria-labelledby="nav-hidden-title">
            <h2 className="nav__group-title" id="nav-hidden-title">
              <button
                type="button"
                className="nav__group-toggle"
                aria-expanded={hiddenExpanded}
                disabled={searching}
                onClick={() => setHiddenOpen((value) => !value)}
              >
                <ChevronRight size={13} className={`chev ${hiddenExpanded ? "chev--open" : ""}`} aria-hidden />
                <EyeOff size={14} aria-hidden />
                <span className="nav__group-name">Hidden</span>
                <span className="nav__group-count" aria-hidden>
                  {hiddenCount}
                </span>
              </button>
            </h2>
            {hiddenExpanded ? (
              <>
                {hiddenGroups.map((group, groupIndex) => (
                  <ProjectGroup
                    key={group.cwd}
                    group={group}
                    headingId={`nav-hidden-group-title-${groupIndex}`}
                    searching={searching}
                    showContext={(nameCounts.get(group.name) ?? 0) > 1}
                    hidden
                    onSelectSession={onSelectSession}
                    onDeleteSession={setDeleteCandidate}
                  />
                ))}
                {hidden.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    showProject
                    onSelect={onSelectSession}
                    onDelete={setDeleteCandidate}
                  />
                ))}
              </>
            ) : null}
          </section>
        ) : null}
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
      {deleteCandidate ? (
        <SessionDeleteDialog
          session={deleteCandidate}
          onClose={() => {
            store.clearSessionDeleteError();
            setDeleteCandidate(null);
          }}
        />
      ) : null}
    </nav>
  );
}
