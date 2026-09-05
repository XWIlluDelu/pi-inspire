import {
  Archive,
  ChevronRight,
  GitFork,
  Loader2,
  Package,
  Trash2,
  X,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import type {
  AssistantRoundDisplayPreference,
  GenericExtensionDisplay,
  PendingQueues,
  ToolVisibilityPreference,
  VisibilityPreference,
} from "../../shared/contracts";
import {
  type ActivityTool,
  type ChatMessage,
  contentItems,
  messageText,
  type ToolCallContent,
} from "../events";
import { store } from "../store";
import { CopyAction } from "./CopyAction";
import { ImagePreview, PersistedImage } from "./ImagePreview";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";
import { useDynamicActivityGroup } from "./transcript-activity";
import { ActivityItemBoundary } from "./transcript-activity-visibility";
import {
  type CollapsedActivity,
  CollapsedActivityStrip,
  CustomMessageCard,
  customActivityItems,
  GenericCard,
  genericContentTitle,
  hasRenderableAssistantContent,
  type StaticVisibility,
  ThinkingCard,
  ToolCard,
} from "./transcript-cards";

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

function clockTime(timestamp?: number): string {
  if (timestamp == null) return "";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// --- Collapsible cards (thinking / tool / custom / generic) ---

function MessageActions({
  text,
  forkEntryId,
  copyLabel = "Message",
  className = "",
}: {
  text: string;
  forkEntryId?: string;
  copyLabel?: string;
  className?: string;
}) {
  const [forking, setForking] = useState(false);
  if (!text && !forkEntryId) return null;
  return (
    <div className={`turn__actions ${className}`}>
      {text ? (
        <CopyAction text={text} label={copyLabel} className="turn__action" />
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
            <Loader2 size={13} className="spin" aria-hidden />
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
  const text = messageText(message);
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
        ) : null}
        {text ? <RichText text={text} variant="user" /> : null}
      </div>
      <MessageActions text={text} forkEntryId={message.__inspireEntryId} />
    </div>
  );
});

function hasCollapsibleActivityRun(
  items: ReturnType<typeof contentItems>,
  trailingCustomCount: number,
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
  return currentToolRun + trailingCustomCount > 1;
}

export const AssistantTurn = memo(function AssistantTurn({
  message,
  toolResults,
  toolActivity,
  customMessages,
  activityItemIds = [],
  customActivityIds = [],
  customCollapseRequested,
  streaming,
  dynamicActive,
  thinkingVisibility,
  toolVisibility,
  assistantRoundDisplay,
  showLead = true,
  roundActivityItemId,
  responseCopyText,
}: {
  message: ChatMessage;
  toolResults: Map<string, ChatMessage>;
  toolActivity: Record<string, ActivityTool>;
  customMessages: ChatMessage[];
  activityItemIds?: string[];
  customActivityIds?: string[];
  customCollapseRequested: boolean;
  streaming: boolean;
  dynamicActive: boolean;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: ToolVisibilityPreference;
  assistantRoundDisplay: AssistantRoundDisplayPreference;
  /** A projected assistant message carries its round lead exactly once: with
   * its first response when present, otherwise with its first activity. */
  showLead?: boolean;
  /** Compact response folds hide a round lead when its owning first activity
   * belongs to the omitted prefix. */
  roundActivityItemId?: string;
  /** Empty suppresses actions; a full-message value keeps the existing one-copy
   * affordance on the message's final visible response fragment. */
  responseCopyText?: string;
}) {
  const items = contentItems(message);
  const customActivities = customActivityItems(customMessages).map(
    (activity, index) => ({
      ...activity,
      key: customActivityIds[index] ?? activity.key,
    }),
  );
  const hasVisibleContent =
    hasRenderableAssistantContent(
      message,
      thinkingVisibility,
      toolVisibility,
    ) ||
    (toolVisibility !== "hidden" && customMessages.length > 0);
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
  const activityKeys = [
    ...toolKeys,
    ...customActivities.map((activity) => activity.key),
  ];
  const hasActivities = activityKeys.length > 0;
  const collapseEligible = hasCollapsibleActivityRun(
    items,
    customActivities.length,
  );
  const lifecycleObserved =
    dynamicActive ||
    customMessages.some((custom) => typeof custom.__inspireLiveId === "string");
  const collapseRequested =
    !dynamicActive && (customMessages.length === 0 || customCollapseRequested);
  const dynamicBatch = useDynamicActivityGroup(
    dynamicTools,
    lifecycleObserved,
    collapseRequested,
    activityKeys,
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
  let customActivitiesRendered = false;
  // Execution events, not membership in the current batch, own the running
  // status. After reconnect an unobserved call stays expanded but unknown.
  const live = streaming;

  for (let index = 0; index < items.length; ) {
    const item = items[index]!;
    if (item.type === "toolCall" && collapsedActivities) {
      const start = index;
      let end = start;
      while (end < items.length && items[end]?.type === "toolCall") end += 1;
      const joinsTrailingCustoms =
        end === items.length && customActivities.length > 0;
      const runLength =
        end - start + (joinsTrailingCustoms ? customActivities.length : 0);
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
        if (joinsTrailingCustoms) {
          activities.push(...customActivities);
          customActivitiesRendered = true;
        }
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

  if (!customActivitiesRendered && customActivities.length > 0) {
    if (collapsedActivities && customActivities.length > 1) {
      renderedItems.push(
        <CollapsedActivityStrip
          key={`customs:${customActivities[0]!.key}`}
          activities={customActivities}
          live={false}
        />,
      );
    } else {
      customMessages.forEach((custom, index) => {
        const activityKey = customActivities[index]!.key;
        renderedItems.push(
          <ActivityItemBoundary key={activityKey} id={activityKey}>
            <CustomMessageCard
              message={custom}
              visibility={ordinaryToolVisibility}
              dynamic={dynamicTools}
              forceClosed={dynamicTools && dynamicBatch.closing}
              onDynamicClosed={
                dynamicTools
                  ? () => dynamicBatch.markClosed(activityKey)
                  : undefined
              }
              onManualOpenChange={
                dynamicTools
                  ? (open) => dynamicBatch.setInspectionHeld(activityKey, open)
                  : undefined
              }
            />
          </ActivityItemBoundary>,
        );
      });
    }
  }

  const divider = showLead && assistantRoundDisplay === "divider";
  const roundLead = divider ? (
    <span className="turn__divider" aria-hidden />
  ) : !showLead ? null : (
    /* Details deliberately remains the existing attribution row verbatim. */
    <div className="turn__head">
      <span className="turn__who">Pi</span>
      {message.model ? (
        <span className="turn__detail">{message.model}</span>
      ) : null}
      {message.timestamp != null ? (
        <span className="turn__detail">{clockTime(message.timestamp)}</span>
      ) : null}
      {message.stopReason && message.stopReason !== "stop" ? (
        <span className="turn__flag">{message.stopReason}</span>
      ) : null}
    </div>
  );
  return (
    <div
      className={`turn turn--assistant ${divider ? "turn--round-divider" : ""} ${streaming ? "turn--streaming" : ""}`}
    >
      {roundActivityItemId && roundLead ? (
        <ActivityItemBoundary id={roundActivityItemId}>
          {roundLead}
        </ActivityItemBoundary>
      ) : (
        roundLead
      )}
      <div className="assistant-doc">
        {streaming && !hasVisibleContent ? (
          <div className="assistant-activity" role="status">
            <Loader2 size={14} className="spin" aria-hidden />
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
        copyLabel="Response"
        className="turn__actions--response"
      />
    </div>
  );
});

export const UnpairedToolResultRow = memo(function UnpairedToolResultRow({
  activityItemId = "unpaired-tool-result",
  toolName,
  visibility,
}: {
  activityItemId?: string;
  toolName?: string;
  visibility: StaticVisibility;
}) {
  return (
    <div className="turn">
      <ActivityItemBoundary id={activityItemId}>
        <GenericCard
          item={{ type: `toolResult:${toolName ?? "unknown"}` }}
          visibility={visibility}
        />
      </ActivityItemBoundary>
    </div>
  );
});

export const ContextCheckpointRow = memo(function ContextCheckpointRow({
  message,
}: {
  message: ChatMessage;
}) {
  const compacted = message.role === "compactionSummary";
  const summary = typeof message.summary === "string" ? message.summary : "";
  const tokens =
    typeof message.tokensBefore === "number" &&
    Number.isFinite(message.tokensBefore)
      ? `${Math.round(message.tokensBefore).toLocaleString()} tokens before`
      : null;
  const timestamp = clockTime(message.timestamp);
  const [open, setOpen] = useState(false);
  return (
    <div className="turn turn--checkpoint">
      <details
        className="context-checkpoint"
        onToggle={(event) => {
          if (event.target === event.currentTarget)
            setOpen(event.currentTarget.open);
        }}
      >
        <summary>
          <Archive size={14} aria-hidden />
          <span className="context-checkpoint__title">
            {compacted ? "Context compacted" : "Branch context"}
          </span>
          {tokens ? (
            <span className="context-checkpoint__metric">{tokens}</span>
          ) : null}
          {timestamp ? (
            <time className="context-checkpoint__time">{timestamp}</time>
          ) : null}
          <ChevronRight
            className="context-checkpoint__chevron"
            size={13}
            aria-hidden
          />
        </summary>
        {open ? (
          <div className="context-checkpoint__body">
            {summary ? (
              <RichText text={summary} />
            ) : (
              <p>No summary was recorded.</p>
            )}
            {summary ? (
              <MessageActions
                text={summary}
                copyLabel={compacted ? "Compaction summary" : "Branch summary"}
              />
            ) : null}
          </div>
        ) : null}
      </details>
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

export function PendingQueueGroups({
  queue,
  pendingAction,
  onClear,
}: {
  queue: PendingQueues;
  pendingAction: "clear" | null;
  onClear: () => Promise<boolean>;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (queue.totalCount === 0) setConfirmClear(false);
  }, [queue.totalCount]);

  const groups = [
    {
      key: "steering",
      label: "Steer",
      mark: "S",
      start: 0,
      items: queue.steering,
    },
    {
      key: "follow-up",
      label: "Queue",
      mark: "Q",
      start: queue.steering.length,
      items: queue.followUp,
    },
  ].filter((group) => group.items.length > 0);
  const entries = [...queue.steering, ...queue.followUp];
  const busy = pendingAction !== null;
  const copyAllPreview = entries
    .map(
      (entry, index) =>
        `${index + 1}. ${entry.textPreview.replace(/\n/g, "\n   ")}`,
    )
    .join("\n");
  const hasText = entries.some(
    (entry) => entry.textPreview.length > 0 || entry.textTruncated,
  );
  const previewOnly = entries.some((entry) => entry.textTruncated);
  const omitted = queue.totalCount - entries.length;
  if (queue.totalCount === 0) return null;

  return (
    <section className="pending-groups" aria-label="Pending input">
      <div className="pending-groups__head">
        <div className="pending-groups__lead">
          <span className="pending-groups__title">Pending input</span>
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
          {hasText ? (
            <CopyAction
              text={copyAllPreview}
              label={
                previewOnly || omitted > 0
                  ? "displayed pending previews"
                  : "all pending input"
              }
              className="pending-group__copy"
            />
          ) : null}
          {queue.totalCount > 0 ? (
            confirmClear ? (
              <span className="pending-groups__confirm">
                <span className="pending-groups__confirm-label">
                  Clear all?
                </span>
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
            )
          ) : null}
        </div>
      </div>
      {confirmClear ? (
        <p className="pending-groups__note" role="status">
          Clear whatever remains queued when Pi handles this request. Items may
          be consumed meanwhile; the current run is not stopped.
        </p>
      ) : null}
      {previewOnly || omitted > 0 ? (
        <p className="pending-groups__note">
          Text previews only; copy uses the displayed text, not omitted content.
          {omitted > 0 ? ` ${omitted} more pending items are not shown.` : ""}
        </p>
      ) : null}
      {groups.map((group) => (
        <section
          key={group.key}
          className={`pending-group pending-group--${group.key}`}
          aria-label={`Pending ${group.label.toLowerCase()}`}
        >
          <div className="pending-group__head">
            <div className="pending-group__head-lead">
              <span className="pending-group__label">{group.label}</span>
              <span className="pending-group__hint">
                ·{" "}
                {group.key === "steering"
                  ? "Delivers on next step"
                  : "Delivers after completion"}
              </span>
            </div>
            <span className="pending-group__head-count">
              <span aria-hidden>
                {group.items.length}{" "}
                {group.items.length === 1 ? "item" : "items"}
              </span>
              <span className="visually-hidden">
                {group.items.length} items
              </span>
            </span>
          </div>
          <ol className="pending-group__list" start={group.start + 1}>
            {group.items.map((entry, index) => {
              const number = group.start + index + 1;
              const contentLabel =
                entry.textPreview || "No text in Pi queue projection";
              const canCopyText = entry.textPreview.length > 0;
              return (
                <li key={entry.id} className="pending-group__item">
                  <span className="pending-group__number" aria-hidden>
                    {number}.
                  </span>
                  <div className="pending-group__mark-col">
                    <span
                      className={`pending-group__mark pending-group__mark--${group.key}`}
                      title={group.label}
                    >
                      <span className="pending-group__mark-text">
                        {group.mark}
                      </span>
                    </span>
                  </div>
                  <div className="pending-group__content">
                    <pre
                      className={
                        entry.textPreview ? undefined : "is-placeholder"
                      }
                    >
                      {contentLabel}
                      {entry.textTruncated ? "…" : ""}
                    </pre>
                  </div>
                  <div className="pending-group__item-actions">
                    {canCopyText ? (
                      <CopyAction
                        text={entry.textPreview}
                        label={`${group.label} item ${index + 1}${entry.textTruncated ? " preview" : ""}`}
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
