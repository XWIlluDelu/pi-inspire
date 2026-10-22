import {
  Archive,
  ChevronRight,
  CornerUpLeft,
  GitFork,
  Image as ImageIcon,
  Package,
  Trash2,
  X,
} from "lucide-react";
import {
  memo,
  type Ref,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
} from "react";
import { fileReferenceName } from "../../shared/attachment-context";
import type {
  GenericExtensionDisplay,
  PendingQueues,
  ToolVisibilityPreference,
  VisibilityPreference,
} from "../../shared/contracts";
import { type CopyLoader, type CopySource, copyLoader } from "../content-copy";
import {
  type ActivityTool,
  type ChatMessage,
  contentItems,
  messageText,
  type ToolCallContent,
  userMessageDisplayContent,
} from "../events";
import { fileIconForPath } from "../file-icons";
import { messageCopyLoader } from "../message-copy";
import { store } from "../store";
import { hasActiveModal } from "../use-modal-focus";
import { CopyAction } from "./CopyAction";
import { ImageGallery } from "./ImageGallery";
import { ImagePreview, PersistedImage } from "./ImagePreview";
import { PiLoader } from "./PiLoader";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";
import { useDynamicActivityGroup } from "./transcript-activity";
import { ActivityItemBoundary } from "./transcript-activity-visibility";
import {
  type CollapsedActivity,
  CollapsedActivityStrip,
  GenericCard,
  genericContentTitle,
  hasRenderableAssistantContent,
  type StaticVisibility,
  ThinkingCard,
  ToolCard,
  ToolResultCard,
} from "./transcript-cards";
import { TranscriptSearchReveal } from "./transcript-search";

export function relativeTime(timestamp: number | string): string {
  const time =
    typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(time).toLocaleDateString();
}

// --- Turns and activity ---

function MessageActions({
  text,
  getContent,
  forkEntryId,
  copyLabel = "Message",
  className = "",
}: {
  text: string;
  getContent?: CopyLoader;
  forkEntryId?: string;
  copyLabel?: string;
  className?: string;
}) {
  const [forking, setForking] = useState(false);
  if (!text && !getContent && !forkEntryId) return null;
  return (
    <div className={`turn__actions ${className}`}>
      {text || getContent ? (
        <CopyAction
          text={text}
          getContent={getContent}
          label={copyLabel}
          className="turn__action"
        />
      ) : null}
      {forkEntryId ? (
        <button
          type="button"
          className="icon-button turn__action"
          aria-label="Fork session from this input"
          title="Fork a new session from this input"
          disabled={forking}
          onClick={() => {
            setForking(true);
            void store
              .forkFromEntry(forkEntryId)
              .finally(() => setForking(false));
          }}
        >
          {forking ? (
            <PiLoader size={13} aria-hidden />
          ) : (
            <GitFork size={13} aria-hidden />
          )}
        </button>
      ) : null}
    </div>
  );
}

