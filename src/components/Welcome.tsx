import { ChevronRight, FolderOpen, Send } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ApiError, type ProjectFileResult } from "../api";
import type { PiCommand } from "../composer-completion";
import { shouldSubmitComposerEnter } from "../composer-keyboard";
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
import { useSessionDraft } from "../session-drafts";
import { shallowEqual, store, useAppState } from "../store";
import {
  readNavigationDisclosure,
  saveNavigationDisclosure,
} from "../workbench-session";
import { AttachmentList } from "./AttachmentList";
import { ComposerInput } from "./ComposerInput";
import { ThinkingControl } from "./ComposerThinkingControl";
import { DirectoryPicker } from "./DirectoryPicker";
import { ModelSelector } from "./ModelSelector";
import { visibleSessions } from "./nav-model";
import { PiLoader } from "./PiLoader";
import { ProjectFileChips, ProjectFileControl } from "./ProjectFiles";
import { useComposerAttachmentInput } from "./use-composer-attachment-input";
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
export const Welcome = memo(function Welcome({
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [recentOpen, setRecentOpen] = useState(() =>
    readNavigationDisclosure("recentSessions"),
  );
  const toggleRecent = () => {
    const open = !recentOpen;
    setRecentOpen(open);
    saveNavigationDisclosure("recentSessions", open);
  };
  const [browsing, setBrowsing] = useState(false);
  const [explicit, chooseModel] = useState<{
    model: ModelOption;
    effort?: { key: string; level: ThinkingLevel };
  }>();
  const explicitModel = explicit?.model;
  const [manualThinking, chooseThinking] = useState<ThinkingLevel>();
  const [modelResolveAttempt, setModelResolveAttempt] = useState(0);
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
  const catalogKey = JSON.stringify([
    transport,
    effectiveDirectory,
    catalogSource,
  ]);
  const sourceKey = JSON.stringify([transport, inheritSession, sourceCwd]);
  const [sourceCheck, setSourceCheck] = useState<{
    key: string;
    result?: ModelCatalogResponse;
    error?: string;
  }>();
  const readSource = Boolean(
    !explicitModel &&
      inheritSession &&
      !inheritance?.model &&
      inheritance?.modelDiscovery,
  );
  const source = sourceCheck?.key === sourceKey ? sourceCheck : undefined;
  const inheritWithCatalog = readSource && Boolean(catalogSource);
  type CatalogCheck = {
    key: string;
    result?: ModelCatalogResponse;
    issue?: { missing: boolean; message: string };
  };
  const [catalogCheck, setCatalogCheck] = useState<CatalogCheck>();
  const currentCheck =
    catalogCheck?.key === catalogKey ? catalogCheck : undefined;
  const catalog = currentCheck?.result;
  const catalogNeeded = !catalog || (inheritWithCatalog && !source?.result);
  const directoryMissing = currentCheck?.issue?.missing === true;
  const directoryProblem = directoryMissing
    ? undefined
    : currentCheck?.issue?.message;
  const [checkingDirectory, setCheckingDirectory] = useState<string | null>(
    null,
  );
  const directoryChecking = checkingDirectory === catalogKey;
  const catalogRequest = useRef<ReturnType<typeof recoverableRead> | null>(
    null,
  );
  const refreshModels = useCallback(
    async (pick = false) => {
      catalogRequest.current?.abort();
      const request = recoverableRead(
        () => store.getState().transportGeneration === transport,
      );
      catalogRequest.current = request;
      setCheckingDirectory(catalogKey);
      try {
        const result = await request.read((signal) =>
          store.readNewSessionModels(
            catalogSource,
            effectiveDirectory || undefined,
            inheritWithCatalog,
            signal,
          ),
        );
        if (!request.current()) return;
        setCatalogCheck({ key: catalogKey, result });
        if (inheritWithCatalog) setSourceCheck({ key: sourceKey, result });
        return result.warning;
      } catch (error) {
        if (!request.current()) return;
        const missing =
          error instanceof ApiError &&
          error.code === "PROJECT_DIRECTORY_MISSING";
        const invalid =
          error instanceof ApiError && [400, 403].includes(error.status);
        setCatalogCheck((previous) => {
          if (!missing && !invalid && previous?.key === catalogKey)
            return previous;
          return {
            key: catalogKey,
            issue: {
              missing,
              message:
                error instanceof Error
                  ? error.message
                  : "Project directory could not be checked",
            },
          };
        });
        if (!missing) throw error;
        if (pick)
          return (
            await request.read((signal) =>
              store.readNewSessionModels(undefined, undefined, false, signal),
            )
          ).warning;
      } finally {
        if (request.current()) setCheckingDirectory(null);
        if (catalogRequest.current === request) catalogRequest.current = null;
      }
    },
    [
      catalogKey,
      catalogSource,
      effectiveDirectory,
      inheritWithCatalog,
      sourceKey,
      transport,
    ],
  );
  useEffect(() => {
    const timer =
      effectiveDirectory && catalogNeeded
        ? setTimeout(() => {
            if (!catalogRequest.current?.current())
              void refreshModels().catch(() => {});
          }, DIRECTORY_PREVIEW_DELAY_MS)
        : undefined;
    return () => {
      clearTimeout(timer);
      catalogRequest.current?.abort();
    };
  }, [catalogNeeded, effectiveDirectory, refreshModels]);
  const refreshPickerModels = useCallback(
    () => refreshModels(true),
    [refreshModels],
  );

  const inheritedSelection =
    source?.result?.selection ?? source?.result?.defaults;
  const inheritedModel = inheritance?.model ?? inheritedSelection?.model;
  const sourceUnresolved = readSource && !source?.result;
  useEffect(() => {
    if (!sourceUnresolved || inheritWithCatalog || !inheritSession) return;
    const request = recoverableRead(
      () => store.getState().transportGeneration === transport,
    );
    void request
      .read((signal) =>
        store.readNewSessionModels(inheritSession, sourceCwd, true, signal),
      )
      .then(
        (result) => {
          if (request.current()) setSourceCheck({ key: sourceKey, result });
        },
        (error: unknown) => {
          if (request.current())
            setSourceCheck({
              key: sourceKey,
              error:
                error instanceof Error
                  ? error.message
                  : "The source model is unavailable",
            });
        },
      );
    return request.abort;
  }, [
    sourceUnresolved,
    inheritWithCatalog,
    inheritSession,
    sourceCwd,
    sourceKey,
    transport,
    modelResolveAttempt,
  ]);

  const chosen = explicitModel ?? inheritedModel;
  const chosenModel = chosen ?? catalog?.defaults?.model ?? null;
  const catalogModels = catalog?.models ?? state.availableModels;
  const selectedModel = resolveModelMetadata(chosenModel, catalogModels);
  const availableModels =
    selectedModel && !catalogModels.includes(selectedModel)
      ? [...catalogModels, selectedModel]
      : catalogModels;
  const thinkingLevels = supportedThinkingLevels(selectedModel);
  const currentEffort =
    (inheritance?.model
      ? inheritance.thinkingLevel
      : inheritedSelection?.thinkingLevel) ??
    catalog?.defaults?.thinkingLevel ??
    inheritance?.thinkingLevel;
  const inheritedEffort = THINKING_LEVELS.includes(
    currentEffort as ThinkingLevel,
  )
    ? (currentEffort as ThinkingLevel)
    : "off";
  const explicitEffort =
    explicit &&
    (explicit.effort?.key === catalogKey
      ? explicit.effort.level
      : candidateEffort(
          explicit.model,
          catalog,
          explicit.effort?.level ?? inheritedEffort,
        ));
  // A refresh can change capabilities, but the choice retains its effort.
  useEffect(() => {
    if (
      catalog &&
      explicit &&
      explicitEffort !== undefined &&
      explicit.effort?.key !== catalogKey
    )
      chooseModel({
        ...explicit,
        effort: { key: catalogKey, level: explicitEffort },
      });
  }, [catalog, catalogKey, explicit, explicitEffort]);

  const modelWarning =
    (sourceUnresolved ? source?.error : undefined) ??
    (!selectedModel && catalog?.defaults
      ? (catalog.warning ?? "Models are unavailable")
      : undefined);
  const modelChecking = sourceUnresolved && !source?.error && !directoryProblem;
  const thinkingLevel = clampThinkingLevel(
    selectedModel,
    manualThinking ?? explicitEffort ?? inheritedEffort,
  );

  const attachmentInput = useComposerAttachmentInput(
    (files) => store.addFiles(files, null),
    starting,
  );

  const searchProjectFiles = useCallback(
    (query: string) =>
      effectiveDirectory
        ? store.searchNewSessionProjectFiles(
            effectiveDirectory,
            query,
            showHiddenFiles,
          )
        : Promise.resolve({ files: [] }),
    [effectiveDirectory, showHiddenFiles],
  );

  const changeDirectory = (value: string) => {
    setDirectory(value);
    if (value.trim() === effectiveDirectory) return;
    catalogRequest.current?.abort();
    setCatalogCheck(undefined);
    if (draft.projectFiles.length)
      store.drafts.update(null, { projectFiles: [], workspaceCwd: undefined });
    setPickerOpen(false);
  };

  // Inherited runtime commands apply only while the visible directory still
  // names the workspace they came from.
  const commandScopeMatches = Boolean(
    inheritance && effectiveDirectory === inheritance.cwd,
  );
  // Both completion and configurable controls consume this target-owned inventory.
  const inheritedCommands = commandScopeMatches
    ? (inheritance?.commands ?? [])
    : [];
  const workspaceCommands = catalog?.commands ?? inheritedCommands;
  const hasInput = Boolean(
    draft.text.trim() || draft.attachments.length || draft.projectFiles.length,
  );
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
    if (!model && !createDirectory) return;
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
        if (createDirectory) void refreshModels().catch(() => {});
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

      <form
        className={`composer welcome__composer ${attachmentInput.dragging ? "composer--drop" : ""}`}
        aria-label="Start a session"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
        {...attachmentInput.dropHandlers}
      >
        {attachmentInput.input}
        {/* The required project choice leads, before what will be sent there. */}
        <div className="welcome__directory">
          <button
            type="button"
            className="icon-button welcome__directory-browse"
            aria-label="Browse host directories"
            title="Browse host directories"
            disabled={starting}
            onClick={() => setBrowsing(true)}
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
              className="button welcome__dir-action-btn"
              disabled={!canCreate}
              aria-busy={starting || sourceUnresolved}
              onClick={() => void start(true)}
              title={
                !hasInput ? "Add a message or attachment to start" : undefined
              }
            >
              {starting || sourceUnresolved ? (
                <PiLoader size={13} aria-hidden />
              ) : null}
              {starting
                ? "Creating folder and starting…"
                : "Create folder and start"}
            </button>
          </div>
        ) : null}
        <AttachmentList
          sessionId={null}
          items={draft.attachments}
          disabled={starting}
          onRemove={(id) => store.removeAttachment(id, null)}
        />
        <ProjectFileChips
          paths={draft.projectFiles}
          disabled={starting}
          onRemove={(path) => store.removeProjectFile(path, null)}
        />
        <ComposerInput
          value={draft.text}
          onChange={(text) => store.drafts.setText(null, text)}
          commands={workspaceCommands}
          includeNativeCommands={false}
          completionDisabled={starting}
          completionScope={`new-session:${effectiveDirectory}`}
          showHiddenFiles={showHiddenFiles}
          onShowHiddenFilesChange={setShowHiddenFiles}
          searchProjectFiles={
            effectiveDirectory ? searchProjectFiles : undefined
          }
          rows={3}
          maxHeightRatio={0.45}
          placeholder="What do you want to work on?"
          label="First message"
          completionLabel="First message completion"
          autoFocus
          onPaste={attachmentInput.onPaste}
          onKeyDown={(event) => {
            if (
              !shouldSubmitComposerEnter(
                event.nativeEvent,
                state.prefs.desktopSendKey,
              )
            )
              return;
            event.preventDefault();
            void start();
          }}
        />
        <div className="composer__meta">
          <div className="composer__selectors">
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
                    effort: catalog
                      ? {
                          key: catalogKey,
                          level: candidateEffort(model, catalog, thinkingLevel),
                        }
                      : undefined,
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
          </div>
          <ProjectFileControl
            scope={effectiveDirectory}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            buttonDisabled={starting || !effectiveDirectory || directoryMissing}
            showHidden={showHiddenFiles}
            onShowHiddenChange={setShowHiddenFiles}
            selected={draft.projectFiles}
            disabled={starting}
            search={searchProjectFiles}
            onAdd={(file: ProjectFileResult) =>
              store.addProjectFile(file.path, null, file.workspaceCwd)
            }
          />
          {attachmentInput.button}
          <span className="composer__spacer" />
          <button
            type="submit"
            className="composer__send"
            disabled={!canStart}
            aria-label="Start session"
            aria-busy={startBusy}
            title="Start session"
          >
            {startBusy ? (
              <PiLoader size={14} aria-hidden />
            ) : (
              <Send size={14} aria-hidden />
            )}
          </button>
        </div>
        {startReadiness ? (
          <div
            className={`welcome__readiness ${directoryProblem || modelWarning ? "welcome__readiness--error" : ""}`}
            role={directoryProblem ? "alert" : "status"}
          >
            <span>{startReadiness}</span>
            {(directoryProblem || modelWarning) && effectiveDirectory ? (
              <button
                type="button"
                className="changes__inline-action"
                disabled={directoryChecking || modelChecking}
                aria-busy={directoryChecking || modelChecking}
                onClick={() => {
                  if (directoryProblem || !selectedModel)
                    void refreshModels().catch(() => {});
                  setModelResolveAttempt((attempt) => attempt + 1);
                }}
              >
                {directoryChecking || modelChecking ? (
                  <PiLoader size={13} aria-hidden />
                ) : null}
                {directoryChecking || modelChecking ? "Checking…" : "Retry"}
              </button>
            ) : null}
          </div>
        ) : null}
      </form>
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
              className="welcome__recent-toggle"
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
            <div role="list">
              {recent.map((session) => (
                <div role="listitem" key={session.id}>
                  <button
                    type="button"
                    className="welcome__row"
                    title={session.title || "New session"}
                    onClick={() => void store.openSession(session.id)}
                  >
                    <span className="welcome__row-title">
                      {session.title || "New session"}
                    </span>
                    <span className="welcome__row-project">
                      {session.project}
                    </span>
                    <span className="welcome__row-time">
                      {relativeTime(session.modified)}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
