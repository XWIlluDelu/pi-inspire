import { History, Square } from "lucide-react";
import {
  memo,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type ComposerHistoryEntry,
  isAbortableRunState,
  isBusyRunState,
} from "../../shared/contracts";
import { contextUsage, selectedRunState } from "../app-state";
import {
  type ComposerHistoryScope,
  recentComposerHistory,
} from "../composer-history";
import { isComposingKeyboardEvent } from "../keyboard-input";
import {
  resolveModelMetadata,
  supportedThinkingLevels,
} from "../model-options";
import { hasDraftInput, useSessionDraft } from "../session-drafts";
import { shallowEqual, store, useAppState } from "../store";
import { hasActiveModal } from "../use-modal-focus";
import { ComposerHistoryDialog } from "./ComposerHistoryDialog";
import { ComposerThinkingControl } from "./ComposerThinkingControl";
import { MessageEditor } from "./MessageEditor";
import { ModelSelector } from "./ModelSelector";

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function DeliveryNotice({
  text,
  children,
}: {
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="composer__failed-delivery" role="status">
      <span>{text}</span>
      {children}
    </div>
  );
}

const ContextMeter = memo(function ContextMeter() {
  const { stats, model, sessionId } = useAppState(
    (state) => ({
      stats: state.sessionStats,
      model: state.model,
      sessionId: state.sessionId,
    }),
    shallowEqual,
  );
  const usage = contextUsage(stats);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  useEffect(() => setOpen(false), [sessionId]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismissKey = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        isComposingKeyboardEvent(event) ||
        hasActiveModal()
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    // Focused controls dismiss first; the hint precedes window-level Stop.
    document.addEventListener("keydown", dismissKey);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissKey);
    };
  }, [open]);
  if (!usage) return null;
  const percent = usage.percent;
  const fillPercent = Math.max(0, Math.min(100, percent ?? 0));
  const tone =
    percent !== null && percent >= 85
      ? "meter--error"
      : percent !== null && percent >= 60
        ? "meter--warning"
        : "";
  const tokens = `${usage.tokens?.toLocaleString() ?? "—"} / ${usage.contextWindow.toLocaleString()} tokens`;
  return (
    <div
      className="meter-anchor"
      ref={rootRef}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (
          event.pointerType !== "touch" &&
          !rootRef.current?.contains(document.activeElement)
        )
          setOpen(false);
      }}
    >
      <button
        type="button"
        className={`meter ${tone}`}
        aria-label={`Session & usage, context ${percent === null ? "unknown" : `${Math.round(percent)} percent full`}`}
        aria-describedby={open ? hintId : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => {
          setOpen(false);
          void store.runPaletteNativeCommand("/session");
        }}
      >
        <span
          className="meter__reading"
          {...(percent === null
            ? { role: "img", "aria-label": "Context usage unknown" }
            : {
                role: "meter",
                "aria-label": `Context ${Math.round(percent)} percent full`,
                "aria-valuemin": 0,
                "aria-valuemax": 100,
                "aria-valuenow": Math.round(fillPercent),
                "aria-valuetext": `${Math.round(percent)}%`,
              })}
        >
          <svg className="meter__ring" viewBox="0 0 14 14" aria-hidden>
            <circle
              className="meter__ring-track"
              cx="7"
              cy="7"
              r={RING_RADIUS}
            />
            {percent !== null && (
              <circle
                className="meter__ring-fill"
                cx="7"
                cy="7"
                r={RING_RADIUS}
                strokeDasharray={`${(fillPercent / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
                transform="rotate(-90 7 7)"
              />
            )}
          </svg>
          <span className="meter__value" aria-hidden>
            <span>{percent === null ? "—" : `${Math.round(percent)}%`}</span>
          </span>
        </span>
      </button>
      {open && (
        <div className="meter__hint" id={hintId} role="tooltip">
          {model && (
            <span className="meter__model">{model.name ?? model.id}</span>
          )}
          <span>
            {percent === null ? tokens : `${Math.round(percent)}% · ${tokens}`}
          </span>
          {usage.tokens === null && <span>Updates after the next reply</span>}
        </div>
      )}
    </div>
  );
});

export const Composer = memo(function Composer() {
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      sessionStatuses: source.sessionStatuses,
      readOnlyReason: source.readOnlyReason,
      transcriptViewId: source.view.viewId,
      transcriptIncarnation: source.view.incarnation,
      transcriptEffectiveLeafId: source.view.effectiveLeafId,
      composerHistoryVersion: source.view.composerHistoryVersion,
      runState: selectedRunState(source),
      bashRunning: source.live.bashRunning,
      sessionSelectionPending: source.sessionSelectionPending,
      workspaceShowHidden: source.workspaceShowHidden,
      model: source.model,
      availableModels: source.availableModels,
      commonModels: source.commonModels,
      commands: source.commands,
      thinkingLevel: source.thinkingLevel,
      thinkingLevelPending: source.thinkingLevelPending,
      recentModelIds: source.prefs.recentModelIds,
      nativeCommandUiRequest: source.nativeCommandUiRequest,
    }),
    shallowEqual,
  );
  const sessionId = state.sessionId;
  const historyScope = useMemo<ComposerHistoryScope | null>(
    () =>
      sessionId &&
      state.transcriptViewId &&
      state.composerHistoryVersion !== null
        ? {
            sessionId,
            viewId: state.transcriptViewId,
            incarnation: state.transcriptIncarnation,
            effectiveLeafId: state.transcriptEffectiveLeafId,
            historyVersion: state.composerHistoryVersion,
          }
        : null,
    [
      sessionId,
      state.transcriptEffectiveLeafId,
      state.transcriptIncarnation,
      state.transcriptViewId,
      state.composerHistoryVersion,
    ],
  );
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
  const historyKey = historyScope
    ? JSON.stringify([inputKey, historyScope.historyVersion])
    : null;
  const [historyOpen, setHistoryOpen] = useState<{
    key: string;
    draftRevision: number;
  } | null>(null);
  const draft = useSessionDraft(store.drafts, sessionId ?? undefined);
  useSyncExternalStore(
    store.subscribeComposerDeliveries,
    store.composerDeliveryVersion,
  );
  const {
    failedCount,
    storageIssue: deliveryStorageIssue,
    reloaded: reloadedDelivery,
    previous: previousDelivery,
  } = store.composerDeliveryState(sessionId);
  const observingDelivery = Boolean(draft.intentId || reloadedDelivery);
  const [deliveryBehavior, setDeliveryBehavior] = useState<
    "steer" | "followUp"
  >("steer");
  const wasBusyRef = useRef(false);
  const busy = isBusyRunState(state.runState);
  const sessionOpening = state.sessionSelectionPending;

  const abortable = isAbortableRunState(state.runState) || state.bashRunning;
  const isRunning = state.runState === "running";
  const isRetrying = state.runState === "retrying";
  const isCompacting = state.runState === "compacting";
  const isFailed = state.runState === "failed";
  const native = sessionId ? state.sessionStatuses[sessionId] : undefined;
  const terminalQueueOnly = busy && native?.external && !native.queueAdmission;
  const deliveryBusy = busy && !terminalQueueOnly;
  const shellInput = draft.text.trim().startsWith("!");

  const runStateClass = isRunning
    ? "composer--running"
    : isRetrying
      ? "composer--retrying"
      : isCompacting
        ? "composer--compacting"
        : isFailed
          ? "composer--failed"
          : "";

  const openHistory = () => {
    if (!sessionOpening && sessionId && historyKey)
      setHistoryOpen({
        key: historyKey,
        draftRevision: draft.revision,
      });
  };

  const useHistory = (entry: ComposerHistoryEntry): boolean => {
    if (
      !historyScope ||
      !historyOpen ||
      !store.useComposerHistoryEntry(
        historyScope,
        entry,
        historyOpen.draftRevision,
      )
    )
      return false;
    setHistoryOpen(null);
    return true;
  };

  useLayoutEffect(() => {
    setHistoryOpen(null);
  }, [historyKey]);

  const previousSessionRef = useRef(sessionId);
  useLayoutEffect(() => {
    if (previousSessionRef.current === sessionId) return;
    previousSessionRef.current = sessionId;
    // Every transient composer surface belongs to the session that opened it.
    // Reset before paint so it cannot silently retarget the newly visible one.
    setDeliveryBehavior("steer");
  }, [sessionId]);

  useEffect(() => {
    if (busy && !wasBusyRef.current) setDeliveryBehavior("steer");
    wasBusyRef.current = busy;
  }, [busy]);

  const canSend = Boolean(
    !sessionOpening &&
      sessionId &&
      (observingDelivery ||
        (deliveryStorageIssue !== "format" &&
          !terminalQueueOnly &&
          (draft.text.trim() ||
            draft.attachments.length ||
            draft.projectFiles.length))),
  );
  const activeBehavior = deliveryBusy
    ? deliveryBehavior
    : state.runState === "conflict"
      ? "steer"
      : undefined;
  const submit = (behavior?: "steer" | "followUp") => {
    if (!canSend || store.getState().sessionId !== sessionId) return;
    void store.sendPrompt(draft.text, behavior, draft);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "ArrowUp" &&
      event.altKey &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !isComposingKeyboardEvent(event.nativeEvent)
    ) {
      event.preventDefault();
      openHistory();
    }
  };

  const sendLabel = observingDelivery
    ? "Retry delivery"
    : shellInput
      ? "Run shell command"
      : !deliveryBusy
        ? "Send message"
        : deliveryBehavior === "steer"
          ? "Send as steer"
          : "Queue after current task";
  const sendTitle = observingDelivery
    ? "Check the original delivery receipt"
    : !shellInput && !deliveryBusy
      ? "Send"
      : sendLabel;
  const activeModel = resolveModelMetadata(state.model, state.availableModels);
  // Owned workers and attached terminal Pi both take model and thinking changes.
  const modelsDisabled =
    sessionOpening || Boolean(state.readOnlyReason) || !sessionId;
  const thinkingSupported = activeModel?.reasoning !== false;
  const thinkingLevels = supportedThinkingLevels(activeModel);
  const deliveryAction = (
    label: string,
    run: () => void,
    disabled = sessionOpening,
  ) => (
    <button
      type="button"
      className="button button--quiet"
      onClick={run}
      disabled={disabled}
    >
      {label}
    </button>
  );

  return (
    <MessageEditor
      sessionId={sessionId}
      draft={draft}
      className={runStateClass}
      label="Message composer"
      busy={busy || sessionOpening}
      disabled={sessionOpening}
      onSubmit={() => submit(activeBehavior)}
      files={{
        scope: sessionId,
        search: store.searchProjectFiles,
        showHidden: state.workspaceShowHidden,
        onShowHiddenChange: store.setWorkspaceShowHidden,
      }}
      input={{
        commands: state.commands,
        models: state.availableModels,
        activeModel,
        completionScope: inputKey,
        placeholder: terminalQueueOnly
          ? "Draft a message or queue it in the Pi terminal…"
          : deliveryBusy
            ? deliveryBehavior === "steer"
              ? "Guide the current task…"
              : "Queue a follow-up…"
            : "Message Pi…",
        label: "Message",
        onKeyDown,
      }}
      beforeInput={
        <>
          {deliveryStorageIssue === "format" ? (
            <DeliveryNotice text="Previous delivery records could not be read. Check the conversation before sending again.">
              {deliveryAction(
                "Stop tracking",
                store.forgetUnsupportedComposerDeliveries,
              )}
            </DeliveryNotice>
          ) : (
            deliveryStorageIssue && (
              <DeliveryNotice text="This tab cannot save delivery records." />
            )
          )}
          {observingDelivery ? (
            <DeliveryNotice
              text={
                reloadedDelivery
                  ? "Delivery before reload is unconfirmed"
                  : "Delivery unconfirmed"
              }
            >
              {deliveryAction(
                reloadedDelivery ? "Stop tracking" : "New input",
                store.detachComposerPrompt,
              )}
            </DeliveryNotice>
          ) : failedCount > 0 ? (
            <DeliveryNotice text="Previous input">
              {deliveryAction(
                "Restore",
                store.restoreFailedComposerPrompt,
                sessionOpening || hasDraftInput(draft),
              )}
            </DeliveryNotice>
          ) : null}
          {!observingDelivery && previousDelivery && (
            <DeliveryNotice text="Earlier delivery unconfirmed">
              {deliveryAction(
                "Check receipt",
                store.retryPreviousComposerDelivery,
              )}
              {deliveryAction(
                "Stop tracking",
                store.forgetPreviousComposerDelivery,
              )}
            </DeliveryNotice>
          )}
        </>
      }
      afterInput={
        <>
          {deliveryBusy ? (
            <div className="composer__delivery">
              <div
                className="segmented"
                role="group"
                aria-label="Message delivery"
              >
                <button
                  type="button"
                  aria-pressed={deliveryBehavior === "steer"}
                  disabled={sessionOpening}
                  onClick={() => setDeliveryBehavior("steer")}
                  title="Influence the running task"
                >
                  Steer
                </button>
                <button
                  type="button"
                  aria-pressed={deliveryBehavior === "followUp"}
                  disabled={sessionOpening}
                  onClick={() => setDeliveryBehavior("followUp")}
                  title="Send after the current task"
                >
                  Queue
                </button>
              </div>
            </div>
          ) : null}
        </>
      }
      selectors={
        <>
          <ModelSelector
            key={`model-${sessionId ?? "none"}`}
            value={activeModel}
            models={state.availableModels}
            recent={state.recentModelIds}
            common={state.commonModels}
            onManageModels={store.openModelSettings}
            disabled={modelsDisabled}
            openRequest={
              state.nativeCommandUiRequest?.sessionId === state.sessionId &&
              state.nativeCommandUiRequest.action === "model"
                ? state.nativeCommandUiRequest
                : undefined
            }
            onOpenRequestHandled={store.consumeNativeCommandUiRequest}
            refreshModels={store.refreshModels}
            onChange={(provider, id) => void store.setModel(provider, id)}
          />
          <ComposerThinkingControl
            thinkingSupported={thinkingSupported}
            key={`thinking-${sessionId ?? "none"}`}
            label="Thinking level"
            title={
              thinkingSupported
                ? "Thinking level"
                : "Thinking unavailable for this model"
            }
            value={state.thinkingLevel}
            display={
              state.thinkingLevelPending
                ? "Saving…"
                : thinkingSupported
                  ? undefined
                  : "Unavailable"
            }
            disabled={state.thinkingLevelPending || modelsDisabled}
            openRequest={
              state.nativeCommandUiRequest?.sessionId === state.sessionId &&
              state.nativeCommandUiRequest.action === "thinking"
                ? state.nativeCommandUiRequest.id
                : undefined
            }
            onOpenRequestHandled={store.consumeNativeCommandUiRequest}
            levels={thinkingLevels}
            onChange={(value) => void store.setThinkingLevel(value)}
          />
        </>
      }
      tools={
        <button
          type="button"
          className="icon-button"
          aria-label="Input history"
          aria-haspopup="dialog"
          aria-keyshortcuts="Alt+ArrowUp"
          title="Input history (Alt+↑)"
          disabled={sessionOpening || !historyScope}
          onClick={openHistory}
        >
          <History size={16} aria-hidden />
        </button>
      }
      actions={
        <>
          <ContextMeter />
          {abortable ? (
            <button
              type="button"
              className={`composer__send ${state.runState === "conflict" ? "composer__send--recover" : "composer__send--abort"}`}
              disabled={sessionOpening}
              onClick={() => void store.abort()}
              aria-label={
                state.runState === "conflict"
                  ? "Recover session"
                  : isCompacting
                    ? "Cancel context compaction"
                    : "Abort running task"
              }
              title={
                state.runState === "conflict"
                  ? "Recover session"
                  : isCompacting
                    ? "Cancel compaction"
                    : "Stop"
              }
            >
              <Square size={14} aria-hidden />
            </button>
          ) : null}
        </>
      }
      send={
        !abortable ||
        deliveryBusy ||
        state.bashRunning ||
        (observingDelivery && state.runState !== "conflict")
          ? { disabled: !canSend, label: sendLabel, title: sendTitle }
          : undefined
      }
    >
      {historyScope &&
        historyOpen &&
        historyOpen.key === historyKey &&
        !sessionOpening && (
          <ComposerHistoryDialog
            scope={historyScope}
            recent={recentComposerHistory(historyScope)}
            onChoose={useHistory}
            onClose={() => setHistoryOpen(null)}
          />
        )}
    </MessageEditor>
  );
});