export const UserBubble = memo(function UserBubble({
  message,
  sessionId,
  viewId,
  projectionKey,
}: {
  message: ChatMessage;
  sessionId: string;
  viewId: string;
  projectionKey: string;
}) {
  const timestamp = message.timestamp;
  const sourceText = messageText(message);
  const { text, references } = userMessageDisplayContent(message);
  const images: Array<
    { key: string; reference: string } | { key: string; src: string }
  > = [];
  if (Array.isArray(message.content)) {
    message.content.forEach((part, partIndex) => {
      if (
        !part ||
        typeof part !== "object" ||
        (part as { type?: unknown }).type !== "image"
      )
        return;
      const image = part as { data?: unknown; mimeType?: unknown };
      if (
        Number.isSafeInteger(message.__inspireMessageIndex) &&
        sessionId &&
        viewId
      ) {
        images.push({
          key: `persisted:${partIndex}`,
          reference: `pi-embedded://${message.__inspireMessageIndex}/${partIndex}`,
        });
      } else if (
        typeof image.data === "string" &&
        typeof image.mimeType === "string" &&
        /^image\//i.test(image.mimeType)
      ) {
        images.push({
          key: `inline:${partIndex}`,
          src: `data:${image.mimeType};base64,${image.data}`,
        });
      }
    });
  }
  return (
    <div className="turn turn--user">
      <div
        className="user-bubble"
        title={
          timestamp != null ? new Date(timestamp).toLocaleString() : undefined
        }
      >
        {images.length > 0 ? (
          <ImageGallery>
            <div
              className="user-bubble__images"
              role="group"
              aria-label="Attached images"
            >
              {images.map((image) =>
                "reference" in image ? (
                  <PersistedImage
                    key={image.key}
                    sessionId={sessionId}
                    viewId={viewId}
                    projectionKey={projectionKey}
                    reference={image.reference}
                  />
                ) : (
                  <ImagePreview
                    key={image.key}
                    src={image.src}
                    className="image-preview--message"
                  />
                ),
              )}
            </div>
          </ImageGallery>
        ) : null}
        {references.length > 0 ? (
          <ul className="user-bubble__files" aria-label="Referenced files">
            {references.map((path, index) => {
              const name = fileReferenceName(path);
              const FileIcon = fileIconForPath(name);
              return (
                <li
                  className="user-bubble__file"
                  key={`${index}:${path}`}
                  title={path}
                >
                  <FileIcon size={13} aria-hidden />
                  <span>{name}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {text ? <RichText text={text} variant="user" /> : null}
      </div>
      <MessageActions
        text={sourceText}
        getContent={
          sourceText || images.length
            ? messageCopyLoader(message, sourceText, {
                sessionId,
                viewId,
                projectionKey,
              })
            : undefined
        }
        forkEntryId={message.__inspireEntryId}
      />
    </div>
  );
});

function hasCollapsibleActivityRun(
  items: ReturnType<typeof contentItems>,
): boolean {
  let currentToolRun = 0;
  for (const item of items) {
    if (item.type === "toolCall") {
      currentToolRun += 1;
      if (currentToolRun > 1) return true;
    } else {
      currentToolRun = 0;
    }
  }
  return false;
}

export const AssistantTurn = memo(function AssistantTurn({
  message,
  toolResults,
  toolActivity,
  activityItemIds = [],
  streaming,
  dynamicActive,
  thinkingVisibility,
  toolVisibility,
  responseCopyText,
  responseCopyContent,
}: {
  message: ChatMessage;
  toolResults: Map<string, ChatMessage>;
  toolActivity: Record<string, ActivityTool>;
  activityItemIds?: string[];
  streaming: boolean;
  dynamicActive: boolean;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: ToolVisibilityPreference;
  /** Empty suppresses actions; a full-message value keeps the existing one-copy
   * affordance on the message's final visible response fragment. */
  responseCopyText?: string;
  responseCopyContent?: CopyLoader;
}) {
  const items = contentItems(message);
  const hasVisibleContent = hasRenderableAssistantContent(
    message,
    thinkingVisibility,
    toolVisibility,
  );
  const dynamicTools = toolVisibility === "dynamic";
  const toolKeys = items.flatMap((item, index) =>
    item.type === "toolCall"
      ? [
          activityItemIds[index] ??
            (item as ToolCallContent).id ??
            `tool:${index}`,
        ]
      : [],
  );
  const hasActivities = toolKeys.length > 0;
  const collapseEligible = hasCollapsibleActivityRun(items);
  const dynamicBatch = useDynamicActivityGroup(
    dynamicTools,
    dynamicActive,
    !dynamicActive,
    toolKeys,
    collapseEligible,
  );
  const renderedItems: React.ReactNode[] =
    typeof message.content === "string" && message.content.length > 0
      ? [<RichText key="text" text={message.content} variant="assistant" />]
      : [];
  const ordinaryToolVisibility: StaticVisibility =
    toolVisibility === "compact" ||
    toolVisibility === "collapsed" ||
    dynamicTools
      ? "collapsed"
      : toolVisibility;
  const collapsedActivities =
    collapseEligible &&
    (toolVisibility === "collapsed" ||
      (dynamicTools && dynamicBatch.collapsed));
  // Execution events, not membership in the current batch, own the running
  // status. After reconnect an unobserved call stays expanded but unknown.
  const live = streaming;

  for (let index = 0; index < items.length; ) {
    const item = items[index]!;
    if (item.type === "toolCall" && collapsedActivities) {
      const start = index;
      let end = start;
      while (end < items.length && items[end]?.type === "toolCall") end += 1;
      const runLength = end - start;
      if (runLength > 1) {
        const activities: CollapsedActivity[] = [];
        for (let cursor = start; cursor < end; cursor += 1) {
          const call = items[cursor] as ToolCallContent;
          activities.push({
            kind: "tool",
            key: activityItemIds[cursor] ?? call.id ?? `tool:${cursor}`,
            call,
            result: toolResults.get(call.id),
            activity: toolActivity[call.id],
          });
        }
        index = end;
        renderedItems.push(
          <CollapsedActivityStrip
            key={`tools:${activities[0]?.key ?? start}`}
            activities={activities}
            live={live}
          />,
        );
        continue;
      }
    }
    if (item.type === "text") {
      const text = (item as { text?: string }).text ?? "";
      if (text)
        renderedItems.push(
          <RichText key={index} text={text} variant="assistant" />,
        );
    } else if (item.type === "thinking") {
      const activityItemId =
        activityItemIds[index] ?? `assistant-item:${index}`;
      renderedItems.push(
        <ActivityItemBoundary key={activityItemId} id={activityItemId}>
          <ThinkingCard
            text={(item as { thinking?: string }).thinking ?? ""}
            visibility={thinkingVisibility}
            dynamicActive={dynamicActive}
          />
        </ActivityItemBoundary>,
      );
    } else if (item.type === "toolCall") {
      const call = item as ToolCallContent;
      const result = toolResults.get(call.id);
      const activity = toolActivity[call.id];
      const activityItemId =
        activityItemIds[index] ?? call.id ?? `assistant-item:${index}`;
      const toolKey = activityItemId;
      renderedItems.push(
        <ActivityItemBoundary key={activityItemId} id={activityItemId}>
          <ToolCard
            call={call}
            result={result}
            activity={activity}
            live={live}
            visibility={ordinaryToolVisibility}
            dynamic={dynamicTools}
            dynamicActive={dynamicActive}
            forceClosed={dynamicTools && dynamicBatch.closing}
            onDynamicClosed={
              dynamicTools ? () => dynamicBatch.markClosed(toolKey) : undefined
            }
            onManualOpenChange={
              dynamicTools
                ? (open) => dynamicBatch.setInspectionHeld(toolKey, open)
                : undefined
            }
          />
        </ActivityItemBoundary>,
      );
    } else {
      const title = genericContentTitle(item);
      if (title) {
        const activityItemId =
          activityItemIds[index] ?? `assistant-item:${index}`;
        renderedItems.push(
          <ActivityItemBoundary key={activityItemId} id={activityItemId}>
            <GenericCard
              item={item}
              visibility={ordinaryToolVisibility}
              title={title}
            />
          </ActivityItemBoundary>,
        );
      }
    }
    index += 1;
  }

  return (
    <div
      className={`turn turn--assistant ${streaming ? "turn--streaming" : ""}`}
    >
      <div className="assistant-doc">
        {streaming && !hasVisibleContent ? (
          <div className="assistant-activity" role="status">
            <PiLoader size={14} aria-hidden />
            <span>Working…</span>
          </div>
        ) : dynamicTools && hasActivities ? (
          <div
            className={`dynamic-activity-batch dynamic-activity-batch--${dynamicBatch.phase}`}
          >
            {renderedItems}
          </div>
        ) : (
          renderedItems
        )}
      </div>
      <MessageActions
        text={responseCopyText ?? messageText(message)}
        getContent={responseCopyContent}
        copyLabel="Response"
        className="turn__actions--response"
      />
    </div>
  );
});

export const UnpairedToolResultRow = memo(function UnpairedToolResultRow({
  activityItemId = "unpaired-tool-result",
  message,
  visibility,
}: {
  activityItemId?: string;
  message: ChatMessage;
  visibility: StaticVisibility;
}) {
  return (
    <div className="turn">
      <ActivityItemBoundary id={activityItemId}>
        <ToolResultCard result={message} visibility={visibility} />
      </ActivityItemBoundary>
    </div>
  );
});

/** Shared display content, so search does not index the elided event prefix. */
export function contextCheckpointContent(message: ChatMessage) {
  const compacted = message.role === "compactionSummary";
  const summary = typeof message.summary === "string" ? message.summary : "";
  const magicContext =
    compacted &&
    (message.__inspireCompactionSource === "magic-context" ||
      (!message.__inspireCompactionSource &&
        /^Magic Context compacted(?:[:\s]|$)/.test(summary)));
  const displaySummary = magicContext
    ? summary.replace(/^Magic Context compacted:\s*/, "")
    : summary;
  return { compacted, summary, magicContext, displaySummary };
}

export const ContextCheckpointRow = memo(function ContextCheckpointRow({
  message,
}: {
  message: ChatMessage;
}) {
  const { compacted, summary, magicContext, displaySummary } =
    contextCheckpointContent(message);
  const tokens =
    compacted &&
    typeof message.tokensBefore === "number" &&
    Number.isFinite(message.tokensBefore)
      ? `${magicContext ? "History chunk" : "Before"} ≈ ${Math.round(message.tokensBefore).toLocaleString()} tokens`
      : null;
  const [open, setOpen] = useState(false);
  const searchReveal = useContext(TranscriptSearchReveal);
  useLayoutEffect(() => {
    if (searchReveal !== null) setOpen(true);
  }, [searchReveal]);
  const bodyId = useId();
  const metricId = `${bodyId}-metric`;
  const title = compacted
    ? magicContext
      ? "Magic Context compacted"
      : "Context compacted"
    : "Branch context";
  return (
    <div className="turn turn--checkpoint">
      <div className="context-checkpoint">
        <div className="context-checkpoint__head">
          <button
            type="button"
            className="context-checkpoint__toggle"
            aria-label={title}
            aria-expanded={open}
            aria-controls={bodyId}
            aria-describedby={tokens ? metricId : undefined}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight
              className="context-checkpoint__chevron"
              size={14}
              aria-hidden
            />
            <Archive
              size={14}
              className="context-checkpoint__icon"
              aria-hidden
            />
            <span className="context-checkpoint__title">{title}</span>
          </button>
          {tokens || (open && summary) ? (
            <div className="context-checkpoint__details">
              {tokens ? (
                <span
                  id={metricId}
                  className="context-checkpoint__metric"
                  title={
                    magicContext
                      ? "Estimated tokens in the history chunk sent to Magic Context for processing."
                      : "Estimated context size before compaction."
                  }
                >
                  {tokens}
                </span>
              ) : null}
              {open && summary ? (
                <CopyAction
                  text={summary}
                  label={compacted ? "Compaction summary" : "Branch summary"}
                  className="context-checkpoint__copy"
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <div id={bodyId} className="context-checkpoint__body" hidden={!open}>
          {open ? (
            summary ? (
              <RichText text={displaySummary} />
            ) : (
              <p>No summary was recorded.</p>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
});

export const UnknownRoleRow = memo(function UnknownRoleRow({
  activityItemId = "unknown-activity",
  message,
  visibility,
}: {
  activityItemId?: string;
  message: ChatMessage;
  visibility: StaticVisibility;
}) {
  return (
    <div className="turn">
      <ActivityItemBoundary id={activityItemId}>
        <GenericCard
          item={{ ...message, type: message.role }}
          visibility={visibility}
        />
      </ActivityItemBoundary>
    </div>
  );
});

function PendingImage({ id, alt }: { id: string; alt: string }) {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const request = new AbortController();
    let objectUrl: string | undefined;
    void store.loadAttachmentImage(id, request.signal).then(
      (blob) => {
        if (request.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      },
      (reason: unknown) => {
        if (!request.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "Image unavailable",
          );
      },
    );
    return () => {
      request.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  return (
    <ImagePreview
      src={src}
      alt={alt}
      className="pending-group__image"
      loading={!src && !error}
      error={error}
    />
  );
}

export function PendingQueueGroups({
  ref,
  queue,
  pendingAction,
  onClear,
  onRecover,
  getText,
}: {
  ref?: Ref<HTMLElement>;
  queue: PendingQueues;
  pendingAction: "clear" | "recover" | null;
  onClear: () => Promise<boolean>;
  onRecover: () => Promise<boolean>;
  getText: (
    revision: number,
    itemId?: string,
    signal?: AbortSignal,
  ) => Promise<CopySource | null>;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (queue.totalCount === 0) setConfirmClear(false);
  }, [queue.totalCount]);

  const groups = [
    {
      key: "steering",
      label: "Steer",
      start: 0,
      items: queue.steering,
    },
    {
      key: "follow-up",
      label: "Queue",
      start: queue.steering.length,
      items: queue.followUp,
    },
  ].filter((group) => group.items.length > 0);
  const entries = [...queue.steering, ...queue.followUp];
  const busy = pendingAction !== null;

  async function returnToComposer() {
    const owner = store.getState();
    let focusChanged = false;
    const onFocus = () => {
      focusChanged = true;
    };
    document.addEventListener("focusin", onFocus);
    try {
      if (!(await onRecover())) return;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const current = store.getState();
      if (
        !focusChanged &&
        !hasActiveModal() &&
        current.sessionId === owner.sessionId &&
        current.transcriptViewId === owner.transcriptViewId &&
        current.transportGeneration === owner.transportGeneration &&
        !current.sessionSelectionPending
      )
        document
          .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
          ?.focus();
    } finally {
      document.removeEventListener("focusin", onFocus);
    }
  }

  const omitted = queue.totalCount - entries.length;
  const singleMode = omitted === 0 && groups.length === 1;
  if (queue.totalCount === 0) return null;

  return (
    <section
      ref={ref}
      className="pending-groups"
      aria-label="Pending input"
      tabIndex={-1}
    >
      <div className="pending-groups__head">
        <div className="pending-groups__lead">
          <span className="pending-groups__title">
            {singleMode ? `Pending · ${groups[0]!.label}` : "Pending input"}
          </span>
          <span
            className="pending-groups__count"
            title={`${queue.totalCount} pending items`}
          >
            <span aria-hidden>{queue.totalCount}</span>
            <span className="visually-hidden">
              {queue.totalCount} pending items
            </span>
          </span>
        </div>
        <div className="pending-groups__actions">
          {queue.totalCount > 0 ? (
            <CopyAction
              key={queue.revision}
              getContent={copyLoader(
                (signal) => getText(queue.revision, undefined, signal),
                queue.totalImageCount === undefined
                  ? null
                  : { text: true, image: queue.totalImageCount > 0 },
              )}
              label="all pending input"
              className="pending-group__copy"
            />
          ) : null}
          <button
            type="button"
            className="icon-button pending-group__control"
            aria-label="Return all Pending input to composer"
            title="Return Pending text and images to your draft without stopping"
            disabled={busy}
            onClick={() => void returnToComposer()}
          >
            {pendingAction === "recover" ? (
              <PiLoader size={13} aria-hidden />
            ) : (
              <CornerUpLeft size={13} aria-hidden />
            )}
          </button>
          {confirmClear ? (
            <span className="pending-groups__confirm">
              <span className="pending-groups__confirm-label">Clear all?</span>
              <button
                type="button"
                className="pending-groups__confirm-btn"
                disabled={busy}
                onClick={() =>
                  void onClear().then((cleared) => {
                    if (cleared) setConfirmClear(false);
                  })
                }
              >
                Clear all
              </button>
              <button
                type="button"
                className="pending-groups__confirm-cancel"
                aria-label="Cancel clearing Pending input"
                disabled={busy}
                onClick={() => setConfirmClear(false)}
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="icon-button pending-group__control pending-group__control--clear"
              aria-label="Clear all Pending input"
              title="Clear all Pending input"
              disabled={busy}
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 size={13} aria-hidden />
            </button>
          )}
        </div>
      </div>
      {omitted > 0 ? (
        <p className="pending-groups__omitted">
          {omitted} more pending {omitted === 1 ? "item" : "items"} not shown.
        </p>
      ) : null}
      {groups.map((group) => (
        <section
          key={group.key}
          className={`pending-group pending-group--${group.key}`}
          aria-label={`Pending ${group.label.toLowerCase()}`}
        >
          {!singleMode ? (
            <div className="pending-group__head">{group.label}</div>
          ) : null}
          <ol className="pending-group__list" start={group.start + 1}>
            {group.items.map((entry, index) => {
              const number = group.start + index + 1;
              const canCopy = entry.textLength > 0 || Boolean(entry.imageCount);
              return (
                <li key={entry.id} className="pending-group__item">
                  <span className="pending-group__number" aria-hidden>
                    {number}.
                  </span>
                  <div className="pending-group__content">
                    {entry.textPreview || !entry.imageCount ? (
                      <pre
                        className={
                          entry.textPreview ? undefined : "is-placeholder"
                        }
                      >
                        {entry.textPreview || "No text"}
                      </pre>
                    ) : null}
                    {entry.imageAttachmentIds?.length ? (
                      <ImageGallery>
                        <div
                          className="pending-group__images"
                          role="group"
                          aria-label={`${entry.imageAttachmentIds.length} ${entry.imageAttachmentIds.length === 1 ? "image" : "images"}`}
                        >
                          {entry.imageAttachmentIds.map((id, imageIndex) => (
                            <PendingImage
                              key={id}
                              id={id}
                              alt={`Pending ${group.label.toLowerCase()} item ${index + 1} image ${imageIndex + 1}`}
                            />
                          ))}
                        </div>
                      </ImageGallery>
                    ) : entry.imageCount ? (
                      <span className="pending-group__image-count">
                        <ImageIcon size={13} aria-hidden />
                        {entry.imageCount === 1
                          ? "Image"
                          : `${entry.imageCount} images`}
                      </span>
                    ) : null}
                  </div>
                  <div className="pending-group__item-actions">
                    {canCopy ? (
                      <CopyAction
                        key={queue.revision}
                        getContent={copyLoader(
                          (signal) => getText(queue.revision, entry.id, signal),
                          queue.totalImageCount === undefined
                            ? null
                            : {
                                text: entry.textLength > 0 || !entry.imageCount,
                                image: Boolean(entry.imageCount),
                              },
                        )}
                        label={`${group.label} item ${index + 1}`}
                        className="pending-group__copy"
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </section>
  );
}

export function ExtensionDisplaySurface({
  displays,
}: {
  displays: GenericExtensionDisplay[];
}) {
  if (displays.length === 0) return null;
  return (
    <section
      className="extension-surface"
      aria-label="Extension display content"
    >
      <div className="extension-surface__head">
        <Package size={14} aria-hidden /> Extension display
      </div>
      {displays.map((display) => (
        <details key={display.id} className="extension-surface__item">
          <summary>
            <code>{display.method}</code>
            <span>
              {display.source} · {display.label}
            </span>
          </summary>
          <pre className="card__mono">
            {JSON.stringify(display.payload, null, 2)}
          </pre>
        </details>
      ))}
    </section>
  );
}
