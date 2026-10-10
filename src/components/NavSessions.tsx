import {
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  Loader2,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { memo } from "react";
import {
  isBusyRunState,
  projectNameFromCwd,
  type SessionIndicator,
  type SessionSummary,
} from "../../shared/contracts";
import { sessionSearchMatchRanges } from "../session-search-presentation";
import { shallowEqual, store, useAppState } from "../store";
import { compactAge, parentSegment, type SessionGroup } from "./nav-model";
import { SearchMatchText } from "./SearchMatchText";

const INDICATOR_LABELS: Record<SessionIndicator, string> = {
  running: "Working",
  completed: "Completed",
  failed: "Failed",
  attention: "Needs recovery",
};

function searchParentContext(cwd: string, query: string): string {
  const parent = parentSegment(cwd);
  return sessionSearchMatchRanges(parent, query).length > 0 &&
    sessionSearchMatchRanges(projectNameFromCwd(cwd), query).length === 0
    ? parent
    : "";
}

/** One dense session line: the title at the left and one number at the right —
 * the activity age, in a fixed column the curation actions take over on hover
 * or focus. The message count is a tooltip fact, not a second number fighting
 * for the same edge. Cross-project path searches replace age with directory
 * context so the title keeps its space. */
export const SessionRow = memo(function SessionRow({
  session,
  selectedSessionId,
  highlightedSessionId,
  showProject = false,
  searchQuery = "",
  onSelect,
  onDelete,
}: {
  session: SessionSummary;
  selectedSessionId: string | null;
  highlightedSessionId?: string | null;
  showProject?: boolean;
  searchQuery?: string;
  onSelect: (id: string) => void;
  onDelete?: (session: SessionSummary) => void;
}) {
  const {
    activeSessionId,
    openingSessionId,
    pinned,
    individuallyHidden,
    projectHidden,
    runtimeStatus,
    deletingSessionId,
    clearingHidden,
  } = useAppState(
    (state) => ({
      activeSessionId: state.sessionId,
      openingSessionId: state.openingSessionId,
      pinned: state.prefs.pinnedSessionIds.includes(session.id),
      individuallyHidden: state.prefs.hiddenSessionIds.includes(session.id),
      projectHidden: state.prefs.hiddenProjectCwds.includes(session.cwd),
      runtimeStatus: state.sessionStatuses[session.id],
      deletingSessionId: state.deletingSessionId,
      clearingHidden: state.clearingHidden,
    }),
    shallowEqual,
  );
  const active = session.id === activeSessionId;
  const selected = session.id === selectedSessionId;
  const opening = openingSessionId === session.id;
  const hidden = individuallyHidden || projectHidden;
  const indicator = runtimeStatus?.indicator;
  const conflicted = runtimeStatus?.runState === "conflict";
  const busy = runtimeStatus ? isBusyRunState(runtimeStatus.runState) : false;
  const deleteDisabled =
    active ||
    opening ||
    busy ||
    conflicted ||
    deletingSessionId !== null ||
    clearingHidden;
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
    indicator === "completed" || indicator === "failed"
      ? selected
        ? null
        : indicator
      : (indicator ?? null);
  const attentionLabel = attention ? INDICATOR_LABELS[attention] : null;
  const title = session.title || "New session";
  const titleMatches = sessionSearchMatchRanges(title, searchQuery);
  const projectName = projectNameFromCwd(session.cwd);
  const parentContext =
    showProject && titleMatches.length === 0
      ? searchParentContext(session.cwd, searchQuery)
      : "";
  const projectLabel = parentContext
    ? `${parentContext}/${projectName}`
    : projectName;
  return (
    <div
      className={`nav__row ${selected ? "nav__row--active" : ""} ${session.id === highlightedSessionId ? "nav__row--highlighted" : ""}`}
    >
      <button
        type="button"
        className="nav__row-main"
        onClick={() => onSelect(session.id)}
        disabled={opening}
        aria-busy={opening}
        aria-current={selected ? "page" : undefined}
        title={`${title} · ${session.messageCount} messages`}
      >
        <span className="nav__row-title">
          {opening ? (
            <span
              role="img"
              aria-label="Opening session"
              title="Opening session"
            >
              <Loader2 size={12} className="spin" aria-hidden />
            </span>
          ) : attention ? (
            <span
              className={`nav__row-dot nav__row-dot--${attention}`}
              role="img"
              aria-label={attentionLabel!}
              title={attentionLabel!}
            />
          ) : null}
          <span className="nav__row-name">
            <SearchMatchText text={title} ranges={titleMatches} />
          </span>
        </span>
        <span className="nav__row-meta">
          {showProject ? (
            <span className="nav__row-project">
              <SearchMatchText
                text={projectLabel}
                ranges={sessionSearchMatchRanges(projectLabel, searchQuery)}
              />
            </span>
          ) : null}
          {!parentContext ? (
            <span
              className="nav__row-age"
              title={new Date(session.modified).toLocaleString()}
            >
              {compactAge(session.modified)}
            </span>
          ) : null}
        </span>
      </button>
      <div className="nav__row-actions">
        {hidden ? (
          <>
            {projectHidden ? (
              <span className="nav__row-action-spacer" aria-hidden />
            ) : (
              <button
                type="button"
                className="nav__row-action"
                aria-label={`Restore "${title}"`}
                title="Move back out of Hidden"
                disabled={clearingHidden}
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
              {pinned ? (
                <PinOff size={12} aria-hidden />
              ) : (
                <Pin size={12} aria-hidden />
              )}
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
});

/** One folder group. Its main row owns the whole collapse hit target while
 * the same fixed right column as a session row owns Pin/Hide or Restore. */
export function ProjectGroup({
  group,
  headingId,
  searching,
  searchQuery = "",
  showContext,
  selectedSessionId,
  highlightedSessionId,
  hidden = false,
  onSelectSession,
  onDeleteSession,
}: {
  group: SessionGroup;
  headingId: string;
  searching: boolean;
  searchQuery?: string;
  showContext: boolean;
  selectedSessionId: string | null;
  highlightedSessionId?: string | null;
  hidden?: boolean;
  onSelectSession: (id: string) => void;
  onDeleteSession?: (session: SessionSummary) => void;
}) {
  const { collapsed, pinned, clearingHidden } = useAppState(
    (state) => ({
      collapsed: state.prefs.navCollapsedGroups.includes(group.cwd),
      pinned: state.prefs.pinnedProjectCwds.includes(group.cwd),
      clearingHidden: state.clearingHidden,
    }),
    shallowEqual,
  );
  // Active search must never hide results inside a collapsed folder.
  const expanded = searching || !collapsed;
  // A collapsed folder that hides the active session carries the active
  // highlight itself.
  const activeInside = group.sessions.some(
    (session) => session.id === selectedSessionId,
  );
  const context = showContext
    ? parentSegment(group.cwd)
    : searchParentContext(group.cwd, searchQuery);
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
          <ChevronRight
            size={13}
            className={`chev ${expanded ? "chev--open" : ""}`}
            aria-hidden
          />
          <Folder size={14} aria-hidden />
          <span className="nav__group-name">
            <SearchMatchText
              text={group.name}
              ranges={sessionSearchMatchRanges(group.name, searchQuery)}
            />
          </span>
          {context ? (
            <span className="nav__group-context">
              @
              <SearchMatchText
                text={context}
                ranges={sessionSearchMatchRanges(context, searchQuery)}
              />
            </span>
          ) : null}
          <span className="nav__group-count" aria-hidden>
            {group.sessions.length}
          </span>
        </button>
        <span className="nav__group-actions">
          {hidden ? (
            <>
              <button
                type="button"
                className="nav__row-action"
                aria-label={`Restore folder ${group.name}`}
                title="Move folder back out of Hidden"
                disabled={clearingHidden}
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
                aria-label={
                  pinned
                    ? `Unpin folder ${group.name}`
                    : `Pin folder ${group.name}`
                }
                title={pinned ? "Unpin folder" : "Pin folder"}
                onClick={() => store.toggleProjectPin(group.cwd)}
              >
                {pinned ? (
                  <PinOff size={12} aria-hidden />
                ) : (
                  <Pin size={12} aria-hidden />
                )}
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
              searchQuery={searchQuery}
              selectedSessionId={selectedSessionId}
              highlightedSessionId={highlightedSessionId}
              onSelect={onSelectSession}
              onDelete={hidden ? onDeleteSession : undefined}
            />
          ))
        : null}
    </section>
  );
}
