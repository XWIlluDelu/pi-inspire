import {
  AlertTriangle,
  FileText,
  FolderSearch,
  Loader2,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProjectFileResult } from "../api";
import { formatBytes } from "../format";
import { isBusyRunState, store, THINKING_LEVELS, useAppState, type PendingAttachment } from "../store";
import { Dropdown } from "./Dropdown";

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Context-window occupancy: a small ring plus percent, colored by how full
 * the window is. Hidden while Pi has no fresh usage data (no stats yet, or
 * immediately after a compaction). */
function ContextMeter() {
  const state = useAppState();
  const usage = state.contextUsage;
  if (!usage || usage.percent === null) return null;
  const percent = Math.max(0, Math.min(100, usage.percent));
  const tone = percent >= 85 ? "meter--error" : percent >= 60 ? "meter--warning" : "";
  const tokens =
    usage.tokens !== null
      ? `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`
      : `${usage.contextWindow.toLocaleString()}-token window`;
  return (
    <div
      className={`meter ${tone}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      title={`Context ${Math.round(percent)}% full (${tokens}) — type /compact to summarize`}
      aria-label={`Context ${Math.round(percent)} percent full`}
    >
      <svg className="meter__ring" viewBox="0 0 14 14" aria-hidden>
        <circle className="meter__ring-track" cx="7" cy="7" r={RING_RADIUS} />
        <circle
          className="meter__ring-fill"
          cx="7"
          cy="7"
          r={RING_RADIUS}
          strokeDasharray={`${(percent / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
      <span aria-hidden>{Math.round(percent)}%</span>
    </div>
  );
}

function AttachmentChip({ item }: { item: PendingAttachment }) {
  // Withdrawal freezes while a prompt is delivering; the host may be
  // resolving this file into the outgoing message.
  const sending = useAppState().sending;
  return (
    <li className={`attachment attachment--${item.status}`} title={item.error ?? item.fileName}>
      {item.kind === "image" && item.previewUrl ? (
        <img className="attachment__thumb" src={item.previewUrl} alt={`Preview of ${item.fileName}`} />
      ) : (
        <FileText size={13} aria-hidden />
      )}
      <span className="attachment__name">{item.fileName}</span>
      <span className="attachment__meta">
        {item.mimeType} · {formatBytes(item.size)}
      </span>
      {item.status === "uploading" ? <Loader2 size={12} className="spin" aria-label="Uploading" /> : null}
      {item.status === "error" ? <AlertTriangle size={12} className="status-error" aria-label="Upload failed" /> : null}
      <button
        type="button"
        className="attachment__remove"
        disabled={sending}
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
    // Re-scoped to the visible session: switching cancels the in-flight search
    // (its results would be another session's paths) and re-queries the new
    // workspace.
  }, [query, state.sessionId]);

  // A session switch invalidates the currently listed paths immediately, so
  // none of session A's files can be picked while session B is visible.
  useEffect(() => {
    setResults([]);
  }, [state.sessionId]);

  return (
    <div className="picker" role="dialog" aria-label="Add project files">
      <input
        className="picker__input"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault(); // closing the picker must not trigger the global Escape abort
            onClose();
          }
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

/** Unsent composer text, per session. In-memory only: a draft survives
 * switching between concurrent sessions, not a page reload. */
const sessionDrafts = new Map<string, string>();

export function Composer() {
  const state = useAppState();
  const sessionId = state.sessionId;
  const [draft, setDraft] = useState(() => (sessionId ? (sessionDrafts.get(sessionId) ?? "") : ""));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = isBusyRunState(state.runState);

  // Write-through: the map always mirrors the textarea, so a session switch
  // only needs to load the destination's draft.
  const updateDraft = (text: string) => {
    setDraft(text);
    if (!sessionId) return;
    if (text) sessionDrafts.set(sessionId, text);
    else sessionDrafts.delete(sessionId);
  };

  const previousSessionRef = useRef(sessionId);
  useEffect(() => {
    if (previousSessionRef.current === sessionId) return;
    previousSessionRef.current = sessionId;
    setDraft(sessionId ? (sessionDrafts.get(sessionId) ?? "") : "");
  }, [sessionId]);

  // Display names drop the provider prefix; it returns only when two
  // providers offer the same model id.
  const modelIdCounts = new Map<string, number>();
  for (const model of state.availableModels) {
    modelIdCounts.set(model.id, (modelIdCounts.get(model.id) ?? 0) + 1);
  }
  const modelLabel = (model: { provider: string; id: string; name?: string }) =>
    (modelIdCounts.get(model.id) ?? 0) > 1 ? `${model.name ?? model.id} (${model.provider})` : (model.name ?? model.id);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [draft]);

  // Extensions can place text into the composer (set_editor_text).
  const editorNonce = state.editorText?.nonce;
  useEffect(() => {
    if (state.editorText) updateDraft(state.editorText.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorNonce]);

  const canSend = Boolean(
    state.sessionId && (draft.trim() || state.attachments.length > 0 || state.projectFiles.length > 0),
  );

  const submit = async (behavior?: "steer" | "followUp") => {
    const message = draft;
    if (!canSend || state.sending) return;
    const owner = sessionId;
    const sent = await store.sendPrompt(message, behavior);
    if (!sent || !owner) return; // failed sends keep the draft and attachments intact
    // Clear the sent text only if nothing new was typed while the send was in
    // flight — the textarea stays editable during delivery, and a changed
    // draft belongs to the next message.
    if ((sessionDrafts.get(owner) ?? "") !== message) return;
    sessionDrafts.delete(owner);
    // A slow send may settle after a session switch; only the owner's visible
    // textarea clears, never the session the user is typing in now.
    if (store.getState().sessionId === owner) setDraft("");
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
        placeholder={busy ? "Steer the running task — Ctrl+Enter queues a follow-up" : "Message Pi…"}
        onChange={(event) => updateDraft(event.target.value)}
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
        <Dropdown
          label="Model"
          title="Model"
          direction="up"
          value={modelValue}
          display={state.model ? modelLabel(state.model) : "No session model"}
          disabled={state.availableModels.length === 0}
          options={state.availableModels.map((model) => ({
            value: `${model.provider}:${model.id}`,
            label: modelLabel(model),
          }))}
          onChange={(value) => {
            const [provider, ...rest] = value.split(":");
            if (provider && rest.length) void store.setModel(provider, rest.join(":"));
          }}
        />
        <Dropdown
          label="Thinking level"
          title="Thinking level"
          direction="up"
          value={state.thinkingLevel}
          options={THINKING_LEVELS.map((level) => ({ value: level, label: level }))}
          onChange={(value) => void store.setThinkingLevel(value)}
        />
        <span className="composer__spacer" />
        <ContextMeter />
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
            disabled={!canSend || state.sending}
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
