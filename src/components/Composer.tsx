import { AlertTriangle, FileText, FolderSearch, Loader2, Paperclip, Send, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProjectFileResult } from "../api";
import { isBusyRunState, store, THINKING_LEVELS, useAppState, type PendingAttachment } from "../store";

function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function AttachmentChip({ item }: { item: PendingAttachment }) {
  return (
    <li className={`attachment attachment--${item.status}`} title={item.error ?? item.fileName}>
      {item.kind === "image" && item.previewUrl ? (
        <img className="attachment__thumb" src={item.previewUrl} alt={`Preview of ${item.fileName}`} />
      ) : (
        <FileText size={13} aria-hidden />
      )}
      <span className="attachment__name">{item.fileName}</span>
      <span className="attachment__meta">
        {item.mimeType} · {formatSize(item.size)}
      </span>
      {item.status === "uploading" ? <Loader2 size={12} className="spin" aria-label="Uploading" /> : null}
      {item.status === "error" ? <AlertTriangle size={12} className="status-error" aria-label="Upload failed" /> : null}
      <button
        type="button"
        className="attachment__remove"
        onClick={() => store.removeAttachment(item.localId)}
        aria-label={`Remove ${item.fileName}`}
      >
        <X size={12} aria-hidden />
      </button>
    </li>
  );
}

function ProjectFilePicker({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProjectFileResult[]>([]);
  const [searching, setSearching] = useState(false);
  const state = useAppState();

  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      store
        .searchProjectFiles(query)
        .then((files) => {
          if (!cancelled) setResults(files);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="picker" role="dialog" aria-label="Add project files">
      <input
        className="picker__input"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        placeholder="Search project files…"
        aria-label="Search project files"
        autoFocus
      />
      <div className="picker__list" role="listbox" aria-label="Project files">
        {results.map((file) => {
          const added = state.projectFiles.includes(file.path);
          return (
            <button
              type="button"
              role="option"
              aria-selected={added}
              key={file.path}
              className={`picker__row ${added ? "picker__row--added" : ""}`}
              onClick={() => store.addProjectFile(file.path)}
            >
              <span className="picker__name">{file.name}</span>
              <span className="picker__path">{file.path}</span>
            </button>
          );
        })}
        {results.length === 0 ? (
          <div className="picker__empty">{searching ? "Searching…" : "No matching files"}</div>
        ) : null}
      </div>
    </div>
  );
}

export function Composer() {
  const state = useAppState();
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = isBusyRunState(state.runState);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [draft]);

  // Extensions can place text into the composer (set_editor_text).
  const editorNonce = state.editorText?.nonce;
  useEffect(() => {
    if (state.editorText) setDraft(state.editorText.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorNonce]);

  const canSend = Boolean(
    state.sessionId && (draft.trim() || state.attachments.length > 0 || state.projectFiles.length > 0),
  );

  const submit = async (behavior?: "steer" | "followUp") => {
    const message = draft;
    if (!canSend) return;
    const sent = await store.sendPrompt(message, behavior);
    if (sent) setDraft(""); // failed sends keep the draft and attachments intact
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey) return; // newline
    event.preventDefault();
    if (busy && (event.ctrlKey || event.metaKey)) void submit("followUp");
    else void submit(busy ? "steer" : undefined);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void store.addFiles(files);
  };

  const modelValue = state.model ? `${state.model.provider}:${state.model.id}` : "";

  return (
    <form
      className={`composer ${dropActive ? "composer--drop" : ""}`}
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(busy ? "steer" : undefined);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDropActive(false);
        void store.addFiles(Array.from(event.dataTransfer?.files ?? []));
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
          void store.addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      {state.attachments.length > 0 ? (
        <ul className="composer__attachments" aria-label="Attachments">
          {state.attachments.map((item) => (
            <AttachmentChip key={item.localId} item={item} />
          ))}
        </ul>
      ) : null}
      {state.projectFiles.length > 0 ? (
        <ul className="composer__attachments" aria-label="Referenced project files">
          {state.projectFiles.map((path) => (
            <li key={path} className="attachment attachment--ready" title={path}>
              <FolderSearch size={13} aria-hidden />
              <span className="attachment__name">{path}</span>
              <span className="attachment__meta">project file</span>
              <button
                type="button"
                className="attachment__remove"
                onClick={() => store.removeProjectFile(path)}
                aria-label={`Remove ${path}`}
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={textareaRef}
        className="composer__input"
        rows={1}
        value={draft}
        placeholder={
          busy ? "Steer the running task… (Ctrl+Enter to queue a follow-up)" : "Message Pi… (paste or drop files to attach)"
        }
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        aria-label="Message"
      />
      <div className="composer__meta">
        <button
          type="button"
          className="icon-button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach files"
          title="Attach files (or paste / drop them)"
        >
          <Paperclip size={14} aria-hidden />
        </button>
        <button
          type="button"
          className={`icon-button ${pickerOpen ? "icon-button--active" : ""}`}
          onClick={() => setPickerOpen((value) => !value)}
          aria-label="Add project files"
          aria-expanded={pickerOpen}
          title="Reference project files"
        >
          <FolderSearch size={14} aria-hidden />
        </button>
        <select
          className="composer__select"
          aria-label="Model"
          value={modelValue}
          onChange={(event) => {
            const [provider, ...rest] = event.target.value.split(":");
            if (provider && rest.length) void store.setModel(provider, rest.join(":"));
          }}
          disabled={state.availableModels.length === 0}
        >
          {state.availableModels.length === 0 ? (
            <option value="">{state.model ? `${state.model.provider}/${state.model.id}` : "No session model"}</option>
          ) : (
            state.availableModels.map((model) => (
              <option key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>
                {model.name ?? `${model.provider}/${model.id}`}
              </option>
            ))
          )}
        </select>
        <select
          className="composer__select"
          aria-label="Thinking level"
          value={state.thinkingLevel}
          onChange={(event) => void store.setThinkingLevel(event.target.value)}
        >
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              thinking: {level}
            </option>
          ))}
        </select>
        {state.project ? <span className="composer__project">{state.project}</span> : null}
        <span className="composer__spacer" />
        {busy ? (
          <button
            type="button"
            className="composer__send composer__send--abort"
            onClick={() => void store.abort()}
            aria-label="Abort running task"
            title="Abort"
          >
            <Square size={14} aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            className="composer__send"
            disabled={!canSend}
            aria-label="Send message"
            title="Send"
          >
            <Send size={14} aria-hidden />
          </button>
        )}
      </div>
      {pickerOpen ? <ProjectFilePicker onClose={() => setPickerOpen(false)} /> : null}
    </form>
  );
}
