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
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { INSPIRE_COMMANDS } from "../../shared/commands";
import type { ProjectFileResult } from "../api";
import {
  parseCaretCompletion,
  rankCommands,
  rankProjectFiles,
  replaceCompletionToken,
  type CaretCompletion,
} from "../composer-completion";
import { formatBytes } from "../format";
import { sessionDraft, setSessionDraft } from "../session-drafts";
import {
  isAbortableRunState,
  isBusyRunState,
  store,
  THINKING_LEVELS,
  useAppState,
  type PendingAttachment,
  type PiCommand,
} from "../store";
import { Dropdown } from "./Dropdown";
import { ModelSelector } from "./ModelSelector";

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ContextMeter() {
  const usage = useAppState().contextUsage;
  if (!usage || usage.percent === null) return null;
  const percent = Math.max(0, Math.min(100, usage.percent));
  const tone = percent >= 85 ? "meter--error" : percent >= 60 ? "meter--warning" : "";
  const tokens = usage.tokens !== null
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
  const sending = useAppState().sending;
  return (
    <li className={`attachment attachment--${item.status}`} title={item.error ?? item.fileName}>
      {item.kind === "image" && item.previewUrl ? (
        <img className="attachment__thumb" src={item.previewUrl} alt={`Preview of ${item.fileName}`} />
      ) : <FileText size={13} aria-hidden />}
      <span className="attachment__name">{item.fileName}</span>
      <span className="attachment__meta">{item.mimeType} · {formatBytes(item.size)}</span>
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
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const state = useAppState();

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const timer = setTimeout(() => {
      store.searchProjectFiles(query).then(
        (files) => {
          if (!cancelled) {
            setResults(rankProjectFiles(files, query));
            setStatus("ready");
          }
        },
        () => {
          if (!cancelled) {
            setResults([]);
            setStatus("error");
          }
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, state.sessionId]);

  useEffect(() => setResults([]), [state.sessionId]);

  return (
    <div className="picker" role="dialog" aria-label="Add project files">
      <input
        className="picker__input"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        placeholder="Search project files…"
        aria-label="Search project files"
        autoFocus
      />
      <div className="picker__list" role="listbox" aria-label="Project files" aria-busy={status === "loading"}>
        {results.map((file) => {
          const added = state.projectFiles.includes(file.path);
          return (
            <button
              type="button"
              role="option"
              aria-selected={added}
              disabled={state.sending}
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
          <div className="picker__empty" role="status">
            {status === "loading" ? "Searching…" : status === "error" ? "Project file search failed" : "No matching files"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface CompletionItem {
  key: string;
  title: string;
  hint?: string;
  group: string;
  file?: ProjectFileResult;
  command?: PiCommand;
}

function CompletionMenu({
  id,
  token,
  items,
  active,
  status,
  onActive,
  onPick,
}: {
  id: string;
  token: CaretCompletion;
  items: CompletionItem[];
  active: number;
  status: "loading" | "ready" | "error";
  onActive: (index: number) => void;
  onPick: (item: CompletionItem) => void;
}) {
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    refs.current[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  let previousGroup = "";
  return (
    <div className="completion" id={id} role="listbox" aria-label={token.kind === "file" ? "Project file completions" : "Slash command completions"} aria-busy={status === "loading"}>
      {items.map((item, index) => {
        const heading = item.group !== previousGroup;
        previousGroup = item.group;
        return (
          <div key={item.key}>
            {heading ? <div className="completion__heading" aria-hidden>{item.group}</div> : null}
            <div
              ref={(element) => { refs.current[index] = element; }}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === active}
              className={`completion__option ${index === active ? "completion__option--active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onActive(index)}
              onClick={() => onPick(item)}
            >
              <span className="completion__title">{item.title}</span>
              {item.hint ? <span className="completion__hint">{item.hint}</span> : null}
            </div>
          </div>
        );
      })}
      {items.length === 0 ? (
        <div className={`completion__empty ${status === "error" ? "completion__empty--error" : ""}`} role="status">
          {status === "loading" ? "Searching project files…" : status === "error" ? "Project file search failed" : token.kind === "file" ? "No matching project files" : "No matching commands"}
        </div>
      ) : null}
    </div>
  );
}

export function Composer() {
  const state = useAppState();
  const sessionId = state.sessionId;
  const completionId = useId();
  const [draft, setDraft] = useState(() => (sessionId ? sessionDraft(sessionId) : ""));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [completion, setCompletion] = useState<CaretCompletion | null>(null);
  const [completionFiles, setCompletionFiles] = useState<ProjectFileResult[]>([]);
  const [completionStatus, setCompletionStatus] = useState<"loading" | "ready" | "error">("ready");
  const [completionActive, setCompletionActive] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const busy = isBusyRunState(state.runState);
  // Conflict recovery keeps the existing steer-shaped keyboard path, but it
  // is not part of the host's active/queued busy ownership set.
  const composerBusy = busy || state.runState === "conflict";
  const abortable = isAbortableRunState(state.runState);

  const updateDraft = (text: string) => {
    setDraft(text);
    if (sessionId) setSessionDraft(sessionId, text);
  };

  const updateCompletion = (value: string, caret: number | null) => {
    if (composingRef.current || state.sending || caret === null) {
      setCompletion(null);
      return;
    }
    setCompletion(parseCaretCompletion(value, caret));
  };

  const previousSessionRef = useRef(sessionId);
  useEffect(() => {
    if (previousSessionRef.current === sessionId) return;
    previousSessionRef.current = sessionId;
    setDraft(sessionId ? sessionDraft(sessionId) : "");
    setCompletion(null);
  }, [sessionId]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [draft]);

  const editorNonce = state.editorText?.nonce;
  useEffect(() => {
    if (state.editorText) {
      updateDraft(state.editorText.text);
      setCompletion(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorNonce]);

  const commands = useMemo<PiCommand[]>(() => {
    const byName = new Map<string, PiCommand>();
    // Pi dispatches the first matching extension command before prompt/skill
    // resources, so preserve first wire occurrence for every authoritative
    // collision rather than letting a later source rewrite execution truth.
    for (const command of state.commands) {
      if (!byName.has(command.name)) byName.set(command.name, command);
    }
    // Host behavior explicitly overrides Pi for `/compact`, which inspire
    // intercepts at the prompt boundary before Pi dispatch.
    for (const command of INSPIRE_COMMANDS) byName.set(command.name, command);
    return [...byName.values()];
  }, [state.commands]);

  useEffect(() => {
    if (completion?.kind !== "file") {
      setCompletionFiles([]);
      setCompletionStatus("ready");
      return;
    }
    let cancelled = false;
    setCompletionFiles([]);
    setCompletionStatus("loading");
    const timer = setTimeout(() => {
      store.searchProjectFiles(completion.query).then(
        (files) => {
          if (!cancelled) {
            setCompletionFiles(rankProjectFiles(files, completion.query));
            setCompletionStatus("ready");
          }
        },
        () => {
          if (!cancelled) setCompletionStatus("error");
        },
      );
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [completion, sessionId]);

  const completionItems = useMemo<CompletionItem[]>(() => {
    if (!completion) return [];
    if (completion.kind === "file") {
      return completionFiles.map((file) => ({
        key: file.path,
        title: file.name,
        hint: file.path,
        group: "Project files",
        file,
      }));
    }
    const ranked = rankCommands(commands, completion.query);
    if (!completion.query.trim()) {
      const sourceOrder = new Map(["inspire", "extension", "prompt", "skill"].map((source, index) => [source, index]));
      ranked.sort((left, right) =>
        (sourceOrder.get(left.source ?? "") ?? 99) - (sourceOrder.get(right.source ?? "") ?? 99),
      );
    }
    return ranked.map((command) => ({
      key: `${command.source ?? "command"}:${command.name}`,
      title: `/${command.name}`,
      hint: command.description,
      group: command.source ? `${command.source[0]!.toUpperCase()}${command.source.slice(1)}` : "Command",
      command,
    }));
  }, [completion, completionFiles, commands]);

  useEffect(() => setCompletionActive(0), [completion?.kind, completion?.query]);
  const activeIndex = Math.min(completionActive, Math.max(0, completionItems.length - 1));

  const pickCompletion = (item: CompletionItem | undefined) => {
    if (!item || !completion || state.sending) return;
    if (item.file) store.addProjectFile(item.file.path);
    const existingDelimiter = draft[completion.end];
    const reusesInlineDelimiter = Boolean(item.command && existingDelimiter && /[ \t]/.test(existingDelimiter));
    const replacement = item.command
      ? `/${item.command.name}${reusesInlineDelimiter ? "" : " "}`
      : "";
    const inserted = replaceCompletionToken(draft, completion, replacement);
    const next = reusesInlineDelimiter ? { ...inserted, caret: inserted.caret + 1 } : inserted;
    updateDraft(next.value);
    setCompletion(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const canSend = Boolean(sessionId && (draft.trim() || state.attachments.length > 0 || state.projectFiles.length > 0));
  const submit = async (behavior?: "steer" | "followUp") => {
    const message = draft;
    if (!canSend || state.sending) return;
    setCompletion(null);
    const owner = sessionId;
    const sent = await store.sendPrompt(message, behavior);
    if (!sent || !owner) return;
    if (sessionDraft(owner) !== message) return;
    setSessionDraft(owner, "");
    if (store.getState().sessionId === owner) setDraft("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composingRef.current) return;
    if (completion) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCompletion(null);
        return;
      }
      if (event.key === "ArrowDown" && completionItems.length > 0) {
        event.preventDefault();
        setCompletionActive((index) => Math.min(index + 1, completionItems.length - 1));
        return;
      }
      if (event.key === "ArrowUp" && completionItems.length > 0) {
        event.preventDefault();
        setCompletionActive((index) => Math.max(0, index - 1));
        return;
      }
      if (((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) && completionItems[activeIndex]) {
        event.preventDefault();
        pickCompletion(completionItems[activeIndex]);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (composerBusy && (event.ctrlKey || event.metaKey)) void submit("followUp");
    else void submit(composerBusy ? "steer" : undefined);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void store.addFiles(files);
  };

  const activeModel = state.model
    ? state.availableModels.find((model) => model.provider === state.model?.provider && model.id === state.model?.id) ?? state.model
    : null;
  const thinkingSupported = activeModel?.reasoning !== false;

  return (
    <form
      className={`composer ${dropActive ? "composer--drop" : ""}`}
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(composerBusy ? "steer" : undefined);
      }}
      onDragOver={(event) => { event.preventDefault(); setDropActive(true); }}
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
          {state.attachments.map((item) => <AttachmentChip key={item.localId} item={item} />)}
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
                disabled={state.sending}
                onClick={() => store.removeProjectFile(path)}
                aria-label={`Remove ${path}`}
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className="composer__input-wrap"
        role="combobox"
        aria-label="Message completion"
        aria-haspopup="listbox"
        aria-expanded={Boolean(completion)}
        aria-owns={completion ? completionId : undefined}
      >
        <textarea
          ref={textareaRef}
          className="composer__input"
          aria-autocomplete="list"
          aria-controls={completion ? completionId : undefined}
          aria-activedescendant={completion && completionItems[activeIndex] ? `${completionId}-option-${activeIndex}` : undefined}
          rows={1}
          value={draft}
          placeholder={composerBusy ? "Steer the running task — Ctrl+Enter queues a follow-up" : "Message Pi…"}
          onChange={(event) => {
            updateDraft(event.target.value);
            updateCompletion(event.target.value, event.target.selectionStart);
          }}
          onSelect={(event) => updateCompletion(event.currentTarget.value, event.currentTarget.selectionStart)}
          onKeyUp={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              updateCompletion(event.currentTarget.value, event.currentTarget.selectionStart);
            }
          }}
          onCompositionStart={() => { composingRef.current = true; setCompletion(null); }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            updateCompletion(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label="Message"
        />
      </div>
      <div className="composer__meta">
        <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()} aria-label="Attach files" title="Attach files (or paste / drop them)">
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
        <ModelSelector
          value={activeModel}
          models={state.availableModels}
          recent={state.prefs.recentModelIds}
          onChange={(provider, id) => void store.setModel(provider, id)}
        />
        <Dropdown
          label="Thinking level"
          title={thinkingSupported ? "Thinking level" : "The active model does not support thinking"}
          direction="up"
          value={state.thinkingLevel}
          display={thinkingSupported ? state.thinkingLevel : "thinking unavailable"}
          disabled={!thinkingSupported}
          options={THINKING_LEVELS.map((level) => ({ value: level, label: level }))}
          onChange={(value) => void store.setThinkingLevel(value)}
        />
        <span className="composer__spacer" />
        <ContextMeter />
        {abortable ? (
          <button
            type="button"
            className={`composer__send ${state.runState === "conflict" ? "composer__send--recover" : "composer__send--abort"}`}
            onClick={() => void store.abort()}
            aria-label={state.runState === "conflict" ? "Recover session" : "Abort running task"}
            title={state.runState === "conflict" ? "Recover session" : "Abort"}
          >
            <Square size={14} aria-hidden />
          </button>
        ) : (
          <button type="submit" className="composer__send" disabled={!canSend || state.sending} aria-label="Send message" title="Send">
            <Send size={14} aria-hidden />
          </button>
        )}
      </div>
      {completion ? (
        <CompletionMenu
          id={completionId}
          token={completion}
          items={completionItems}
          active={activeIndex}
          status={completion.kind === "file" ? completionStatus : "ready"}
          onActive={setCompletionActive}
          onPick={pickCompletion}
        />
      ) : null}
      {pickerOpen ? <ProjectFilePicker onClose={() => setPickerOpen(false)} /> : null}
    </form>
  );
}
