import { ChevronRight, FolderOpen, FolderSearch, Loader2, Paperclip, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_PROJECT_FILES,
  THINKING_LEVELS,
  modelIdentityKey,
  type ModelOption,
  type ThinkingLevel,
} from "../../shared/contracts";
import type { ProjectFileResult } from "../api";
import { selectAttachmentFiles } from "../attachment-selection";
import { clipboardFiles } from "../clipboard-files";
import { supportedThinkingLevels } from "../model-options";
import { setSessionDraft } from "../session-drafts";
import { store, useAppState, type PendingAttachment, type PiCommand } from "../store";
import { AttachmentList } from "./AttachmentList";
import { ComposerInput } from "./ComposerInput";
import { DirectoryPicker } from "./DirectoryPicker";
import { Dropdown } from "./Dropdown";
import { ModelSelector } from "./ModelSelector";
import { ProjectFileChips, ProjectFilePicker } from "./ProjectFiles";
import { relativeTime } from "./Transcript";
import { Wordmark } from "./Wordmark";

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
    previewUrl: image && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined,
    status: "ready",
  };
}

export interface WelcomeInheritance {
  cwd: string;
  model: ModelOption | null;
  thinkingLevel: string;
  commands: readonly PiCommand[];
}

/** Landing composer. Its staged files remain browser-local until Pi has
 * assigned the new session identity, then enter the normal attachment owner
 * and prompt lifecycle before the first message is delivered. */
