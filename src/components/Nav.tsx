import {
  Bell,
  CheckCheck,
  ChevronUp,
  EyeOff,
  Inbox,
  PanelLeft,
  Pin,
  Plus,
  SearchX,
  Settings as SettingsIcon,
  Trash2,
  X,
} from "lucide-react";
import {
  memo,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type SessionSummary } from "../../shared/contracts";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { type NeedsYouReason, needsYouRows } from "../needs-you";
import { shallowEqual, store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import {
  readNavigationDisclosure,
  saveNavigationDisclosure,
} from "../workbench-session";
import { HiddenClearDialog } from "./HiddenClearDialog";
import { NavigationToggle } from "./NavigationToggle";
import { ProjectGroup, SessionRow } from "./NavSessions";
import { hiddenDeletionBlockReason, splitNavSections } from "./nav-model";
import { PiLoader } from "./PiLoader";
import { ScrollRail } from "./ScrollRail";
import { SearchField } from "./SearchField";
import { SessionDeleteDialog } from "./SessionDeleteDialog";
import { BrandLogo, Wordmark } from "./Wordmark";

export const Nav = memo(function Nav({
  collapsed,
  isModal = false,
  onClose,
  onOpenSettings,
  onToggleNavigation,
  onNewSession,
  onSelectSession,
  searchInputRef,
}: {
  collapsed: boolean;
  isModal?: boolean;
  onClose?: () => void;
  /** Narrow drawers own Settings so the header can favor session identity. */
  onOpenSettings?: () => void;
  onToggleNavigation: () => void;
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
    selectedSessionId,
    openingSessionId,
    sessionStatuses,
    externalSessionActivities,
    sessionQuery,
    sessionListNextOffset,
    sessionListTotal,
    sessionListLoading,
    sessionListLoadingOlder,
    sessionListHydrating,
    sessionListOperation,
    sessionListError,
    sessionListIssues,
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
      selectedSessionId: state.sessionId,
      openingSessionId: state.openingSessionId,
      sessionStatuses: state.sessionStatuses,
      externalSessionActivities: state.externalSessionActivities,
      sessionQuery: state.sessionQuery,
      sessionListNextOffset: state.sessionListNextOffset,
      sessionListTotal: state.sessionListTotal,
      sessionListLoading: state.sessionListLoading,
      sessionListLoadingOlder: state.sessionListLoadingOlder,
      sessionListHydrating: state.sessionListHydrating,
      sessionListOperation: state.sessionListOperation,
      sessionListError: state.sessionListError,
      sessionListIssues: state.sessionListIssues,
      sessionActionError: state.sessionActionError,
      clearingHidden: state.clearingHidden,
      deletingSessionId: state.deletingSessionId,
    }),
    shallowEqual,
  );

  const internalNavRef = useRef<HTMLElement>(null);
  const modalNavRef = useModalFocus<HTMLDivElement>(
    isModal,
    undefined,
    onClose,
    "drawer",
  );
  const navRef = isModal ? modalNavRef : internalNavRef;
  const [hiddenOpen, setHiddenOpen] = useState(() =>
    readNavigationDisclosure("hiddenSessions"),
  );
  const toggleHidden = () => {
    const open = !hiddenOpen;
    setHiddenOpen(open);
    saveNavigationDisclosure("hiddenSessions", open);
  };
  // Needs you is a second way to read the same column, not a filter chip.
  const [needsYouMode, setNeedsYouMode] = useState(() =>
    readNavigationDisclosure("needsYou"),
  );
  const chooseNeedsYouMode = (on: boolean) => {
    setNeedsYouMode(on);
    saveNavigationDisclosure("needsYou", on);
  };
  const [retainedNeed, setRetainedNeed] = useState<{
    id: string;
    reason: NeedsYouReason;
  } | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchSelection, setSearchSelection] = useState<{
    query: string;
    id: string | null;
  }>({ query: sessionQuery, id: null });
  const composing = useRef(false);
  const selectionStatusId = useId();
  const hiddenContentId = useId();
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
  const needsYou = useMemo(
    () =>
      needsYouRows(
        sections.visible,
        sessionStatuses,
        externalSessionActivities,
        selectedSessionId,
        retainedNeed,
      ),
    [
      sections.visible,
      sessionStatuses,
      externalSessionActivities,
      selectedSessionId,
      retainedNeed,
    ],
  );
  const needsYouCount = needsYou.filter((row) => row.reason).length;
  const needsYouUrgent = needsYou.some(
    (row) => row.reason === "attention" || row.reason === "failed",
  );
  const selectSession = (id: string) => {
    const row = needsYouMode
      ? needsYou.find((candidate) => candidate.session.id === id)
      : undefined;
    setRetainedNeed(row?.reason ? { id, reason: row.reason } : null);
    onSelectSession(id);
  };
  useLayoutEffect(() => {
    if (!hiddenOpen || searching || collapsed) return;
    const nav = navRef.current;
    const body = nav?.querySelector(".nav__hidden-content");
    if (!nav || !body) return;
    // Reveal the actual scrollport after flex layout and subsequent resizes settle.
    const observer = new ResizeObserver(() => {
      body.scrollIntoView({ block: "nearest" });
    });
    observer.observe(body);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [hiddenOpen, searching, collapsed, navRef]);
  const searchResults = useMemo(() => {
    if (needsYouMode) return needsYou.map((row) => row.session);
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
        ? [...sections.hidden, ...folderRows(sections.hiddenGroups)]
        : []),
    ];
  }, [
    sections,
    searching,
    hiddenExpanded,
    collapsedGroupCwds,
    needsYouMode,
    needsYou,
  ]);
  const defaultHighlight = searching ? searchResults[0] : undefined;
  const highlighted = searchFocused
    ? searchSelection.query === sessionQuery
      ? (searchResults.find((session) => session.id === searchSelection.id) ??
        defaultHighlight)
      : defaultHighlight
    : undefined;
  const highlightedSessionId = highlighted?.id ?? null;
  useEffect(() => {
    setSearchSelection((previous) => {
      if (
        previous.query === sessionQuery &&
        ((!searching && previous.id === null) ||
          searchResults.length === 0 ||
          searchResults.some((session) => session.id === previous.id))
      )
        return previous;
      return {
        query: sessionQuery,
        id: searching ? (searchResults[0]?.id ?? null) : null,
      };
    });
  }, [sessionQuery, searchResults, searching]);
  useEffect(() => {
    if (!highlightedSessionId) return;
    navRef.current
      ?.querySelector(".nav__row--highlighted .nav__row-main")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedSessionId, navRef]);
  const [deleteCandidate, setDeleteCandidate] = useState<SessionSummary | null>(
    null,
  );
  const [hiddenClearCandidate, setHiddenClearCandidate] = useState<{
    sessionIds: string[];
    projectCwd?: string;
  } | null>(null);

  if (collapsed) {
    return (
      <nav className="nav nav--rail" aria-label="Sessions">
        <div className="nav__header nav__header--rail">
          <NavigationToggle
            className="nav__brand-rail nav__toggle"
            onClick={onToggleNavigation}
            title="Expand navigation (Ctrl+B)"
            aria-label="Expand navigation"
            aria-expanded={false}
          >
            <BrandLogo size={24} className="nav__brand-icon--rail" />
            <PanelLeft
              size={16}
              className="nav__rail-toggle-icon"
              aria-hidden
            />
          </NavigationToggle>
        </div>
        <button
          type="button"
          className="nav__new-session nav__new-session--rail"
          onClick={onNewSession}
          title="New session"
          aria-label="New session"
        >
          <Plus size={16} className="nav__new-session-icon" aria-hidden />
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
    (sessionListLoading || sessionListLoadingOlder) &&
    (sessionListOperation !== "refresh" || sessions.length === 0);
  const showSessionListActivity =
    hasOlderSessions || sessionListError !== null || foregroundSessionListBusy;
  const retrySessionLabel =
    sessionListOperation === "refresh"
      ? "Retry refreshing sessions"
      : sessionListOperation === "older"
        ? "Retry loading older sessions"
        : "Retry loading sessions";
  const loadingSessionLabel =
    sessionListOperation === "refresh"
      ? "Refreshing sessions…"
      : sessionListOperation === "older"
        ? "Loading older sessions…"
        : "Loading sessions…";
  const hiddenSessions = [
    ...hiddenGroups.flatMap((group) => group.sessions),
    ...hidden,
  ];
  const hiddenSessionIds = hiddenSessions.map((session) => session.id);
  const hiddenCount = hiddenSessions.length;
  const deletionState = {
    openingSessionId,
    sessionQuery,
    sessionListLoading,
    sessionListLoadingOlder,
    sessionListHydrating,
    sessionListError,
    sessionListIssues,
    clearingHidden,
    deletingSessionId,
  };
  const hiddenClearReason = hiddenDeletionBlockReason(
    hiddenSessions,
    deletionState,
  );
  const hiddenClearDisabled = hiddenClearReason !== null;
  const hiddenClearTitle = hiddenClearReason ?? "Clear Hidden";

  const contents = (
    <>
      <div className="nav__top">
        <div className="nav__header">
          <div className="nav__brand-lockup">
            <BrandLogo size={24} className="nav__brand-icon" />
            <Wordmark />
          </div>
          <div className="nav__header-actions">
            <button
              type="button"
              className="icon-button nav__needs-you"
              aria-pressed={needsYouMode}
              aria-label={
                needsYouCount > 0 ? `Needs you (${needsYouCount})` : "Needs you"
              }
              title={
                needsYouMode
                  ? "Showing sessions that need you. Click to show all sessions"
                  : "Show only sessions waiting for input, failed, or finished and not yet seen"
              }
              onClick={() => chooseNeedsYouMode(!needsYouMode)}
            >
              <Bell size={15} aria-hidden />
              {needsYouCount > 0 ? (
                <span
                  className={`navigation-toggle__attention${needsYouUrgent ? " navigation-toggle__attention--urgent" : ""}`}
                  aria-hidden
                >
                  {needsYouCount > 9 ? "9+" : needsYouCount}
                </span>
              ) : null}
            </button>
            {isModal && onClose ? (
              <>
                {onOpenSettings ? (
                  <button
                    type="button"
                    className="icon-button nav__settings"
                    aria-label="Settings"
                    title="Settings"
                    onClick={onOpenSettings}
                  >
                    <SettingsIcon size={15} aria-hidden />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="icon-button nav__close"
                  aria-label="Close navigation"
                  title="Close navigation"
                  onClick={onClose}
                >
                  <X size={15} aria-hidden />
                </button>
              </>
            ) : !isModal ? (
              <button
                type="button"
                className="icon-button nav__close nav__toggle"
                aria-label="Collapse navigation"
                aria-expanded={true}
                title="Collapse navigation (Ctrl+B)"
                onClick={onToggleNavigation}
              >
                <PanelLeft size={15} aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
        <div className="nav__controls">
          <button
            type="button"
            className="nav__new-session"
            aria-label="New session"
            onClick={onNewSession}
          >
            <span className="nav__new-session-label">
              <Plus size={16} className="nav__new-session-icon" aria-hidden />
              <span>New session</span>
            </span>
          </button>
          <SearchField
            className="nav__search"
            inputRef={searchInputRef}
            iconSize={16}
            clearLabel="Clear session search"
            placeholder="Search sessions"
            aria-label="Search sessions"
            value={sessionQuery}
            aria-describedby={selectionStatusId}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => {
              setSearchFocused(false);
              if (!searching)
                setSearchSelection({ query: sessionQuery, id: null });
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onValueChange={store.searchSessions}
            onKeyDown={(event) => {
              if (
                isComposingKeyboardEvent(event.nativeEvent) ||
                composing.current
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
                  selectSession(highlighted.id);
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
          <span id={selectionStatusId} className="sr-only" role="status">
            {highlighted
              ? `${highlighted.title}. Up and Down select a session; Enter opens it.`
              : ""}
          </span>
        </div>
      </div>
      {sessionActionError ? (
        <p className="nav__error" role="alert">
          {sessionActionError}
        </p>
      ) : null}
      <div className="nav__list">
        {needsYouMode ? (
          needsYou.length > 0 ? (
            <section
              className="nav__group nav__group--needs-you"
              aria-label="Sessions that need you"
            >
              {needsYou.map(({ session }) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  searchQuery={sessionQuery}
                  selectedSessionId={selectedSessionId}
                  highlightedSessionId={highlightedSessionId}
                  showProject
                  onSelect={selectSession}
                />
              ))}
            </section>
          ) : (
            <div className="empty-state">
              <CheckCheck size={26} strokeWidth={1.5} aria-hidden />
              <span className="empty-state__title">
                {searching
                  ? "No matching sessions need you"
                  : "Nothing needs you"}
              </span>
              <span className="empty-state__hint">
                Questions waiting for you, failed runs and finished runs you
                haven't seen appear here.
              </span>
            </div>
          )
        ) : null}
        {!needsYouMode && pinned.length > 0 ? (
          <section
            className="nav__group nav__group--pinned"
            aria-labelledby="nav-pinned-title"
          >
            <h2 className="nav__group-title" id="nav-pinned-title">
              <Pin size={16} aria-hidden />
              <span className="nav__group-name">Pinned</span>
              <span className="nav__group-count" aria-hidden>
                {pinned.length}
              </span>
            </h2>
            {pinned.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                searchQuery={sessionQuery}
                selectedSessionId={selectedSessionId}
                highlightedSessionId={highlightedSessionId}
                showProject
                onSelect={onSelectSession}
              />
            ))}
          </section>
        ) : null}
        {needsYouMode
          ? null
          : folders.map((group) => (
              <ProjectGroup
                key={group.cwd}
                group={group}
                searching={searching}
                searchQuery={sessionQuery}
                showContext={(nameCounts.get(group.name) ?? 0) > 1}
                selectedSessionId={selectedSessionId}
                highlightedSessionId={highlightedSessionId}
                onSelectSession={onSelectSession}
              />
            ))}
        {sessionListIssues.length ? (
          <div className="nav__pagination">
            <details className="nav__source-issues">
              <summary>Some sessions may be missing</summary>
              <p>Counts may be incomplete.</p>
              <ul>
                {sessionListIssues.map((issue) => (
                  <li key={issue.path}>
                    <strong>{issue.path}</strong>
                    <br />
                    {issue.message}
                  </li>
                ))}
              </ul>
            </details>
            <button
              type="button"
              className="nav__pagination-button"
              disabled={sessionListBusy}
              onClick={() => void store.refreshSessions()}
            >
              Retry loading sessions
            </button>
          </div>
        ) : null}
        {!needsYouMode && showSessionListActivity ? (
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
                <PiLoader size={12} aria-hidden />
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
        {!needsYouMode &&
        sessions.length === 0 &&
        !sessionListBusy &&
        !sessionListError &&
        !sessionListIssues.length ? (
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
      {!needsYouMode && hiddenCount > 0 ? (
        <section
          className="nav__group nav__group--hidden"
          aria-labelledby="nav-hidden-title"
        >
          <h2
            className="nav__hidden-heading nav__dock-heading"
            id="nav-hidden-title"
            aria-label="Hidden"
          >
            <button
              type="button"
              className="nav__hidden-toggle nav__dock-toggle"
              aria-expanded={hiddenExpanded}
              aria-controls={hiddenContentId}
              disabled={searching}
              onClick={toggleHidden}
            >
              <EyeOff size={16} aria-hidden />
              <span className="nav__group-name nav__dock-title">Hidden</span>
              <span className="nav__hidden-count" aria-hidden>
                {hiddenCount}
              </span>
              <ChevronUp
                size={12}
                className={`chev-flip ${hiddenExpanded ? "chev-flip--open" : ""}`}
                aria-hidden
              />
            </button>
            <button
              type="button"
              className="nav__row-action nav__row-action--danger nav__hidden-clear"
              aria-label="Clear Hidden"
              title={hiddenClearTitle}
              disabled={hiddenClearDisabled}
              onClick={() =>
                setHiddenClearCandidate({ sessionIds: hiddenSessionIds })
              }
            >
              {clearingHidden ? (
                <PiLoader size={12} aria-hidden />
              ) : (
                <Trash2 size={12} aria-hidden />
              )}
            </button>
          </h2>
          {hiddenExpanded ? (
            <div className="nav__hidden-content" id={hiddenContentId}>
              {hidden.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  searchQuery={sessionQuery}
                  selectedSessionId={selectedSessionId}
                  highlightedSessionId={highlightedSessionId}
                  showProject
                  onSelect={onSelectSession}
                  onDelete={setDeleteCandidate}
                />
              ))}
              {hiddenGroups.map((group) => (
                <ProjectGroup
                  key={group.cwd}
                  group={group}
                  searching={searching}
                  searchQuery={sessionQuery}
                  showContext={(nameCounts.get(group.name) ?? 0) > 1}
                  selectedSessionId={selectedSessionId}
                  highlightedSessionId={highlightedSessionId}
                  hidden
                  onSelectSession={onSelectSession}
                  onDeleteSession={setDeleteCandidate}
                  onDeleteGroup={() =>
                    setHiddenClearCandidate({
                      sessionIds: group.sessions.map((session) => session.id),
                      projectCwd: group.cwd,
                    })
                  }
                  deleteGroupDisabledReason={hiddenDeletionBlockReason(
                    group.sessions,
                    deletionState,
                  )}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      <ScrollRail container={navRef} variant="nav" />
      <ScrollRail container={navRef} scroller=".nav__list" variant="nav" />
      <ScrollRail
        container={navRef}
        scroller=".nav__hidden-content"
        variant="nav"
      />
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
          sessionIds={hiddenClearCandidate.sessionIds}
          projectCwd={hiddenClearCandidate.projectCwd}
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
