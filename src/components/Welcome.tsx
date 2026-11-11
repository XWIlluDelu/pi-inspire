import { ChevronRight, FolderOpen, Send } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_PROJECT_FILES,
  type ModelIdentity,
  type ModelOption,
  modelIdentityKey,
  type NewSessionDefaults,
  type SessionReadOnlyReason,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../../shared/contracts";
import {
  isImageMimeType,
  isSupportedPromptImageMimeType,
} from "../../shared/image-types";
import { ApiError, type ProjectFileResult } from "../api";
import { selectAttachmentFiles } from "../attachment-selection";
import type { PiCommand } from "../composer-completion";
import { shouldSubmitComposerEnter } from "../composer-keyboard";
import type { PendingAttachment } from "../controllers/composer-controller";
import { relativeTime } from "../format";
import { isComposingKeyboardEvent } from "../keyboard-input";
import { clampThinkingLevel, supportedThinkingLevels } from "../model-options";
import {
  availableStatusControls,
  usePresentationAdapters,
} from "../presentation-adapters";
import { recoverableRead } from "../recovery-backoff";
import {
  sessionDraft,
  setSessionDraft,
  setStartDraft,
  startDraft,
} from "../session-drafts";
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

interface WelcomeAttachment extends PendingAttachment {
  file: File;
}

