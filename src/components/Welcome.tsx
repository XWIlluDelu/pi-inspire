import { ChevronRight, FolderOpen, Loader2, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { modelIdentityKey } from "../../shared/contracts";
import { supportedThinkingLevels } from "../model-options";
import { store, useAppState } from "../store";
import { DirectoryPicker } from "./DirectoryPicker";
import { Dropdown } from "./Dropdown";
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
  const [browsing, setBrowsing] = useState(false);
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recent = state.sessions.slice(0, 6);
  const selectedModel = state.availableModels.find((model) => modelIdentityKey(model) === modelKey) ?? null;
  const thinkingLevels = useMemo(() => supportedThinkingLevels(selectedModel), [selectedModel]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, Math.round(window.innerHeight * 0.45))}px`;
  }, [draft]);

  useEffect(() => {
    if (thinkingLevel && !thinkingLevels.includes(thinkingLevel as (typeof thinkingLevels)[number])) {
      setThinkingLevel("");
    }
  }, [thinkingLevel, thinkingLevels]);

  // A typed directory wins over the current project; empty means current.
  const canStart = Boolean(draft.trim() && (directory.trim() || state.cwd) && !starting);

  const start = async () => {
    if (!canStart) return;
    const message = draft;
    const target = directory.trim();
    setStarting(true);
    try {
      // newSession resolves once the runtime is ready to accept a prompt and
      // returns only the identity owned by this selection request. A failed or
      // superseded creation cannot redirect the draft into another session.
      const opened = await store.newSession(target || undefined, {
        ...(selectedModel ? { model: { provider: selectedModel.provider, id: selectedModel.id } } : {}),
        ...(selectedModel?.reasoning !== false && thinkingLevel
          ? { thinkingLevel: thinkingLevel as (typeof thinkingLevels)[number] }
          : {}),
      });
      if (opened) {
        const sent = await store.sendPrompt(message);
        if (sent) setDraft("");
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="welcome">
      <span className="welcome__mark" aria-hidden />
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
          ref={textareaRef}
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
        <div className="welcome__session-controls">
          <div className="welcome__session-field">
            <span>Model</span>
            <Dropdown
              label="New session model"
              value={modelKey}
              disabled={starting}
              options={[
                { value: "", label: "Pi default" },
                ...state.availableModels.map((model) => ({
                  value: modelIdentityKey(model),
                  label: `${model.name ?? model.id} · ${model.provider}`,
                })),
              ]}
              onChange={setModelKey}
            />
          </div>
          <div className="welcome__session-field">
            <span>Effort</span>
            <Dropdown
              label="New session effort"
              value={thinkingLevel}
              display={selectedModel?.reasoning === false ? "Not supported" : undefined}
              disabled={starting || selectedModel?.reasoning === false}
              options={[
                { value: "", label: "Pi default" },
                ...thinkingLevels.map((level) => ({ value: level, label: level })),
              ]}
              onChange={setThinkingLevel}
            />
          </div>
        </div>
        <div className="composer__meta">
          <input
            className="welcome__dir"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder={state.cwd ?? "/path/to/project"}
            aria-label="Project directory"
            spellCheck={false}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Browse host directories"
            title="Browse host directories"
            onClick={() => setBrowsing(true)}
          >
            <FolderOpen size={14} aria-hidden />
          </button>
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
      {state.sessionActionError ? (
        <p className="welcome__error" role="alert">{state.sessionActionError}</p>
      ) : null}

      {browsing ? (
        <DirectoryPicker
          initial={directory.trim() || state.cwd || undefined}
          onCancel={() => setBrowsing(false)}
          onPick={(path) => {
            setDirectory(path);
            setBrowsing(false);
          }}
        />
      ) : null}

      {recent.length > 0 ? (
        <div className="welcome__recent">
          <h2 className="welcome__recent-title">
            <button
              type="button"
              className="welcome__recent-toggle"
              aria-expanded={recentOpen}
              onClick={() => setRecentOpen((value) => !value)}
            >
              <ChevronRight size={12} className={`chev ${recentOpen ? "chev--open" : ""}`} aria-hidden />
              Recent sessions
            </button>
          </h2>
          {recentOpen ? (
            <div role="list">
              {recent.map((session) => (
                <div role="listitem" key={session.id}>
                  <button
                    type="button"
                    className="welcome__row"
                    title={session.title || "New session"}
                    onClick={() => void store.openSession(session.id)}
                  >
                    <span className="welcome__row-title">{session.title || "New session"}</span>
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
