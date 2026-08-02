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
import { Profiler, useEffect, useState } from "react";
import { MAX_SESSION_DISPLAY_TITLE_CHARS, type RunState, type ThemePreference } from "../shared/contracts";
import { setToken } from "./api";
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

function StateChip({ runState }: { runState: RunState }) {
  // Keys force a remount across state changes so the entrance animation
  // replays; `chip--live` marks states still in progress (they breathe).
  switch (runState) {
    case "running":
      return (
        <span key="running" className="chip chip--accent chip--live">
          <Loader2 size={12} className="spin" aria-hidden /> Running
        </span>
      );
    case "retrying":
      return (
        <span key="retrying" className="chip chip--warning chip--live">
          <AlertTriangle size={12} aria-hidden /> Retrying
        </span>
      );
    case "compacting":
      return (
        <span key="compacting" className="chip chip--info chip--live">
          <RefreshCw size={12} className="spin-slow" aria-hidden /> Compacting
        </span>
      );
    case "queued":
      return (
        <span key="queued" className="chip chip--muted">
          <Clock size={12} aria-hidden /> Queued
        </span>
      );
    case "aborted":
      return (
        <span key="aborted" className="chip chip--error">
          <Ban size={12} aria-hidden /> Aborted
        </span>
      );
    case "failed":
      return (
        <span key="failed" className="chip chip--error">
          <XCircle size={12} aria-hidden /> Failed
        </span>
      );
    case "conflict":
      return (
        <span key="conflict" className="chip chip--error">
          <AlertTriangle size={12} aria-hidden /> Conflict
        </span>
      );
    case "idle":
      return null;
    default: {
      const exhaustive: never = runState;
      return exhaustive;
    }
  }
}

function SessionIdent({ show, navCollapsed }: { show: boolean; navCollapsed: boolean }) {
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

  // Without a session the nav brand already identifies the product; the
  // serif wordmark steps in here only while the nav is a rail.
  if (!show || !state.sessionId) {
    return navCollapsed ? (
      <h1 className="topbar__title">
        <Wordmark />
      </h1>
    ) : null;
  }

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
          {/* Both layers always occupy the same grid cell, so toggling the
              copied state never shifts the layout. */}
          <span className={`topbar__project-layer ${copied ? "topbar__project-layer--hidden" : ""}`}>
            {state.prefs.projectDisplay === "path" ? state.cwd : state.project}
          </span>
          <span
            className={`topbar__project-layer ${copied ? "" : "topbar__project-layer--hidden"}`}
            aria-hidden={!copied}
          >
            <Check size={11} aria-hidden /> Copied
          </span>
        </button>
      ) : null}
    </div>
  );
}

