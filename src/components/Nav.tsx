import { Monitor, Moon, Plus, RefreshCw, Search, Sun } from "lucide-react";
import type { LaunchPreference, ThemePreference, VisibilityPreference } from "../../shared/contracts";
import { store, useAppState } from "../store";
import { relativeTime } from "./Transcript";

const THEMES: Array<{ value: ThemePreference; label: string; icon: React.ReactNode }> = [
  { value: "light", label: "Light", icon: <Sun size={13} aria-hidden /> },
  { value: "dark", label: "Dark", icon: <Moon size={13} aria-hidden /> },
  { value: "system", label: "System", icon: <Monitor size={13} aria-hidden /> },
];

const VISIBILITIES: VisibilityPreference[] = ["hidden", "collapsed", "expanded"];

export function Nav({ collapsed }: { collapsed: boolean }) {
  const state = useAppState();

  if (collapsed) {
    return (
      <nav className="nav nav--rail" aria-label="Sessions">
        <div className="nav__brand nav__brand--rail" title="insπre">
          π
        </div>
        <button type="button" className="icon-button" onClick={() => void store.newSession()} title="New session" aria-label="New session">
          <Plus size={16} aria-hidden />
        </button>
      </nav>
    );
  }

  return (
    <nav className="nav" aria-label="Sessions">
      <div className="nav__brand">
        <span className="wordmark">insπre</span>
        {state.mock ? <span className="nav__mock">mock</span> : null}
      </div>
      <button type="button" className="button button--primary nav__new" onClick={() => void store.newSession()}>
        <Plus size={14} aria-hidden /> New session
      </button>
      <div className="nav__search-row">
        <label className="nav__search">
          <Search size={13} aria-hidden />
          <input
            type="search"
            placeholder="Search sessions"
            aria-label="Search sessions"
            value={state.sessionQuery}
            onChange={(event) => store.searchSessions(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="icon-button"
          onClick={() => void store.refreshSessions()}
          title="Refresh session list"
          aria-label="Refresh session list"
        >
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      <div className="nav__list" role="list">
        {state.sessions.map((session) => {
          const active = session.id === state.sessionId;
          return (
            <div role="listitem" key={session.id}>
              <button
                type="button"
                className={`nav__row ${active ? "nav__row--active" : ""}`}
                onClick={() => void store.openSession(session.id)}
              >
                <span className="nav__row-title">
                  {active && state.runState === "running" ? <span className="nav__row-dot" aria-label="running" /> : null}
                  {session.title || "Untitled session"}
                </span>
                <span className="nav__row-meta">
                  <span className="nav__row-project">{session.project}</span>
                  {relativeTime(session.modified)}
                </span>
              </button>
            </div>
          );
        })}
        {state.sessions.length === 0 ? <div className="nav__empty">No sessions found</div> : null}
      </div>
      <div className="nav__footer">
        <div className="nav__field">
          <span className="nav__field-label">Theme</span>
          <div className="segmented" role="group" aria-label="Theme">
            {THEMES.map((theme) => (
              <button
                type="button"
                key={theme.value}
                className={`segmented__item ${state.prefs.theme === theme.value ? "segmented__item--active" : ""}`}
                onClick={() => store.setTheme(theme.value)}
                title={theme.label}
                aria-pressed={state.prefs.theme === theme.value}
              >
                {theme.icon}
                <span>{theme.label}</span>
              </button>
            ))}
          </div>
        </div>
        <label className="nav__field">
          <span className="nav__field-label">Thinking cards</span>
          <select
            value={state.prefs.thinkingVisibility}
            onChange={(event) => store.setThinkingVisibility(event.target.value as VisibilityPreference)}
          >
            {VISIBILITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="nav__field">
          <span className="nav__field-label">Tool cards</span>
          <select
            value={state.prefs.toolVisibility}
            onChange={(event) => store.setToolVisibility(event.target.value as VisibilityPreference)}
          >
            {VISIBILITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="nav__field">
          <span className="nav__field-label">Reading font</span>
          <select
            value={state.prefs.readingSerif ? "serif" : "sans"}
            onChange={(event) => store.setReadingSerif(event.target.value === "serif")}
          >
            <option value="sans">sans</option>
            <option value="serif">serif</option>
          </select>
        </label>
        <label className="nav__field">
          <span className="nav__field-label">On launch</span>
          <select
            value={state.prefs.launch}
            onChange={(event) => store.setLaunch(event.target.value as LaunchPreference)}
          >
            <option value="welcome">welcome</option>
            <option value="continue">continue</option>
          </select>
        </label>
      </div>
    </nav>
  );
}
