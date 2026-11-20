import {
  AlertTriangle,
  Check,
  Command,
  Ellipsis,
  Folder,
  GitBranch,
  PanelLeft,
  PanelRight,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type ProjectionConflict,
  projectionConflictSeverity,
  projectNameFromCwd,
  type RunState,
} from "../../shared/contracts";
import { selectedRunState } from "../app-state";
import { gitChangeCount, gitHeadLabel } from "../git-presentation";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { type SessionInspection, sessionPresentationName } from "../session-actions";
import { shallowEqual, store, useAppState } from "../store";
import { useCopied } from "../use-copied";
import { ExtensionStatus } from "./ExtensionDisplays";
import { NavigationToggle } from "./NavigationToggle";
import { PiLoader } from "./PiLoader";
import { SessionActionsMenu } from "./SessionActionsMenu";

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
  const { branch, changes, conflictCount, gitStatusError, changesVisible } =
    useAppState(
      (state) => ({
        branch: gitHeadLabel(state.gitStatus),
        changes: gitChangeCount(state.gitStatus),
        conflictCount:
          state.gitStatus?.kind === "repository"
            ? state.gitStatus.conflicts
            : 0,
        gitStatusError: state.gitStatusError,
        // Changes already states the same authoritative count beside the list.
        changesVisible: state.resourcesOpen && state.contextMode === "changes",
      }),
      shallowEqual,
    );
  if (!branch || changes === null) return null;

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
          {changes}
          <span className="topbar__git-count-word">
            {" "}
            {changes === 1 ? "change" : "changes"}
          </span>
        </span>
      ) : null}
    </button>
  );
}

const SessionIdent = memo(function SessionIdent({
  onInspect,
}: {
  onInspect: (kind: SessionInspection) => void;
}) {
  const { sessionId, heading, cwd, projectDisplay, readOnly, branchRequest } =
    useAppState(
      (state) => ({
        sessionId: state.sessionId,
        heading: sessionPresentationName(state),
        cwd: state.cwd,
        projectDisplay: state.prefs.projectDisplay,
        readOnly: Boolean(state.readOnlyReason),
        branchRequest:
          state.nativeCommandUiRequest?.action === "branches" &&
          state.nativeCommandUiRequest.sessionId === state.sessionId
            ? state.nativeCommandUiRequest.id
            : null,
      }),
      shallowEqual,
    );
  const [menuOpen, setMenuOpen] = useState(false);
  const [branchRequested, setBranchRequested] = useState(false);
  useLayoutEffect(() => {
    if (branchRequest === null) return;
    setBranchRequested(true);
    setMenuOpen(true);
    store.consumeNativeCommandUiRequest(branchRequest);
  }, [branchRequest]);
  const titleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [edit, setEdit] = useState<{ initial: string; name: string } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const editRef = useRef(edit);
  editRef.current = edit;
  const editing = edit !== null && !readOnly;
  const focusTitle = useRef(false);
  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (focusTitle.current) {
      focusTitle.current = false;
      titleRef.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  const closeEditor = () => {
    focusTitle.current = Boolean(
      inputRef.current?.form?.contains(document.activeElement),
    );
    setEdit(null);
  };
  const saveName = async () => {
    if (
      !edit ||
      !sessionId ||
      saveInFlight.current ||
      readOnly ||
      store.getState().sessionId !== sessionId
    )
      return;
    const name = edit.name.trim();
    if (!name || name === edit.initial.trim()) {
      closeEditor();
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      const saved = await store.sessionManagement.renameSession(
        sessionId,
        name,
      );
      if (
        saved &&
        editRef.current === edit &&
        store.getState().sessionId === sessionId
      )
        closeEditor();
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };
  const closeMenu = (restoreFocus = false) => {
    setMenuOpen(false);
    setBranchRequested(false);
    if (restoreFocus) titleRef.current?.focus({ preventScroll: true });
  };
  const { copied, copy } = useCopied({
    scope: cwd,
    onError: store.reportCopyError,
  });

  if (!sessionId) return null;

  return (
    <div className="topbar__ident">
      {editing ? (
        <form
          className="topbar__rename"
          onSubmit={(event) => {
            event.preventDefault();
            void saveName();
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              void saveName();
          }}
        >
          <input
            className="inline-rename-input"
            aria-label="Session name"
            ref={inputRef}
            value={edit.name}
            onChange={(event) => setEdit({ ...edit, name: event.target.value })}
            onKeyDown={(event) => {
              if (isComposingKeyboardEvent(event.nativeEvent)) {
                event.stopPropagation();
                if (event.key === "Enter") event.preventDefault();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeEditor();
              }
            }}
          />
          <button
            type="submit"
            className="icon-button"
            aria-label="Save session name"
            disabled={saving || !edit.name.trim()}
          >
            <Check size={14} aria-hidden />
          </button>
        </form>
      ) : (
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
      )}

      {menuOpen ? (
        <SessionActionsMenu
          anchorRef={titleRef}
          initialBranchSelection={branchRequested}
          sessionId={sessionId}
          onClose={closeMenu}
          onRename={(_, name) => setEdit({ initial: name, name })}
          onInspect={onInspect}
        />
      ) : null}
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
              {projectDisplay === "path" ? cwd : projectNameFromCwd(cwd)}
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
  settingsOpen,
  onToggleNavigation,
  onOpenCommandPalette,
  onInspectSession,
  onToggleSettings,
  onToggleResources,
}: {
  narrowViewport: boolean;
  mobileNavOpen: boolean;
  settingsOpen: boolean;
  onToggleNavigation: () => void;
  onOpenCommandPalette: () => void;
  onInspectSession: (kind: SessionInspection) => void;
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
    store.git.setSurfaceVisible("topbar-git", true);
    return () => store.git.setSurfaceVisible("topbar-git", false);
  }, [state.observesRepository]);
  return (
    <header className="topbar">
      {narrowViewport ? (
        <NavigationToggle
          className="icon-button"
          onClick={onToggleNavigation}
          aria-label="Toggle navigation"
          aria-expanded={mobileNavOpen}
          title="Toggle navigation (Ctrl+B)"
        >
          <PanelLeft size={15} aria-hidden />
        </NavigationToggle>
      ) : null}
      <SessionIdent key={state.sessionId} onInspect={onInspectSession} />
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
          title={narrowViewport ? "Actions" : "Command palette (Ctrl+K)"}
        >
          {narrowViewport ? (
            <Ellipsis size={17} aria-hidden />
          ) : (
            <Command size={15} aria-hidden />
          )}
        </button>
        <button
          type="button"
          className={`icon-button ${settingsOpen ? "icon-button--active" : ""}`}
          onClick={onToggleSettings}
          aria-label="Settings"
          title="Settings"
        >
          <SettingsIcon size={15} aria-hidden />
        </button>
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
