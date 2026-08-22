import { SearchX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACTIVITY_FOLD_VISIBILITIES,
  ASSISTANT_ROUND_DISPLAYS,
  isAbortableRunState,
  TOOL_VISIBILITY_PREFERENCES,
  VISIBILITY_PREFERENCES,
  type PalettePreference,
  type ThemePreference,
} from "../../shared/contracts";
import { store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";
import { sessionHeading } from "./AppTopbar";
import { relativeTime } from "./transcript-rows";

interface PaletteItem {
  id: string;
  group: string;
  title: string;
  hint?: string;
  keepOpen?: boolean;
  run: () => void;
}

const THEME_LABELS: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const PALETTE_LABELS: Record<PalettePreference, string> = {
  amber: "Amber",
  teal: "Jade",
};

function matches(item: PaletteItem, words: string[]): boolean {
  const haystack =
    `${item.group} ${item.title} ${item.hint ?? ""}`.toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function CommandPalette({
  onClose,
  onToggleNav,
  onToggleCtx,
  onNewSession,
  onOpenSession,
}: {
  onClose: () => void;
  onToggleNav: () => void;
  onToggleCtx: () => void;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
}) {
  const state = useAppState();
  const [searchQuery, setSearchQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameInitialValue, setRenameInitialValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const exitRename = () => {
    setRenaming(false);
    setRenameSessionId(null);
    setRenameValue("");
    setRenameInitialValue("");
  };
  const dialogRef = useModalFocus<HTMLDivElement>(
    true,
    "command-palette",
    () => {
      if (renaming) exitRename();
      else onClose();
    },
  );
  const abortable = isAbortableRunState(state.runState);
  const hasEarlierBranch = Boolean(
    state.transcriptDurableLeafId &&
      state.transcriptEffectiveLeafId &&
      state.transcriptDurableLeafId !== state.transcriptEffectiveLeafId,
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, [renaming]);

  useEffect(() => {
    if (renaming && renameSessionId !== state.sessionId) {
      setRenaming(false);
      setRenameSessionId(null);
      setRenameValue("");
      setRenameInitialValue("");
    }
  }, [renameSessionId, renaming, state.sessionId]);

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { id: "new", group: "Actions", title: "New session", run: onNewSession },
      {
        id: "refresh",
        group: "Actions",
        title: "Refresh session list",
        run: () => void store.refreshSessions(),
      },
      {
        id: "nav",
        group: "Actions",
        title: "Toggle navigation panel",
        hint: "Ctrl+B",
        run: onToggleNav,
      },
      {
        id: "ctx",
        group: "Actions",
        title: "Toggle resources panel",
        hint: "Ctrl+.",
        run: onToggleCtx,
      },
    ];
    if (state.sessionId) {
      actions.push(
        {
          id: "files",
          group: "Workspace",
          title: "Open Files",
          run: () => {
            store.setResourcesOpen(true);
            store.setContextMode("files");
          },
        },
        {
          id: "changes",
          group: "Workspace",
          title: "Open Changes",
          run: () => {
            store.setResourcesOpen(true);
            store.setContextMode("changes");
          },
        },
        {
          id: "history",
          group: "Workspace",
          title: "Open History",
          hint: "branches",
          run: () => {
            store.setResourcesOpen(true);
            store.setContextMode("branches");
          },
        },
      );
      if (hasEarlierBranch) {
        actions.push({
          id: "latest-branch",
          group: "Conversation",
          title: "Back to latest branch",
          run: () => void store.returnToLatestBranch(),
        });
      }
    }
    if (state.sessionId) {
      actions.push({
        id: "rename",
        group: "Actions",
        title: "Rename session…",
        keepOpen: true,
        run: () => {
          const catalogTitle = state.sessions.find(
            (session) => session.id === state.sessionId,
          )?.title;
          const currentTitle = sessionHeading(
            state.sessionName,
            catalogTitle,
            state.messages,
            !state.hasOlderMessages,
          );
          setRenameSessionId(state.sessionId);
          setRenameValue(currentTitle);
          setRenameInitialValue(currentTitle);
          setRenaming(true);
        },
      });
    }
    if (abortable) {
      actions.push({
        id: "abort",
        group: "Actions",
        title: "Abort running task",
        hint: "Esc",
        run: () => void store.abort(),
      });
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
    for (const palette of Object.keys(PALETTE_LABELS) as PalettePreference[]) {
      actions.push({
        id: `palette-${palette}`,
        group: "Preferences",
        title: `Palette: ${PALETTE_LABELS[palette]}`,
        hint:
          (state.prefs.palette ?? "amber") === palette ? "current" : undefined,
        run: () => store.setPalette(palette),
      });
    }
    actions.push(
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
      actions.push({
        id: `thinking-${value}`,
        group: "Preferences",
        title: `Thinking cards: ${value}`,
        hint: state.prefs.thinkingVisibility === value ? "current" : undefined,
        run: () => store.setThinkingVisibility(value),
      });
    }
    for (const value of TOOL_VISIBILITY_PREFERENCES) {
      actions.push({
        id: `tools-${value}`,
        group: "Preferences",
        title: `Tool cards: ${value}`,
        hint: state.prefs.toolVisibility === value ? "current" : undefined,
        run: () => store.setToolVisibility(value),
      });
    }
    for (const value of ACTIVITY_FOLD_VISIBILITIES) {
      actions.push({
        id: `activity-folds-${value}`,
        group: "Preferences",
        title: `Activity folds: ${value}`,
        hint:
          (state.prefs.activityFoldVisibility ?? "dynamic") === value
            ? "current"
            : undefined,
        run: () => store.setActivityFoldVisibility(value),
      });
    }
    for (const value of ASSISTANT_ROUND_DISPLAYS) {
      actions.push({
        id: `assistant-rounds-${value}`,
        group: "Preferences",
        title: `Assistant rounds: ${value}`,
        hint:
          state.prefs.assistantRoundDisplay === value ? "current" : undefined,
        run: () => store.setAssistantRoundDisplay(value),
      });
    }

    const sessions: PaletteItem[] = state.sessions.map((session) => ({
      id: `session-${session.id}`,
      group: "Sessions",
      title: session.title || "New session",
      hint: `${session.project} · ${relativeTime(session.modified)}`,
      run: () => onOpenSession(session.id),
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
  }, [
    state,
    abortable,
    hasEarlierBranch,
    onToggleNav,
    onToggleCtx,
    onNewSession,
    onOpenSession,
  ]);

  const words = searchQuery
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const filtered =
    words.length === 0 ? items : items.filter((item) => matches(item, words));
  const clamped = Math.min(index, Math.max(0, filtered.length - 1));

  // Rows render under one header per group — the same grammar the model
  // selector and the composer completion use — rather than repeating the
  // group label on every row. Keyboard navigation still indexes the flat
  // filtered list, so headers are never selectable.
  const sections = new Map<
    string,
    Array<{ item: PaletteItem; index: number }>
  >();
  filtered.forEach((item, itemIndex) => {
    const rows = sections.get(item.group);
    if (rows) rows.push({ item, index: itemIndex });
    else sections.set(item.group, [{ item, index: itemIndex }]);
  });

  // Keyboard navigation must keep the active row visible (jsdom has no
  // scrollIntoView, hence the guard).
  useEffect(() => {
    const active = listRef.current?.querySelector('[aria-selected="true"]');
    if (active && typeof active.scrollIntoView === "function")
      active.scrollIntoView({ block: "nearest" });
  }, [clamped, filtered.length]);

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    item.run();
    if (!item.keepOpen) onClose();
  };

  const submitRename = async () => {
    const name = renameValue.trim();
    const owner = renameSessionId;
    if (!name || !owner || store.getState().sessionId !== owner) return;
    // A prefilled presentation title may be a fallback rather than Pi-owned
    // metadata. Enter without an edit must not promote it into a new name.
    if (name === renameInitialValue.trim()) {
      onClose();
      return;
    }
    if (await store.renameSession(owner, name)) onClose();
  };

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette__input"
          value={renaming ? renameValue : searchQuery}
          placeholder={
            renaming ? "New session name…" : "Type a command or search…"
          }
          aria-label={renaming ? "New session name" : "Filter commands"}
          onChange={(event) => {
            if (renaming) setRenameValue(event.target.value);
            else {
              setSearchQuery(event.target.value);
              setIndex(0);
            }
          }}
          onKeyDown={(event) => {
            if (renaming) {
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
          <div className="palette__hint">
            Enter a new name and press Enter — Esc goes back.
          </div>
        ) : (
          <div
            className="palette__list"
            role="listbox"
            aria-label="Commands"
            ref={listRef}
          >
            {[...sections].map(([group, rows]) => (
              <div
                className="palette__section"
                key={group}
                role="group"
                aria-label={group}
              >
                <div className="palette__group" aria-hidden="true">
                  {group}
                </div>
                {rows.map(({ item, index: itemIndex }) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={itemIndex === clamped}
                    key={item.id}
                    className={`palette__row ${itemIndex === clamped ? "palette__row--active" : ""}`}
                    onMouseEnter={() => setIndex(itemIndex)}
                    onClick={() => runItem(item)}
                  >
                    <span className="palette__title">{item.title}</span>
                    {item.hint ? (
                      <span className="palette__hint-inline">{item.hint}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
            {filtered.length === 0 ? (
              <div className="empty-state">
                <SearchX size={26} strokeWidth={1.5} aria-hidden />
                <span className="empty-state__title">No matching commands</span>
                <span className="empty-state__hint">
                  Shorter words match more
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
