import {
  AlertTriangle,
  Check,
  Command,
  Folder,
  GitBranch,
  PanelLeft,
  PanelRight,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  memo,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type ProjectionConflict,
  projectionConflictSeverity,
  projectNameFromCwd,
  type RunState,
} from "../../shared/contracts";
import { userMessageTitle } from "../../shared/user-message";
import { selectedRunState } from "../app-state";
import { branchCopiesBlocked } from "../controllers/branch-controller";
import { type ChatMessage } from "../events";
import { gitChangeCount, gitHeadLabel } from "../git-presentation";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { shallowEqual, store, useAppState } from "../store";
import { useCopied } from "../use-copied";
import { ExtensionStatus } from "./ExtensionDisplays";
import { NavigationToggle } from "./NavigationToggle";
import { PiLoader } from "./PiLoader";
import { RenameSessionDialog } from "./RenameSessionDialog";
import { SessionActionsMenu } from "./SessionActionsMenu";

const GENERIC_SESSION_HEADINGS = new Set(["Untitled session", "New session"]);

/** Keep Pi's explicit session name distinct from its visual fallback. The
 * catalog normally owns the first-prompt projection; a complete short
 * transcript covers the brief interval before that catalog row refreshes. */
export function sessionHeading(
  sessionName: string,
  catalogTitle: string | undefined,
  messages: readonly ChatMessage[],
  transcriptStartsAtRoot: boolean,
): string {
  const explicit = sessionName.trim();
  if (explicit) return explicit;
  const catalog = catalogTitle?.trim() ?? "";
  if (catalog && !GENERIC_SESSION_HEADINGS.has(catalog)) return catalog;
  if (transcriptStartsAtRoot) {
    for (const message of messages) {
      if (message.role !== "user") continue;
      const title = userMessageTitle(message.content);
      if (title) return title;
    }
  }
  return "New session";
}

function StatusChip({
  children,
  className,
  label,
  role,
}: {
  children?: React.ReactNode;
  className: string;
  label: string;
  role?: "status";
}) {
  return (
    <span className={className} title={label} role={role}>
      {children}
      <span className="chip__label chip__label--responsive">{label}</span>
    </span>
  );
}

function StateChip({
  runState,
  conflict,
}: {
  runState: RunState;
  conflict: ProjectionConflict | null;
}) {
  if (runState === "conflict") {
    const attention = projectionConflictSeverity(conflict) === "attention";
    const label = attention ? "Needs recovery" : "Conflict";
    return (
      <StatusChip
        key="conflict"
        className={`chip chip--${attention ? "warning" : "error"}`}
        label={label}
      >
        <AlertTriangle size={12} aria-hidden />
      </StatusChip>
    );
  }
  return null;
}

function GitSummary() {
  const { gitStatus, gitStatusError, changesVisible } = useAppState(
    (state) => ({
      gitStatus: state.gitStatus,
      gitStatusError: state.gitStatusError,
      // Changes already states the same authoritative count beside the list.
      changesVisible: state.resourcesOpen && state.contextMode === "changes",
    }),
    shallowEqual,
  );
  const branch = gitHeadLabel(gitStatus);
  const changes = gitChangeCount(gitStatus);
  if (!branch || changes === null) return null;

  const conflictCount =
    gitStatus?.kind === "repository"
      ? gitStatus.files.filter((file) => file.conflict).length
      : 0;
  const changeLabel = changes === 1 ? "1 change" : `${changes} changes`;
  const conflictLabel =
    conflictCount === 1 ? "1 conflict" : `${conflictCount} conflicts`;
  const statusLabel =
    changes > 0
      ? [changeLabel, ...(conflictCount > 0 ? [conflictLabel] : [])].join(", ")
      : "Working tree clean";
  const tone = gitStatusError
    ? "topbar__git--stale"
    : conflictCount > 0
      ? "topbar__git--conflict"
      : "";
  const staleLabel = gitStatusError ? " Status may be stale." : "";
  return (
    <button
      type="button"
      className={`button button--quiet topbar__git ${tone}`}
      onClick={() => store.openContextMode("changes")}
      aria-label={`Open Git changes: ${branch}, ${statusLabel}${gitStatusError ? ", status may be stale" : ""}`}
      title={`${branch} · ${statusLabel} — open Changes.${staleLabel}`}
    >
      <GitBranch size={13} className="topbar__git-icon" aria-hidden />
      <span className="topbar__git-branch">{branch}</span>
      {changes > 0 && !changesVisible ? (
        <span className="topbar__git-count" aria-hidden>
          {changes > 99 ? "99+" : changes}
        </span>
      ) : null}
    </button>
  );
}

