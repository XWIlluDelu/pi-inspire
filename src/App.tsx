import {
  AlertTriangle,
  Ban,
  Check,
  Clock,
  Command,
  Loader2,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Settings as SettingsIcon,
  X,
  XCircle,
} from "lucide-react";
import { Profiler, useCallback, useEffect, useState } from "react";
import {
  MAX_SESSION_DISPLAY_TITLE_CHARS,
  projectionConflictSeverity,
  type ProjectionConflict,
  type RunState,
  type ThemePreference,
} from "../shared/contracts";
import { ApiError, pairHost } from "./api";
import { recordBenchmarkCommit } from "./benchmark-profiler";
import { ActivityBar } from "./components/ActivityBar";
import { CommandPalette } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import { ExtensionUiDialog } from "./components/ExtensionUiDialog";
import { Nav } from "./components/Nav";
import { PaneResizeHandle } from "./components/PaneResizeHandle";
import { ResourcesPane } from "./components/ResourcesPane";
import { Settings } from "./components/Settings";
import { Transcript } from "./components/Transcript";
import { Welcome } from "./components/Welcome";
import { Wordmark } from "./components/Wordmark";
import { isAbortableRunState, messageText, store, type ChatMessage, useAppState } from "./store";
import { useCopied } from "./use-copied";

// Vite replaces MODE at build time. The production false branches are folded
// before Rollup, leaving the ordinary elements directly in the component tree.
const MAINTENANCE_BENCHMARK = import.meta.env.MODE === "maintenance-benchmark";

export function resolveTheme(pref: ThemePreference, systemDark: boolean): "light" | "dark" {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

export function composeDocumentTitle(windowTitle: string | null, sessionName: string, attentionCount: number): string {
  const base = windowTitle ?? (sessionName ? `${sessionName} · insπre` : "insπre");
  return attentionCount > 0 ? `● ${base}` : base;
}

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
    const firstPrompt = messages.find((message) => message.role === "user" && messageText(message).trim());
    if (firstPrompt) {
      return messageText(firstPrompt).replace(/\s+/g, " ").trim().slice(0, MAX_SESSION_DISPLAY_TITLE_CHARS);
    }
  }
  return "New session";
}

function StateChip({
  runState,
  conflict,
}: {
  runState: RunState;
  conflict: ProjectionConflict | null;
}) {
  // Keys force a remount across state changes so the entrance animation
  // replays; `chip--live` marks states still in progress (they breathe).
  switch (runState) {
    case "running":
      return (
        <span key="running" className="chip chip--accent chip--live">
          <Loader2 size={12} className="spin" aria-hidden /> <span className="chip__label">Running</span>
        </span>
      );
    case "retrying":
      return (
        <span key="retrying" className="chip chip--warning chip--live">
          <AlertTriangle size={12} aria-hidden /> <span className="chip__label">Retrying</span>
        </span>
      );
    case "compacting":
      return (
        <span key="compacting" className="chip chip--info chip--live">
          <RefreshCw size={12} className="spin-slow" aria-hidden /> <span className="chip__label">Compacting</span>
        </span>
      );
    case "queued":
      return (
        <span key="queued" className="chip chip--muted">
          <Clock size={12} aria-hidden /> <span className="chip__label">Queued</span>
        </span>
      );
    case "aborted":
      return (
        <span key="aborted" className="chip chip--muted">
          <Ban size={12} aria-hidden /> <span className="chip__label">Stopped</span>
        </span>
      );
    case "failed":
      return (
        <span key="failed" className="chip chip--error">
          <XCircle size={12} aria-hidden /> <span className="chip__label">Failed</span>
        </span>
      );
    case "conflict": {
      const attention = projectionConflictSeverity(conflict) === "attention";
      return (
        <span key="conflict" className={`chip chip--${attention ? "warning" : "error"}`}>
          <AlertTriangle size={12} aria-hidden />
          <span className="chip__label">{attention ? "Needs recovery" : "Conflict"}</span>
        </span>
      );
    }
    case "idle":
      return null;
    default: {
      const exhaustive: never = runState;
      return exhaustive;
    }
  }
}

