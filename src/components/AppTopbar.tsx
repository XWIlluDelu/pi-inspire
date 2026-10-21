import {
  AlertTriangle,
  Check,
  Command,
  GitBranch,
  PanelLeft,
  PanelRight,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  MAX_SESSION_DISPLAY_TITLE_CHARS,
  type ProjectionConflict,
  projectionConflictSeverity,
  projectNameFromCwd,
  type RunState,
} from "../../shared/contracts";
import { branchActionsBlocked } from "../controllers/branch-controller";
import { type ChatMessage, userMessageDisplayText } from "../events";
import { gitChangeCount, gitHeadLabel } from "../git-presentation";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { shallowEqual, store, useAppState } from "../store";
import { useCopied } from "../use-copied";
import { ExtensionStatus } from "./ExtensionDisplays";
import { PiLoader } from "./PiLoader";
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
    const firstPrompt = messages.find(
      (message) =>
        message.role === "user" && userMessageDisplayText(message).trim(),
    );
    if (firstPrompt) {
      return userMessageDisplayText(firstPrompt)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_SESSION_DISPLAY_TITLE_CHARS);
    }
  }
  return "New session";
}

function StatusChip({
  children,
  className,
  label,
  title = label,
  role,
}: {
  children?: React.ReactNode;
  className: string;
  label: string;
  title?: string;
  role?: "status";
}) {
  return (
    <span className={className} title={title} role={role}>
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
  const { gitStatus, gitStatusError } = useAppState(
    (state) => ({
      gitStatus: state.gitStatus,
      gitStatusError: state.gitStatusError,
    }),
    shallowEqual,
  );
  const branch = gitHeadLabel(gitStatus);
  const changes = gitChangeCount(gitStatus);
  if (!branch || changes === null) return null;

  const conflictCount =
    gitStatus?.kind === "repository" ? gitStatus.groups.conflicted.length : 0;
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
      className={tone ? `topbar__git ${tone}` : "topbar__git"}
      onClick={() => {
        store.setResourcesOpen(true);
        store.setContextMode("changes");
      }}
      aria-label={`Open Git changes: ${branch}, ${statusLabel}${gitStatusError ? ", status may be stale" : ""}`}
      title={`${branch} · ${statusLabel} — open Changes.${staleLabel}`}
    >
      <GitBranch size={13} className="topbar__git-icon" aria-hidden />
      <span className="topbar__git-branch">{branch}</span>
      {changes > 0 ? (
        <span className="topbar__git-count">
          {changes}
          <span className="topbar__git-count-word">
            {changes === 1 ? " change" : " changes"}
          </span>
        </span>
      ) : null}
    </button>
  );
}