export function Welcome({
  showRecent = true,
  inherited,
}: {
  showRecent?: boolean;
  inherited?: WelcomeInheritance | null;
}) {
  const state = useAppState();
  const liveInheritance = state.cwd ? {
    cwd: state.cwd,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    commands: state.commands,
  } satisfies WelcomeInheritance : null;
  const inheritance = liveInheritance ?? inherited ?? null;
  const inheritedModel = inheritance?.model ?? null;
  const inheritedThinkingLevel = inheritance?.thinkingLevel ?? state.thinkingLevel;
  const [draft, setDraft] = useState("");
  const [directory, setDirectory] = useState(() => inheritance?.cwd ?? "");
  const [attachments, setAttachments] = useState<WelcomeAttachment[]>([]);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [projectFileRoot, setProjectFileRoot] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [recentOpen, setRecentOpen] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [modelKey, setModelKey] = useState(() => inheritedModel ? modelIdentityKey(inheritedModel) : "");
  const [resolvedDefaultModel, setResolvedDefaultModel] = useState<ModelOption | null>(null);
  const [modelTouched, setModelTouched] = useState(false);
  const [modelStatus, setModelStatus] = useState<"idle" | "loading" | "ready" | "error">(
    inheritedModel ? "ready" : "idle",
  );
  const [thinkingTouched, setThinkingTouched] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() =>
    THINKING_LEVELS.includes(inheritedThinkingLevel as ThinkingLevel)
      ? inheritedThinkingLevel as ThinkingLevel
      : "off",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const recent = state.sessions.slice(0, 6);
  const effectiveDirectory = directory.trim();
  const availableModels = useMemo(() => {
    if (!resolvedDefaultModel || state.availableModels.some((model) => modelIdentityKey(model) === modelIdentityKey(resolvedDefaultModel))) {
      return state.availableModels;
    }
    return [...state.availableModels, resolvedDefaultModel];
  }, [resolvedDefaultModel, state.availableModels]);
  const selectedModel = useMemo<ModelOption | null>(() => {
    const catalogModel = availableModels.find((model) => modelIdentityKey(model) === modelKey);
    if (catalogModel) return catalogModel;
    return inheritedModel && modelIdentityKey(inheritedModel) === modelKey ? inheritedModel : null;
  }, [availableModels, inheritedModel, modelKey]);
  const thinkingLevels = useMemo(() => supportedThinkingLevels(selectedModel), [selectedModel]);

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  useEffect(() => {
    if (!thinkingLevels.includes(thinkingLevel)) setThinkingLevel(thinkingLevels[0] ?? "off");
  }, [thinkingLevel, thinkingLevels]);

  // Until the user chooses explicitly, an inherited session model is the
  // preferred source. The explicit inheritance survives host deselection, and
  // a live model still closes the snapshot-arrival race in isolated renders.
  useEffect(() => {
    if (modelTouched || !inheritedModel) return;
    setModelKey(modelIdentityKey(inheritedModel));
    setModelStatus("ready");
    if (!thinkingTouched && THINKING_LEVELS.includes(inheritedThinkingLevel as ThinkingLevel)) {
      setThinkingLevel(inheritedThinkingLevel as ThinkingLevel);
    }
  }, [inheritedModel, inheritedThinkingLevel, modelTouched, thinkingTouched]);

  // With no session model to inherit, ask the host for Pi's actual startup
  // choice in the prospective workspace. A stale path response cannot replace
  // a later path or an explicit user selection.
  useEffect(() => {
    if (modelTouched || inheritedModel || !effectiveDirectory) {
      if (!effectiveDirectory && !inheritedModel && !modelTouched) setModelStatus("idle");
      return;
    }
    let cancelled = false;
    setModelKey("");
    setResolvedDefaultModel(null);
    setModelStatus("loading");
    const timer = setTimeout(() => {
      store.resolveNewSessionDefaults(effectiveDirectory).then(
        (defaults) => {
          if (cancelled) return;
          setResolvedDefaultModel(defaults.model);
          setModelKey(defaults.model ? modelIdentityKey(defaults.model) : "");
          if (!thinkingTouched) setThinkingLevel(defaults.thinkingLevel);
          setModelStatus("ready");
        },
        () => {
          if (!cancelled) setModelStatus("error");
        },
      );
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [effectiveDirectory, inheritedModel, modelTouched, thinkingTouched]);

  const addFiles = (files: File[]) => {
    if (starting || files.length === 0) return;
    const { accepted, warning } = selectAttachmentFiles(attachmentsRef.current, files);
    setAttachmentError(warning);
    if (accepted.length > 0) setAttachments((current) => [...current, ...accepted.map(localAttachment)]);
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
    const sameWorkspace = projectFileRoot && nextRoot && projectFileRoot !== nextRoot ? [] : projectFiles;
    if (!file.path || sameWorkspace.includes(file.path)) {
      if (sameWorkspace !== projectFiles) setProjectFiles(sameWorkspace);
      if (nextRoot) setProjectFileRoot(nextRoot);
      return;
    }
    if (sameWorkspace.length >= MAX_PROJECT_FILES) {
      setAttachmentError(`At most ${MAX_PROJECT_FILES} project files per message`);
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
    (query: string) => effectiveDirectory
      ? store.searchNewSessionProjectFiles(effectiveDirectory, query)
      : Promise.resolve([]),
    [effectiveDirectory],
  );

  const changeDirectory = (value: string) => {
    setDirectory(value);
    setProjectFiles([]);
    setProjectFileRoot(null);
    setPickerOpen(false);
  };

  // Inherited runtime commands apply only while the visible directory still
  // names the workspace they came from.
  const commandScopeMatches = Boolean(inheritance && effectiveDirectory === inheritance.cwd);
  const hasInput = Boolean(draft.trim() || attachments.length > 0 || projectFiles.length > 0);
  const canStart = Boolean(hasInput && effectiveDirectory && selectedModel && !starting);

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
      const opened = await store.newSession(target || undefined, {
        model: { provider: model.provider, id: model.id },
        ...(model.reasoning !== false ? { thinkingLevel } : {}),
      });
      if (!opened) return;

      // The ordinary composer may mount before this async continuation. Drive
      // both its durable browser draft and its live nonce channel, then let the
      // normal upload/send path own all host attachment state.
      setSessionDraft(opened, message);
      store.replaceComposerText(message);
      for (const path of referencedProjectFiles) store.addProjectFile(path);
      if (files.length > 0) await store.addFiles(files);
      const sent = await store.sendPrompt(message);
      if (sent) {
        setSessionDraft(opened, "");
        store.replaceComposerText("");
        setDraft("");
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="welcome">
      <span className="welcome__mark" aria-hidden />
      <div className="welcome__hero">
        <div className="welcome__lockup">
          <span className="welcome__hero-icon" aria-hidden />
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
        onDragOver={(event) => { event.preventDefault(); setDropActive(true); }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDropActive(false);
          addFiles(Array.from(event.dataTransfer?.files ?? []));
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
        <AttachmentList items={attachments} disabled={starting} onRemove={removeAttachment} />
        <ProjectFileChips
          paths={projectFiles}
          disabled={starting}
          onRemove={removeProjectFile}
        />
        <ComposerInput
          value={draft}
          onChange={setDraft}
          commands={commandScopeMatches ? inheritance?.commands ?? [] : []}
          completionDisabled={starting}
          completionScope={`new-session:${effectiveDirectory}`}
          searchProjectFiles={effectiveDirectory ? searchProjectFiles : undefined}
          onPickProjectFile={addProjectFile}
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
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void start();
            }
          }}
        />
        <div className="composer__meta">
          <ModelSelector
            value={selectedModel}
            models={availableModels}
            recent={state.prefs.recentModelIds}
            emptyLabel={modelStatus === "loading" || (modelStatus === "idle" && effectiveDirectory && !modelTouched)
              ? "Resolving model…"
              : "Select model"}
            disabled={starting}
            onChange={(provider, id) => {
              setModelTouched(true);
              setModelStatus("ready");
              setModelKey(modelIdentityKey({ provider, id }));
            }}
          />
          <Dropdown
            label="Thinking level"
            title={selectedModel?.reasoning === false ? "The selected model does not support thinking" : "Thinking level"}
            direction="up"
            value={thinkingLevel}
            display={selectedModel?.reasoning === false ? "thinking unavailable" : thinkingLevel}
            disabled={starting || !selectedModel || selectedModel.reasoning === false}
            options={thinkingLevels.map((level) => ({ value: level, label: level }))}
            onChange={(value) => {
              setThinkingTouched(true);
              setThinkingLevel(value as ThinkingLevel);
            }}
          />
          <button
            type="button"
            className={`icon-button ${pickerOpen ? "icon-button--active" : ""}`}
            onClick={() => setPickerOpen((value) => !value)}
            disabled={starting || !effectiveDirectory}
            aria-label="Add project files"
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
            {starting ? <Loader2 size={14} className="spin" aria-hidden /> : <Send size={14} aria-hidden />}
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
            disabled={starting}
          />
        </div>
        {pickerOpen && effectiveDirectory ? (
          <ProjectFilePicker
            scope={effectiveDirectory}
            selected={projectFiles}
            disabled={starting}
            search={searchProjectFiles}
            onAdd={addProjectFile}
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </form>
      {attachmentError ? <p className="welcome__error" role="alert">{attachmentError}</p> : null}
      {state.sessionActionError ? (
        <p className="welcome__error" role="alert">{state.sessionActionError}</p>
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
