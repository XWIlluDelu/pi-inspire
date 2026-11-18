import { ChevronRight, FolderOpen } from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ModelOption,
  modelIdentityKey,
  type SessionReadOnlyReason,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../../shared/contracts";
import {
  type ModelCatalogResponse,
  modelSwitchThinkingLevel,
} from "../../shared/model-settings";
import { ApiError } from "../api";
import type { PiCommand } from "../composer-completion";
import { relativeTime } from "../format";
import { isComposingKeyboardEvent } from "../keyboard-input";
import {
  clampThinkingLevel,
  resolveModelMetadata,
  supportedThinkingLevels,
} from "../model-options";
import {
  availableStatusControls,
  usePresentationAdapters,
} from "../presentation-adapters";
import { recoverableRead } from "../recovery-backoff";
import { hasDraftInput, useSessionDraft } from "../session-drafts";
import { shallowEqual, store, useAppState } from "../store";
import {
  readRecentSessionsOpen,
  saveRecentSessionsOpen,
} from "../workbench-session";
import { ThinkingControl } from "./ComposerThinkingControl";
import { DirectoryPicker } from "./DirectoryPicker";
import { MessageEditor } from "./MessageEditor";
import { ModelSelector } from "./ModelSelector";
import { visibleSessions } from "./nav-model";
import { PiLoader } from "./PiLoader";
import { BrandLogo, Wordmark } from "./Wordmark";

const DIRECTORY_PREVIEW_DELAY_MS = 220;

function candidateEffort(
  model: ModelOption,
  catalog: ModelCatalogResponse | undefined,
  current: ThinkingLevel,
): ThinkingLevel {
  const defaults = catalog?.defaults;
  return defaults?.model &&
    modelIdentityKey(model) === modelIdentityKey(defaults.model)
    ? defaults.thinkingLevel
    : modelSwitchThinkingLevel(model, catalog?.thinkingPreferences, current);
}

export interface WelcomeInheritance {
  sessionId?: string;
  cwd: string;
  model: ModelOption | null;
  modelDiscovery?: "loading" | "unavailable" | null;
  readOnlyReason?: SessionReadOnlyReason | null;
  thinkingLevel: string;
  commands: readonly PiCommand[];
}

/** Landing composer. Its staged files remain browser-local until Pi has
 * assigned the new session identity, then enter the normal attachment owner
 * and prompt lifecycle before the first message is delivered. */
