import { ArrowRight, FolderOpen, Plus } from "lucide-react";
import { useState } from "react";
import { store, useAppState } from "../store";
import { relativeTime } from "./Transcript";

export function Welcome() {
  const state = useAppState();
  const [directory, setDirectory] = useState("");
  const previous = state.sessions[0];
  // The continue-previous card already features that session; don't repeat it.
  const recent = state.sessions.filter((session) => session.id !== previous?.id).slice(0, 5);

  return (
    <div className="welcome">
      <span className="wordmark wordmark--large">insπre</span>
      <p className="welcome__tagline">A workbench for Pi</p>

      <div className="welcome__actions">
        {previous ? (
          <button
            type="button"
            className="button button--primary welcome__continue"
            onClick={() => void store.openSession(previous.id)}
          >
            <ArrowRight size={14} aria-hidden />
            <span className="welcome__continue-text">
              Continue previous
              <span className="welcome__continue-detail">
                {previous.title || "Untitled session"} · {previous.project} · {relativeTime(previous.modified)}
              </span>
            </span>
          </button>
        ) : null}

        {state.cwd ? (
          <button type="button" className="button" onClick={() => void store.newSession()}>
            <Plus size={14} aria-hidden /> New session in {state.project}
          </button>
        ) : null}

        <form
          className="welcome__project"
          onSubmit={(event) => {
            event.preventDefault();
            const dir = directory.trim();
            if (dir) void store.newSession(dir);
          }}
        >
          <input
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder="/path/to/project"
            aria-label="Project directory"
            spellCheck={false}
          />
          <button type="submit" className="button" disabled={!directory.trim()}>
            <FolderOpen size={14} aria-hidden />
            {state.cwd ? "Another project" : "Start in this project"}
          </button>
        </form>
      </div>

      {recent.length > 0 ? (
        <div className="welcome__recent">
          <h2 className="welcome__recent-title">Recent sessions</h2>
          <div role="list">
            {recent.map((session) => (
              <div role="listitem" key={session.id}>
                <button type="button" className="nav__row" onClick={() => void store.openSession(session.id)}>
                  <span className="nav__row-title">{session.title || "Untitled session"}</span>
                  <span className="nav__row-meta">
                    <span className="nav__row-project">{session.project}</span>
                    {relativeTime(session.modified)}
                  </span>
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
