import { SearchX } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { parseCommandInvocation } from "../../shared/commands";
import {
  ACTIVITY_FOLD_VISIBILITIES,
  ASSISTANT_ROUND_DISPLAYS,
  isAbortableRunState,
  isBusyRunState,
  type PalettePreference,
  type ThemePreference,
  TOOL_VISIBILITY_PREFERENCES,
  VISIBILITY_PREFERENCES,
} from "../../shared/contracts";
import {
  type PiCommand,
  resolveCommandInventory,
} from "../composer-completion";
import { shouldSubmitComposerEnter } from "../composer-keyboard";
import { isTouchFirstDevice } from "../input-device";
import { rankPaletteItems } from "../palette-search";
import { preferenceChoiceLabel } from "../preference-labels";
import { shallowEqual, store, useAppState } from "../store";
import {
  queueTerminalAction,
  type TerminalUiAction,
} from "../terminal-actions";
import { useModalFocus } from "../use-modal-focus";
import { useSearchFocus } from "../use-search-focus";
import { sessionHeading } from "./AppTopbar";
import { ComposerInput } from "./ComposerInput";
import { relativeTime } from "./transcript-rows";

interface PaletteItem {
  id: string;
  group: string;
  title: string;
  hint?: string;
  keepOpen?: boolean;
  aliases?: string[];
  default?: boolean;
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

function runTerminalAction(action: TerminalUiAction): void {
  store.setResourcesOpen(true);
  store.setContextMode("terminal");
  queueTerminalAction(action);
}

export const CommandPalette = memo(function CommandPalette({
  onClose,
  active = true,
  onExportSession,
  onToggleNav,
  onToggleCtx,
  onNewSession,
  onOpenSession,
  onFindSession = () => {
    store.runPaletteNativeCommand("/resume");
  },
  onOpenSettings = () => {
    store.runPaletteNativeCommand("/settings");
  },
  onOpenHelp = (mode) => {
    store.runPaletteNativeCommand(`/${mode}`);
  },
}: {
  onClose: () => void;
  active?: boolean;
  onExportSession: () => void;
  onToggleNav: () => void;
  onToggleCtx: () => void;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onFindSession?: () => void;
  onOpenSettings?: () => void;
  onOpenHelp?: (mode: "hotkeys" | "changelog") => void;
}) {
  const state = useAppState((appState) => {
    const catalogTitle = appState.sessions.find(
      (session) => session.id === appState.sessionId,
    )?.title;
    return {
      sessionId: appState.sessionId,
      heading: sessionHeading(
        appState.sessionName,
        catalogTitle,
        appState.messages,
        !appState.hasOlderMessages,
      ),
      runState: appState.runState,
      bashRunning: appState.bashRunning,
      transcriptDurableLeafId: appState.transcriptDurableLeafId,
      transcriptEffectiveLeafId: appState.transcriptEffectiveLeafId,
      prefs: appState.prefs,
      sessions: appState.sessions,
      commands: appState.commands,
      models: appState.availableModels,
      model: appState.model,
    };
  }, shallowEqual);
  const listId = useId();
  const [searchQuery, setSearchQuery] = useState("");
  const [preparation, setPreparation] = useState<{
    owner: string;
    command: PiCommand;
    text: string;
  } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const preparedInvocation = preparation
    ? parseCommandInvocation(preparation.text)
    : null;
  const preparedCommand = preparedInvocation
    ? resolveCommandInventory(state.commands).find(
        (command) => command.name === preparedInvocation.name,
      )
    : undefined;
  const [preparationSending, setPreparationSending] = useState(false);
  const [delivery, setDelivery] = useState<"steer" | "followUp">("steer");
  const [index, setIndex] = useState(0);
  const [keyboardActive, setKeyboardActive] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameInitialValue, setRenameInitialValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const renameIncarnationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const exitRename = useCallback(() => {
    renameIncarnationRef.current += 1;
    setRenaming(false);
    setRenameSessionId(null);
    setRenameValue("");
    setRenameInitialValue("");
  }, []);
  const dialogRef = useModalFocus<HTMLDivElement>(
    active,
    "command-palette",
    (event) => {
      if (event.isComposing) return false;
      if (preparation && !preparationSending) setPreparation(null);
      else if (renaming) exitRename();
      else onClose();
    },
  );
  const abortable = isAbortableRunState(state.runState) || state.bashRunning;
  const hasEarlierBranch = Boolean(
    state.transcriptDurableLeafId &&
      state.transcriptEffectiveLeafId &&
      state.transcriptDurableLeafId !== state.transcriptEffectiveLeafId,
  );

  useSearchFocus(active && !preparation && !renaming, inputRef, dialogRef);
  useEffect(() => {
    if (active && renaming) inputRef.current?.focus({ preventScroll: true });
  }, [active, renaming]);

  useEffect(() => {
    if (preparation && preparation.owner !== state.sessionId)
      setPreparation(null);
  }, [preparation, state.sessionId]);

  useEffect(() => {
    if (renaming && renameSessionId !== state.sessionId) exitRename();
  }, [exitRename, renameSessionId, renaming, state.sessionId]);

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      {
        id: "new",
        group: "Actions",
        title: "New session",
        aliases: ["/new"],
        default: true,
        run: onNewSession,
      },
      {
        id: "resume",
        group: "Actions",
        title: "Find a session",
        aliases: ["/resume", "sessions"],
        default: true,
        run: onFindSession,
      },
      {
        id: "settings",
        group: "Actions",
        title: "Settings",
        aliases: ["/settings", "preferences"],
        default: true,
        run: onOpenSettings,
      },
      {
        id: "hotkeys",
        group: "Help",
        title: "Keyboard shortcuts",
        aliases: ["/hotkeys", "shortcuts", "help"],
        default: true,
        run: () => onOpenHelp("hotkeys"),
      },
      {
        id: "changelog",
        group: "Help",
        title: "Pi changelog",
        aliases: ["/changelog", "release notes"],
        run: () => onOpenHelp("changelog"),
      },
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
          default: true,
          run: () => {
            store.setResourcesOpen(true);
            store.setContextMode("files");
          },
        },
        {
          id: "changes",
          group: "Workspace",
          title: "Open Changes",
          default: true,
          run: () => {
            store.setResourcesOpen(true);
            store.setContextMode("changes");
          },
        },
        {
          id: "history",
          group: "Workspace",
          title: "Open History",
          aliases: ["/tree", "history", "branches"],
          default: true,
          hint: "Branch navigation",
          run: () => {
            store.setResourcesOpen(true);
            store.setContextMode("branches");
          },
        },
        {
          id: "terminal",
          group: "Workspace",
          title: "Open Terminal",
          default: true,
          hint: "Project shell",
          run: () => {
            store.setResourcesOpen(true);
            store.setContextMode("terminal");
          },
        },
        {
          id: "terminal-new",
          group: "Terminal",
          title: "New terminal",
          hint: "Ctrl+Shift+`",
          run: () => runTerminalAction("new"),
        },
        {
          id: "terminal-next",
          group: "Terminal",
          title: "Next terminal",
          hint: "Ctrl+PageDown",
          run: () => runTerminalAction("next"),
        },
        {
          id: "terminal-previous",
          group: "Terminal",
          title: "Previous terminal",
          hint: "Ctrl+PageUp",
          run: () => runTerminalAction("previous"),
        },
        {
          id: "terminal-control",
          group: "Terminal",
          title: "Take control of terminal",
          run: () => runTerminalAction("take-control"),
        },
        {
          id: "terminal-restart",
          group: "Terminal",
          title: "Restart terminal",
          run: () => runTerminalAction("restart"),
        },
        {
          id: "terminal-close",
          group: "Terminal",
          title: "Close terminal",
          run: () => runTerminalAction("close"),
        },
        {
          id: "terminal-focus",
          group: "Terminal",
          title: "Focus terminal",
          run: () => runTerminalAction("focus"),
        },
        {
          id: "terminal-settings",
          group: "Terminal",
          title: "Terminal settings",
          run: () => runTerminalAction("settings"),
        },
      );
      actions.push(
        {
          id: "model-next",
          group: "Models",
          title: "Next model",
          hint: "Alt+Shift+M",
          run: () => void store.cycleModel(1),
        },
        {
          id: "model-previous",
          group: "Models",
          title: "Previous model",
          hint: "Alt+Shift+P",
          run: () => void store.cycleModel(-1),
        },
        {
          id: "thinking-cycle",
          group: "Models",
          title: "Cycle thinking level",
          hint: "Alt+Shift+R",
          run: () => void store.cycleThinking(),
        },
        {
          id: "manage-models",
          group: "Models",
          title: "Manage models",
          aliases: ["/scoped-models", "common models", "provider settings"],
          run: () => store.openModelSettings(),
        },
      );
      if (hasEarlierBranch) {
        actions.push({
          id: "latest-branch",
          group: "Conversation",
          title: "Back to latest branch",
          default: true,
          run: () => void store.returnToLatestBranch(),
        });
      }
    }
    if (state.sessionId) {
      actions.push({
        id: "clone",
        group: "Conversation",
        title: "Clone current branch",
        aliases: ["/clone"],
        run: () => void store.cloneCurrentBranch(),
      });
      actions.push({
        id: "rename",
        group: "Actions",
        title: "Rename session…",
        aliases: ["/name", "rename"],
        keepOpen: true,
        run: () => {
          renameIncarnationRef.current += 1;
          setRenameSessionId(state.sessionId);
          setRenameValue(state.heading);
          setRenameInitialValue(state.heading);
          setRenaming(true);
        },
      });
    }
    if (abortable) {
      actions.push({
        id: "abort",
        group: "Actions",
        title: "Abort running task",
        default: true,
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
        hint: state.prefs.palette === palette ? "current" : undefined,
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
        title: `Reasoning details: ${preferenceChoiceLabel(value)}`,
        hint: state.prefs.thinkingVisibility === value ? "current" : undefined,
        run: () => store.setThinkingVisibility(value),
      });
    }
    for (const value of TOOL_VISIBILITY_PREFERENCES) {
      actions.push({
        id: `tools-${value}`,
        group: "Preferences",
        title: `Tool activity: ${preferenceChoiceLabel(value)}`,
        hint: state.prefs.toolVisibility === value ? "current" : undefined,
        run: () => store.setToolVisibility(value),
      });
    }
    for (const value of ACTIVITY_FOLD_VISIBILITIES) {
      actions.push({
        id: `activity-folds-${value}`,
        group: "Preferences",
        title: `Activity groups: ${preferenceChoiceLabel(value)}`,
        hint:
          state.prefs.activityFoldVisibility === value ? "current" : undefined,
        run: () => store.setActivityFoldVisibility(value),
      });
    }
    for (const value of ASSISTANT_ROUND_DISPLAYS) {
      actions.push({
        id: `assistant-rounds-${value}`,
        group: "Preferences",
        title: `Assistant turn details: ${value === "details" ? "On" : "Off"}`,
        hint:
          state.prefs.assistantRoundDisplay === value ? "current" : undefined,
        run: () => store.setAssistantRoundDisplay(value),
      });
    }

    const recentIds = new Set(
      [...state.sessions]
        .filter((session) => session.id !== state.sessionId)
        .sort(
          (left, right) =>
            Date.parse(right.modified) - Date.parse(left.modified),
        )
        .slice(0, 5)
        .map((session) => session.id),
    );
    const sessions: PaletteItem[] = state.sessions.map((session) => ({
      id: `session-${session.id}`,
      group: "Sessions",
      aliases: ["session"],
      default: recentIds.has(session.id),
      title: session.title || "New session",
      hint: `${session.project} · ${relativeTime(session.modified)}`,
      run: () => onOpenSession(session.id),
    }));

    const commands: PaletteItem[] = state.sessionId
      ? resolveCommandInventory(state.commands)
          .filter(
            (command) =>
              !actions.some((action) =>
                action.aliases?.includes(`/${command.name}`),
              ),
          )
          .map((command) => {
            const prepare =
              command.source !== "builtin" || command.name === "compact";
            const titles: Record<string, string> = {
              model: "Choose model",
              thinking: "Choose thinking level",
              export: "Export session…",
              compact: "Compact context…",
              copy: "Copy last response",
              fork: "Fork from History",
              session: "Session information",
              reload: "Reload Pi resources",
              quit: "Leave Inspire",
            };
            return {
              id: `cmd-${command.name}`,
              group: command.source === "builtin" ? "Pi" : "Pi resources",
              title:
                command.source === "builtin"
                  ? (titles[command.name] ?? `/${command.name}`)
                  : `/${command.name}`,
              aliases: [command.name, `/${command.name}`],
              default: ["model", "export"].includes(command.name),
              hint:
                command.execution === "terminal"
                  ? `Terminal only — ${command.description}`
                  : prepare
                    ? (command.description ?? command.source ?? "Command")
                    : command.description,
              keepOpen: prepare,
              run: () => {
                if (command.source === "builtin" && command.name === "export") {
                  onExportSession();
                } else if (prepare) {
                  setDelivery("steer");
                  setPreparation({
                    owner: state.sessionId!,
                    command,
                    text: `/${command.name} `,
                  });
                } else {
                  // The palette must release modal focus before its native picker opens.
                  requestAnimationFrame(() => {
                    if (store.getState().sessionId === state.sessionId)
                      store.runPaletteNativeCommand(`/${command.name}`);
                  });
                }
              },
            };
          })
      : [];

    return [...actions, ...commands, ...sessions];
  }, [
    state,
    abortable,
    hasEarlierBranch,
    onToggleNav,
    onToggleCtx,
    onNewSession,
    onOpenSession,
    onFindSession,
    onOpenSettings,
    onOpenHelp,
    onExportSession,
  ]);

  const filtered = searchQuery.trim()
    ? rankPaletteItems(items, searchQuery)
    : items.filter((item) => item.default);
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
    const group = searchQuery.trim() ? "Results" : item.group;
    const rows = sections.get(group);
    if (rows) rows.push({ item, index: itemIndex });
    else sections.set(group, [{ item, index: itemIndex }]);
  });

  useEffect(() => {
    if (!keyboardActive) return;
    const active = listRef.current?.querySelector('[aria-selected="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [clamped, searchQuery, filtered.length, keyboardActive]);

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    item.run();
    if (!item.keepOpen) onClose();
  };

  const submitPreparation = async () => {
    if (
      !preparation ||
      preparationSending ||
      store.getState().sessionId !== preparation.owner
    )
      return;
    setPreparationSending(true);
    const sent = await store.sendPreparedCommand(
      preparation.text,
      isBusyRunState(state.runState) ? delivery : undefined,
    );
    if (!mountedRef.current) return;
    setPreparationSending(false);
    if (sent && store.getState().sessionId === preparation.owner) onClose();
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
    const incarnation = renameIncarnationRef.current;
    if (
      (await store.renameSession(owner, name)) &&
      renameIncarnationRef.current === incarnation &&
      renameSessionId === owner &&
      store.getState().sessionId === owner
    )
      onClose();
  };

  return (
    <div
      ref={overlayRef}
      className="overlay palette-overlay"
      role="presentation"
      style={active ? undefined : { display: "none" }}
      aria-hidden={!active || undefined}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        data-modal-autofocus={
          isTouchFirstDevice() && !preparation && !renaming ? true : undefined
        }
        onKeyDown={(event) => {
          if (
            preparation ||
            renaming ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            (event.target !== event.currentTarget &&
              event.target !== inputRef.current)
          )
            return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setKeyboardActive(true);
            setIndex(Math.min(clamped + 1, filtered.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setKeyboardActive(true);
            setIndex(Math.max(clamped - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            runItem(filtered[clamped]);
          }
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {preparation ? (
          <div className="palette__prepare">
            <h2 className="palette__prepare-title">
              {preparedCommand
                ? `Prepare /${preparedCommand.name}`
                : "Prepare command"}
            </h2>
            {!preparedCommand ? (
              <p className="palette__hint">
                Choose an available slash command.
              </p>
            ) : preparedCommand.description ? (
              <p className="palette__hint">{preparedCommand.description}</p>
            ) : null}
            <ComposerInput
              key={`${preparation.owner}:${preparation.command.name}`}
              value={preparation.text}
              onChange={(text) => setPreparation({ ...preparation, text })}
              commands={state.commands}
              searchProjectFiles={
                preparedCommand?.source !== "builtin"
                  ? (query) => store.searchProjectFiles(query)
                  : undefined
              }
              models={state.models}
              activeModel={state.model}
              completionScope={preparation.owner}
              completionPortal={overlayRef}
              disabled={preparationSending || !active}
              completionDisabled={preparationSending || !active}
              label="Prepared command"
              placeholder="Command and arguments…"
              initialCaretAtEnd
              autoFocus
              onKeyDown={(event) => {
                if (shouldSubmitComposerEnter(event.nativeEvent, "mod-enter")) {
                  event.preventDefault();
                  void submitPreparation();
                }
              }}
            />
            {isBusyRunState(state.runState) &&
            ["prompt", "skill"].includes(preparedCommand?.source ?? "") ? (
              <div
                className="segmented"
                role="group"
                aria-label="Prepared prompt delivery"
              >
                <button
                  type="button"
                  aria-pressed={delivery === "steer"}
                  onClick={() => setDelivery("steer")}
                >
                  Steer
                </button>
                <button
                  type="button"
                  aria-pressed={delivery === "followUp"}
                  onClick={() => setDelivery("followUp")}
                >
                  Queue
                </button>
              </div>
            ) : null}
            <div className="palette__prepare-actions">
              <button
                type="button"
                className="button button--quiet"
                disabled={preparationSending}
                onClick={() => setPreparation(null)}
              >
                Back
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={preparationSending || !preparedCommand}
                onClick={() => void submitPreparation()}
              >
                {preparationSending
                  ? "Sending…"
                  : preparedCommand?.source === "extension" ||
                      preparedCommand?.source === "builtin"
                    ? "Run command"
                    : isBusyRunState(state.runState)
                      ? delivery === "steer"
                        ? "Steer Pi"
                        : "Queue prompt"
                      : "Send prepared prompt"}
              </button>
            </div>
          </div>
        ) : (
          <>
            {renaming ? (
              <input
                ref={inputRef}
                className="palette__input"
                value={renameValue}
                placeholder="New session name…"
                aria-label="New session name"
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitRename();
                  }
                }}
              />
            ) : (
              <input
                ref={inputRef}
                className="palette__input"
                value={searchQuery}
                placeholder="Search actions and sessions…"
                aria-label="Filter commands"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={true}
                aria-controls={listId}
                aria-activedescendant={
                  keyboardActive && filtered[clamped]
                    ? `${listId}-${clamped}`
                    : undefined
                }
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setIndex(0);
                  setKeyboardActive(true);
                }}
              />
            )}
            {renaming ? (
              <div className="palette__prepare-actions">
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={exitRename}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="button button--primary"
                  disabled={!renameValue.trim()}
                  onClick={() => void submitRename()}
                >
                  Rename
                </button>
              </div>
            ) : (
              <div
                className="palette__list"
                data-keyboard-active={keyboardActive}
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label="Commands"
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
                        id={`${listId}-${itemIndex}`}
                        aria-selected={keyboardActive && itemIndex === clamped}
                        key={item.id}
                        className={`palette__row ${keyboardActive && itemIndex === clamped ? "palette__row--active" : ""}`}
                        onPointerMove={(event) => {
                          if (event.pointerType === "touch") return;
                          setKeyboardActive(false);
                          setIndex(itemIndex);
                        }}
                        onFocus={() => {
                          setKeyboardActive(true);
                          setIndex(itemIndex);
                        }}
                        onClick={() => runItem(item)}
                      >
                        <span className="palette__title">{item.title}</span>
                        {item.hint ? (
                          <span className="palette__hint-inline">
                            {item.hint}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ))}
                {filtered.length === 0 ? (
                  <div className="empty-state">
                    <SearchX size={26} strokeWidth={1.5} aria-hidden />
                    <span className="empty-state__title">
                      No matching commands
                    </span>
                    <span className="empty-state__hint">
                      Shorter words match more
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
