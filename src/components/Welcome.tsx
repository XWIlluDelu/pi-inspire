import { ChevronRight, FolderOpen, Loader2, Paperclip, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_ATTACHMENTS,
  THINKING_LEVELS,
  modelIdentityKey,
  type ModelOption,
  type ThinkingLevel,
} from "../../shared/contracts";
import { clipboardFiles } from "../clipboard-files";
import { supportedThinkingLevels } from "../model-options";
import { setSessionDraft } from "../session-drafts";
import { store, useAppState, type PendingAttachment } from "../store";
import { AttachmentList } from "./AttachmentList";
import { DirectoryPicker } from "./DirectoryPicker";
import { Dropdown } from "./Dropdown";
import { ModelSelector } from "./ModelSelector";
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

/** Landing composer. Its staged files remain browser-local until Pi has
 * assigned the new session identity, then enter the normal attachment owner
 * and prompt lifecycle before the first message is delivered. */
export function Welcome({ showRecent = true }: { showRecent?: boolean }) {
  const state = useAppState();
  const [draft, setDraft] = useState("");
  const [directory, setDirectory] = useState("");
  const [attachments, setAttachments] = useState<WelcomeAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [recentOpen, setRecentOpen] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [modelKey, setModelKey] = useState(() => state.model ? modelIdentityKey(state.model) : "");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() =>
    THINKING_LEVELS.includes(state.thinkingLevel as ThinkingLevel)
      ? state.thinkingLevel as ThinkingLevel
      : "off",
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const recent = state.sessions.slice(0, 6);
  const selectedModel = useMemo<ModelOption | null>(() => {
    const catalogModel = state.availableModels.find((model) => modelIdentityKey(model) === modelKey);
    if (catalogModel) return catalogModel;
    return state.model && modelIdentityKey(state.model) === modelKey ? state.model : null;
  }, [modelKey, state.availableModels, state.model]);
  const thinkingLevels = useMemo(() => supportedThinkingLevels(selectedModel), [selectedModel]);

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, Math.round(window.innerHeight * 0.45))}px`;
  }, [draft]);

  useEffect(() => {
    if (!thinkingLevels.includes(thinkingLevel)) setThinkingLevel(thinkingLevels[0] ?? "off");
  }, [thinkingLevel, thinkingLevels]);

  const addFiles = (files: File[]) => {
    if (starting || files.length === 0) return;
    const room = MAX_ATTACHMENTS - attachmentsRef.current.length;
    const accepted = files.slice(0, Math.max(0, room));
    setAttachmentError(accepted.length < files.length ? `At most ${MAX_ATTACHMENTS} attachments per message` : null);
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

  // A typed directory wins over the current project; empty means current.
  const canStart = Boolean((draft.trim() || attachments.length > 0) && (directory.trim() || state.cwd) && !starting);

  const start = async () => {
    if (!canStart) return;
    const message = draft;
    const files = attachments.map((attachment) => attachment.file);
    const target = directory.trim();
    setStarting(true);
    try {
      const opened = await store.newSession(target || undefined, {
        ...(selectedModel ? { model: { provider: selectedModel.provider, id: selectedModel.id } } : {}),
        ...(selectedModel && selectedModel.reasoning !== false ? { thinkingLevel } : {}),
      });
      if (!opened) return;

      // The ordinary composer may mount before this async continuation. Drive
      // both its durable browser draft and its live nonce channel, then let the
      // normal upload/send path own all host attachment state.
      setSessionDraft(opened, message);
      store.replaceComposerText(message);
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
        <Wordmark large />
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
        <textarea
          ref={textareaRef}
          className="composer__input"
          rows={3}
          value={draft}
          placeholder="What do you want to work on?"
          aria-label="First message"
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
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
          <input
            className="welcome__dir"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder={state.cwd ?? "/path/to/project"}
            aria-label="Project directory"
            spellCheck={false}
            disabled={starting}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Browse host directories"
            title="Browse host directories"
            disabled={starting}
            onClick={() => setBrowsing(true)}
          >
            <FolderOpen size={14} aria-hidden />
          </button>
          <ModelSelector
            value={selectedModel}
            models={state.availableModels}
            recent={state.prefs.recentModelIds}
            emptyLabel="Select model"
            disabled={starting}
            onChange={(provider, id) => setModelKey(modelIdentityKey({ provider, id }))}
          />
          <Dropdown
            label="Thinking level"
            title={selectedModel?.reasoning === false ? "The selected model does not support thinking" : "Thinking level"}
            direction="up"
            value={thinkingLevel}
            display={selectedModel?.reasoning === false ? "thinking unavailable" : thinkingLevel}
            disabled={starting || selectedModel?.reasoning === false}
            options={thinkingLevels.map((level) => ({ value: level, label: level }))}
            onChange={(value) => setThinkingLevel(value as ThinkingLevel)}
          />
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
      {attachmentError ? <p className="welcome__error" role="alert">{attachmentError}</p> : null}
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