function TokenGate() {
  const [value, setValue] = useState("");
  return (
    <div className="token-gate">
      <div className="token-gate__card">
        <Wordmark large />
        <p className="token-gate__hint">
          This insπre host requires its access token. Open the URL printed by the host (it contains{" "}
          <code>?token=…</code>), or paste the token below.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const token = value.trim();
            if (!token) return;
            setToken(token);
            void store.init(token);
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
          <button type="submit" className="button button--primary" disabled={!value.trim()}>
            Connect
          </button>
        </form>
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

export function App() {
  const state = useAppState();
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // "New session" opens the start surface (message + project directory)
  // instead of immediately creating a session in the current project.
  const [draftingNew, setDraftingNew] = useState(false);

  const openSession = (id: string) => {
    setSettingsOpen(false);
    setDraftingNew(false);
    void store.openSession(id);
  };

  const newSession = () => {
    setSettingsOpen(false);
    setDraftingNew(true);
  };

  const activeSessionId = state.sessionId;
  useEffect(() => {
    // A session opened from the start surface (or anywhere else) ends the draft.
    if (activeSessionId) setDraftingNew(false);
  }, [activeSessionId]);

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
        setNavCollapsed((value) => !value);
      } else if (mod && event.key === ".") {
        event.preventDefault();
        store.setResourcesOpen(!store.getState().resourcesOpen);
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
  }, [state.runState, state.extensionUiRequests.length, paletteOpen]);

  if (state.needsToken) return <TokenGate />;

  const statuses = Object.entries(state.statuses);
  const navigationContent = <Nav collapsed={navCollapsed} onNewSession={newSession} onSelectSession={openSession} />;
  const transcriptContent = state.sessionId && !draftingNew ? (
    <Transcript
      messages={state.messages}
      streaming={state.streaming}
      sessionId={state.sessionId}
      queue={state.queue}
      extensionDisplays={state.extensionDisplays}
      thinkingVisibility={state.prefs.thinkingVisibility}
      toolVisibility={state.prefs.toolVisibility}
      hasOlder={state.hasOlderMessages}
      loadingOlder={state.loadingOlderMessages}
      olderError={state.olderMessagesError}
    />
  ) : null;
  const composerContent = state.sessionId && !draftingNew ? (
    <div className="composer-dock">
      <ActivityBar />
      <Composer />
    </div>
  ) : null;
  const resourcesContent = state.resourcesOpen ? <ResourcesPane /> : null;

  return (
    <div className="app">
      {MAINTENANCE_BENCHMARK ? (
        <Profiler id="navigation" onRender={recordBenchmarkCommit}>{navigationContent}</Profiler>
      ) : navigationContent}
      {!navCollapsed ? (
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
            onClick={() => setNavCollapsed((value) => !value)}
            aria-label="Toggle navigation"
            title="Toggle navigation (Ctrl+B)"
          >
            <PanelLeft size={15} aria-hidden />
          </button>
          <SessionIdent show={!draftingNew} navCollapsed={navCollapsed} />
          <StateChip runState={state.runState} />
          {statuses.map(([key, text]) => (
            <span key={key} className="chip chip--muted">
              {text}
            </span>
          ))}
          <span className="topbar__spacer" />
          {state.connection !== "open" ? (
            <span className="chip chip--warning chip--live">
              <Loader2 size={12} className="spin" aria-hidden />
              {state.connection === "reconnecting" ? "Reconnecting" : "Connecting"}
            </span>
          ) : null}
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
            onClick={() => store.setResourcesOpen(!state.resourcesOpen)}
            aria-label="Toggle resources panel"
            title="Toggle resources panel (Ctrl+.)"
          >
            <PanelRight size={15} aria-hidden />
          </button>
        </header>
        {state.error ? (
          <div className="banner banner--error" role="alert">
            <span>{state.error}</span>
            <button type="button" onClick={() => store.dismissError()}>
              Dismiss
            </button>
          </div>
        ) : null}
        {state.connection !== "open" && !state.error ? (
          <div className="banner banner--warning" role="status">
            Connection to the insπre host interrupted — retrying automatically. The last settled state stays visible.
          </div>
        ) : null}
        {settingsOpen ? <Settings onClose={() => setSettingsOpen(false)} /> : null}
        {state.sessionId && !draftingNew ? (
          <>
            {MAINTENANCE_BENCHMARK ? (
              <Profiler id="transcript" onRender={recordBenchmarkCommit}>{transcriptContent}</Profiler>
            ) : transcriptContent}
            {MAINTENANCE_BENCHMARK ? (
              <Profiler id="composer" onRender={recordBenchmarkCommit}>{composerContent}</Profiler>
            ) : composerContent}
          </>
        ) : (
          <Welcome />
        )}
      </main>
      {state.resourcesOpen ? (
        <>
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
          {MAINTENANCE_BENCHMARK ? (
            <Profiler id="resources" onRender={recordBenchmarkCommit}>{resourcesContent}</Profiler>
          ) : resourcesContent}
        </>
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onToggleNav={() => setNavCollapsed((value) => !value)}
          onToggleCtx={() => store.setResourcesOpen(!store.getState().resourcesOpen)}
          onNewSession={newSession}
          onOpenSession={openSession}
        />
      ) : null}
      <ExtensionUiDialog />
      <Notices />
    </div>
  );
}
