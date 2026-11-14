import { SearchX } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { nativeCommand, parseCommandInvocation } from "../../shared/commands";
import { isAbortableRunState, isBusyRunState } from "../../shared/contracts";
import { selectedRunState } from "../app-state";
import {
  type PiCommand,
  resolveCommandInventory,
} from "../composer-completion";
import { shouldSubmitComposerEnter } from "../composer-keyboard";
import {
  branchCopiesBlocked,
  hasEarlierContinuation,
} from "../controllers/branch-controller";
import { relativeTime } from "../format";
import { isTouchFirstDevice } from "../input-device";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { paletteTextMatchRanges, rankPaletteItems } from "../palette-search";
import { preferenceChoices } from "../preference-labels";
import { sessionActions } from "../session-actions";
import { shallowEqual, store, useAppState } from "../store";
import {
  queueTerminalAction,
  type TerminalUiAction,
} from "../terminal-actions";
import { useSearchFocus } from "../use-search-focus";
import {
  modelCycleShortcut,
  workbenchShortcutLabel,
  workbenchShortcuts,
} from "../workbench-keyboard";
import { sessionHeading } from "./AppTopbar";
import { ButtonLabel } from "./ButtonLabel";
import { ComposerInput } from "./ComposerInput";
import { Modal } from "./Modal";
import { visibleSessions } from "./nav-model";
import { OptionList, useOptionList } from "./OptionList";
import { RenameSessionDialog } from "./RenameSessionDialog";
import { SearchMatchText } from "./SearchMatchText";

interface PaletteItem {
  id: string;
  group: string;
  title: string;
  hint?: string;
  keepOpen?: boolean;
  aliases?: readonly string[];
  default?: boolean;
  run: () => void;
}

const workspaceActions = [
  { mode: "files", title: "Open Files", aliases: [] },
  { mode: "changes", title: "Open Changes", aliases: [] },
  {
    mode: "terminal",
    title: "Open Terminal",
    aliases: ["shell", "project shell"],
  },
] as const;

const terminalActions: {
  action: TerminalUiAction;
  title: string;
  hint?: string;
}[] = [
  { action: "new", title: "New terminal", hint: "Ctrl+Shift+`" },
  { action: "next", title: "Next terminal", hint: "Ctrl+PageDown" },
  { action: "previous", title: "Previous terminal", hint: "Ctrl+PageUp" },
  { action: "take-control", title: "Take control of terminal" },
  { action: "restart", title: "Restart terminal" },
  { action: "close", title: "Close terminal" },
  { action: "focus", title: "Toggle terminal focus" },
  { action: "settings", title: "Terminal settings" },
];

const nativeTitles: Partial<Record<string, string>> = {
  model: "Choose model",
  thinking: "Choose thinking level",
  [sessionActions.export.command]: sessionActions.export.title,
  compact: "Compact context…",
  copy: "Copy last response",
  fork: "Fork from History",
  session: "Session & usage",
  reload: "Reload Pi resources",
  quit: "Leave Inspire",
};

function runTerminalAction(action: TerminalUiAction): void {
  const projectCwd = store.getState().cwd;
  if (!projectCwd) return;
  queueTerminalAction(action, projectCwd);
  store.openContextMode("terminal");
}

