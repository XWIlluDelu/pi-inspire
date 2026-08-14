import { FolderSearch, Paperclip, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { clipboardFiles } from "../clipboard-files";
import { sessionDraft, setSessionDraft } from "../session-drafts";
import {
  isAbortableRunState,
  isBusyRunState,
  store,
  THINKING_LEVELS,
  useAppState,
} from "../store";
import { AttachmentList } from "./AttachmentList";
import { ComposerInput } from "./ComposerInput";
import { Dropdown } from "./Dropdown";
import { ModelSelector } from "./ModelSelector";
import { ProjectFileChips, ProjectFilePicker } from "./ProjectFiles";

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ContextMeter() {
  const usage = useAppState().contextUsage;
  if (!usage || usage.percent === null) return null;
  const percent = Math.max(0, Math.min(100, usage.percent));
  const tone =
    percent >= 85 ? "meter--error" : percent >= 60 ? "meter--warning" : "";
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

export function Composer() {
  const state = useAppState();
  const sessionId = state.sessionId;
  const [draft, setDraft] = useState(() =>
    sessionId ? sessionDraft(sessionId) : "",
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [deliveryBehavior, setDeliveryBehavior] = useState<
    "steer" | "followUp"
  >("steer");
  const wasBusyRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectPickerButtonRef = useRef<HTMLButtonElement>(null);
  const busy = isBusyRunState(state.runState);
  // Conflict recovery keeps the existing steer-shaped keyboard path, but it
  // is not part of the host's active/queued busy ownership set.
  const composerBusy = busy || state.runState === "conflict";
  const abortable = isAbortableRunState(state.runState);

  const updateDraft = (text: string) => {
    setDraft(text);
    if (sessionId) setSessionDraft(sessionId, text);
  };

  const previousSessionRef = useRef(sessionId);
  useEffect(() => {
    if (previousSessionRef.current === sessionId) return;
    previousSessionRef.current = sessionId;
    setDraft(sessionId ? sessionDraft(sessionId) : "");
  }, [sessionId]);

  useEffect(() => {
    setDeliveryBehavior("steer");
  }, [sessionId]);

  useEffect(() => {
    if (busy && !wasBusyRef.current) setDeliveryBehavior("steer");
    wasBusyRef.current = busy;
  }, [busy]);

  const editorNonce = state.editorText?.nonce;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Pi's nonce is the editor-delivery revision; same-nonce payload changes must not replace a draft.
  useEffect(() => {
    if (state.editorText) updateDraft(state.editorText.text);
  }, [editorNonce]);

  const canSend = Boolean(
    sessionId &&
      (draft.trim() ||
        state.attachments.length > 0 ||
        state.projectFiles.length > 0),
  );
  const activeBehavior = busy
    ? deliveryBehavior
    : composerBusy
      ? "steer"
      : undefined;
  const submit = async (behavior?: "steer" | "followUp") => {
    const message = draft;
    if (!canSend || state.sending) return;
    const owner = sessionId;
    const sent = await store.sendPrompt(message, behavior);
    if (!sent || !owner) return;
    if (sessionDraft(owner) !== message) return;
    setSessionDraft(owner, "");
    if (store.getState().sessionId === owner) setDraft("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (composerBusy && (event.ctrlKey || event.metaKey))
      void submit("followUp");
    else void submit(activeBehavior);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void store.addFiles(files);
  };

  const activeModel = state.model
    ? (state.availableModels.find(
        (model) =>
          model.provider === state.model?.provider &&
          model.id === state.model?.id,
      ) ?? state.model)
    : null;
  const thinkingSupported = activeModel?.reasoning !== false;

  return (
    <form
      className={`composer ${dropActive ? "composer--drop" : ""}`}
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(activeBehavior);
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
      <AttachmentList
        items={state.attachments}
        disabled={state.sending}
        onRemove={store.removeAttachment}
      />
      <ProjectFileChips
        paths={state.projectFiles}
        disabled={state.sending}
        onRemove={store.removeProjectFile}
      />
      <ComposerInput
        value={draft}
        onChange={updateDraft}
        commands={state.commands}
        completionDisabled={state.sending}
        completionScope={sessionId}
        searchProjectFiles={store.searchProjectFiles}
        onPickProjectFile={(file) => store.addProjectFile(file.path)}
        placeholder={
          busy
            ? deliveryBehavior === "steer"
              ? "Add direction to the running task…"
              : "Add a follow-up for after this task…"
            : "Message Pi…"
        }
        label="Message"
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {busy ? (
        <div className="composer__delivery">
          <div className="segmented" role="group" aria-label="Message delivery">
            <button
              type="button"
              aria-pressed={deliveryBehavior === "steer"}
              onClick={() => setDeliveryBehavior("steer")}
              title="Influence the task that is running now"
            >
              Steer
            </button>
            <button
              type="button"
              aria-pressed={deliveryBehavior === "followUp"}
              onClick={() => setDeliveryBehavior("followUp")}
              title="Queue this message after the current task"
            >
              Queue next
            </button>
          </div>
        </div>
      ) : null}
      <div className="composer__meta">
        <ModelSelector
          value={activeModel}
          models={state.availableModels}
          recent={state.prefs.recentModelIds}
          onChange={(provider, id) => void store.setModel(provider, id)}
        />
        <Dropdown
          label="Thinking level"
          title={
            thinkingSupported
              ? "Thinking level"
              : "The active model does not support thinking"
          }
          direction="up"
          value={state.thinkingLevel}
          display={
            thinkingSupported ? state.thinkingLevel : "thinking unavailable"
          }
          disabled={!thinkingSupported}
          options={THINKING_LEVELS.map((level) => ({
            value: level,
            label: level,
          }))}
          onChange={(value) => void store.setThinkingLevel(value)}
        />
        <button
          ref={projectPickerButtonRef}
          type="button"
          className={`icon-button ${pickerOpen ? "icon-button--active" : ""}`}
          onClick={() => setPickerOpen((value) => !value)}
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
          aria-label="Attach files"
          title="Attach files (or paste / drop them)"
        >
          <Paperclip size={14} aria-hidden />
        </button>
        <span className="composer__spacer" />
        <ContextMeter />
        {busy ? (
          <button
            type="submit"
            className="composer__send"
            disabled={!canSend || state.sending}
            aria-label={
              deliveryBehavior === "steer"
                ? "Send as steer"
                : "Queue after current task"
            }
            title={
              deliveryBehavior === "steer"
                ? "Send as steer"
                : "Queue after current task"
            }
          >
            <Send size={14} aria-hidden />
          </button>
        ) : null}
        {abortable ? (
          <button
            type="button"
            className={`composer__send ${state.runState === "conflict" ? "composer__send--recover" : "composer__send--abort"}`}
            onClick={() => void store.abort()}
            aria-label={
              state.runState === "conflict"
                ? "Recover session"
                : "Abort running task"
            }
            title={state.runState === "conflict" ? "Recover session" : "Abort"}
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
      {pickerOpen && sessionId ? (
        <ProjectFilePicker
          scope={sessionId}
          selected={state.projectFiles}
          disabled={state.sending}
          search={store.searchProjectFiles}
          onAdd={(file) => store.addProjectFile(file.path)}
          onClose={() => {
            setPickerOpen(false);
            requestAnimationFrame(() =>
              projectPickerButtonRef.current?.focus(),
            );
          }}
        />
      ) : null}
    </form>
  );
}
