import {
  ChevronRight,
  ChevronUp,
  EyeOff,
  Folder,
  Inbox,
  Loader2,
  Pin,
  Plus,
  Search,
  SearchX,
  Trash2,
  X,
} from "lucide-react";
import {
  memo,
  type Ref,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  isBusyRunState,
  projectNameFromCwd,
  type SessionSummary,
} from "../../shared/contracts";
import { shallowEqual, store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { HiddenClearDialog } from "./HiddenClearDialog";
import { ProjectGroup, SessionRow } from "./NavSessions";
import { splitNavSections } from "./nav-model";
import { ScrollRail } from "./ScrollRail";
import { SessionDeleteDialog } from "./SessionDeleteDialog";
import { BrandLogo, Wordmark } from "./Wordmark";
import { WorkspaceTree } from "./WorkspaceBrowser";

/** Compact quick navigation over the shared workspace projection. The right
 * Files pane consumes the same expansion, search, identity, selection, and
 * disclosure state so narrow drawer remounts do not reset it. */
const WorkspaceExplorer = memo(function WorkspaceExplorer({
  selectedSessionId,
}: {
  selectedSessionId: string | null;
}) {
  const { activeSessionId, activeCwd, open } = useAppState(
    (state) => ({
      activeSessionId: state.sessionId,
      activeCwd: state.cwd,
      open: state.workspaceExplorerOpen,
    }),
    shallowEqual,
  );
  const cwd = selectedSessionId === activeSessionId ? activeCwd : null;

  useEffect(() => {
    store.setGitSurfaceVisible("workspace-explorer", open && cwd !== null);
    return () => store.setGitSurfaceVisible("workspace-explorer", false);
  }, [open, cwd]);

  if (!cwd) return null;

  return (
    <section
      className={`explorer ${open ? "explorer--open" : ""}`}
      aria-label="Workspace files"
    >
      <div className="explorer__heading">
        <button
          type="button"
          className="explorer__header"
          aria-expanded={open}
          onClick={() => store.setWorkspaceExplorerOpen(!open)}
          title={cwd}
        >
          <Folder size={13} aria-hidden />
          <span className="explorer__title">{projectNameFromCwd(cwd)}</span>
          <ChevronUp
            size={12}
            className={`chev-flip ${open ? "chev-flip--open" : ""}`}
            aria-hidden
          />
        </button>
      </div>
      {open ? (
        <div className="explorer__browser">
          <div className="explorer__tree">
            <WorkspaceTree />
          </div>
        </div>
      ) : null}
    </section>
  );
});

export const Nav = memo(function Nav({
  collapsed,
  selectedSessionId,
  isModal = false,
  onClose,
  onNewSession,
  onSelectSession,
  searchInputRef,
}: {
  collapsed: boolean;
  selectedSessionId?: string | null;
  isModal?: boolean;
  onClose?: () => void;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  searchInputRef?: Ref<HTMLInputElement>;
}) {
  const {
    sessions,
    pinnedSessionIds,
    pinnedProjectCwds,
    curatedHiddenSessionIds,
    hiddenProjectCwds,
    collapsedGroupCwds,
    activeSessionId,
    openingSessionId,
    sessionStatuses,
    sessionQuery,
    sessionListNextOffset,
    sessionListTotal,
    sessionListLoading,
    sessionListLoadingOlder,
    sessionListHydrating,
    sessionListOperation,
    sessionListError,
    sessionActionError,
    clearingHidden,
    deletingSessionId,
  } = useAppState(
    (state) => ({
      sessions: state.sessions,
      pinnedSessionIds: state.prefs.pinnedSessionIds,
      pinnedProjectCwds: state.prefs.pinnedProjectCwds,
      curatedHiddenSessionIds: state.prefs.hiddenSessionIds,
      hiddenProjectCwds: state.prefs.hiddenProjectCwds,
      collapsedGroupCwds: state.prefs.navCollapsedGroups,
      activeSessionId: state.sessionId,
      openingSessionId: state.openingSessionId,
      sessionStatuses: state.sessionStatuses,
      sessionQuery: state.sessionQuery,
      sessionListNextOffset: state.sessionListNextOffset,
      sessionListTotal: state.sessionListTotal,
      sessionListLoading: state.sessionListLoading,
      sessionListLoadingOlder: state.sessionListLoadingOlder,
      sessionListHydrating: state.sessionListHydrating,
      sessionListOperation: state.sessionListOperation,
      sessionListError: state.sessionListError,
      sessionActionError: state.sessionActionError,
      clearingHidden: state.clearingHidden,
      deletingSessionId: state.deletingSessionId,
    }),
    shallowEqual,
  );
  const hiddenIds = new Set(curatedHiddenSessionIds);
  const hiddenCwds = new Set(hiddenProjectCwds);
  const hiddenHasBlockedSession = sessions.some((session) => {
    if (!hiddenIds.has(session.id) && !hiddenCwds.has(session.cwd))
      return false;
    const status = sessionStatuses[session.id];
    return status
      ? isBusyRunState(status.runState) || status.runState === "conflict"
      : false;
  });
  const visibleSessionId =
    selectedSessionId === undefined ? activeSessionId : selectedSessionId;
  const internalNavRef = useRef<HTMLElement>(null);
  const modalNavRef = useModalFocus<HTMLDivElement>(
    isModal,
    undefined,
    onClose,
  );
  const navRef = isModal ? modalNavRef : internalNavRef;
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchSelection, setSearchSelection] = useState<{
    query: string;
    id: string | null;
  }>({ query: sessionQuery, id: null });
  const composing = useRef(false);
  const selectionStatusId = useId();
  const sections = useMemo(
    () =>
      splitNavSections(sessions, {
        pinnedSessionIds,
        pinnedProjectCwds,
        hiddenSessionIds: curatedHiddenSessionIds,
        hiddenProjectCwds,
      }),
    [
      sessions,
      pinnedSessionIds,
      pinnedProjectCwds,
      curatedHiddenSessionIds,
      hiddenProjectCwds,
    ],
  );
  const searching = sessionQuery.trim() !== "";
  const hiddenExpanded = searching || hiddenOpen;
  const searchResults = useMemo(() => {
    const folderRows = (groups: typeof sections.groups) =>
      groups.flatMap((group) =>
        searching || !collapsedGroupCwds.includes(group.cwd)
          ? group.sessions
          : [],
      );
    return [
      ...sections.pinned,
      ...folderRows(sections.pinnedGroups),
      ...folderRows(sections.groups),
      ...(hiddenExpanded
        ? [...folderRows(sections.hiddenGroups), ...sections.hidden]
        : []),
    ];
  }, [sections, searching, hiddenExpanded, collapsedGroupCwds]);
  const highlighted = searchFocused
    ? searchSelection.query === sessionQuery
      ? (searchResults.find((session) => session.id === searchSelection.id) ??
        searchResults[0])
      : searchResults[0]
    : undefined;
  const highlightedSessionId = highlighted?.id ?? null;
  useEffect(() => {
    setSearchSelection((previous) => {
      if (
        previous.query === sessionQuery &&
        (searchResults.length === 0 ||
          searchResults.some((session) => session.id === previous.id))
      )
        return previous;
      return { query: sessionQuery, id: searchResults[0]?.id ?? null };
    });
  }, [sessionQuery, searchResults]);
  useEffect(() => {
    if (!highlightedSessionId) return;
    navRef.current
      ?.querySelector(".nav__row--highlighted .nav__row-main")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedSessionId, navRef]);
  const [deleteCandidate, setDeleteCandidate] = useState<SessionSummary | null>(
    null,
  );
  const [hiddenClearCandidate, setHiddenClearCandidate] = useState<
    string[] | null
  >(null);

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
          <BrandLogo size={22} className="nav__brand-icon--rail" />
        </button>
      </nav>
    );
  }

  const { pinned, pinnedGroups, groups, hiddenGroups, hidden } = sections;
  const folders = [...pinnedGroups, ...groups];
  const allFolders = [...folders, ...hiddenGroups];
  const nameCounts = new Map<string, number>();
  for (const group of allFolders)
    nameCounts.set(group.name, (nameCounts.get(group.name) ?? 0) + 1);
  const shownBaseRows = Math.min(sessionListNextOffset, sessionListTotal);
  const hasOlderSessions = sessionListNextOffset < sessionListTotal;
  const sessionListBusy =
    sessionListLoading || sessionListLoadingOlder || sessionListHydrating;
  const foregroundSessionListBusy =
    sessionListBusy && sessionListOperation !== "curation";
  const showSessionListActivity =
    hasOlderSessions ||
    sessionListError !== null ||
    (foregroundSessionListBusy && sessionListOperation !== "preserve");
  const retrySessionLabel =
    sessionListOperation === "hydrate"
      ? "Retry loading active sessions"
      : sessionListOperation === "curation"
        ? "Retry loading curated sessions"
        : sessionListOperation === "preserve"
          ? "Retry refreshing the list"
          : sessionListOperation === "refresh"
            ? "Retry refreshing sessions"
            : sessionListOperation === "older"
              ? "Retry loading older sessions"
              : "Retry loading sessions";
  const loadingSessionLabel =
    sessionListOperation === "hydrate"
      ? "Loading active sessions…"
      : sessionListOperation === "curation"
        ? "Loading curated sessions…"
        : sessionListOperation === "preserve"
          ? "Refreshing loaded sessions…"
          : sessionListOperation === "refresh"
            ? "Refreshing sessions…"
            : sessionListOperation === "older"
              ? "Loading older sessions…"
              : "Loading sessions…";
  // Hidden is a curation drawer, not a browsing group: it opens on demand and
  // starts closed again next time. Search reveals matches inside it without
  // reclassifying them out of Hidden.
  const hiddenSessions = [
    ...hiddenGroups.flatMap((group) => group.sessions),
    ...hidden,
  ];
  const hiddenSessionIds = hiddenSessions.map((session) => session.id);
  const hiddenCount = hiddenSessions.length;
  const hiddenHasSelectedSession = hiddenSessions.some(
    (session) => session.id === activeSessionId,
  );
  const hiddenHasOpeningSession = hiddenSessions.some(
    (session) => session.id === openingSessionId,
  );
  const hiddenClearDisabled =
    clearingHidden ||
    deletingSessionId !== null ||
    searching ||
    sessionListBusy ||
    sessionListError !== null ||
    hiddenHasSelectedSession ||
    hiddenHasOpeningSession ||
    hiddenHasBlockedSession;
  const hiddenClearTitle = clearingHidden
    ? "Clearing Hidden…"
    : hiddenHasSelectedSession
      ? "Switch to another session before clearing Hidden"
      : hiddenHasOpeningSession
        ? "Wait for every session in Hidden to finish opening"
        : hiddenHasBlockedSession
          ? "Wait for every session in Hidden to finish working or resolve conflicts"
          : searching
            ? "Clear Hidden is unavailable while searching"
            : sessionListBusy || sessionListError !== null
              ? "Wait for Hidden sessions to finish loading"
              : deletingSessionId !== null
                ? "Wait for the current session deletion to finish"
                : "Clear Hidden";

  const contents = (
    <>
      <div className="nav__header">
        <button
          type="button"
          className="nav__brand-new"
          onClick={onNewSession}
          aria-label="New session"
          title="New session"
        >
          <div className="nav__brand-lockup">
            <BrandLogo size={20} className="nav__brand-icon" />
            <Wordmark />
          </div>
          <span className="nav__new-session">
            <Plus size={12} className="nav__new-session-icon" aria-hidden />
            <span className="nav__new-session-label">New session</span>
          </span>
        </button>
        {isModal && onClose ? (
          <button
            type="button"
            className="icon-button nav__close"
            aria-label="Close navigation"
            title="Close navigation"
            onClick={onClose}
          >
            <X size={15} aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="nav__controls">
        <label className="nav__search">
          <Search size={13} aria-hidden />
          <input
            ref={searchInputRef}
            type="search"
            placeholder="Search sessions"
            aria-label="Search sessions"
            value={sessionQuery}
            aria-describedby={selectionStatusId}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onChange={(event) => store.searchSessions(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                composing.current ||
                event.nativeEvent.keyCode === 229
              ) {
                event.stopPropagation();
                return;
              }
              if (
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
              )
                return;
              if (
                !["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                if (sessionQuery) store.searchSessions("");
                else event.currentTarget.blur();
              } else if (event.key === "Enter") {
                if (highlighted && highlighted.id !== openingSessionId)
                  onSelectSession(highlighted.id);
              } else if (searchResults.length > 0) {
                const index = searchResults.findIndex(
                  (session) => session.id === highlightedSessionId,
                );
                const next = Math.max(
                  0,
                  Math.min(
                    searchResults.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                );
                setSearchSelection({
                  query: sessionQuery,
                  id: searchResults[next]!.id,
                });
              }
            }}
          />
        </label>
        <span id={selectionStatusId} className="sr-only" role="status">
          {highlighted
            ? `${highlighted.title}. Up and Down select a session; Enter opens it.`
            : ""}
        </span>
      </div>
      {sessionActionError ? (
        <p className="nav__error" role="alert">
          {sessionActionError}
        </p>
      ) : null}
      <div className="nav__list">
        {pinned.length > 0 ? (
          <section
            className="nav__group nav__group--pinned"
            aria-labelledby="nav-pinned-title"
          >
            <h2 className="nav__group-title" id="nav-pinned-title">
              <Pin size={14} aria-hidden />
              <span className="nav__group-name">Pinned</span>
              <span className="nav__group-count" aria-hidden>
                {pinned.length}
              </span>
            </h2>
            {pinned.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                selectedSessionId={visibleSessionId}
                highlightedSessionId={highlightedSessionId}
                showProject
                onSelect={onSelectSession}
              />
            ))}
          </section>
        ) : null}
        {folders.map((group, groupIndex) => {
          return (
            <ProjectGroup
              key={group.cwd}
              group={group}
              headingId={`nav-group-title-${groupIndex}`}
              searching={searching}
              showContext={(nameCounts.get(group.name) ?? 0) > 1}
              selectedSessionId={visibleSessionId}
              highlightedSessionId={highlightedSessionId}
              onSelectSession={onSelectSession}
            />
          );
        })}
        {showSessionListActivity ? (
          <div className="nav__pagination">
            <span
              className="nav__pagination-status"
              role="status"
              aria-live="polite"
            >
              Showing {shownBaseRows} of {sessionListTotal}
              {sessionListError ? ` · ${sessionListError}` : ""}
            </span>
            {sessionListError ? (
              <button
                type="button"
                className="nav__pagination-button"
                onClick={() => void store.retrySessionList()}
              >
                {retrySessionLabel}
              </button>
            ) : foregroundSessionListBusy ? (
              <button
                type="button"
                className="nav__pagination-button"
                disabled
                aria-busy="true"
              >
                <Loader2 size={12} className="spin" aria-hidden />
                {loadingSessionLabel}
              </button>
            ) : hasOlderSessions ? (
              <button
                type="button"
                className="nav__pagination-button"
                disabled={sessionListBusy}
                onClick={() => void store.loadOlderSessions()}
              >
                Load older sessions
              </button>
            ) : null}
          </div>
        ) : null}
        {hiddenCount > 0 ? (
          <section
            className="nav__group nav__group--hidden"
            aria-labelledby="nav-hidden-title"
          >
            <h2
              className="nav__group-title nav__group-title--hidden"
              id="nav-hidden-title"
              aria-label="Hidden"
            >
              <button
                type="button"
                className="nav__group-toggle"
                aria-expanded={hiddenExpanded}
                disabled={searching}
                onClick={() => setHiddenOpen((value) => !value)}
              >
                <ChevronRight
                  size={13}
                  className={`chev ${hiddenExpanded ? "chev--open" : ""}`}
                  aria-hidden
                />
                <EyeOff size={14} aria-hidden />
                <span className="nav__group-name">Hidden</span>
                <span className="nav__group-count" aria-hidden>
                  {hiddenCount}
                </span>
              </button>
              <span className="nav__group-actions">
                <button
                  type="button"
                  className="nav__row-action nav__row-action--danger"
                  aria-label="Clear Hidden"
                  title={hiddenClearTitle}
                  disabled={hiddenClearDisabled}
                  onClick={() => setHiddenClearCandidate(hiddenSessionIds)}
                >
                  {clearingHidden ? (
                    <Loader2 size={12} className="spin" aria-hidden />
                  ) : (
                    <Trash2 size={12} aria-hidden />
                  )}
                </button>
              </span>
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
                    selectedSessionId={visibleSessionId}
                    highlightedSessionId={highlightedSessionId}
                    hidden
                    onSelectSession={onSelectSession}
                    onDeleteSession={setDeleteCandidate}
                  />
                ))}
                {hidden.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    selectedSessionId={visibleSessionId}
                    highlightedSessionId={highlightedSessionId}
                    showProject
                    onSelect={onSelectSession}
                    onDelete={setDeleteCandidate}
                  />
                ))}
              </>
            ) : null}
          </section>
        ) : null}
        {sessions.length === 0 ? (
          <div className="empty-state">
            {searching ? (
              <SearchX size={26} strokeWidth={1.5} aria-hidden />
            ) : (
              <Inbox size={26} strokeWidth={1.5} aria-hidden />
            )}
            <span className="empty-state__title">
              {searching ? "No sessions found" : "No sessions yet"}
            </span>
            <span className="empty-state__hint">
              {searching
                ? "Try a different keyword"
                : "Start a session to begin"}
            </span>
          </div>
        ) : null}
      </div>
      <WorkspaceExplorer selectedSessionId={visibleSessionId} />
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
      {hiddenClearCandidate ? (
        <HiddenClearDialog
          sessionIds={hiddenClearCandidate}
          onClose={() => {
            store.clearSessionDeleteError();
            setHiddenClearCandidate(null);
          }}
        />
      ) : null}
    </>
  );
  return isModal ? (
    <div
      className="nav"
      role="dialog"
      aria-modal="true"
      aria-label="Sessions"
      tabIndex={-1}
      ref={modalNavRef}
    >
      {contents}
    </div>
  ) : (
    <nav className="nav" aria-label="Sessions" ref={internalNavRef}>
      {contents}
    </nav>
  );
});
