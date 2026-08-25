import { FolderSearch, Paperclip, Send, Square } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { parseCompactCommand } from "../../shared/commands";
import {
  isAbortableRunState,
  isBusyRunState,
  THINKING_LEVELS,
} from "../../shared/contracts";
import { clipboardFiles } from "../clipboard-files";
import {
  type ComposerHistoryScope,
  composerHistory,
  composerHistoryScopeKey,
  hydrateComposerHistory,
  rememberComposerHistory,
} from "../composer-history";
import { shouldSubmitComposerEnter } from "../composer-keyboard";
import { sessionDraft, setSessionDraft } from "../session-drafts";
import { store, useAppState } from "../store";
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
  const historyScope = useMemo<ComposerHistoryScope | null>(
    () =>
      sessionId && state.transcriptViewId
        ? {
            sessionId,
            viewId: state.transcriptViewId,
            incarnation: state.transcriptIncarnation,
            effectiveLeafId: state.transcriptEffectiveLeafId,
          }
        : null,
    [
      sessionId,
      state.transcriptEffectiveLeafId,
      state.transcriptIncarnation,
      state.transcriptViewId,
    ],
  );
  const historyKey = historyScope
    ? composerHistoryScopeKey(historyScope)
    : null;
  // A branch view remains the same while its effective leaf advances through
  // persisted run activity. Keep the textarea instance alive across that
  // append-only movement so streaming cannot take focus or selection.
  const inputKey = useMemo(
    () =>
      JSON.stringify([
        sessionId,
        state.transcriptViewId,
        state.transcriptIncarnation,
      ]),
    [sessionId, state.transcriptIncarnation, state.transcriptViewId],
  );
  const [historyState, setHistoryState] = useState(() => ({
    key: historyKey,
    entries: historyScope ? composerHistory(historyScope) : [],
  }));
  const history =
    historyState.key === historyKey
      ? historyState.entries
      : historyScope
        ? composerHistory(historyScope)
        : [];
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
  const sessionOpening = state.sessionSelectionPending;

  // Conflict recovery keeps the existing steer-shaped keyboard path, but it
  // is not part of the host's active/queued busy ownership set.
  const composerBusy = busy || state.runState === "conflict";
  const abortable = isAbortableRunState(state.runState);
  const isRunning = state.runState === "running";
  const isRetrying = state.runState === "retrying";
  const isCompacting = state.runState === "compacting";
  const isFailed = state.runState === "failed";

  const runStateClass = isRunning
    ? "composer--running"
    : isRetrying
      ? "composer--retrying"
      : isCompacting
        ? "composer--compacting"
        : isFailed
          ? "composer--failed"
          : "";

  const updateDraft = (text: string) => {
    setDraft(text);
    if (sessionId) setSessionDraft(sessionId, text);
  };

  const previewHistory = useCallback(
    (text: string, entry: (typeof history)[number] | null) => {
      setDraft(text);
      if (historyScope) store.previewComposerHistoryEntry(historyScope, entry);
    },
    [historyScope],
  );
  const commitHistoryPreview = useCallback(() => {
    if (historyScope) store.commitComposerHistoryPreview(historyScope);
  }, [historyScope]);
  const cancelHistoryPreview = useCallback(() => {
    if (sessionId) store.cancelComposerHistoryPreview(sessionId);
  }, [sessionId]);

  useLayoutEffect(() => {
    setHistoryState({
      key: historyKey,
      entries: historyScope ? composerHistory(historyScope) : [],
    });
  }, [historyKey, historyScope]);

  useEffect(() => {
    if (!historyScope) return;
    let cancelled = false;
    void hydrateComposerHistory(historyScope, () =>
      store.loadComposerHistory(
        historyScope.sessionId,
        historyScope.viewId,
        historyScope.incarnation,
        historyScope.effectiveLeafId,
      ),
    ).then((entries) => {
      if (!cancelled) setHistoryState({ key: historyKey, entries });
    });
    return () => {
      cancelled = true;
    };
  }, [historyKey, historyScope]);

  useEffect(() => {
    const owner = sessionId;
    return () => {
      if (owner) store.cancelComposerHistoryPreview(owner);
    };
  }, [historyKey, sessionId]);

  const previousSessionRef = useRef(sessionId);
  // Restore the target draft before paint so immediate typing after navigation
  // cannot be overwritten by delayed session synchronization.
  useLayoutEffect(() => {
    if (previousSessionRef.current === sessionId) return;
    previousSessionRef.current = sessionId;
    // Every transient composer surface belongs to the session that opened it.
    // Reset before paint so it cannot silently retarget the newly visible one.
    setDraft(sessionId ? sessionDraft(sessionId) : "");
    setPickerOpen(false);
    setDropActive(false);
    setDeliveryBehavior("steer");
  }, [sessionId]);

  const previousHistoryKeyRef = useRef(historyKey);
  useLayoutEffect(() => {
    if (previousHistoryKeyRef.current === historyKey) return;
    previousHistoryKeyRef.current = historyKey;
    if (previousSessionRef.current === sessionId)
      setDraft(sessionId ? sessionDraft(sessionId) : "");
  }, [historyKey, sessionId]);

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
    !sessionOpening &&
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
    if (!canSend || state.sending || sessionOpening) return;
    const owner = sessionId;
    if (owner && sessionDraft(owner) !== message)
      setSessionDraft(owner, message);
    const sent = await store.sendPrompt(message, behavior);
    if (!sent || !owner) return;
    const recordsHistory = !(
      parseCompactCommand(message) &&
      state.attachments.length === 0 &&
      state.projectFiles.length === 0
    );
    if (recordsHistory && historyScope) {
      const entries = rememberComposerHistory(
        historyScope,
        sent.historyEntry ?? message,
      );
      setHistoryState((current) =>
        current.key === historyKey ? { key: historyKey, entries } : current,
      );
    }
    if (sessionDraft(owner) !== message) return;
    setSessionDraft(owner, "");
    if (store.getState().sessionId === owner) setDraft("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      !shouldSubmitComposerEnter(event.nativeEvent, state.prefs.desktopSendKey)
    )
      return;
    event.preventDefault();
    void submit(activeBehavior);
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
      className={`composer ${dropActive ? "composer--drop" : ""} ${runStateClass}`}
      aria-label="Message composer"
      aria-busy={busy || sessionOpening || undefined}
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
        if (!sessionOpening)
          void store.addFiles(Array.from(event.dataTransfer?.files ?? []));
      }}
    >
      <input
        key={`file-input-${sessionId ?? "none"}`}
        ref={fileInputRef}
        type="file"
        multiple
        className="composer__file-input"
        aria-label="Attach files"
        tabIndex={-1}
        disabled={sessionOpening}
        onChange={(event) => {
          void store.addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <AttachmentList
        sessionId={sessionId}
        items={state.attachments}
        disabled={state.sending || sessionOpening}
        onRemove={store.removeAttachment}
      />
      <ProjectFileChips
        paths={state.projectFiles}
        disabled={state.sending || sessionOpening}
        onRemove={store.removeProjectFile}
      />
      <ComposerInput
        key={`input-${inputKey}`}
        value={draft}
        onChange={updateDraft}
        onHistoryPreview={previewHistory}
        onHistoryCommit={commitHistoryPreview}
        onHistoryCancel={cancelHistoryPreview}
        history={history}
        commands={state.commands}
        completionDisabled={state.sending || sessionOpening}
        disabled={sessionOpening}
        completionScope={historyKey}
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
              disabled={sessionOpening}
              onClick={() => setDeliveryBehavior("steer")}
              title="Influence the task that is running now"
            >
              Steer
            </button>
            <button
              type="button"
              aria-pressed={deliveryBehavior === "followUp"}
              disabled={sessionOpening}
              onClick={() => setDeliveryBehavior("followUp")}
              title="Queue this message after the current task"
            >
              Queue
            </button>
          </div>
        </div>
      ) : null}
      <div className="composer__meta">
        <ModelSelector
          key={`model-${sessionId ?? "none"}`}
          value={activeModel}
          models={state.availableModels}
          recent={state.prefs.recentModelIds}
          disabled={sessionOpening}
          onChange={(provider, id) => void store.setModel(provider, id)}
        />
        <Dropdown
          key={`thinking-${sessionId ?? "none"}`}
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
          disabled={!thinkingSupported || sessionOpening}
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
          disabled={sessionOpening}
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
          disabled={sessionOpening}
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
            disabled={sessionOpening}
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
          disabled={state.sending || sessionOpening}
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