function localAttachment(file: File): WelcomeAttachment {
  const image = isImageMimeType(file.type);
  return {
    localId: crypto.randomUUID(),
    file,
    fileName: file.name || "pasted-image",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind: isSupportedPromptImageMimeType(file.type) ? "image" : "file",
    previewUrl: image ? URL.createObjectURL(file) : undefined,
    status: "ready",
  };
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
    : (sourceSelection?.thinkingLevel ?? inheritance?.thinkingLevel ?? "off");
  const sourcePending = Boolean(
    !inheritance?.readOnlyReason &&
      inheritance?.modelDiscovery &&
      !sourceSelection,
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
  const [sizeActionSlot, setSizeActionSlot] = useState<HTMLSpanElement | null>(
    null,
  );
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
  const { configuration } = usePresentationAdapters();
  const [controlValues, setControlValues] = useState<Record<string, string>>(
    {},
  );
  const [thinkingTouched, setThinkingTouched] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() =>
    THINKING_LEVELS.includes(inheritedThinkingLevel as ThinkingLevel)
      ? (inheritedThinkingLevel as ThinkingLevel)
      : "off",
  );
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
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
  const [directoryIssue, setDirectoryIssue] = useState<{
    path: string;
    missing: boolean;
    message: string;
  } | null>(null);
  const currentDirectoryIssue =
    directoryIssue?.path === effectiveDirectory ? directoryIssue : null;
  const directoryMissing = currentDirectoryIssue?.missing === true;
  const directoryProblem =
    currentDirectoryIssue && !directoryMissing
      ? currentDirectoryIssue.message
      : null;
  const [checkingDirectory, setCheckingDirectory] = useState<string | null>(
    null,
  );
  const directoryChecking = checkingDirectory === effectiveDirectory;
  const confirmedDirectory = useRef<{
    path: string;
    transportGeneration: number;
  } | null>(null);
  const directoryConfirmed =
    confirmedDirectory.current?.path === effectiveDirectory &&
    confirmedDirectory.current.transportGeneration ===
      state.transportGeneration;
  const modelReadyRef = useRef(false);
  modelReadyRef.current = modelStatus === "ready";
  const catalogRequest = useRef<ReturnType<typeof recoverableRead> | null>(
    null,
  );
  const [catalog, setCatalog] = useState<ModelOption[] | null>(null);
  const [catalogCommands, setCatalogCommands] = useState<{
    cwd: string;
    transport: number;
    commands: PiCommand[];
  } | null>(null);
  const [pickedModel, setPickedModel] = useState<ModelOption | null>(null);
  const [commonModels, setCommonModels] = useState<ModelIdentity[]>([]);
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
    !inheritance?.readOnlyReason && inheritance?.cwd === effectiveDirectory
      ? inheritance.sessionId
      : undefined;
  const refreshModels = useCallback(
    async (pick = false) => {
      catalogRequest.current?.abort();
      const transportGeneration = state.transportGeneration;
      const request = recoverableRead(
        () => store.getState().transportGeneration === transportGeneration,
      );
      catalogRequest.current = request;
      setCheckingDirectory(effectiveDirectory);
      const inputGeneration = thinkingInputGeneration.current;
      let result;
      try {
        result = await request.read(() =>
          store.readNewSessionModels(
            catalogSource,
            effectiveDirectory || undefined,
          ),
        );
      } catch (error) {
        if (!request.current()) return undefined;
        const missing =
          error instanceof ApiError &&
          error.code === "PROJECT_DIRECTORY_MISSING";
        const invalid =
          error instanceof ApiError &&
          (error.status === 400 || error.status === 403);
        if (missing || invalid) confirmedDirectory.current = null;
        const directoryWasConfirmed =
          confirmedDirectory.current?.path === effectiveDirectory &&
          confirmedDirectory.current.transportGeneration ===
            transportGeneration;
        // An observation failure cannot undo a known invalid/missing path.
        setDirectoryIssue((previous) => {
          if (missing || invalid) {
            return {
              path: effectiveDirectory,
              missing,
              message:
                error instanceof Error
                  ? error.message
                  : "Project directory could not be checked",
            };
          }
          if (previous?.path === effectiveDirectory) return previous;
          return directoryWasConfirmed
            ? null
            : {
                path: effectiveDirectory,
                missing: false,
                message:
                  error instanceof Error
                    ? error.message
                    : "Project directory could not be checked",
              };
        });
        const keepReady = directoryWasConfirmed && modelReadyRef.current;
        if (!modelOwnedRef.current && !keepReady) {
          setModelWarning(
            error instanceof Error ? error.message : "Model discovery failed",
          );
          setModelStatus("error");
        }
        if (missing) {
          if (pick) {
            const fallback = await store.readNewSessionModels();
            if (request.current()) {
              setCatalog(fallback.models);
              setCommonModels(fallback.commonModels ?? []);
            }
            return fallback.warning;
          }
          return undefined;
        }
        throw error;
      } finally {
        if (request.current()) setCheckingDirectory(null);
        if (catalogRequest.current === request) catalogRequest.current = null;
      }
      if (!request.current()) return undefined;
      confirmedDirectory.current = {
        path: effectiveDirectory,
        transportGeneration,
      };
      setDirectoryIssue(null);
      setCatalog(result.models);
      setCatalogCommands(
        result.commands
          ? {
              cwd: effectiveDirectory,
              transport: transportGeneration,
              commands: result.commands,
            }
          : null,
      );
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
      return result.warning;
    },
    [catalogSource, effectiveDirectory, state.transportGeneration],
  );
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
      catalogRequest.current?.abort();
    };
  }, [effectiveDirectory, refreshModels]);
  const refreshPickerModels = useCallback(
    () => refreshModels(true),
    [refreshModels],
  );
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

  // Preview native defaults only until effort is chosen explicitly. A manual
  // choice survives model/directory changes and retires an in-flight preview.
  // Catalog refresh alone must not reapply defaults.
  useEffect(() => {
    if (!modelTouched || !effectiveDirectory || !pickedModel) return;
    if (thinkingTouched) {
      setModelStatus("ready");
      return;
    }
    const request = recoverableRead(
      () => store.getState().transportGeneration === state.transportGeneration,
    );
    const inputGeneration = thinkingInputGeneration.current;
    setModelWarning(null);
    setModelStatus("loading");
    void (async () => {
      try {
        const level = await request.read(() =>
          store.resolveNewSessionThinking(
            effectiveDirectory,
            pickedModel,
            thinkingRef.current,
          ),
        );
        if (!request.current()) return;
        if (thinkingInputGeneration.current === inputGeneration)
          setThinkingLevel(clampThinkingLevel(pickedModel, level));
        setModelStatus("ready");
      } catch (error) {
        if (!request.current()) return;
        setModelWarning(
          error instanceof Error
            ? error.message
            : "Thinking preview could not be loaded",
        );
        setModelStatus("error");
      }
    })();
    return request.abort;
  }, [
    effectiveDirectory,
    modelKey,
    modelTouched,
    pickedModel,
    thinkingTouched,
    modelResolveAttempt,
    state.transportGeneration,
  ]);

  useEffect(() => {
    const sessionId = inheritance?.sessionId;
    if (!sourcePending || modelTouched || !sessionId) return;
    const request = recoverableRead(
      () => store.getState().transportGeneration === state.transportGeneration,
    );
    setModelWarning(null);
    setModelStatus("loading");
    void (async () => {
      try {
        const result = await request.read(() =>
          store.readNewSessionModels(sessionId, inheritance.cwd, true),
        );
        if (!request.current()) return;
        const selection = result.selection ?? result.defaults;
        if (!selection) {
          setModelStatus("error");
          return;
        }
        setResolvedInheritance({ sessionId, selection });
        setPickedModel(selection.model);
        setModelWarning(result.warning ?? null);
        setModelStatus(selection.model ? "ready" : "idle");
      } catch (error) {
        if (!request.current()) return;
        setModelWarning(
          error instanceof Error
            ? error.message
            : "The source model is unavailable",
        );
        setModelStatus("error");
      }
    })();
    return request.abort;
  }, [
    inheritance?.sessionId,
    inheritance?.cwd,
    sourcePending,
    modelTouched,
    modelResolveAttempt,
    state.transportGeneration,
  ]);

  // Inherited discovery may finish after New opens. An explicit model or
  // effort choice keeps ownership of that field.
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
  const attachmentInput = useComposerAttachmentInput(addFiles, starting);

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
    if (value.trim() === effectiveDirectory) return;
    catalogRequest.current?.abort();
    confirmedDirectory.current = null;
    setDirectoryIssue(null);
    setProjectFiles([]);
    setProjectFileRoot(null);
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
  const workspaceCommands =
    catalogCommands?.cwd === effectiveDirectory &&
    catalogCommands.transport === state.transportGeneration
      ? catalogCommands.commands
      : inheritedCommands;
  const hasInput = Boolean(
    draft.trim() || attachments.length > 0 || projectFiles.length > 0,
  );
  const sourceUnresolved = sourcePending && !modelTouched;
  const thinkingDefault =
    directoryMissing && !thinkingTouched && modelStatus !== "ready";
  const preparing = Boolean(
    effectiveDirectory &&
      !directoryProblem &&
      modelStatus !== "error" &&
      ((!directoryConfirmed && !directoryMissing) ||
        modelStatus === "loading" ||
        sourceUnresolved),
  );
  const startBusy = starting || (hasInput && preparing && !directoryMissing);
  const startReadiness =
    directoryProblem ??
    ((directoryMissing && !sourceUnresolved) ||
    starting ||
    !effectiveDirectory ||
    !hasInput ||
    preparing
      ? null
      : modelStatus === "error"
        ? (modelWarning ?? "Models are unavailable")
        : !selectedModel
          ? "Select a model"
          : null);
  const canStart = Boolean(
    hasInput &&
      effectiveDirectory &&
      !directoryMissing &&
      !directoryProblem &&
      directoryConfirmed &&
      selectedModel &&
      modelStatus === "ready" &&
      !starting,
  );

  const canCreate = Boolean(
    hasInput &&
      effectiveDirectory &&
      directoryMissing &&
      !sourceUnresolved &&
      !starting,
  );
  const start = async (createDirectory = false) => {
    if (createDirectory ? !canCreate : !canStart) return;
    const message = draft;
    const files = attachments.map((attachment) => attachment.file);
    const referencedProjectFiles = [...projectFiles];
    // A selected pre-session file binds creation to the canonical workspace
    // that produced it, so a symlink retarget cannot reinterpret the path.
    const target = projectFileRoot || directory.trim();
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
      const selected = model && (modelTouched || Boolean(inheritedModel));
      const opened = await store.newSession(target || undefined, {
        ...(createDirectory ? { createDirectory: true } : {}),
        ...(selected
          ? { model: { provider: model.provider, id: model.id } }
          : {}),
        ...(thinkingTouched ||
        (selected && (!directoryMissing || modelStatus === "ready"))
          ? { thinkingLevel }
          : {}),
      });
      if (!opened) {
        if (createDirectory) void refreshModels().catch(() => {});
        return;
      }

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
      // Creation has transferred the draft and artifacts. Do not deliver the first
      // input until Pi confirms each explicit choice; failure leaves that draft intact.
      if (!(await store.applyInitialStatusControls(opened, selections))) return;
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
          sizeActionSlot={sizeActionSlot}
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
                directoryMissing && !sourceUnresolved
                  ? "Pi default"
                  : modelStatus === "error"
                    ? "Model unavailable"
                    : "Select model"
              }
              loading={
                !selectedModel &&
                (sourceUnresolved ||
                  modelStatus === "loading" ||
                  (modelStatus === "idle" &&
                    Boolean(effectiveDirectory) &&
                    !modelTouched))
              }
              disabled={starting}
              refreshModels={refreshPickerModels}
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
                setModelWarning(null);
                setThinkingLevel(
                  clampThinkingLevel(model, thinkingRef.current),
                );
                setModelTouched(true);
                setModelStatus("ready");
                setModelKey(modelIdentityKey({ provider, id }));
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
              direction="up"
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
              onChange={(value) => {
                ++thinkingInputGeneration.current;
                setThinkingTouched(true);
                setThinkingLevel(value as ThinkingLevel);
              }}
            />
          </div>
          <ProjectFileControl
            scope={effectiveDirectory}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            buttonDisabled={starting || !effectiveDirectory || directoryMissing}
            showHidden={showHiddenFiles}
            onShowHiddenChange={setShowHiddenFiles}
            selected={projectFiles}
            disabled={starting}
            search={searchProjectFiles}
            onAdd={addProjectFile}
          />
          {attachmentInput.button}
          <span className="composer__action-slot" ref={setSizeActionSlot} />
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
            className={`welcome__readiness ${directoryProblem || modelStatus === "error" ? "welcome__readiness--error" : ""}`}
            role={directoryProblem ? "alert" : "status"}
          >
            <span>{startReadiness}</span>
            {(directoryProblem || modelStatus === "error") &&
            effectiveDirectory ? (
              <button
                type="button"
                className="changes__inline-action"
                disabled={directoryChecking || modelStatus === "loading"}
                aria-busy={directoryChecking || modelStatus === "loading"}
                onClick={() => {
                  if (directoryProblem) {
                    void refreshModels().catch(() => {});
                    return;
                  }
                  setModelStatus("loading");
                  if (modelOwnedRef.current)
                    setModelResolveAttempt((attempt) => attempt + 1);
                  else void refreshModels().catch(() => {});
                }}
              >
                {directoryChecking || modelStatus === "loading" ? (
                  <PiLoader size={13} aria-hidden />
                ) : null}
                {directoryChecking || modelStatus === "loading"
                  ? "Checking…"
                  : "Retry"}
              </button>
            ) : null}
          </div>
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