const SessionIdent = memo(function SessionIdent({
  show,
  onExport,
}: {
  show: boolean;
  onExport: () => void;
}) {
  const {
    sessionId,
    sessionName,
    heading,
    cwd,
    project,
    projectDisplay,
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
        state.messages,
        !state.hasOlderMessages,
      ),
      cwd: state.cwd,
      project: state.cwd ? projectNameFromCwd(state.cwd) : null,
      projectDisplay: state.prefs.projectDisplay,
      cloneDisabled: branchActionsBlocked(state),
      readOnlyReason: state.readOnlyReason,
    };
  }, shallowEqual);
  const [editing, setEditing] = useState(false);
  const [restoredTitleFocus, setRestoredTitleFocus] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [value, setValue] = useState("");
  const [renameWidth, setRenameWidth] = useState(240);
  const titleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreTitleFocus = useRef(false);
  const editIncarnationRef = useRef(0);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeEditor = useCallback(() => {
    restoreTitleFocus.current = Boolean(
      inputRef.current?.form?.contains(document.activeElement),
    );
    setRestoredTitleFocus(restoreTitleFocus.current);
    editIncarnationRef.current += 1;
    setEditing(false);
  }, []);
  const { copied, copy } = useCopied({
    scope: cwd,
    onError: store.reportCopyError,
  });

  useLayoutEffect(() => {
    if (editing) inputRef.current?.select();
    else if (restoreTitleFocus.current) {
      restoreTitleFocus.current = false;
      titleRef.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  const startRename = () => {
    const width = (titleRef.current?.getBoundingClientRect().width ?? 192) + 48;
    setRenameWidth(Math.max(240, Math.min(560, width)));
    closeMenu();
    setValue(sessionName);
    editIncarnationRef.current += 1;
    setEditing(true);
  };

  const saveRename = () => {
    const name = value.trim();
    const owner = sessionId;
    if (
      !name ||
      name === sessionName.trim() ||
      !owner ||
      store.getState().sessionId !== owner
    ) {
      closeEditor();
      return;
    }
    const incarnation = editIncarnationRef.current;
    void store.renameSession(owner, name).then((ok) => {
      if (
        ok &&
        editIncarnationRef.current === incarnation &&
        store.getState().sessionId === owner
      ) {
        closeEditor();
      }
    });
  };

  if (!show || !sessionId) return null;

  if (editing && !readOnlyReason) {
    return (
      <form
        className="topbar__rename"
        onSubmit={(event) => {
          event.preventDefault();
          saveRename();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) saveRename();
        }}
      >
        <input
          ref={inputRef}
          style={{ width: renameWidth }}
          value={value}
          onChange={(event) => {
            editIncarnationRef.current += 1;
            setValue(event.target.value);
          }}
          aria-label="Session name"
          autoFocus
          onKeyDown={(event) => {
            if (isComposingKeyboardEvent(event.nativeEvent)) return;
            if (event.key === "Escape") {
              event.preventDefault(); // leaving rename must not trigger the global Escape abort
              closeEditor();
            }
          }}
        />
        <button
          type="submit"
          className="icon-button"
          aria-label="Save session name"
          disabled={!value.trim()}
        >
          <Check size={14} aria-hidden />
        </button>
      </form>
    );
  }

  return (
    <div className="topbar__ident">
      <div className="topbar__heading">
        <h1 className="topbar__title" aria-label={heading}>
          <button
            ref={titleRef}
            type="button"
            className="topbar__title-button"
            data-restored-focus={restoredTitleFocus || undefined}
            onBlur={() => setRestoredTitleFocus(false)}
            aria-label={`Session actions: ${heading}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={heading}
            onClick={() => setMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              setRestoredTitleFocus(false);
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
            cloneDisabled={cloneDisabled}
            renameDisabled={Boolean(readOnlyReason)}
            onClose={closeMenu}
            onRename={startRename}
            onClone={() => {
              const trigger = document.activeElement;
              void store.cloneCurrentBranch().then((cloned) => {
                if (!cloned) return;
                const returnFocus =
                  document.activeElement === trigger ||
                  document.activeElement === document.body;
                closeMenu();
                if (returnFocus)
                  titleRef.current?.focus({ preventScroll: true });
              });
            }}
            onExport={() => {
              closeMenu();
              titleRef.current?.focus({ preventScroll: true });
              onExport();
            }}
          />
        ) : null}
      </div>
      <div className="topbar__workspace-meta">
        {cwd ? (
          <button
            type="button"
            className="topbar__project"
            onClick={() => void copy(cwd)}
            title={copied ? "Copied" : `Copy path — ${cwd}`}
            aria-label="Copy project path"
          >
            {/* The normal label remains the sole width authority. Copy feedback
                overlays it, so a wider hidden message cannot extend hover chrome. */}
            <span
              className={`topbar__project-label ${copied ? "topbar__project-label--copied" : ""}`}
            >
              {projectDisplay === "path" ? cwd : project}
            </span>
            <Check
              size={11}
              className={`topbar__project-feedback ${copied ? "topbar__project-feedback--visible" : ""}`}
              aria-hidden
            />
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
  onExportSession,
  onToggleSettings,
  onToggleResources,
}: {
  narrowViewport: boolean;
  mobileNavOpen: boolean;
  settingsOpen: boolean;
  onToggleNavigation: () => void;
  onOpenCommandPalette: () => void;
  onExportSession: () => void;
  onToggleSettings: () => void;
  onToggleResources: () => void;
}) {
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      runState: source.runState,
      projectionConflict: source.projectionConflict,
      connection: source.connection,
      connectionProblem: source.connectionProblem,
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
        <button
          type="button"
          className="icon-button"
          onClick={onToggleNavigation}
          aria-label="Toggle navigation"
          aria-expanded={mobileNavOpen}
          title="Toggle navigation (Ctrl+B)"
        >
          <PanelLeft size={15} aria-hidden />
        </button>
      ) : null}
      <SessionIdent
        key={state.sessionId}
        show={Boolean(state.sessionId)}
        onExport={onExportSession}
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