const SessionIdent = memo(function SessionIdent({
  show,
  onExport,
  onOpenHistory,
}: {
  show: boolean;
  onExport: () => void;
  onOpenHistory: () => void;
}) {
  const {
    sessionId,
    sessionName,
    heading,
    cwd,
    project,
    projectDisplay,
    sessionActionOrder,
    cloneDisabled,
    readOnlyReason,
  } = useAppState((state) => {
    const catalogTitle = state.sessions.find(
      (session) => session.id === state.sessionId,
    )?.title;
    return {
      sessionId: state.sessionId,
      sessionName: state.sessionName,
      heading: sessionHeading(
        state.sessionName,
        catalogTitle,
        state.live.messages,
        !state.view.hasOlder,
      ),
      cwd: state.cwd,
      project: state.cwd ? projectNameFromCwd(state.cwd) : null,
      projectDisplay: state.prefs.projectDisplay,
      sessionActionOrder: state.prefs.sessionActionOrder,
      cloneDisabled: branchCopiesBlocked(state),
      readOnlyReason: state.readOnlyReason,
    };
  }, shallowEqual);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const titleRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const { copied, copy } = useCopied({
    scope: cwd,
    onError: store.reportCopyError,
  });

  if (!show || !sessionId) return null;

  return (
    <div className="topbar__ident">
      <h1 className="topbar__title" aria-label={heading}>
        <button
          ref={titleRef}
          type="button"
          className="button button--quiet topbar__title-button"
          aria-label={`Session actions: ${heading}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={heading}
          onClick={() => setMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            if (
              event.key === "ArrowDown" &&
              !isComposingKeyboardEvent(event.nativeEvent)
            ) {
              event.preventDefault();
              setMenuOpen(true);
            }
          }}
        >
          <span>{heading}</span>
        </button>
      </h1>

      {menuOpen ? (
        <SessionActionsMenu
          anchorRef={titleRef}
          sessionId={sessionId}
          actionOrder={sessionActionOrder}
          onCopyError={store.reportCopyError}
          cloneDisabled={cloneDisabled}
          renameDisabled={Boolean(readOnlyReason)}
          onClose={closeMenu}
          onRename={() => {
            titleRef.current?.focus({ preventScroll: true });
            closeMenu();
            setEditing(true);
          }}
          onSwitchBranch={() => {
            closeMenu();
            onOpenHistory();
          }}
          onClone={() => {
            const trigger = document.activeElement;
            void store.cloneCurrentBranch().then((cloned) => {
              if (!cloned) return;
              const returnFocus =
                document.activeElement === trigger ||
                document.activeElement === document.body;
              closeMenu();
              if (returnFocus) titleRef.current?.focus({ preventScroll: true });
            });
          }}
          onExport={() => {
            closeMenu();
            titleRef.current?.focus({ preventScroll: true });
            onExport();
          }}
        />
      ) : null}
      {editing && !readOnlyReason && (
        <RenameSessionDialog
          sessionId={sessionId}
          initialName={sessionName}
          onClose={() => setEditing(false)}
        />
      )}
      <div className="topbar__workspace-meta">
        {cwd ? (
          <button
            type="button"
            className={`button button--quiet topbar__project ${copied ? "is-copied" : ""}`}
            onClick={(event) => {
              // Ctrl/⌘+click opens the project folder on the Host desktop.
              if (event.ctrlKey || event.metaKey)
                void store.showInFileManager(".", ".", true);
              else void copy(cwd, store.copyOwnership());
            }}
            title={
              copied
                ? "Copied"
                : `Copy path — ${cwd}\nCtrl+click: Show in file manager`
            }
            aria-label="Copy project path"
          >
            <Folder className="topbar__project-icon" size={13} aria-hidden />
            {/* The normal label remains the sole width authority. Copy feedback
                overlays it, so a wider hidden message cannot extend hover chrome. */}
            <span className="topbar__project-label">
              {projectDisplay === "path" ? cwd : project}
            </span>
            <Check size={11} className="topbar__project-feedback" aria-hidden />
          </button>
        ) : null}
        <GitSummary />
      </div>
    </div>
  );
});

export const AppTopbar = memo(function AppTopbar({
  narrowViewport,
  mobileNavOpen,
  mobileNavToggleRef,
  settingsOpen,
  onToggleNavigation,
  onOpenCommandPalette,
  onExportSession,
  onOpenHistory = store.openHistory,
  onToggleSettings,
  onToggleResources,
}: {
  narrowViewport: boolean;
  mobileNavOpen: boolean;
  mobileNavToggleRef?: Ref<HTMLButtonElement>;
  settingsOpen: boolean;
  onToggleNavigation: () => void;
  onOpenCommandPalette: () => void;
  onExportSession: () => void;
  onOpenHistory?: () => void;
  onToggleSettings: () => void;
  onToggleResources: () => void;
}) {
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      runState: selectedRunState(source),
      projectionConflict: source.view.conflict,
      connection: source.connection,
      connectionProblem: source.connectionProblem,
      workspaceLoading:
        !source.sessionId && (!source.bootstrapped || source.startupPending),
      resourcesOpen: source.resourcesOpen,
      observesRepository:
        Boolean(source.sessionId) &&
        (source.gitStatus === null || source.gitStatus.kind === "repository"),
    }),
    shallowEqual,
  );
  useEffect(() => {
    // Observe from the stable topbar, not the session-keyed identity below.
    // Session changes already refresh Git in the store; remounting that
    // subscription would cancel and restart the same request.
    if (!state.observesRepository) return;
    store.setGitSurfaceVisible("topbar-git", true);
    return () => store.setGitSurfaceVisible("topbar-git", false);
  }, [state.observesRepository]);
  return (
    <header className="topbar">
      {narrowViewport ? (
        <NavigationToggle
          ref={mobileNavToggleRef}
          className="icon-button"
          onClick={onToggleNavigation}
          aria-label="Toggle navigation"
          aria-expanded={mobileNavOpen}
          title="Toggle navigation (Ctrl+B)"
        >
          <PanelLeft size={15} aria-hidden />
        </NavigationToggle>
      ) : null}
      <SessionIdent
        key={state.sessionId}
        show={Boolean(state.sessionId)}
        onExport={onExportSession}
        onOpenHistory={onOpenHistory}
      />
      <div className="topbar__status" aria-live="polite">
        <StateChip
          runState={state.runState}
          conflict={state.projectionConflict}
        />
        <ExtensionStatus />
        {state.connection !== "open"
          ? (() => {
              const problem = state.connectionProblem;
              const failure =
                problem !== null && problem.kind !== "stream-interrupted";
              if (state.workspaceLoading && !failure) return null;
              const label =
                problem?.kind === "device-offline"
                  ? "Device offline"
                  : problem?.kind === "relay-unavailable"
                    ? "Tunnel unavailable"
                    : problem?.kind === "service-error"
                      ? "Host error"
                      : problem?.kind === "address-unreachable"
                        ? "Address unavailable"
                        : state.connection === "reconnecting"
                          ? "Reconnecting"
                          : "Connecting";
              return (
                <StatusChip
                  className={
                    failure ? "chip chip--warning" : "topbar__connection"
                  }
                  label={label}
                  role="status"
                >
                  {failure ? (
                    <AlertTriangle size={12} aria-hidden />
                  ) : (
                    <PiLoader size={12} aria-hidden />
                  )}
                </StatusChip>
              );
            })()
          : null}
      </div>
      <div className="topbar__actions">
        <button
          type="button"
          className="icon-button topbar__palette"
          onClick={() => onOpenCommandPalette()}
          aria-label="Open command palette"
          title="Command palette (Ctrl+K)"
        >
          <Command size={15} aria-hidden />
        </button>
        {narrowViewport ? null : (
          // Narrow layouts reach Settings from the navigation drawer and the
          // command palette, leaving header width to the session identity.
          <button
            type="button"
            className={`icon-button ${settingsOpen ? "icon-button--active" : ""}`}
            onClick={onToggleSettings}
            aria-label="Settings"
            title="Settings"
          >
            <SettingsIcon size={15} aria-hidden />
          </button>
        )}
        <button
          type="button"
          className={`icon-button ${state.resourcesOpen ? "icon-button--active" : ""}`}
          onClick={onToggleResources}
          aria-label="Toggle resources panel"
          data-terminal-focus-trigger
          aria-expanded={state.resourcesOpen}
          title="Toggle resources panel (Ctrl+.)"
        >
          <PanelRight size={15} aria-hidden />
        </button>
      </div>
    </header>
  );
});
