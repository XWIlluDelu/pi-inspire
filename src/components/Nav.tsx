import {
  CheckCheck,
  Bell,
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
  Fragment,
  memo,
  type Ref,
  useEffect,
  useId,
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
  readHiddenSessionsOpen,
  readSessionCatalogView,
  type SessionCatalogView,
  saveHiddenSessionsOpen,
  saveSessionCatalogView,
} from "../workbench-session";
import { HiddenClearDialog } from "./HiddenClearDialog";
import { NavigationToggle } from "./NavigationToggle";
import { ProjectGroup, SessionRow } from "./NavSessions";
import {
  buildSessionCatalog,
  hiddenDeletionBlockReason,
  sectionSessions,
} from "./nav-model";
import { PiLoader } from "./PiLoader";
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
  const catalogState = useAppState(
    (state) => ({
      sessions: state.sessions,
      pinnedSessionIds:
        state.desiredPreferences.pinnedSessionIds ??
        state.prefs.pinnedSessionIds,
      pinnedProjectCwds:
        state.desiredPreferences.pinnedProjectCwds ??
        state.prefs.pinnedProjectCwds,
      curatedHiddenSessionIds:
        state.desiredPreferences.hiddenSessionIds ??
        state.prefs.hiddenSessionIds,
      hiddenProjectCwds:
        state.desiredPreferences.hiddenProjectCwds ??
        state.prefs.hiddenProjectCwds,
      collapsedGroupCwds:
        state.desiredPreferences.navCollapsedGroups ??
        state.prefs.navCollapsedGroups,
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
      sessionActionError: state.sessionActionError,
      curationPending: state.curationPending,
      clearingHidden: state.clearingHidden,
      deletingSessionId: state.deletingSessionId,
    }),
    shallowEqual,
  );

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
    sessionActionError,
    curationPending,
    clearingHidden,
  } = catalogState;
  const internalNavRef = useRef<HTMLElement>(null);
  const modalNavRef = useModalFocus<HTMLDivElement>(
    isModal,
    undefined,
    onClose,
  );
  const navRef = isModal ? modalNavRef : internalNavRef;
  const [view, setView] = useState<Exclude<SessionCatalogView, "hidden">>(() =>
    readSessionCatalogView() === "needs-you" ? "needs-you" : "all",
  );
  const [hiddenOpen, setHiddenOpen] = useState(
    () => readSessionCatalogView() === "hidden" || readHiddenSessionsOpen(),
  );
  const hiddenContentId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const chooseView = (next: Exclude<SessionCatalogView, "hidden">) => {
    setView(next);
    saveSessionCatalogView(next);
    if (listRef.current) listRef.current.scrollTop = 0;
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
  const catalog = useMemo(
    () =>
      buildSessionCatalog(sessions, {
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

  const needsYou = useMemo(
    () =>
      needsYouRows(
        catalog.visible,
        sessionStatuses,
        externalSessionActivities,
        selectedSessionId,
        retainedNeed,
      ),
    [
      catalog.visible,
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
    const row =
      view === "needs-you"
        ? needsYou.find((candidate) => candidate.session.id === id)
        : undefined;
    setRetainedNeed(row?.reason ? { id, reason: row.reason } : null);
    onSelectSession(id);
  };
  const displayed = (
    view === "needs-you"
      ? [
          {
            kind: "needs-you" as const,
            sessions: needsYou.map(({ session }) => session),
          },
        ]
      : catalog.all
  ).filter((section) => sectionSessions(section).length);
  const showHidden = view === "all" && (hiddenOpen || searching);
  const hiddenSections = view === "all" ? catalog.hidden : [];
  const searchResults = [
    ...displayed,
    ...(showHidden ? hiddenSections : []),
  ].flatMap((section) =>
    section.kind === "folder" &&
    !searching &&
    collapsedGroupCwds.includes(section.group.cwd)
      ? []
      : sectionSessions(section),
  );
  const defaultHighlight = searching ? searchResults[0] : undefined;
  const highlighted = searchFocused
    ? searchSelection.query === sessionQuery
      ? (searchResults.find((session) => session.id === searchSelection.id) ??
        defaultHighlight)
      : defaultHighlight
    : undefined;
  const highlightedSessionId = highlighted?.id ?? null;
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

  const nameCounts = new Map<string, number>();
  for (const section of [...displayed, ...hiddenSections])
    if (section.kind === "folder") {
      const { name } = section.group;
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
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
  const hiddenSessions = catalog.hidden.flatMap(sectionSessions);
  const hiddenClearReason = hiddenDeletionBlockReason(
    hiddenSessions,
    catalogState,
  );

  const renderSection = (section: (typeof displayed)[number]) => {
    if (section.kind === "folder") {
      const { group, hidden } = section;
      return (
        <ProjectGroup
          key={group.cwd}
          group={group}
          searching={searching}
          searchQuery={sessionQuery}
          showContext={(nameCounts.get(group.name) ?? 0) > 1}
          selectedSessionId={selectedSessionId}
          highlightedSessionId={highlightedSessionId}
          hidden={hidden}
          onSelectSession={selectSession}
          onDeleteSession={hidden ? setDeleteCandidate : undefined}
          onDeleteGroup={
            hidden
              ? () =>
                  setHiddenClearCandidate({
                    sessionIds: group.sessions.map(({ id }) => id),
                    projectCwd: group.cwd,
                  })
              : undefined
          }
          deleteGroupDisabledReason={
            hidden
              ? hiddenDeletionBlockReason(group.sessions, catalogState)
              : null
          }
        />
      );
    }
    const rows = section.sessions.map((session) => (
      <SessionRow
        key={session.id}
        session={session}
        searchQuery={sessionQuery}
        selectedSessionId={selectedSessionId}
        highlightedSessionId={highlightedSessionId}
        showProject
        onSelect={selectSession}
        onDelete={section.kind === "hidden" ? setDeleteCandidate : undefined}
      />
    ));
    return section.kind === "pinned" ? (
      <section
        key={section.kind}
        className="nav__group nav__group--pinned"
        aria-label="Pinned"
      >
        <h2 className="nav__group-title">
          <Pin size={16} aria-hidden />
          <span className="nav__group-name">Pinned</span>
          <span className="nav__group-count" aria-hidden>
            {section.sessions.length}
          </span>
        </h2>
        {rows}
      </section>
    ) : (
      <Fragment key={section.kind}>{rows}</Fragment>
    );
  };

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
              aria-pressed={view === "needs-you"}
              aria-label={
                needsYouCount > 0 ? `Needs you (${needsYouCount})` : "Needs you"
              }
              title={
                view === "needs-you"
                  ? "Showing sessions that need you. Click to show all sessions"
                  : "Show only sessions waiting for input, failed, or finished and not yet seen"
              }
              onClick={() =>
                chooseView(view === "needs-you" ? "all" : "needs-you")
              }
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
      <div
        ref={listRef}
        className={`nav__list nav__list--${view}`}
        role="region"
        aria-label={
          view === "needs-you" ? "Sessions that need you" : "All sessions"
        }
        aria-busy={curationPending || undefined}
      >
        {displayed.map(renderSection)}
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
                className="button button--quiet"
                onClick={() => void store.retrySessionList()}
              >
                {retrySessionLabel}
              </button>
            ) : foregroundSessionListBusy ? (
              <button
                type="button"
                className="button button--quiet"
                disabled
                aria-busy="true"
              >
                <PiLoader size={12} aria-hidden />
                {loadingSessionLabel}
              </button>
            ) : hasOlderSessions ? (
              <button
                type="button"
                className="button button--quiet"
                disabled={sessionListBusy}
                onClick={() => void store.loadOlderSessions()}
              >
                Load older sessions
              </button>
            ) : null}
          </div>
        ) : null}
        {displayed.length === 0 &&
          (!showHidden || hiddenSessions.length === 0) &&
          !sessionListBusy &&
          !sessionListError && (
            <div className="empty-state">
              {searching ? (
                <SearchX size={26} strokeWidth={1.5} aria-hidden />
              ) : view === "needs-you" ? (
                <CheckCheck size={26} strokeWidth={1.5} aria-hidden />
              ) : (
                <Inbox size={26} strokeWidth={1.5} aria-hidden />
              )}
              <span className="empty-state__title">
                {view === "needs-you"
                  ? searching
                    ? "No matching sessions need you"
                    : "Nothing needs you"
                  : searching
                    ? "No sessions found"
                    : "No sessions yet"}
              </span>
            </div>
          )}
      </div>
      {hiddenSections.length > 0 && (
        <section className="nav__group nav__group--hidden" aria-label="Hidden">
          <h2 className="nav__hidden-heading nav__dock-heading">
            <button
              type="button"
              className="nav__hidden-toggle nav__dock-toggle"
              aria-expanded={showHidden}
              disabled={searching}
              aria-controls={hiddenContentId}
              onClick={() => {
                const next = !hiddenOpen;
                setHiddenOpen(next);
                saveHiddenSessionsOpen(next);
              }}
            >
              <EyeOff size={16} aria-hidden />
              <span className="nav__group-name nav__dock-title">Hidden</span>
              <span className="nav__hidden-count" aria-hidden>
                {hiddenSessions.length}
              </span>
              <ChevronUp
                size={12}
                className={`chev-flip ${showHidden ? "chev-flip--open" : ""}`}
                aria-hidden
              />
            </button>
            <button
              type="button"
              className="nav__row-action nav__row-action--danger nav__hidden-clear"
              aria-label="Clear Hidden"
              title={hiddenClearReason ?? "Clear Hidden"}
              disabled={hiddenClearReason !== null}
              onClick={() =>
                setHiddenClearCandidate({
                  sessionIds: hiddenSessions.map(({ id }) => id),
                })
              }
            >
              {clearingHidden ? (
                <PiLoader size={12} aria-hidden />
              ) : (
                <Trash2 size={12} aria-hidden />
              )}
            </button>
          </h2>
          {showHidden && (
            <div className="nav__hidden-content" id={hiddenContentId}>
              {hiddenSections.map(renderSection)}
            </div>
          )}
        </section>
      )}
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
