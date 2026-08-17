import { GitFork, Loader2, Package } from "lucide-react";
import { memo, useState } from "react";
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
  store,
  type ToolCallContent,
} from "../store";
import { ImagePreview, PersistedImage } from "./ImagePreview";
import { RichText } from "./RichText";
import { useDynamicActivityGroup } from "./transcript-activity";
import {
  type CompactActivity,
  CompactActivityStrip,
  CopyAction,
  CustomMessageCard,
  compactCustomActivities,
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
}: {
  message: ChatMessage;
  sessionId: string;
  viewId: string;
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

function hasCompactableActivityRun(
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
  customCompactRequested,
  streaming,
  dynamicActive,
  thinkingVisibility,
  toolVisibility,
  assistantRoundDisplay,
}: {
  message: ChatMessage;
  toolResults: Map<string, ChatMessage>;
  toolActivity: Record<string, ActivityTool>;
  customMessages: ChatMessage[];
  customCompactRequested: boolean;
  streaming: boolean;
  dynamicActive: boolean;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: ToolVisibilityPreference;
  assistantRoundDisplay: AssistantRoundDisplayPreference;
}) {
  const items = contentItems(message);
  const customActivities = compactCustomActivities(customMessages);
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
      ? [(item as ToolCallContent).id || `tool:${index}`]
      : [],
  );
  const activityKeys = [
    ...toolKeys,
    ...customActivities.map((activity) => activity.key),
  ];
  const hasActivities = activityKeys.length > 0;
  const compactEligible = hasCompactableActivityRun(
    items,
    customActivities.length,
  );
  const lifecycleObserved =
    dynamicActive ||
    customMessages.some((custom) => typeof custom.__inspireLiveId === "string");
  const compactRequested =
    !dynamicActive && (customMessages.length === 0 || customCompactRequested);
  const dynamicBatch = useDynamicActivityGroup(
    dynamicTools,
    lifecycleObserved,
    compactRequested,
    activityKeys,
    compactEligible,
  );
  const renderedItems: React.ReactNode[] =
    typeof message.content === "string" && message.content.length > 0
      ? [<RichText key="text" text={message.content} variant="assistant" />]
      : [];
  const ordinaryToolVisibility: StaticVisibility =
    toolVisibility === "compact" || dynamicTools ? "collapsed" : toolVisibility;
  const compactActivities =
    compactEligible &&
    (toolVisibility === "compact" || (dynamicTools && dynamicBatch.compact));
  let customActivitiesRendered = false;
  // Execution events, not membership in the current batch, own the running
  // status. After reconnect an unobserved call stays expanded but unknown.
  const live = streaming;

  for (let index = 0; index < items.length; ) {
    const item = items[index]!;
    if (item.type === "toolCall" && compactActivities) {
      const start = index;
      let end = start;
      while (end < items.length && items[end]?.type === "toolCall") end += 1;
      const joinsTrailingCustoms =
        end === items.length && customActivities.length > 0;
      const runLength =
        end - start + (joinsTrailingCustoms ? customActivities.length : 0);
      if (runLength > 1) {
        const activities: CompactActivity[] = [];
        for (let cursor = start; cursor < end; cursor += 1) {
          const call = items[cursor] as ToolCallContent;
          activities.push({
            kind: "tool",
            key: call.id || `tool:${cursor}`,
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
          <CompactActivityStrip
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
      renderedItems.push(
        <ThinkingCard
          key={index}
          text={(item as { thinking?: string }).thinking ?? ""}
          visibility={thinkingVisibility}
          dynamicActive={dynamicActive}
        />,
      );
    } else if (item.type === "toolCall") {
      const call = item as ToolCallContent;
      const result = toolResults.get(call.id);
      const activity = toolActivity[call.id];
      const toolKey = call.id || `tool:${index}`;
      renderedItems.push(
        <ToolCard
          key={toolKey}
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
        />,
      );
    } else {
      const title = genericContentTitle(item);
      if (title) {
        renderedItems.push(
          <GenericCard
            key={index}
            item={item}
            visibility={ordinaryToolVisibility}
            title={title}
          />,
        );
      }
    }
    index += 1;
  }

  if (!customActivitiesRendered && customActivities.length > 0) {
    if (compactActivities && customActivities.length > 1) {
      renderedItems.push(
        <CompactActivityStrip
          key={`customs:${customActivities[0]!.key}`}
          activities={customActivities}
          live={false}
        />,
      );
    } else {
      customMessages.forEach((custom, index) => {
        const activityKey = customActivities[index]!.key;
        renderedItems.push(
          <CustomMessageCard
            key={activityKey}
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
          />,
        );
      });
    }
  }

  const divider = assistantRoundDisplay === "divider";
  return (
    <div
      className={`turn turn--assistant ${divider ? "turn--round-divider" : ""} ${streaming ? "turn--streaming" : ""}`}
    >
      {divider ? <span className="turn__divider" aria-hidden /> : null}
      {divider ? null : (
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
        text={messageText(message)}
        copyLabel="Response"
        className="turn__actions--response"
      />
    </div>
  );
});

export const UnpairedToolResultRow = memo(function UnpairedToolResultRow({
  toolName,
  visibility,
}: {
  toolName?: string;
  visibility: StaticVisibility;
}) {
  return (
    <div className="turn">
      <GenericCard
        item={{ type: `toolResult:${toolName ?? "unknown"}` }}
        visibility={visibility}
      />
    </div>
  );
});

export const UnknownRoleRow = memo(function UnknownRoleRow({
  message,
  visibility,
}: {
  message: ChatMessage;
  visibility: StaticVisibility;
}) {
  return (
    <div className="turn">
      <GenericCard
        item={{ ...message, type: message.role }}
        visibility={visibility}
      />
    </div>
  );
});

export function PendingQueueGroups({ queue }: { queue: PendingQueues }) {
  const groups = [
    { key: "steering", label: "Pending steering", items: queue.steering },
    { key: "follow-up", label: "Pending follow-up", items: queue.followUp },
  ];
  return (
    <div
      className="pending-groups"
      role="group"
      aria-label="Pending input queues"
    >
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <section
            key={group.key}
            className="pending-group"
            aria-label={group.label}
          >
            <div className="pending-group__head">
              <span>{group.label}</span>
              <span>
                <span aria-hidden>{group.items.length}</span>
                <span className="visually-hidden"> items</span>
              </span>
            </div>
            <ol className="pending-group__list">
              {group.items.map((text, index) => (
                <li key={index} className="pending-group__item">
                  <pre>{text}</pre>
                </li>
              ))}
            </ol>
          </section>
        ))}
    </div>
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
            <span>{display.attribution}</span>
          </summary>
          <pre className="card__mono">
            {JSON.stringify(display.payload, null, 2)}
          </pre>
        </details>
      ))}
    </section>
  );
}
