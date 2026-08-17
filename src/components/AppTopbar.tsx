import {
  AlertTriangle,
  Check,
  Command,
  GitBranch,
  Loader2,
  PanelLeft,
  PanelRight,
  Settings as SettingsIcon,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  MAX_SESSION_DISPLAY_TITLE_CHARS,
  projectionConflictSeverity,
  type ProjectionConflict,
  type RunState,
} from "../../shared/contracts";
import { gitChangeCount, gitHeadLabel } from "../git-presentation";
import { messageText, store, type ChatMessage, useAppState } from "../store";
import { useCopied } from "../use-copied";

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
      (message) => message.role === "user" && messageText(message).trim(),
    );
    if (firstPrompt) {
      return messageText(firstPrompt)
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
}: {
  children?: React.ReactNode;
  className: string;
  label: string;
  title?: string;
}) {
  return (
    <span className={className} title={title}>
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
  if (runState === "failed") {
    return (
      <StatusChip key="failed" className="chip chip--error" label="Failed">
        <XCircle size={12} aria-hidden />
      </StatusChip>
    );
  }
  return null;
}

function GitSummary({ sessionId }: { sessionId: string }) {
  const state = useAppState();
  const observesRepository =
    state.gitStatus === null || state.gitStatus.kind === "repository";
  useEffect(() => {
    // The compact topbar indicator is a first-class Git surface, so its branch
    // and dirty count remain current even while the detailed Changes pane is closed.
    // Once Git has authoritatively said this workspace is not a repository, do
    // not leave a background poll running for an indicator that cannot render.
    if (!observesRepository) return;
    store.setGitSurfaceVisible("topbar-git", true);
    return () => store.setGitSurfaceVisible("topbar-git", false);
  }, [observesRepository, sessionId]);

  const branch = gitHeadLabel(state.gitStatus);
  const changes = gitChangeCount(state.gitStatus);
  if (!branch || changes === null) return null;

  const conflictCount =
    state.gitStatus?.kind === "repository"
      ? state.gitStatus.groups.conflicted.length
      : 0;
  const changeLabel = changes === 1 ? "1 change" : `${changes} changes`;
  const conflictLabel =
    conflictCount === 1 ? "1 conflict" : `${conflictCount} conflicts`;
  const statusLabel =
    changes > 0
      ? [changeLabel, ...(conflictCount > 0 ? [conflictLabel] : [])].join(", ")
      : "Working tree clean";
  const tone = state.gitStatusError
    ? "topbar__git--stale"
    : conflictCount > 0
      ? "topbar__git--conflict"
      : "";
  const staleLabel = state.gitStatusError ? " Status may be stale." : "";
  return (
    <button
      type="button"
      className={tone ? `topbar__git ${tone}` : "topbar__git"}
      onClick={() => {
        store.setResourcesOpen(true);
        store.setContextMode("changes");
      }}
      aria-label={`Open Git changes: ${branch}, ${statusLabel}${state.gitStatusError ? ", status may be stale" : ""}`}
      title={`${branch} · ${statusLabel} — open Changes.${staleLabel}`}
    >
      <GitBranch size={13} className="topbar__git-icon" aria-hidden />
      <span className="topbar__git-branch">{branch}</span>
      {changes > 0 ? (
        <span className="topbar__git-count">{changeLabel}</span>
      ) : null}
    </button>
  );
}

function SessionIdent({ show }: { show: boolean }) {
  const state = useAppState();
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const { copied, copy } = useCopied();
  const editing =
    editingSessionId !== null && editingSessionId === state.sessionId;

  useEffect(() => {
    // The editor belongs to the session whose heading opened it. Switching
    // sessions cancels that local editor before a submit can retarget it.
    if (editingSessionId !== null && editingSessionId !== state.sessionId) {
      setEditingSessionId(null);
      setValue("");
    }
  }, [editingSessionId, state.sessionId]);

  if (editing) {
    return (
      <form
        className="topbar__rename"
        onSubmit={(event) => {
          event.preventDefault();
          const owner = editingSessionId;
          if (!owner || store.getState().sessionId !== owner) {
            setEditingSessionId(null);
            return;
          }
          void store.renameSession(owner, value).then((ok) => {
            if (
              ok &&
              editingSessionId === owner &&
              store.getState().sessionId === owner
            ) {
              setEditingSessionId(null);
            }
          });
        }}
      >
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label="Session name"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault(); // leaving rename must not trigger the global Escape abort
              setEditingSessionId(null);
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

  // The rail already carries the product icon. The topbar belongs to the
  // visible session; the welcome surface needs no duplicate wordmark.
  if (!show || !state.sessionId) return null;

  const catalogTitle = state.sessions.find(
    (session) => session.id === state.sessionId,
  )?.title;
  const heading = sessionHeading(
    state.sessionName,
    catalogTitle,
    state.messages,
    !state.hasOlderMessages,
  );

  // The heading itself is the rename affordance: an absent Pi name is
  // presented as the first prompt without turning that prompt into a name.
  // The project location sits beside it and copies the absolute path.
  return (
    <div className="topbar__ident">
      <h1 className="topbar__title">
        <button
          type="button"
          className="topbar__title-button"
          aria-label="Rename session"
          title={`${heading} — click to rename`}
          onClick={() => {
            // The first-prompt heading is presentation only; rename starts
            // empty unless Pi already owns an explicit session name.
            setValue(state.sessionName);
            setEditingSessionId(state.sessionId);
          }}
        >
          {heading}
        </button>
      </h1>
      <div className="topbar__workspace-meta">
        {state.cwd ? (
          <button
            type="button"
            className="topbar__project"
            onClick={() => void copy(state.cwd ?? "")}
            title={copied ? "Copied" : `Copy path — ${state.cwd}`}
            aria-label="Copy project path"
          >
            {/* The normal label remains the sole width authority. Copy feedback
                overlays it, so a wider hidden message cannot extend hover chrome. */}
            <span
              className={`topbar__project-label ${copied ? "topbar__project-label--copied" : ""}`}
            >
              {state.prefs.projectDisplay === "path"
                ? state.cwd
                : state.project}
            </span>
            <Check
              size={11}
              className={`topbar__project-feedback ${copied ? "topbar__project-feedback--visible" : ""}`}
              aria-hidden
            />
          </button>
        ) : null}
        <GitSummary sessionId={state.sessionId} />
      </div>
    </div>
  );
}

export function AppTopbar({
  narrowViewport,
  mobileNavOpen,
  settingsOpen,
  onToggleNavigation,
  onOpenCommandPalette,
  onToggleSettings,
  onToggleResources,
}: {
  narrowViewport: boolean;
  mobileNavOpen: boolean;
  settingsOpen: boolean;
  onToggleNavigation: () => void;
  onOpenCommandPalette: () => void;
  onToggleSettings: () => void;
  onToggleResources: () => void;
}) {
  const state = useAppState();
  const statuses = Object.entries(state.statuses);
  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button"
        onClick={onToggleNavigation}
        aria-label="Toggle navigation"
        aria-expanded={narrowViewport ? mobileNavOpen : undefined}
        title="Toggle navigation (Ctrl+B)"
      >
        <PanelLeft size={15} aria-hidden />
      </button>
      <SessionIdent show={Boolean(state.sessionId)} />
      <div className="topbar__status" aria-live="polite">
        <StateChip
          runState={state.runState}
          conflict={state.projectionConflict}
        />
        {statuses.map(([key, text]) => (
          <span key={key} className="topbar__extension-status" title={text}>
            {text}
          </span>
        ))}
        {state.connection !== "open"
          ? (() => {
              const label =
                state.connectionProblem?.kind === "host-unreachable"
                  ? "Host unavailable"
                  : state.connection === "reconnecting"
                    ? "Reconnecting"
                    : "Connecting";
              return (
                <StatusChip
                  className={`chip chip--warning ${state.connectionProblem?.kind === "host-unreachable" ? "" : "chip--live"}`}
                  label={label}
                >
                  {state.connectionProblem?.kind === "host-unreachable" ? (
                    <AlertTriangle size={12} aria-hidden />
                  ) : (
                    <Loader2 size={12} className="spin" aria-hidden />
                  )}
                </StatusChip>
              );
            })()
          : null}
      </div>
      <div className="topbar__actions">
        <button
          type="button"
          className="icon-button"
          onClick={onOpenCommandPalette}
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
          aria-expanded={state.resourcesOpen}
          title="Toggle resources panel (Ctrl+.)"
        >
          <PanelRight size={15} aria-hidden />
        </button>
      </div>
    </header>
  );
}
