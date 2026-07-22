import { useEffect, useMemo, useRef, useState } from "react";
import { VISIBILITY_PREFERENCES, type ThemePreference } from "../../shared/contracts";
import { isBusyRunState, store, useAppState } from "../store";
import { relativeTime } from "./Transcript";

interface PaletteItem {
  id: string;
  group: string;
  title: string;
  hint?: string;
  keepOpen?: boolean;
  run: () => void;
}

const THEME_LABELS: Record<ThemePreference, string> = { light: "Light", dark: "Dark", system: "System" };

function matches(item: PaletteItem, words: string[]): boolean {
  const haystack = `${item.group} ${item.title} ${item.hint ?? ""}`.toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function CommandPalette({
  onClose,
  onToggleNav,
  onToggleCtx,
}: {
  onClose: () => void;
  onToggleNav: () => void;
  onToggleCtx: () => void;
}) {
  const state = useAppState();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = isBusyRunState(state.runState);

  useEffect(() => {
    inputRef.current?.focus();
  }, [renaming]);

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { id: "new", group: "Actions", title: "New session", run: () => void store.newSession() },
      { id: "refresh", group: "Actions", title: "Refresh session list", run: () => void store.refreshSessions() },
      { id: "nav", group: "Actions", title: "Toggle navigation panel", hint: "Ctrl+B", run: onToggleNav },
      { id: "ctx", group: "Actions", title: "Toggle context panel", hint: "Ctrl+.", run: onToggleCtx },
    ];
    if (state.sessionId) {
      actions.push(
        {
          id: "rename",
          group: "Actions",
          title: "Rename session…",
          keepOpen: true,
          run: () => setRenaming(true),
        },
        { id: "compact", group: "Actions", title: "Compact context", run: () => void store.compact() },
      );
    }
    if (busy) {
      actions.push({ id: "abort", group: "Actions", title: "Abort running task", hint: "Esc", run: () => void store.abort() });
    }
    for (const theme of Object.keys(THEME_LABELS) as ThemePreference[]) {
      actions.push({
        id: `theme-${theme}`,
        group: "Preferences",
        title: `Theme: ${THEME_LABELS[theme]}`,
        hint: state.prefs.theme === theme ? "current" : undefined,
        run: () => store.setTheme(theme),
      });
    }
    actions.push(
      {
        id: "serif",
        group: "Preferences",
        title: `Reading font: ${state.prefs.readingSerif ? "Sans" : "Serif"}`,
        hint: "toggle",
        run: () => store.setReadingSerif(!state.prefs.readingSerif),
      },
      {
        id: "launch-welcome",
        group: "Preferences",
        title: "On launch: show welcome",
        hint: state.prefs.launch === "welcome" ? "current" : undefined,
        run: () => store.setLaunch("welcome"),
      },
      {
        id: "launch-continue",
        group: "Preferences",
        title: "On launch: continue previous session",
        hint: state.prefs.launch === "continue" ? "current" : undefined,
        run: () => store.setLaunch("continue"),
      },
    );
    for (const value of VISIBILITY_PREFERENCES) {
      actions.push(
        {
          id: `thinking-${value}`,
          group: "Preferences",
          title: `Thinking cards: ${value}`,
          hint: state.prefs.thinkingVisibility === value ? "current" : undefined,
          run: () => store.setThinkingVisibility(value),
        },
        {
          id: `tools-${value}`,
          group: "Preferences",
          title: `Tool cards: ${value}`,
          hint: state.prefs.toolVisibility === value ? "current" : undefined,
          run: () => store.setToolVisibility(value),
        },
      );
    }

    const sessions: PaletteItem[] = state.sessions.map((session) => ({
      id: `session-${session.id}`,
      group: "Sessions",
      title: session.title || "Untitled session",
      hint: `${session.project} · ${relativeTime(session.modified)}`,
      run: () => void store.openSession(session.id),
    }));

    const commands: PaletteItem[] = state.sessionId
      ? state.commands.map((command) => ({
          id: `cmd-${command.name}`,
          group: "Pi commands",
          title: `/${command.name}`,
          hint: command.description,
          run: () => void store.sendPrompt(`/${command.name}`),
        }))
      : [];

    return [...actions, ...sessions, ...commands];
  }, [state, busy, onToggleNav, onToggleCtx]);

  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = words.length === 0 ? items : items.filter((item) => matches(item, words));
  const clamped = Math.min(index, Math.max(0, filtered.length - 1));

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    item.run();
    if (!item.keepOpen) onClose();
  };

  const submitRename = async () => {
    const name = query.trim();
    if (name && (await store.renameSession(name))) onClose();
  };

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          placeholder={renaming ? "New session name…" : "Type a command or search…"}
          aria-label={renaming ? "New session name" : "Filter commands"}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              if (renaming) setRenaming(false);
              else onClose();
            } else if (renaming) {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitRename();
              }
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex(Math.min(clamped + 1, filtered.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex(Math.max(clamped - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              runItem(filtered[clamped]);
            }
          }}
        />
        {renaming ? (
          <div className="palette__hint">Enter a new name and press Enter — Esc goes back.</div>
        ) : (
          <div className="palette__list" role="listbox" aria-label="Commands">
            {filtered.map((item, itemIndex) => (
              <button
                type="button"
                role="option"
                aria-selected={itemIndex === clamped}
                key={item.id}
                className={`palette__row ${itemIndex === clamped ? "palette__row--active" : ""}`}
                onMouseEnter={() => setIndex(itemIndex)}
                onClick={() => runItem(item)}
              >
                <span className="palette__group">{item.group}</span>
                <span className="palette__title">{item.title}</span>
                {item.hint ? <span className="palette__hint-inline">{item.hint}</span> : null}
              </button>
            ))}
            {filtered.length === 0 ? <div className="palette__empty">No matching commands</div> : null}
          </div>
        )}
      </div>
    </div>
  );
}
