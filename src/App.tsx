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
import { useEffect, useState } from "react";
import type { RunState, ThemePreference } from "../shared/contracts";
import { setToken } from "./api";
import { ActivityBar } from "./components/ActivityBar";
import { CommandPalette } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import { ExtensionUiDialog } from "./components/ExtensionUiDialog";
import { Nav } from "./components/Nav";
import { ResourcesPane } from "./components/ResourcesPane";
import { Settings } from "./components/Settings";
import { Transcript } from "./components/Transcript";
import { Welcome } from "./components/Welcome";
import { Wordmark } from "./components/Wordmark";
import { isBusyRunState, store, useAppState } from "./store";
import { useCopied } from "./use-copied";

export function resolveTheme(pref: ThemePreference, systemDark: boolean): "light" | "dark" {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

function StateChip({ runState }: { runState: RunState }) {
  switch (runState) {
    case "running":
      return (
        <span className="chip chip--accent">
          <Loader2 size={12} className="spin" aria-hidden /> Running
        </span>
      );
    case "retrying":
      return (
        <span className="chip chip--warning">
          <AlertTriangle size={12} aria-hidden /> Retrying
        </span>
      );
    case "compacting":
      return (
        <span className="chip chip--info">
          <RefreshCw size={12} aria-hidden /> Compacting
        </span>
      );
    case "queued":
      return (
        <span className="chip chip--muted">
          <Clock size={12} aria-hidden /> Queued
        </span>
      );
    case "aborted":
      return (
        <span className="chip chip--error">
          <Ban size={12} aria-hidden /> Aborted
        </span>
      );
    case "failed":
      return (
        <span className="chip chip--error">
          <XCircle size={12} aria-hidden /> Failed
        </span>
      );
    default:
      return null;
  }
}

function SessionIdent({ show, navCollapsed }: { show: boolean; navCollapsed: boolean }) {
  const state = useAppState();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const { copied, copy } = useCopied();

  if (editing) {
    return (
      <form
        className="topbar__rename"
        onSubmit={(event) => {
          event.preventDefault();
          void store.renameSession(value).then((ok) => {
            if (ok) setEditing(false);
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
              setEditing(false);
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

  // The title itself is the rename affordance: click to edit in place. The
  // project location sits beside it — folder name or full path per the
  // preference — and clicking it copies the absolute path.
  return (
    <div className="topbar__ident">
      <h1 className="topbar__title">
        <button
          type="button"
          className="topbar__title-button"
          aria-label="Rename session"
          title="Rename session"
          onClick={() => {
            setValue(state.sessionName);
            setEditing(true);
          }}
        >
          {state.sessionName || "Untitled session"}
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
    // Pi-driven titles win; otherwise the session name identifies the tab.
    document.title = state.windowTitle ?? (state.sessionName ? `${state.sessionName} · insπre` : "insπre");
  }, [state.windowTitle, state.sessionName]);

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
        !state.extensionUi &&
        isBusyRunState(state.runState)
      ) {
        void store.abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.runState, state.extensionUi, paletteOpen]);

  if (state.needsToken) return <TokenGate />;

  const statuses = Object.entries(state.statuses);

  return (
    <div className="app">
      <Nav collapsed={navCollapsed} onNewSession={newSession} onSelectSession={openSession} />
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
            <span className="chip chip--warning">
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
            <Transcript
              messages={state.messages}
              streaming={state.streaming}
              thinkingVisibility={state.prefs.thinkingVisibility}
              toolVisibility={state.prefs.toolVisibility}
            />
            <div className="composer-dock">
              <ActivityBar />
              <Composer />
            </div>
          </>
        ) : (
          <Welcome />
        )}
      </main>
      {state.resourcesOpen ? <ResourcesPane /> : null}
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