function SessionIdent({ show }: { show: boolean }) {
  const state = useAppState();
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const { copied, copy } = useCopied();
  const editing = editingSessionId !== null && editingSessionId === state.sessionId;

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
            if (ok && editingSessionId === owner && store.getState().sessionId === owner) {
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
        <button type="submit" className="icon-button" aria-label="Save session name" disabled={!value.trim()}>
          <Check size={14} aria-hidden />
        </button>
      </form>
    );
  }

  // The rail already carries the product icon. The topbar belongs to the
  // visible session; the welcome surface needs no duplicate wordmark.
  if (!show || !state.sessionId) return null;

  const catalogTitle = state.sessions.find((session) => session.id === state.sessionId)?.title;
  const heading = sessionHeading(state.sessionName, catalogTitle, state.messages, !state.hasOlderMessages);

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
          <span className={`topbar__project-label ${copied ? "topbar__project-label--copied" : ""}`}>
            {state.prefs.projectDisplay === "path" ? state.cwd : state.project}
          </span>
          <Check
            size={11}
            className={`topbar__project-feedback ${copied ? "topbar__project-feedback--visible" : ""}`}
            aria-hidden
          />
        </button>
      ) : null}
    </div>
  );
}

function TokenGate() {
  const [value, setValue] = useState("");
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="token-gate">
      <div className="token-gate__card">
        <Wordmark large />
        <div>
          <h1 className="token-gate__title">Pair this browser</h1>
          <p className="token-gate__hint">
            The host is running, but this browser has not been paired yet. Open the URL printed by{" "}
            <code>./inspire</code>, or paste its access token once below. The pairing is remembered on this device.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const token = value.trim();
            if (!token || pairing) return;
            setPairing(true);
            setError(null);
            void pairHost(token)
              .then(() => store.init(null))
              .catch((reason: unknown) => {
                setError(reason instanceof ApiError && reason.status === 401
                  ? "That access token does not match this host."
                  : "The host became unavailable before pairing completed.");
              })
              .finally(() => setPairing(false));
          }}
        >
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Access token"
            aria-label="Access token"
            autoComplete="off"
          />
          <button type="submit" className="button button--primary" disabled={!value.trim() || pairing}>
            {pairing ? "Pairing…" : "Pair"}
          </button>
        </form>
        {error ? <p className="token-gate__error" role="alert">{error}</p> : null}
      </div>
    </div>
  );
}

function HostUnavailable({ problem }: { problem: NonNullable<ReturnType<typeof store.getState>["connectionProblem"]> }) {
  const host = typeof window === "undefined" ? "the configured address" : window.location.host;
  const hostError = problem.kind === "host-error";
  return (
    <div className="token-gate">
      <div className="token-gate__card">
        <Wordmark large />
        <div>
          <h1 className="token-gate__title">{hostError ? "Host needs attention" : "Host not reachable"}</h1>
          <p className="token-gate__hint">
            {hostError
              ? `The host answered at ${host}, but could not initialize: ${problem.message}`
              : `The installed app is ready, but no insπre host is reachable at ${host}.`}
          </p>
        </div>
        <div className="token-gate__instruction">
          <span>Start or restart it from the insπre project directory:</span>
          <code>./inspire</code>
        </div>
        <div className="token-gate__actions">
          <button type="button" className="button button--primary" onClick={() => store.retryConnection()}>
            Try again
          </button>
          <span><Loader2 size={12} className="spin" aria-hidden /> Reconnecting automatically</span>
        </div>
      </div>
    </div>
  );
}