export function Welcome({
  showRecent = true,
  inherited: inheritance = null,
  onDirectoryChange,
}: {
  showRecent?: boolean;
  inherited?: WelcomeInheritance | null;
  onDirectoryChange?: (directory: string) => void;
}) {
  const state = useAppState(
    (source) => ({
      transportGeneration: source.transportGeneration,
      sessions: source.sessions,
      availableModels: source.availableModels,
      prefs: source.prefs,
      sessionActionError: source.sessionActionError,
    }),
    shallowEqual,
  );
  const draft = useSessionDraft(store.drafts, null);
  const [directory, setDirectory] = useState(() => inheritance?.cwd ?? "");
  const [starting, setStarting] = useState(false);
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [recentOpen, setRecentOpen] = useState(readRecentSessionsOpen);
  const toggleRecent = () => {
    const open = !recentOpen;
    setRecentOpen(open);
    saveRecentSessionsOpen(open);
  };
  const [browsing, setBrowsing] = useState(false);
  const [explicit, chooseModel] = useState<{
    model: ModelOption;
    effort: ThinkingLevel;
    pending?: boolean;
  }>();
  const explicitModel = explicit?.model;
  const [manualThinking, chooseThinking] = useState<ThinkingLevel>();
  const { configuration } = usePresentationAdapters();
  const [controlValues, setControlValues] = useState<Record<string, string>>(
    {},
  );
  const recent = useMemo(
    () =>
      visibleSessions(state.sessions, {
        hiddenSessionIds: state.prefs.hiddenSessionIds,
        hiddenProjectCwds: state.prefs.hiddenProjectCwds,
      })
        .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
        .slice(0, 6),
    [
      state.sessions,
      state.prefs.hiddenSessionIds,
      state.prefs.hiddenProjectCwds,
    ],
  );
  const effectiveDirectory = directory.trim();
  useEffect(() => {
    onDirectoryChange?.(effectiveDirectory);
  }, [effectiveDirectory, onDirectoryChange]);
  const transport = state.transportGeneration;
  const inheritSession = !inheritance?.readOnlyReason
    ? inheritance?.sessionId
    : undefined;
  const sourceCwd = inheritance?.cwd;
  const catalogSource =
    sourceCwd === effectiveDirectory ? inheritSession : undefined;
  const key = (cwd?: string, sessionId?: string) =>
    JSON.stringify([transport, cwd, sessionId]);
  const catalogKey = key(effectiveDirectory, catalogSource);
  const sourceKey = key(sourceCwd, inheritSession);
  const readSource = Boolean(
    !explicitModel &&
      inheritSession &&
      !inheritance?.model &&
      inheritance?.modelDiscovery,
  );
  const inheritWithCatalog = readSource && Boolean(catalogSource);
  type Preview = {
    key: string;
    result?: ModelCatalogResponse;
    error?: string;
    missing?: boolean;
    pending?: boolean;
  };
  const [catalogPreview, publishCatalog] = useState<Preview>();
  const [sourcePreview, publishSource] = useState<Preview>();
  const check = catalogPreview?.key === catalogKey ? catalogPreview : undefined;
  const catalog = check?.missing || check?.error ? undefined : check?.result;
  const source = sourcePreview?.key === sourceKey ? sourcePreview : undefined;
  const directoryMissing = Boolean(check?.missing);
  const directoryProblem = !directoryMissing ? check?.error : undefined;
  const directoryChecking = Boolean(check?.pending);
  const sourceUnresolved = readSource && !source?.result;
  const sourceError = sourceUnresolved ? source?.error : undefined;
  const inheritedSelection =
    source?.result?.selection ?? source?.result?.defaults;
  const inheritedModel = inheritance?.model ?? inheritedSelection?.model;
  const initialEffort = inheritance?.model
    ? inheritance.thinkingLevel
    : (inheritedSelection?.thinkingLevel ?? inheritance?.thinkingLevel);
  const inheritedEffort = THINKING_LEVELS.includes(
    initialEffort as ThinkingLevel,
  )
    ? (initialEffort as ThinkingLevel)
    : "off";
  const requests = useRef<
    Partial<Record<"catalog" | "source", ReturnType<typeof recoverableRead>>>
  >({});

  const refresh = useCallback(
    async (target: "catalog" | "source", pick = false) => {
      const ownCatalog = target === "catalog";
      const previewKey = ownCatalog ? catalogKey : sourceKey;
      const publish = ownCatalog ? publishCatalog : publishSource;
      requests.current[target]?.abort();
      const request = recoverableRead(
        () => store.getState().transportGeneration === transport,
      );
      requests.current[target] = request;
      publish((old) => ({
        ...(old?.key === previewKey ? old : {}),
        key: previewKey,
        pending: true,
      }));
      try {
        const result = await request.read((signal) =>
          store.readNewSessionModels(
            ownCatalog ? catalogSource : inheritSession,
            (ownCatalog ? effectiveDirectory : sourceCwd) || undefined,
            !ownCatalog || inheritWithCatalog,
            signal,
          ),
        );
        publish({ key: previewKey, result });
        if (ownCatalog)
          chooseModel((choice) =>
            choice?.pending
              ? {
                  model: choice.model,
                  effort: candidateEffort(choice.model, result, choice.effort),
                }
              : choice,
          );
        if (ownCatalog && inheritWithCatalog)
          publishSource({ key: sourceKey, result });
        return result.warning;
      } catch (error) {
        if (!request.current()) return;
        const missing =
          ownCatalog &&
          error instanceof ApiError &&
          error.code === "PROJECT_DIRECTORY_MISSING";
        const invalid =
          error instanceof ApiError && [400, 403].includes(error.status);
        const message =
          error instanceof Error
            ? error.message
            : ownCatalog
              ? "Project directory could not be checked"
              : "The source model is unavailable";
        publish((old) => {
          if (old?.key !== previewKey) return old;
          return !missing && !invalid && (old.result || old.error)
            ? { ...old, pending: false }
            : { key: previewKey, error: message, missing };
        });
        if (ownCatalog && inheritWithCatalog && !missing)
          publishSource((old) =>
            old?.key === sourceKey && old.result
              ? old
              : { key: sourceKey, error: message },
          );
        if (!missing) throw error;
        if (pick) {
          const result = await request.read((signal) =>
            store.readNewSessionModels(undefined, undefined, false, signal),
          );
          publish({ key: previewKey, missing: true, result });
          return result.warning;
        }
      } finally {
        if (requests.current[target] === request)
          delete requests.current[target];
      }
    },
    [
      catalogKey,
      sourceKey,
      catalogSource,
      inheritSession,
      effectiveDirectory,
      sourceCwd,
      inheritWithCatalog,
      transport,
    ],
  );
  const autoPreview = useEffectEvent((target: "catalog" | "source") => {
    if (target === "catalog" && catalog && !sourceUnresolved) return;
    if (!requests.current[target]?.current())
      void refresh(target).catch(() => {});
  });
  useEffect(() => {
    const timer = effectiveDirectory
      ? setTimeout(() => autoPreview("catalog"), DIRECTORY_PREVIEW_DELAY_MS)
      : undefined;
    return () => {
      clearTimeout(timer);
      requests.current.catalog?.abort();
    };
  }, [catalogKey, effectiveDirectory, inheritWithCatalog]);
  useEffect(() => {
    if (!sourceUnresolved || (inheritWithCatalog && !directoryMissing)) return;
    autoPreview("source");
    return () => requests.current.source?.abort();
  }, [sourceKey, sourceUnresolved, inheritWithCatalog, directoryMissing]);

  const refreshPickerModels = useCallback(
    () => refresh("catalog", true),
    [refresh],
  );
  const retryPreview = () => {
    const target =
      sourceError && (!inheritWithCatalog || directoryMissing)
        ? "source"
        : "catalog";
    void refresh(target).catch(() => {});
  };

  const chosen = explicitModel ?? inheritedModel;
  const chosenModel = chosen ?? catalog?.defaults?.model ?? null;
  const catalogModels = check?.result?.models ?? state.availableModels;
  const selectedModel = resolveModelMetadata(chosenModel, catalogModels);
  const availableModels =
    selectedModel && !catalogModels.includes(selectedModel)
      ? [...catalogModels, selectedModel]
      : catalogModels;
  const thinkingLevels = supportedThinkingLevels(selectedModel);
  const modelWarning =
    sourceError ??
    (!selectedModel && catalog?.defaults
      ? (catalog.warning ?? "Models are unavailable")
      : undefined);
  const modelChecking =
    sourceUnresolved &&
    !directoryProblem &&
    (!sourceError || Boolean(source?.pending || check?.pending));
  const thinkingLevel = clampThinkingLevel(
    selectedModel,
    manualThinking ??
      explicit?.effort ??
      (chosen ? inheritedEffort : catalog?.defaults?.thinkingLevel) ??
      inheritedEffort,
  );

  const searchProjectFiles = useCallback(
    (query: string, signal: AbortSignal) =>
      store.searchNewSessionProjectFiles(
        effectiveDirectory,
        query,
        showHiddenFiles,
        signal,
      ),
    [effectiveDirectory, showHiddenFiles],
  );

  const changeDirectory = (value: string) => {
    setDirectory(value);
    if (value.trim() === effectiveDirectory) return;
    requests.current.catalog?.abort();
    publishCatalog(undefined);
    chooseModel((choice) => choice && { ...choice, pending: true });
    if (draft.projectFiles.length)
      store.drafts.update(null, { projectFiles: [], workspaceCwd: undefined });
  };

  // Inherited runtime commands apply only while the visible directory still
  // names the workspace they came from.
  const workspaceCommands =
    catalog?.commands ??
    (effectiveDirectory === inheritance?.cwd ? inheritance.commands : []);
  const hasInput = hasDraftInput({ ...draft, text: draft.text.trim() });
  const thinkingDefault =
    directoryMissing &&
    manualThinking === undefined &&
    (!selectedModel || (explicitModel && selectedModel.reasoning !== false));
  const preparing = Boolean(
    effectiveDirectory &&
      !directoryProblem &&
      !directoryMissing &&
      (!catalog || modelChecking),
  );
  const startBusy = starting || (hasInput && preparing);
  const startReadiness =
    directoryProblem ??
    (directoryMissing ? sourceError : undefined) ??
    (!hasInput || starting || !effectiveDirectory || directoryMissing
      ? null
      : (modelWarning ??
        (preparing || selectedModel ? null : "Select a model")));
  const canStart = Boolean(
    hasInput &&
      effectiveDirectory &&
      catalog &&
      selectedModel &&
      !modelChecking &&
      !modelWarning &&
      !starting,
  );
  const canCreate =
    hasInput && directoryMissing && !sourceUnresolved && !starting;
  const start = async (createDirectory = false) => {
    if (createDirectory ? !canCreate : !canStart) return;
    if (store.drafts.get(null).revision !== draft.revision) return;
    // A selected pre-session file binds creation to the canonical workspace
    // that produced it, so a symlink retarget cannot reinterpret the path.
    const target = draft.workspaceCwd || effectiveDirectory;
    const model = selectedModel;
    const selections = availableStatusControls(
      configuration,
      workspaceCommands,
    ).flatMap((control) => {
      const value = controlValues[control.id];
      return value && control.options.some((option) => option.value === value)
        ? [{ control, value }]
        : [];
    });
    setStarting(true);
    try {
      // A displayed workspace default is a preview, not an explicit override:
      // native startup must resolve its own model after registration/trust.
      const selected = model && chosen;
      const opened = await store.newSession(target || undefined, {
        ...(createDirectory ? { createDirectory: true } : {}),
        ...(selected
          ? { model: { provider: model.provider, id: model.id } }
          : {}),
        ...(manualThinking !== undefined || (selected && !thinkingDefault)
          ? { thinkingLevel }
          : {}),
      });
      if (!opened) {
        if (createDirectory) void refresh("catalog").catch(() => {});
        return;
      }

      const destinationEmpty = !store.drafts.get(opened).text;
      const upload = store.transferStartDraft(opened, draft);
      const revision = store.drafts.get(opened).revision;
      await upload;
      const ownsDraft = () =>
        destinationEmpty &&
        store.getState().sessionId === opened &&
        store.drafts.get(opened).revision === revision;
      if (
        !ownsDraft() ||
        !(await store.applyInitialStatusControls(opened, selections)) ||
        !ownsDraft()
      )
        return;
      const targetDraft = store.drafts.get(opened);
      await store.sendPrompt(targetDraft.text, undefined, targetDraft);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome__hero">
        <div className="welcome__lockup">
          <BrandLogo size={36} className="welcome__hero-icon" />
          <Wordmark large />
        </div>
        <p className="welcome__tagline">A workbench for Pi</p>
      </div>

      <MessageEditor
        sessionId={null}
        draft={draft}
        className="welcome__composer"
        label="Start a session"
        disabled={starting}
        onSubmit={() => void start()}
        files={{
          scope: effectiveDirectory,
          search: searchProjectFiles,
          showHidden: showHiddenFiles,
          onShowHiddenChange: setShowHiddenFiles,
          pickerDisabled: !effectiveDirectory || directoryMissing,
        }}
        input={{
          commands: workspaceCommands,
          includeNativeCommands: false,
          completionScope: effectiveDirectory,
          rows: 3,
          placeholder: "What do you want to work on?",
          label: "First message",
          completionLabel: "First message completion",
          autoFocus: true,
        }}
        header={
          <>
            <div className="welcome__directory">
              <button
                type="button"
                className="icon-button"
                aria-label="Browse host directories"
                title="Browse host directories"
                disabled={starting}
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  setBrowsing(true);
                }}
              >
                <FolderOpen size={14} aria-hidden />
              </button>
              <input
                className="welcome__dir"
                value={directory}
                onChange={(event) => changeDirectory(event.target.value)}
                placeholder="/path/to/project"
                aria-label="Project directory"
                spellCheck={false}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !isComposingKeyboardEvent(event.nativeEvent)
                  )
                    event.preventDefault();
                }}
                disabled={starting}
              />
            </div>
            {directoryMissing ? (
              <div
                className="welcome__dir-action"
                role="status"
                aria-busy={starting}
              >
                <span>Folder doesn't exist.</span>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={!canCreate}
                  aria-busy={starting || modelChecking}
                  onClick={() => void start(true)}
                  title={
                    !hasInput
                      ? "Add a message or attachment to start"
                      : undefined
                  }
                >
                  {starting || modelChecking ? (
                    <PiLoader size={13} aria-hidden />
                  ) : null}
                  {starting
                    ? "Creating folder and starting…"
                    : "Create folder and start"}
                </button>
              </div>
            ) : null}
          </>
        }
        selectors={
          <>
            <ModelSelector
              value={selectedModel}
              title={
                explicitModel
                  ? undefined
                  : inheritedModel || sourceUnresolved
                    ? "Inherit model from source session"
                    : "Use workspace model defaults"
              }
              selectCurrent
              models={availableModels}
              recent={state.prefs.recentModelIds}
              common={catalog?.commonModels}
              onManageModels={() =>
                store.openModelSettings(undefined, undefined, {
                  cwd: effectiveDirectory || undefined,
                })
              }
              emptyLabel={
                directoryMissing
                  ? "Pi default"
                  : modelWarning
                    ? "Model unavailable"
                    : "Select model"
              }
              loading={!selectedModel && preparing}
              disabled={starting}
              refreshModels={refreshPickerModels}
              onChange={(provider, id) => {
                const model = availableModels.find(
                  (item) => item.provider === provider && item.id === id,
                );
                if (model)
                  chooseModel({
                    model,
                    effort: candidateEffort(
                      model,
                      check?.result,
                      thinkingLevel,
                    ),
                    pending: !catalog,
                  });
              }}
            />
            <ThinkingControl
              scope={{
                kind: "new-session",
                commands: workspaceCommands,
                values: controlValues,
                onSelect: (id, value) =>
                  setControlValues((previous) => ({
                    ...previous,
                    [id]: value,
                  })),
              }}
              thinkingSupported={Boolean(
                selectedModel?.reasoning !== false && selectedModel,
              )}
              label="Thinking level"
              title={
                selectedModel?.reasoning === false
                  ? "Thinking unavailable for this model"
                  : "Thinking level"
              }
              value={thinkingDefault ? "" : thinkingLevel}
              display={
                thinkingDefault
                  ? "Default"
                  : selectedModel?.reasoning === false
                    ? "Unavailable"
                    : undefined
              }
              disabled={starting || !selectedModel}
              levels={thinkingLevels}
              onChange={chooseThinking}
            />
          </>
        }
        send={{ label: "Start session", disabled: !canStart, busy: startBusy }}
      >
        {startReadiness && (
          <div
            className={`welcome__readiness ${directoryProblem || modelWarning ? "welcome__readiness--error" : ""}`}
            role={directoryProblem ? "alert" : "status"}
          >
            <span>{startReadiness}</span>
            {(directoryProblem || modelWarning) && effectiveDirectory && (
              <button
                type="button"
                className="changes__inline-action"
                disabled={directoryChecking || modelChecking}
                aria-busy={directoryChecking || modelChecking}
                onClick={retryPreview}
              >
                {(directoryChecking || modelChecking) && (
                  <PiLoader size={13} aria-hidden />
                )}
                {directoryChecking || modelChecking ? "Checking…" : "Retry"}
              </button>
            )}
          </div>
        )}
      </MessageEditor>
      {state.sessionActionError ? (
        <p className="welcome__error" role="alert">
          {state.sessionActionError}
        </p>
      ) : null}

      {browsing ? (
        <DirectoryPicker
          initial={effectiveDirectory || undefined}
          onCancel={() => setBrowsing(false)}
          onPick={(path) => {
            changeDirectory(path);
            setBrowsing(false);
          }}
        />
      ) : null}

      {showRecent && recent.length > 0 ? (
        <div className="welcome__recent">
          <h2 className="welcome__recent-title">
            <button
              type="button"
              className="button button--quiet disclosure-row welcome__recent-toggle"
              aria-expanded={recentOpen}
              onClick={toggleRecent}
            >
              <ChevronRight
                size={12}
                className={`chev ${recentOpen ? "chev--open" : ""}`}
                aria-hidden
              />
              Recent sessions
            </button>
          </h2>
          {recentOpen ? (
            <div role="list" data-keyboard-active="false">
              {recent.map((session) => (
                <div role="listitem" key={session.id}>
                  <button
                    type="button"
                    className="picker__row welcome__row"
                    title={session.title || "New session"}
                    onClick={() => void store.openSession(session.id)}
                  >
                    <span className="welcome__row-title">
                      {session.title || "New session"}
                    </span>
                    <small className="welcome__row-project">
                      {session.project}
                    </small>
                    <small>{relativeTime(session.modified)}</small>
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
