import {
  ChevronRight,
  FolderOpen,
  FolderSearch,
  Loader2,
  Paperclip,
  Send,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_PROJECT_FILES,
  type ModelIdentity,
  type ModelOption,
  modelIdentityKey,
  type NewSessionDefaults,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../../shared/contracts";
import type { ProjectFileResult } from "../api";
import { selectAttachmentFiles } from "../attachment-selection";
import { clipboardFiles } from "../clipboard-files";
import type { PiCommand } from "../composer-completion";
import { shouldSubmitComposerEnter } from "../composer-keyboard";
import type { PendingAttachment } from "../controllers/composer-controller";
import { clampThinkingLevel, supportedThinkingLevels } from "../model-options";
import {
  sessionDraft,
  setSessionDraft,
  setStartDraft,
  startDraft,
} from "../session-drafts";
import { shallowEqual, store, useAppState } from "../store";
import { AttachmentList } from "./AttachmentList";
import { ComposerInput } from "./ComposerInput";
import { DirectoryPicker } from "./DirectoryPicker";
import { Dropdown } from "./Dropdown";
import { ModelSelector } from "./ModelSelector";
import { ProjectFileChips, ProjectFilePicker } from "./ProjectFiles";
import { relativeTime } from "./transcript-rows";
import { BrandLogo, Wordmark } from "./Wordmark";

const DIRECTORY_PREVIEW_DELAY_MS = 220;

interface WelcomeAttachment extends PendingAttachment {
  file: File;
}

function localAttachment(file: File): WelcomeAttachment {
  const image = /^image\//i.test(file.type);
  return {
    localId: crypto.randomUUID(),
    file,
    fileName: file.name || "pasted-image",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind: image ? "image" : "file",
    previewUrl: image ? URL.createObjectURL(file) : undefined,
    status: "ready",
  };
}

export interface WelcomeInheritance {
  sessionId?: string;
  cwd: string;
  model: ModelOption | null;
  modelDiscovery?: "loading" | "unavailable" | null;
  thinkingLevel: string;
  commands: readonly PiCommand[];
}

/** Landing composer. Its staged files remain browser-local until Pi has
 * assigned the new session identity, then enter the normal attachment owner
 * and prompt lifecycle before the first message is delivered. */
export const Welcome = memo(function Welcome({
  showRecent = true,
  inherited,
}: {
  showRecent?: boolean;
  inherited?: WelcomeInheritance | null;
}) {
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      cwd: source.cwd,
      model: source.model,
      modelDiscovery: source.modelDiscovery,
      thinkingLevel: source.thinkingLevel,
      commands: source.commands,
      sessions: source.sessions,
      availableModels: source.availableModels,
      prefs: source.prefs,
      sessionActionError: source.sessionActionError,
    }),
    shallowEqual,
  );
  const liveInheritance = state.cwd
    ? ({
        sessionId: state.sessionId ?? undefined,
        cwd: state.cwd,
        model: state.model,
        modelDiscovery: state.modelDiscovery,
        thinkingLevel: state.thinkingLevel,
        commands: state.commands,
      } satisfies WelcomeInheritance)
    : null;
  const inheritance = liveInheritance ?? inherited ?? null;
  const [resolvedInheritance, setResolvedInheritance] = useState<{
    sessionId: string;
    selection: NewSessionDefaults;
  } | null>(null);
  const sourceSelection =
    resolvedInheritance?.sessionId === inheritance?.sessionId
      ? resolvedInheritance?.selection
      : null;
  const inheritedModel = inheritance?.model ?? sourceSelection?.model ?? null;
  const inheritedThinkingLevel = inheritance?.model
    ? inheritance.thinkingLevel
    : (sourceSelection?.thinkingLevel ??
      inheritance?.thinkingLevel ??
      state.thinkingLevel);
  const sourcePending = Boolean(
    inheritance?.modelDiscovery && !sourceSelection,
  );
  const [draft, setDraft] = useState(startDraft);
  const updateDraft = (text: string) => {
    setDraft(text);
    setStartDraft(text);
  };
  const [directory, setDirectory] = useState(() => inheritance?.cwd ?? "");
  const [attachments, setAttachments] = useState<WelcomeAttachment[]>([]);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [projectFileRoot, setProjectFileRoot] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [recentOpen, setRecentOpen] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [modelKey, setModelKey] = useState(() =>
    inheritedModel ? modelIdentityKey(inheritedModel) : "",
  );
  const [resolvedDefaultModel, setResolvedDefaultModel] =
    useState<ModelOption | null>(null);
  const [modelTouched, setModelTouched] = useState(false);
  const [modelResolveAttempt, setModelResolveAttempt] = useState(0);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >(inheritedModel ? "ready" : sourcePending ? "loading" : "idle");
  const [thinkingTouched, setThinkingTouched] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() =>
    THINKING_LEVELS.includes(inheritedThinkingLevel as ThinkingLevel)
      ? (inheritedThinkingLevel as ThinkingLevel)
      : "off",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectPickerButtonRef = useRef<HTMLButtonElement>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const recent = state.sessions.slice(0, 6);
  const effectiveDirectory = directory.trim();
  const [catalog, setCatalog] = useState<ModelOption[] | null>(null);
  const [pickedModel, setPickedModel] = useState<ModelOption | null>(null);
  const [commonModels, setCommonModels] = useState<ModelIdentity[]>([]);
  const catalogGeneration = useRef(0);
  const thinkingInputGeneration = useRef(0);
  const thinkingTouchedRef = useRef(thinkingTouched);
  thinkingTouchedRef.current = thinkingTouched;
  const modelOwnedRef = useRef(
    modelTouched || Boolean(inheritedModel) || sourcePending,
  );
  modelOwnedRef.current =
    modelTouched || Boolean(inheritedModel) || sourcePending;
  const thinkingRef = useRef(thinkingLevel);
  thinkingRef.current = thinkingLevel;
  const catalogSource =
    inheritance?.cwd === effectiveDirectory ? inheritance.sessionId : undefined;
  const refreshModels = useCallback(async () => {
    const generation = ++catalogGeneration.current;
    const inputGeneration = thinkingInputGeneration.current;
    let result;
    try {
      result = await store.readNewSessionModels(
        catalogSource,
        effectiveDirectory || undefined,
      );
    } catch (error) {
      if (catalogGeneration.current === generation && !modelOwnedRef.current) {
        setModelWarning(
          error instanceof Error ? error.message : "Model discovery failed",
        );
        setModelStatus("error");
      }
      throw error;
    }
    if (catalogGeneration.current === generation) {
      setCatalog(result.models);
      setCommonModels(result.commonModels ?? []);
      if (!modelOwnedRef.current && result.defaults) {
        const defaults = result.defaults;
        setResolvedDefaultModel(defaults.model);
        setModelKey(defaults.model ? modelIdentityKey(defaults.model) : "");
        setModelWarning(result.warning ?? null);
        if (
          !thinkingTouchedRef.current &&
          thinkingInputGeneration.current === inputGeneration
        )
          setThinkingLevel(defaults.thinkingLevel);
        setModelStatus(defaults.model ? "ready" : "error");
      }
    }
    return result.warning;
  }, [catalogSource, effectiveDirectory]);
  useEffect(() => {
    if (!modelOwnedRef.current) {
      setModelKey("");
      setResolvedDefaultModel(null);
      setModelWarning(null);
      setModelStatus(effectiveDirectory ? "loading" : "idle");
    }
    const timer = effectiveDirectory
      ? setTimeout(() => {
          void refreshModels().catch(() => {});
        }, DIRECTORY_PREVIEW_DELAY_MS)
      : undefined;
    return () => {
      clearTimeout(timer);
      ++catalogGeneration.current;
    };
  }, [effectiveDirectory, refreshModels]);
  const availableModels = useMemo(() => {
    const models = catalog ?? state.availableModels;
    if (
      !resolvedDefaultModel ||
      models.some(
        (model) =>
          modelIdentityKey(model) === modelIdentityKey(resolvedDefaultModel),
      )
    ) {
      return models;
    }
    return [...models, resolvedDefaultModel];
  }, [catalog, resolvedDefaultModel, state.availableModels]);
  const selectedModel = useMemo<ModelOption | null>(() => {
    const catalogModel = availableModels.find(
      (model) => modelIdentityKey(model) === modelKey,
    );
    if (catalogModel) return catalogModel;
    if (pickedModel && modelIdentityKey(pickedModel) === modelKey)
      return pickedModel;
    return inheritedModel && modelIdentityKey(inheritedModel) === modelKey
      ? inheritedModel
      : null;
  }, [availableModels, inheritedModel, modelKey, pickedModel]);
  const thinkingLevels = useMemo(
    () => supportedThinkingLevels(selectedModel),
    [selectedModel],
  );

  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    },
    [],
  );

  useEffect(() => {
    if (selectedModel && !thinkingLevels.includes(thinkingLevel))
      setThinkingLevel(clampThinkingLevel(selectedModel, thinkingLevel));
  }, [thinkingLevel, thinkingLevels, selectedModel]);

  // Model switches apply native defaults even after an earlier effort choice;
  // input made AFTER this request remains user-owned. Catalog refresh alone is
  // not a model switch and must not reapply defaults.
  useEffect(() => {
    if (
      !modelTouched ||
      !effectiveDirectory ||
      !pickedModel ||
      thinkingTouchedRef.current
    )
      return;
    let cancelled = false;
    const inputGeneration = thinkingInputGeneration.current;
    setModelStatus("loading");
    void store
      .resolveNewSessionThinking(
        effectiveDirectory,
        pickedModel,
        thinkingRef.current,
      )
      .then(
        (level) => {
          if (cancelled) return;
          if (thinkingInputGeneration.current === inputGeneration)
            setThinkingLevel(clampThinkingLevel(pickedModel, level));
          setModelStatus("ready");
        },
        () => {
          if (!cancelled) setModelStatus("error");
        },
      );
    return () => {
      cancelled = true;
    };
  }, [
    effectiveDirectory,
    modelKey,
    modelTouched,
    pickedModel,
    modelResolveAttempt,
  ]);

  useEffect(() => {
    const sessionId = inheritance?.sessionId;
    if (!sourcePending || modelTouched || !sessionId) return;
    let cancelled = false;
    setModelStatus("loading");
    void store.readNewSessionModels(sessionId, inheritance.cwd, true).then(
      (result) => {
        if (cancelled) return;
        if (!result.selection) {
          setModelStatus("error");
          return;
        }
        setResolvedInheritance({ sessionId, selection: result.selection });
        setPickedModel(result.selection.model);
        setModelWarning(result.warning ?? null);
        setModelStatus(result.selection.model ? "ready" : "idle");
      },
      () => {
        if (!cancelled) setModelStatus("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    inheritance?.sessionId,
    inheritance?.cwd,
    sourcePending,
    modelTouched,
    modelResolveAttempt,
  ]);

  // Until the user chooses explicitly, an inherited session model is the
  // preferred source. The explicit inheritance survives host deselection, and
  // a live model still closes the snapshot-arrival race in isolated renders.
  useEffect(() => {
    if (modelTouched || !inheritedModel) return;
    setModelKey(modelIdentityKey(inheritedModel));
    setModelStatus("ready");
    if (
      !thinkingTouched &&
      THINKING_LEVELS.includes(inheritedThinkingLevel as ThinkingLevel)
    ) {
      setThinkingLevel(inheritedThinkingLevel as ThinkingLevel);
    }
  }, [inheritedModel, inheritedThinkingLevel, modelTouched, thinkingTouched]);

  const addFiles = (files: File[]) => {
    if (starting || files.length === 0) return;
    const { accepted, warning } = selectAttachmentFiles(
      attachmentsRef.current,
      files,
    );
    setAttachmentError(warning);
    if (accepted.length > 0)
      setAttachments((current) => [
        ...current,
        ...accepted.map(localAttachment),
      ]);
  };

  const removeAttachment = (localId: string) => {
    setAttachments((current) => {
      const target = current.find((item) => item.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.localId !== localId);
    });
    setAttachmentError(null);
  };

  const addProjectFile = (file: ProjectFileResult) => {
    const nextRoot = file.workspaceCwd ?? projectFileRoot;
    const sameWorkspace =
      projectFileRoot && nextRoot && projectFileRoot !== nextRoot
        ? []
        : projectFiles;
    if (!file.path || sameWorkspace.includes(file.path)) {
      if (sameWorkspace !== projectFiles) setProjectFiles(sameWorkspace);
      if (nextRoot) setProjectFileRoot(nextRoot);
      return;
    }
    if (sameWorkspace.length >= MAX_PROJECT_FILES) {
      setAttachmentError(
        `At most ${MAX_PROJECT_FILES} project files per message`,
      );
      return;
    }
    setAttachmentError(null);
    setProjectFiles([...sameWorkspace, file.path]);
    if (nextRoot) setProjectFileRoot(nextRoot);
  };

  const removeProjectFile = (path: string) => {
    const next = projectFiles.filter((item) => item !== path);
    setProjectFiles(next);
    if (next.length === 0) setProjectFileRoot(null);
  };

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
    setShowHiddenFiles(false);
    setProjectFiles([]);
    setProjectFileRoot(null);
    setPickerOpen(false);
  };

  // Inherited runtime commands apply only while the visible directory still
  // names the workspace they came from.
  const commandScopeMatches = Boolean(
    inheritance && effectiveDirectory === inheritance.cwd,
  );
  const hasInput = Boolean(
    draft.trim() || attachments.length > 0 || projectFiles.length > 0,
  );
  const startReadiness = starting
    ? "Starting session…"
    : !effectiveDirectory || !hasInput
      ? null
      : modelStatus === "loading"
        ? "Resolving model…"
        : modelStatus === "error"
          ? (modelWarning ?? "Model resolution failed")
          : !selectedModel
            ? "Select a model"
            : null;
  const canStart = Boolean(
    hasInput &&
      effectiveDirectory &&
      selectedModel &&
      modelStatus === "ready" &&
      !starting,
  );

  const start = async () => {
    if (!canStart) return;
    const message = draft;
    const files = attachments.map((attachment) => attachment.file);
    const referencedProjectFiles = [...projectFiles];
    // A selected pre-session file binds creation to the canonical workspace
    // that produced it, so a symlink retarget cannot reinterpret the path.
    const target = projectFileRoot || directory.trim();
    const model = selectedModel;
    if (!model) return;
    setStarting(true);
    try {
      // A displayed workspace default is a preview, not an explicit override:
      // native startup must resolve its own model after registration/trust.
      const selected = modelTouched || Boolean(inheritedModel);
      const opened = await store.newSession(target || undefined, {
        ...(selected
          ? { model: { provider: model.provider, id: model.id } }
          : {}),
        ...(selected || thinkingTouched ? { thinkingLevel } : {}),
      });
      if (!opened) return;

      // The ordinary composer may mount before this async continuation. Drive
      // both its durable browser draft and its live nonce channel, then let the
      // normal upload/send path own all host attachment state.
      setSessionDraft(opened, message);
      // Creation transfers this input to its session even if uploading/sending
      // later fails. A newer start-surface draft keeps its separate ownership.
      if (startDraft() === message) {
        setStartDraft("");
        setDraft("");
      }
      store.replaceComposerText(message);
      for (const path of referencedProjectFiles) store.addProjectFile(path);
      if (files.length > 0) await store.addFiles(files);
      if (
        store.getState().sessionId !== opened ||
        sessionDraft(opened) !== message
      )
        return;
      let handedOff = false;
      const sent = await store.sendPrompt(message, undefined, () => {
        handedOff = true;
        if (sessionDraft(opened) !== message) return;
        setSessionDraft(opened, "");
        if (store.getState().sessionId === opened)
          store.replaceComposerText("");
      });
      if (!sent || handedOff || sessionDraft(opened) !== message) return;
      setSessionDraft(opened, "");
      if (store.getState().sessionId === opened) store.replaceComposerText("");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="welcome">
      <span className="welcome__mark" aria-hidden />
      <div className="welcome__hero">
        <div className="welcome__lockup">
          <BrandLogo size={36} className="welcome__hero-icon" />
          <Wordmark large />
        </div>
        <p className="welcome__tagline">A workbench for Pi</p>
      </div>

      <form
        className={`composer welcome__composer ${dropActive ? "composer--drop" : ""}`}
        aria-label="Start a session"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDropActive(false);
          addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="composer__file-input"
          aria-label="Attach files"
          tabIndex={-1}
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <AttachmentList
          sessionId={null}
          items={attachments}
          disabled={starting}
          onRemove={removeAttachment}
        />
        <ProjectFileChips
          paths={projectFiles}
          disabled={starting}
          onRemove={removeProjectFile}
        />
        <ComposerInput
          value={draft}
          onChange={updateDraft}
          commands={commandScopeMatches ? (inheritance?.commands ?? []) : []}
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
          onPaste={(event) => {
            const files = clipboardFiles(event.clipboardData);
            if (files.length === 0) return;
            event.preventDefault();
            addFiles(files);
          }}
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
              selectCurrent
              models={availableModels}
              recent={state.prefs.recentModelIds}
              common={commonModels}
              onManageModels={() =>
                store.openModelSettings(undefined, undefined, {
                  cwd: effectiveDirectory || undefined,
                })
              }
              emptyLabel={
                modelStatus === "loading" ||
                (modelStatus === "idle" && effectiveDirectory && !modelTouched)
                  ? "Resolving model…"
                  : modelStatus === "error"
                    ? "Model unavailable"
                    : "Select model"
              }
              disabled={starting}
              refreshModels={refreshModels}
              onChange={(provider, id) => {
                const model = availableModels.find(
                  (item) => item.provider === provider && item.id === id,
                );
                if (!model) return;
                if (modelIdentityKey(model) === modelKey) {
                  setModelTouched(true);
                  return;
                }
                setPickedModel(model);
                setThinkingTouched(false);
                setModelWarning(null);
                setThinkingLevel(
                  clampThinkingLevel(model, thinkingRef.current),
                );
                setModelTouched(true);
                setModelStatus("ready");
                setModelKey(modelIdentityKey({ provider, id }));
              }}
            />
            <Dropdown
              label="Thinking level"
              title={
                selectedModel?.reasoning === false
                  ? "The selected model does not support thinking"
                  : "Thinking level"
              }
              direction="up"
              value={thinkingLevel}
              display={
                selectedModel?.reasoning === false
                  ? "unavailable"
                  : thinkingLevel
              }
              disabled={
                starting || !selectedModel || selectedModel.reasoning === false
              }
              options={thinkingLevels.map((level) => ({
                value: level,
                label: level,
              }))}
              onChange={(value) => {
                ++thinkingInputGeneration.current;
                setThinkingTouched(true);
                setThinkingLevel(value as ThinkingLevel);
              }}
            />
          </div>
          <button
            type="button"
            className={`icon-button ${pickerOpen ? "icon-button--active" : ""}`}
            onClick={() => setPickerOpen((value) => !value)}
            disabled={starting || !effectiveDirectory}
            ref={projectPickerButtonRef}
            aria-label="Add project files"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            title="Reference project files"
          >
            <FolderSearch size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={starting}
            aria-label="Attach files"
            title="Attach files (or paste / drop them)"
          >
            <Paperclip size={14} aria-hidden />
          </button>
          <span className="composer__spacer" />
          <button
            type="submit"
            className="composer__send"
            disabled={!canStart}
            aria-label="Start session"
            title="Start session"
          >
            {starting ? (
              <Loader2 size={14} className="spin" aria-hidden />
            ) : (
              <Send size={14} aria-hidden />
            )}
          </button>
        </div>
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
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229
              )
                event.preventDefault();
            }}
            disabled={starting}
          />
        </div>
        {startReadiness ? (
          <div
            className={`welcome__readiness ${modelStatus === "error" ? "welcome__readiness--error" : ""}`}
            role="status"
          >
            <span>{startReadiness}</span>
            {modelStatus === "error" && effectiveDirectory ? (
              <button
                type="button"
                className="changes__inline-action"
                onClick={() => {
                  setModelStatus("loading");
                  if (modelOwnedRef.current)
                    setModelResolveAttempt((attempt) => attempt + 1);
                  else void refreshModels().catch(() => {});
                }}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
        {pickerOpen && effectiveDirectory ? (
          <ProjectFilePicker
            anchorRef={projectPickerButtonRef}
            scope={effectiveDirectory}
            showHidden={showHiddenFiles}
            onShowHiddenChange={setShowHiddenFiles}
            selected={projectFiles}
            disabled={starting}
            search={searchProjectFiles}
            onAdd={addProjectFile}
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </form>
      {attachmentError ? (
        <p className="welcome__error" role="alert">
          {attachmentError}
        </p>
      ) : null}
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
              onClick={() => setRecentOpen((value) => !value)}
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