function Notices() {
  const state = useAppState();
  if (state.notices.length === 0) return null;
  return (
    <div className="notices" aria-live="polite">
      {state.notices.map((notice) => (
        <div key={notice.id} className={`notice notice--${notice.kind}`} role="status">
          <span className="notice__text">{notice.text}</span>
          <button
            type="button"
            className="notice__dismiss"
            onClick={() => store.dismissNotice(notice.id)}
            aria-label="Dismiss notification"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (
    typeof window !== "undefined" && window.matchMedia(query).matches
  ));
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function App() {
  const state = useAppState();
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const narrowViewport = useMediaQuery("(max-width: 900px)");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const openSession = (id: string) => {
    setSettingsOpen(false);
    setMobileNavOpen(false);
    void store.openSession(id);
  };

  const newSession = () => {
    setSettingsOpen(false);
    setMobileNavOpen(false);
    void store.deselectSession().then((deselected) => {
      if (!deselected) return;
      store.setResourcesOpen(false);
    });
  };

  const toggleNavigation = useCallback(() => {
    if (narrowViewport) {
      if (!mobileNavOpen) store.setResourcesOpen(false);
      setMobileNavOpen(!mobileNavOpen);
    } else {
      setNavCollapsed((value) => !value);
    }
  }, [mobileNavOpen, narrowViewport]);

  const toggleResources = useCallback(() => {
    if (narrowViewport) setMobileNavOpen(false);
    store.setResourcesOpen(!store.getState().resourcesOpen);
  }, [narrowViewport]);

  useEffect(() => {
    if (!narrowViewport) setMobileNavOpen(false);
  }, [narrowViewport]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(state.prefs.theme, media.matches);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.prefs.theme]);

  useEffect(() => {
    // Attention composes with Pi's extension-set title instead of replacing
    // it; the marker clears only when its owning session is viewed/focused.
    document.title = composeDocumentTitle(state.windowTitle, state.sessionName, state.attentionSessionIds.length);
  }, [state.windowTitle, state.sessionName, state.attentionSessionIds.length]);

  useEffect(() => {
    const acknowledge = () => store.acknowledgeVisibleSession();
    window.addEventListener("focus", acknowledge);
    document.addEventListener("visibilitychange", acknowledge);
    acknowledge();
    return () => {
      window.removeEventListener("focus", acknowledge);
      document.removeEventListener("visibilitychange", acknowledge);
    };
  }, [state.sessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      } else if (mod && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleNavigation();
      } else if (mod && event.key === ".") {
        event.preventDefault();
        toggleResources();
      } else if (event.key === "Escape" && narrowViewport && mobileNavOpen) {
        event.preventDefault();
        setMobileNavOpen(false);
      } else if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !paletteOpen &&
        (state.extensionUiRequests.length === 0 || state.runState === "conflict") &&
        isAbortableRunState(state.runState)
      ) {
        void store.abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.runState, state.extensionUiRequests.length, paletteOpen, narrowViewport, mobileNavOpen, toggleNavigation, toggleResources]);

  if (state.needsToken) return <TokenGate />;
  if (!state.bootstrapped && state.connection === "offline" && state.connectionProblem) {
    return <HostUnavailable problem={state.connectionProblem} />;
  }

  const statuses = Object.entries(state.statuses);
  const navigationContent = narrowViewport && !mobileNavOpen ? null : (
    <Nav
      collapsed={narrowViewport ? false : navCollapsed}
      selectedSessionId={state.sessionId}
      onNewSession={newSession}
      onSelectSession={openSession}
    />
  );
  const transcriptContent = state.sessionId ? (
    <Transcript
      messages={state.messages}
      streaming={state.streaming}
      activeAssistantMessageKey={state.activeAssistantMessageKey}
      toolActivity={state.tools}
      sessionId={state.sessionId}
      viewId={state.transcriptViewId ?? ""}
      queue={state.queue}
      extensionDisplays={state.extensionDisplays}
      thinkingVisibility={state.prefs.thinkingVisibility}
      toolVisibility={state.prefs.toolVisibility}
      assistantRoundDisplay={state.prefs.assistantRoundDisplay}
      hasOlder={state.hasOlderMessages}
      loadingOlder={state.loadingOlderMessages}
      olderError={state.olderMessagesError}
    />
  ) : null;
  const composerContent = state.sessionId ? (
    <div className="composer-dock">
      <ActivityBar />
      <Composer />
    </div>
  ) : null;
  const resourcesContent = state.resourcesOpen ? <ResourcesPane /> : null;

  return (
    <div className={`app ${narrowViewport ? "app--narrow" : ""}`}>
      {narrowViewport && mobileNavOpen ? (
        <button
          type="button"
          className="pane-scrim pane-scrim--nav"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close navigation"
        />
      ) : null}
      {MAINTENANCE_BENCHMARK ? (
        <Profiler id="navigation" onRender={recordBenchmarkCommit}>{navigationContent}</Profiler>
      ) : navigationContent}
      {!narrowViewport && !navCollapsed ? (
        <PaneResizeHandle
          cssVar="--nav-w"
          storageKey="inspire.nav-width"
          paneSelector=".nav"
          edge="end"
          min={220}
          max={() => 460}
          label="Resize navigation"
          variant="nav"
        />
      ) : null}
      <main className="center">
        <header className="topbar">
          <button
            type="button"
            className="icon-button"
            onClick={toggleNavigation}
            aria-label="Toggle navigation"
            aria-expanded={narrowViewport ? mobileNavOpen : undefined}
            title="Toggle navigation (Ctrl+B)"
          >
            <PanelLeft size={15} aria-hidden />
          </button>
          <SessionIdent show={Boolean(state.sessionId)} />
          <div className="topbar__status" aria-live="polite">
            <StateChip runState={state.runState} conflict={state.projectionConflict} />
            {statuses.map(([key, text]) => (
              <span key={key} className="chip chip--muted topbar__extension-status" title={text}>
                <span className="chip__label">{text}</span>
              </span>
            ))}
            {state.connection !== "open" ? (
              <span className={`chip chip--warning ${state.connectionProblem?.kind === "host-unreachable" ? "" : "chip--live"}`}>
                {state.connectionProblem?.kind === "host-unreachable"
                  ? <AlertTriangle size={12} aria-hidden />
                  : <Loader2 size={12} className="spin" aria-hidden />}
                <span className="chip__label">
                  {state.connectionProblem?.kind === "host-unreachable"
                    ? "Host unavailable"
                    : state.connection === "reconnecting" ? "Reconnecting" : "Connecting"}
                </span>
              </span>
            ) : null}
          </div>
          <div className="topbar__actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              title="Command palette (Ctrl+K)"
            >
              <Command size={15} aria-hidden />
            </button>
            <button
              type="button"
              className={`icon-button ${settingsOpen ? "icon-button--active" : ""}`}
              onClick={() => setSettingsOpen((value) => !value)}
              aria-label="Settings"
              title="Settings"
            >
              <SettingsIcon size={15} aria-hidden />
            </button>
            <button
              type="button"
              className={`icon-button ${state.resourcesOpen ? "icon-button--active" : ""}`}
              onClick={toggleResources}
              aria-label="Toggle resources panel"
              title="Toggle resources panel (Ctrl+.)"
            >
              <PanelRight size={15} aria-hidden />
            </button>
          </div>
        </header>
        {state.error ? (
          <div className={`banner banner--${state.errorSeverity}`} role={state.errorSeverity === "warning" ? "status" : "alert"}>
            <span className="banner__message">
              {state.error}
              {state.projectionConflict?.incidentId ? (
                <code
                  className="banner__incident"
                  title="Diagnostic incident ID"
                  aria-label="Diagnostic incident"
                >
                  {state.projectionConflict.incidentId}
                </code>
              ) : null}
            </span>
            {state.projectionConflict ? (
              <button type="button" onClick={() => void store.abort()}>
                Recover
              </button>
            ) : (
              <button type="button" onClick={() => store.dismissError()}>
                Dismiss
              </button>
            )}
          </div>
        ) : null}
        {state.connection !== "open" && !state.error ? (
          <div className="banner banner--warning" role="status">
            <span>
              {state.connectionProblem?.kind === "host-unreachable"
                ? `The insπre host is not reachable at ${window.location.host}. Start or restart it with ./inspire; the last settled state stays visible.`
                : state.connectionProblem?.kind === "host-error"
                  ? `The host responded but could not initialize: ${state.connectionProblem.message}`
                  : "The live host connection was interrupted. The last settled state stays visible."}
            </span>
            <button type="button" onClick={() => store.retryConnection()}>Retry now</button>
          </div>
        ) : null}
        {settingsOpen ? <Settings onClose={() => setSettingsOpen(false)} /> : null}
        {state.sessionId ? (
          <>
            {MAINTENANCE_BENCHMARK ? (
              <Profiler id="transcript" onRender={recordBenchmarkCommit}>{transcriptContent}</Profiler>
            ) : transcriptContent}
            {MAINTENANCE_BENCHMARK ? (
              <Profiler id="composer" onRender={recordBenchmarkCommit}>{composerContent}</Profiler>
            ) : composerContent}
          </>
        ) : (
          <Welcome showRecent={narrowViewport ? !mobileNavOpen : navCollapsed} />
        )}
      </main>
      {state.resourcesOpen ? (
        <>
          {narrowViewport ? (
            <button
              type="button"
              className="pane-scrim pane-scrim--resources"
              onClick={() => store.setResourcesOpen(false)}
              aria-label="Dismiss resources panel"
            />
          ) : (
            <PaneResizeHandle
              cssVar="--ctx-w"
              storageKey="inspire.ctx-width"
              paneSelector=".ctx"
              edge="start"
              min={320}
              max={(viewport) => Math.min(920, viewport - 640)}
              label="Resize files panel"
              variant="ctx"
            />
          )}
          {MAINTENANCE_BENCHMARK ? (
            <Profiler id="resources" onRender={recordBenchmarkCommit}>{resourcesContent}</Profiler>
          ) : resourcesContent}
        </>
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onToggleNav={toggleNavigation}
          onToggleCtx={toggleResources}
          onNewSession={newSession}
          onOpenSession={openSession}
        />
      ) : null}
      <ExtensionUiDialog />
      <Notices />
    </div>
  );
}
