import { ChevronDown, ChevronRight, Loader2, Send } from "lucide-react";
import { useState } from "react";
import { store, useAppState } from "../store";
import { relativeTime } from "./Transcript";
import { Wordmark } from "./Wordmark";

/**
 * Landing surface: one inline composer starts a session with its first
 * message; recent sessions sit below in a collapsible list. The project
 * directory is part of the composer's meta row; leaving it empty starts in
 * the current project.
 */
export function Welcome() {
  const state = useAppState();
  const [draft, setDraft] = useState("");
  const [directory, setDirectory] = useState("");
  const [starting, setStarting] = useState(false);
  const [recentOpen, setRecentOpen] = useState(true);
  const recent = state.sessions.slice(0, 6);

  // A typed directory wins over the current project; empty means current.
  const canStart = Boolean(draft.trim() && (directory.trim() || state.cwd) && !starting);

  const start = async () => {
    if (!canStart) return;
    const message = draft;
    const target = directory.trim();
    setStarting(true);
    try {
      // newSession resolves once the runtime is ready to accept a prompt. A
      // failed creation keeps the previous session selected (the store maps
      // the error into a banner), so the draft only fires into a session
      // this submission actually created.
      const before = store.getState().sessionId;
      await store.newSession(target || undefined);
      const opened = store.getState().sessionId;
      if (opened && opened !== before) {
        const sent = await store.sendPrompt(message);
        if (sent) setDraft("");
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome__hero">
        <Wordmark large />
        <p className="welcome__tagline">A workbench for Pi</p>
      </div>

      <form
        className="composer welcome__composer"
        aria-label="Start a session"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <textarea
          className="composer__input"
          rows={3}
          value={draft}
          placeholder="What do you want to work on?"
          aria-label="First message"
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void start();
            }
          }}
        />
        <div className="composer__meta">
          <input
            className="welcome__dir"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder={state.cwd ?? "/path/to/project"}
            aria-label="Project directory"
            spellCheck={false}
          />
          <span className="composer__spacer" />
          <button
            type="submit"
            className="composer__send"
            disabled={!canStart}
            aria-label="Start session"
            title="Start session"
          >
            {starting ? <Loader2 size={14} className="spin" aria-hidden /> : <Send size={14} aria-hidden />}
          </button>
        </div>
      </form>

      {recent.length > 0 ? (
        <div className="welcome__recent">
          <h2 className="welcome__recent-title">
            <button
              type="button"
              className="welcome__recent-toggle"
              aria-expanded={recentOpen}
              onClick={() => setRecentOpen((value) => !value)}
            >
              {recentOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
              Recent sessions
            </button>
          </h2>
          {recentOpen ? (
            <div role="list">
              {recent.map((session) => (
                <div role="listitem" key={session.id}>
                  <button type="button" className="welcome__row" onClick={() => void store.openSession(session.id)}>
                    <span className="welcome__row-title">{session.title || "Untitled session"}</span>
                    <span className="welcome__row-project">{session.project}</span>
                    <span className="welcome__row-time">{relativeTime(session.modified)}</span>
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