export const CommandPalette = memo(function CommandPalette({
  onClose,
  active = true,
  onExportSession,
  onToggleNav,
  onToggleCtx,
  onNewSession,
  onOpenSession,
  onFindSession,
  onOpenSettings,
  onOpenHelp,
}: {
  onClose: () => void;
  active?: boolean;
  onExportSession: () => void;
  onToggleNav: () => void;
  onToggleCtx: () => void;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onFindSession: () => void;
  onOpenSettings: () => void;
  onOpenHelp: (mode: "hotkeys" | "changelog") => void;
}) {
  const state = useAppState((appState) => {
    const catalogTitle = appState.sessions.find(
      (session) => session.id === appState.sessionId,
    )?.title;
    return {
      sessionId: appState.sessionId,
      readOnlyReason: appState.readOnlyReason,
      copiesBlocked: branchCopiesBlocked(appState),
      external: Boolean(
        appState.sessionId &&
          appState.sessionStatuses[appState.sessionId]?.external,
      ),
      heading: sessionHeading(
        appState.sessionName,
        catalogTitle,
        appState.live.messages,
        !appState.view.hasOlder,
      ),
      runState: selectedRunState(appState),
      bashRunning: appState.live.bashRunning,
      earlierContinuation: hasEarlierContinuation(appState),
      prefs: appState.prefs,
      sessions: appState.sessions,
      commands: appState.commands,
      models: appState.availableModels,
      model: appState.model,
    };
  }, shallowEqual);
  const list = useOptionList<PaletteItem>();
  const [searchQuery, setSearchQuery] = useState("");
  const [preparation, setPreparation] = useState<{
    owner: string;
    command: PiCommand;
    text: string;
  } | null>(null);
  const commandInventory = useMemo(
    () => resolveCommandInventory(state.commands),
    [state.commands],
  );
  const preparedInvocation = preparation
    ? parseCommandInvocation(preparation.text, (name) =>
        commandInventory.some((command) => command.name === name),
      )
    : null;
  const preparedCommand = preparedInvocation
    ? commandInventory.find(
        (command) => command.name === preparedInvocation.name,
      )
    : undefined;
  const [sendingLabel, setSendingLabel] = useState<string | null>(null);
  const preparationSending = sendingLabel !== null;
  const [delivery, setDelivery] = useState<"steer" | "followUp">("steer");
  const [rename, setRename] = useState<{ owner: string; name: string } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const abortable = isAbortableRunState(state.runState) || state.bashRunning;

  useSearchFocus(active && !preparation && !rename, inputRef, dialogRef);

  useEffect(() => {
    if (preparation && preparation.owner !== state.sessionId)
      setPreparation(null);
  }, [preparation, state.sessionId]);

  useEffect(() => {
    if (rename && rename.owner !== state.sessionId) setRename(null);
  }, [rename, state.sessionId]);

  const items = useMemo<PaletteItem[]>(() => {
    const sessionId = state.sessionId;
    const destinations = [
      ["new", "New session", onNewSession, []],
      ["resume", "Find a session", onFindSession, ["sessions"]],
      ["settings", "Settings", onOpenSettings, ["preferences"]],
      [
        "hotkeys",
        "Keyboard shortcuts",
        () => onOpenHelp("hotkeys"),
        ["shortcuts", "help"],
      ],
      [
        "changelog",
        "Pi changelog",
        () => onOpenHelp("changelog"),
        ["release notes"],
      ],
    ] as const;
    const actions: PaletteItem[] = [
      ...destinations.map(([id, title, run, aliases]) => ({
        id,
        title,
        run,
        group: "Actions",
        default: id !== "changelog",
        aliases: [`/${id}`, ...aliases],
      })),
      {
        id: "refresh",
        group: "Actions",
        title: "Refresh session list",
        run: () => void store.refreshSessions(),
      },
      ...(["nav", "ctx"] as const).map((id) => ({
        id,
        group: "Actions",
        title: workbenchShortcuts[id].title,
        hint: workbenchShortcutLabel(id),
        run: id === "nav" ? onToggleNav : onToggleCtx,
      })),
    ];
    const runInSession = (run: () => void) => () => {
      if (store.getState().sessionId === sessionId) run();
    };
    if (sessionId) {
      actions.push(
        {
          id: "copy-resume-command",
          group: "Actions",
          title: "Copy resume command",
          run: runInSession(() => void store.copyResumeCommand(sessionId)),
        },
        ...workspaceActions.map(
          ({ mode, title, aliases }): PaletteItem => ({
            id: mode,
            group: "Workspace",
            title,
            aliases,
            default: true,
            run: runInSession(() => store.openContextMode(mode)),
          }),
        ),
        {
          id: "history",
          group: "Workspace",
          title: "Open History",
          aliases: [
            `/${sessionActions["switch-branch"].command}`,
            "history",
            "branches",
            "branch navigation",
          ],
          default: true,
          run: runInSession(store.openHistory),
        },
        ...terminalActions.map(
          ({ action, title, hint }): PaletteItem => ({
            id: `terminal-${action}`,
            group: "Terminal",
            title,
            hint,
            run: runInSession(() => runTerminalAction(action)),
          }),
        ),
      );
      if (!state.readOnlyReason) {
        if (!state.external)
          actions.push(
            {
              id: "model-next",
              group: "Models",
              title: "Next model",
              hint: modelCycleShortcut("next-model"),
              run: runInSession(() => void store.cycleModel(1)),
            },
            {
              id: "model-previous",
              group: "Models",
              title: "Previous model",
              hint: modelCycleShortcut("previous-model"),
              run: runInSession(() => void store.cycleModel(-1)),
            },
          );
        actions.push({
          id: "thinking-cycle",
          group: "Models",
          title: "Cycle thinking level",
          hint: modelCycleShortcut("thinking"),
          run: runInSession(() => void store.cycleThinking()),
        });
      }
      actions.push({
        id: "manage-models",
        group: "Models",
        title: "Manage models",
        aliases: ["/scoped-models", "common models", "provider settings"],
        run: runInSession(() => store.openModelSettings()),
      });
      if (state.earlierContinuation) {
        actions.push({
          id: "latest-branch",
          group: "Workspace",
          title: "Restore latest saved position",
          aliases: ["Back to latest branch"],
          default: true,
          run: runInSession(() => void store.returnToLatestBranch()),
        });
      }
    }
    if (sessionId && !state.copiesBlocked) {
      actions.push({
        id: "clone",
        group: "Workspace",
        title: sessionActions.clone.title,
        aliases: [`/${sessionActions.clone.command}`],
        run: runInSession(() => void store.cloneCurrentBranch()),
      });
    }
    if (sessionId && !state.readOnlyReason) {
      actions.push({
        id: "rename",
        group: "Actions",
        title: `${sessionActions.rename.title}…`,
        aliases: [`/${sessionActions.rename.command}`, "rename"],
        keepOpen: true,
        run: runInSession(() => {
          if (!store.getState().readOnlyReason)
            setRename({ owner: sessionId, name: state.heading });
        }),
      });
    }
    if (abortable) {
      actions.push({
        id: "abort",
        group: "Actions",
        title: "Abort running task",
        default: true,
        hint: "Esc",
        run: runInSession(() => void store.abort()),
      });
    }
    for (const key of Object.keys(
      preferenceChoices,
    ) as (keyof typeof preferenceChoices)[]) {
      const field = preferenceChoices[key];
      const title = "paletteLabel" in field ? field.paletteLabel : field.label;
      for (const option of field.options)
        actions.push({
          id: `${key}-${option.value}`,
          group: "Preferences",
          title: `${title}: ${"actionLabel" in option ? option.actionLabel : option.label}`,
          hint: state.prefs[key] === option.value ? "current" : undefined,
          run: () => store.setPreference(key, option.value),
        });
    }

    const visible = visibleSessions(state.sessions, state.prefs);
    const recentIds = new Set(
      [...visible]
        .filter((session) => session.id !== state.sessionId)
        .sort(
          (left, right) =>
            Date.parse(right.modified) - Date.parse(left.modified),
        )
        .slice(0, 5)
        .map((session) => session.id),
    );
    const sessions: PaletteItem[] = visible.map((session) => ({
      id: `session-${session.id}`,
      group: "Sessions",
      aliases: ["session"],
      default: recentIds.has(session.id),
      title: session.title || "New session",
      hint: `${session.project} · ${relativeTime(session.modified)}`,
      run: () => onOpenSession(session.id),
    }));

    const handled = new Set(actions.flatMap(({ aliases }) => aliases ?? []));
    const commands: PaletteItem[] = sessionId
      ? commandInventory
          .filter(
            (command) =>
              (!state.readOnlyReason ||
                (command.source === "builtin" &&
                  (command.name === sessionActions.export.command ||
                    nativeCommand(command.name)?.availableWithoutWorkspace))) &&
              !handled.has(`/${command.name}`),
          )
          .map((command) => {
            const prepare =
              command.source !== "builtin" ||
              (command.name === "compact" && !state.external);
            const sessionAliases =
              command.name === "session" ? ["cost", "tokens"] : [];
            let humanTitle =
              command.source === "builtin"
                ? nativeTitles[command.name]
                : undefined;
            if (humanTitle && state.external) {
              if (command.name === "compact")
                humanTitle = "Compact in native Pi…";
              if (command.name === "reload")
                humanTitle = "Reload in native Pi…";
            }
            return {
              id: `cmd-${command.name}`,
              group: command.source === "builtin" ? "Actions" : "Pi resources",
              title: humanTitle ?? `/${command.name}`,
              aliases: [
                command.name,
                `/${command.name}`,
                ...sessionAliases,
                ...(humanTitle && command.description
                  ? [command.description]
                  : []),
              ],
              default: ["model", "export"].includes(command.name),
              hint:
                command.execution === "terminal"
                  ? `Terminal only — ${command.description}`
                  : humanTitle
                    ? undefined
                    : prepare
                      ? (command.description ?? command.source ?? "Command")
                      : command.description,
              keepOpen: prepare,
              run: runInSession(() => {
                if (
                  command.source === "builtin" &&
                  command.name === sessionActions.export.command
                ) {
                  onExportSession();
                } else if (prepare) {
                  setDelivery("steer");
                  setPreparation({
                    owner: sessionId,
                    command,
                    text: `/${command.name} `,
                  });
                } else {
                  // The palette must release modal focus before its native picker opens.
                  requestAnimationFrame(
                    runInSession(() =>
                      store.runPaletteNativeCommand(`/${command.name}`),
                    ),
                  );
                }
              }),
            };
          })
      : [];

    return [...actions, ...commands, ...sessions];
  }, [
    state,
    abortable,
    commandInventory,
    onToggleNav,
    onToggleCtx,
    onNewSession,
    onOpenSession,
    onFindSession,
    onOpenSettings,
    onOpenHelp,
    onExportSession,
  ]);

  const defaultItems = useMemo(() => {
    const byGroup = new Map<string, PaletteItem[]>();
    for (const item of items) {
      if (!item.default) continue;
      const list = byGroup.get(item.group);
      if (list) list.push(item);
      else byGroup.set(item.group, [item]);
    }
    return [...byGroup.values()].flat();
  }, [items]);

  const searching = Boolean(searchQuery.trim());
  const options = (
    searching ? rankPaletteItems(items, searchQuery) : defaultItems
  ).map((item) => ({
    key: item.id,
    value: item,
    group: searching ? "Results" : item.group,
    title: item.title,
  }));

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    item.run();
    if (!item.keepOpen) onClose();
  };

  const preparationLabel =
    preparedCommand?.source === "extension" ||
    preparedCommand?.source === "builtin"
      ? "Run"
      : isBusyRunState(state.runState)
        ? delivery === "steer"
          ? "Steer Pi"
          : "Queue prompt"
        : "Send";

  const submitPreparation = async () => {
    if (
      !preparation ||
      preparationSending ||
      store.getState().sessionId !== preparation.owner
    )
      return;
    setSendingLabel(preparationLabel);
    const sent = await store.sendPreparedCommand(
      preparation.text,
      isBusyRunState(state.runState) ? delivery : undefined,
    );
    if (!mountedRef.current) return;
    setSendingLabel(null);
    if (sent && store.getState().sessionId === preparation.owner) onClose();
  };

  return (
    <Modal
      ref={dialogRef}
      active={active}
      aria-label="Command palette"
      onDismiss={onClose}
      focusSurface={isTouchFirstDevice() && !preparation}
      onEscape={() => {
        if (preparation && !preparationSending) setPreparation(null);
        else onClose();
      }}
      onKeyDown={(event) => {
        if (
          preparation ||
          event.defaultPrevented ||
          isComposingKeyboardEvent(event.nativeEvent) ||
          (event.target !== event.currentTarget &&
            event.target !== inputRef.current)
        )
          return;
        list.navigate(event, options, runItem, { consumeEmptyEnter: true });
      }}
    >
      <div className="dialog dialog--flush palette">
        {preparation ? (
          <div className="palette__prepare">
            <h2 className="dialog__title">
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
            <footer className="dialog__actions palette__prepare-actions">
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
                <ButtonLabel
                  reserve={[sendingLabel ?? preparationLabel, "Sending…"]}
                >
                  {preparationSending ? "Sending…" : preparationLabel}
                </ButtonLabel>
              </button>
            </footer>
          </div>
        ) : (
          <>
            <input
              ref={inputRef}
              className="palette__input"
              value={searchQuery}
              placeholder="Search actions and sessions…"
              aria-label="Filter commands"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={list.id}
              aria-activedescendant={list.descendant(options)}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                list.reset(true);
              }}
            />
            <OptionList
              list={list}
              options={options}
              label="Commands"
              className="palette__list"
              optionClass="palette__row"
              optionButtons
              highlightAsSelection
              plain
              onPick={runItem}
              heading={({ group }) => (
                <div className="palette__group" aria-hidden="true">
                  {group}
                </div>
              )}
              renderOption={({ value: item }) => (
                <>
                  <span className="palette__title">
                    <SearchMatchText
                      text={item.title}
                      ranges={paletteTextMatchRanges(item.title, searchQuery)}
                    />
                  </span>
                  {item.hint ? (
                    <span className="palette__hint-inline">
                      <SearchMatchText
                        text={item.hint}
                        ranges={paletteTextMatchRanges(item.hint, searchQuery)}
                      />
                    </span>
                  ) : null}
                </>
              )}
            >
              {!options.length ? (
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
            </OptionList>
          </>
        )}
      </div>
      {rename && rename.owner === state.sessionId ? (
        <RenameSessionDialog
          sessionId={rename.owner}
          initialName={rename.name}
          active={active}
          onClose={() => setRename(null)}
        />
      ) : null}
    </Modal>
  );
});
