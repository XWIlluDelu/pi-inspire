import {
  Fragment,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
} from "react";
import {
  type ActivityFoldVisibilityPreference,
  type AssistantRoundDisplayPreference,
  isBusyRunState,
  type RunState,
  type ToolVisibilityPreference,
  type VisibilityPreference,
} from "../../shared/contracts";
import { messageFallbackCorrelation } from "../../shared/message-identity";
import {
  type ActivityTool,
  asMessage,
  type ChatMessage,
  contentItems,
  messageKey,
  messageText,
  type ToolCallContent,
} from "../events";
import type {
  ActivityMaterializationMode,
  TranscriptActivityRangeState,
} from "../store";
import { ActivitySegmentBoundary } from "./transcript-activity-visibility";
import {
  assistantEndsWithToolRun,
  CustomActivityBatch,
  customActivityItems,
  genericContentTitle,
} from "./transcript-cards";
import {
  type ActivityFoldPresentation,
  type ActivityTelemetryItem,
  ResponseActivityFold,
} from "./transcript-fold";
import {
  AssistantTurn,
  UnknownRoleRow,
  UnpairedToolResultRow,
  UserBubble,
} from "./transcript-rows";
import type { TranscriptSearchScope } from "./transcript-search";

type ProjectionIdentityRegistry = {
  prefix: string;
  byMember: Map<string, string>;
};

type ProjectionIdentityClaim = {
  key: string;
  members: string[];
};

interface DeferredActivityMarker extends ChatMessage {
  role: "__inspireDeferredActivity";
  __inspireActivityRange: TranscriptActivityRangeState;
}

interface TranscriptGapMarker extends ChatMessage {
  role: "__inspireTranscriptGap";
  __inspireGapAfterTurn: number;
  __inspireGapBeforeTurn: number;
}

function isDeferredActivityMarker(
  message: ChatMessage,
): message is DeferredActivityMarker {
  return message.role === "__inspireDeferredActivity";
}

function isTranscriptGapMarker(
  message: ChatMessage,
): message is TranscriptGapMarker {
  return message.role === "__inspireTranscriptGap";
}

function claimProjectionIdentity(
  registry: ProjectionIdentityRegistry,
  claimedKeys: Set<string>,
  claims: ProjectionIdentityClaim[],
  members: string[],
): string {
  let key: string | undefined;
  for (const member of members) {
    const existing = registry.byMember.get(member);
    if (existing && !claimedKeys.has(existing)) {
      key = existing;
      break;
    }
  }
  key ??= `${registry.prefix}:${members[0]}`;
  claimedKeys.add(key);
  claims.push({ key, members });
  return key;
}

type PreserveActivityAnchor = (
  element: HTMLElement,
  alignment: "start" | "center" | "end",
) => void;

interface TranscriptRowProjectionOptions {
  messages: ChatMessage[];
  activityRanges: TranscriptActivityRangeState[];
  sessionId: string;
  viewId: string;
  projectionViewKey: string;
  streaming: boolean;
  runState: RunState | undefined;
  activeAssistantMessageKey: string | null;
  toolActivity: Record<string, ActivityTool>;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: ToolVisibilityPreference;
  activityFoldVisibility: ActivityFoldVisibilityPreference;
  assistantRoundDisplay: AssistantRoundDisplayPreference;
  onMaterializeActivityRanges: (
    cursors: readonly string[],
    beforeCommit?: () => void,
    mode?: ActivityMaterializationMode,
  ) => Promise<void>;
  preserveActivityAnchorRef: RefObject<PreserveActivityAnchor>;
}

export function useTranscriptRows({
  messages,
  activityRanges,
  sessionId,
  viewId,
  projectionViewKey,
  streaming,
  runState,
  activeAssistantMessageKey,
  toolActivity,
  thinkingVisibility,
  toolVisibility,
  activityFoldVisibility,
  assistantRoundDisplay,
  onMaterializeActivityRanges,
  preserveActivityAnchorRef,
}: TranscriptRowProjectionOptions) {
  // Activity runs and their custom batches are semantic groups even while
  // older pages extend them from the left or live events extend them from the
  // right. Member aliases retain the already-mounted disclosure owners.
  const activityProjectionIdentities = useMemo(
    () => ({
      folds: {
        prefix: `activity-fold:${sessionId}\u0000${projectionViewKey}`,
        byMember: new Map<string, string>(),
      },
      customBatches: {
        prefix: `custom-batch:${sessionId}\u0000${projectionViewKey}`,
        byMember: new Map<string, string>(),
      },
      manualFoldPresentation: new Map<string, ActivityFoldPresentation>(),
    }),
    [projectionViewKey, sessionId],
  );

  const projectionMessages = useMemo(() => {
    const rangesByAnchor = new Map<
      string | null,
      TranscriptActivityRangeState[]
    >();
    for (const range of activityRanges) {
      const anchored = rangesByAnchor.get(range.afterMessageId) ?? [];
      anchored.push(range);
      rangesByAnchor.set(range.afterMessageId, anchored);
    }
    const projected: ChatMessage[] = [];
    const appendRanges = (anchor: string | null) => {
      for (const range of rangesByAnchor.get(anchor) ?? []) {
        projected.push({
          role: "__inspireDeferredActivity",
          __inspireActivityRange: range,
        } as DeferredActivityMarker);
      }
      rangesByAnchor.delete(anchor);
    };
    appendRanges(null);
    let previousTurnIndex: number | null = null;
    for (const message of messages) {
      const turnIndex = Number.isSafeInteger(message.__inspireUserTurnIndex)
        ? (message.__inspireUserTurnIndex as number)
        : null;
      if (
        previousTurnIndex !== null &&
        turnIndex !== null &&
        turnIndex > previousTurnIndex + 1
      ) {
        projected.push({
          role: "__inspireTranscriptGap",
          __inspireGapAfterTurn: previousTurnIndex,
          __inspireGapBeforeTurn: turnIndex,
        } as TranscriptGapMarker);
      }
      projected.push(message);
      appendRanges(message.__inspireMessageId ?? null);
      if (turnIndex !== null) previousTurnIndex = turnIndex;
    }
    // A stale anchor should remain visible as a recoverable range instead of
    // silently losing transcript content. Materialization will report the
    // missing boundary and an authoritative refresh can repair it.
    for (const ranges of rangesByAnchor.values()) {
      for (const range of ranges)
        projected.unshift({
          role: "__inspireDeferredActivity",
          __inspireActivityRange: range,
        } as DeferredActivityMarker);
    }
    return projected;
  }, [activityRanges, messages]);

  // Tool-call pairing is derived data: recompute only when the message list changes.
  const { toolResults, toolCallIds } = useMemo(() => {
    const results = new Map<string, ChatMessage>();
    const callIds = new Set<string>();
    for (const raw of messages) {
      if (raw.role === "toolResult" && typeof raw.toolCallId === "string")
        results.set(raw.toolCallId, raw);
      if (raw.role === "assistant") {
        for (const item of contentItems(raw)) {
          if (
            item.type === "toolCall" &&
            typeof (item as ToolCallContent).id === "string"
          ) {
            callIds.add((item as ToolCallContent).id);
          }
        }
      }
    }
    return { toolResults: results, toolCallIds: callIds };
  }, [messages]);

  const authoritativeRunState: RunState =
    runState ??
    (streaming || activeAssistantMessageKey !== null ? "running" : "idle");
  const runBusy = isBusyRunState(authoritativeRunState);

  let activeStreamingMessage: ChatMessage | null = null;
  if (runBusy && streaming && activeAssistantMessageKey) {
    const candidate = messages.find(
      (message) => messageKey(message) === activeAssistantMessageKey,
    );
    if (candidate?.role === "assistant" && candidate.__inspireSettled !== true)
      activeStreamingMessage = candidate;
  }
  // Preview/mock projections may not carry an active lifecycle identity. Only
  // their literal unsettled tail is safe; never reinterpret settled history as
  // the current retry merely because the host run is busy.
  if (runBusy && streaming && !activeAssistantMessageKey) {
    const tail = messages.at(-1);
    if (tail?.role === "assistant" && tail.__inspireSettled !== true)
      activeStreamingMessage = tail;
  }

  const preserveActivityAnchor = useCallback(
    (element: HTMLElement, alignment: "start" | "center" | "end") =>
      preserveActivityAnchorRef.current(element, alignment),
    [preserveActivityAnchorRef],
  );

  // Project visible response passages and the maximal activity between them
  // into separate rows. Activity cards keep their existing renderers and local
  // state; only the outer band changes their collective visibility.
  const rowProjection = useMemo(() => {
    type Row = {
      key: string;
      node: ReactNode;
      searchText: string;
      searchScope: Exclude<TranscriptSearchScope, "all"> | null;
      turnOrdinal: number | null;
      turnId: string | null;
      turnStart: boolean;
    };
    type ActivityRun = {
      memberKeys: string[];
      nodes: { key: string; node: ReactNode }[];
      deferredRanges: TranscriptActivityRangeState[];
      telemetry: ActivityTelemetryItem[];
      live: boolean;
      turnOrdinal: number | null;
      turnId: string | null;
    };
    type AssistantSegment = {
      kind: "response" | "activity";
      start: number;
      content: ChatMessage["content"];
      customMessages: ChatMessage[];
    };

    const built: Row[] = [];
    const foldIdentityClaims: ProjectionIdentityClaim[] = [];
    const customBatchIdentityClaims: ProjectionIdentityClaim[] = [];
    const claimedFoldKeys = new Set<string>();
    const claimedCustomBatchKeys = new Set<string>();
    // Outer disclosure state must survive live-overlay adoption. Ordinary Pi
    // messages keep their timestamp correlation; displayed custom activity can
    // change timestamps and instead carries its host-paired durable entry id.
    const projectionKeyOccurrences = new Map<string, number>();
    const deferredRangeAlias = (message: ChatMessage): string[] =>
      typeof message.__inspireActivityRangeCursor === "string"
        ? [`deferred:${message.__inspireActivityRangeCursor}`]
        : [];
    const projectionKey = (message: ChatMessage, fallback: string): string => {
      const customEntryId =
        message.role === "custom" &&
        typeof message.__inspireEntryId === "string"
          ? `entry:${message.__inspireEntryId}`
          : null;
      const base = `${viewId ?? "current"}:${customEntryId ?? messageFallbackCorrelation(message) ?? fallback}`;
      const occurrence = projectionKeyOccurrences.get(base) ?? 0;
      projectionKeyOccurrences.set(base, occurrence + 1);
      return `${base}:${occurrence}`;
    };
    let currentTurnOrdinal: number | null = null;
    let currentTurnId: string | null = null;
    let activityRun: ActivityRun | null = null;
    const adoptTurnOwner = (message: ChatMessage) => {
      if (Number.isSafeInteger(message.__inspireUserTurnIndex))
        currentTurnOrdinal = message.__inspireUserTurnIndex as number;
      if (typeof message.__inspireUserTurnId === "string")
        currentTurnId = message.__inspireUserTurnId;
      if (message.role === "user") {
        if (!Number.isSafeInteger(message.__inspireUserTurnIndex))
          currentTurnOrdinal = (currentTurnOrdinal ?? -1) + 1;
        if (typeof message.__inspireUserTurnId !== "string")
          currentTurnId = message.__inspireMessageId ?? messageKey(message);
      }
    };
    const appendActivity = (
      key: string,
      node: ReactNode,
      live: boolean,
      aliases: string[] = [],
      deferredRange?: TranscriptActivityRangeState,
      telemetryItems: ActivityTelemetryItem[] = [],
    ) => {
      if (!activityRun)
        activityRun = {
          memberKeys: [],
          nodes: [],
          deferredRanges: [],
          telemetry: [],
          live: false,
          turnOrdinal: currentTurnOrdinal,
          turnId: currentTurnId,
        };
      activityRun.memberKeys.push(key, ...aliases);
      activityRun.nodes.push({ key, node });
      if (deferredRange) activityRun.deferredRanges.push(deferredRange);
      if (telemetryItems.length > 0)
        activityRun.telemetry.push(...telemetryItems);
      activityRun.live ||= live;
    };
    const flushActivity = (boundaryClosed: boolean, tail = false) => {
      if (!activityRun) return;
      const run = activityRun;
      const lifecycleActive =
        !boundaryClosed && (run.live || (tail && runBusy));
      const foldKey = claimProjectionIdentity(
        activityProjectionIdentities.folds,
        claimedFoldKeys,
        foldIdentityClaims,
        run.memberKeys,
      );
      built.push({
        key: foldKey,
        node: (
          <ResponseActivityFold
            visibility={activityFoldVisibility}
            lifecycleActive={lifecycleActive}
            closeRequested={boundaryClosed || !lifecycleActive}
            initialManualPresentation={
              activityProjectionIdentities.manualFoldPresentation.get(
                foldKey,
              ) ?? null
            }
            onManualPresentationChange={(next) =>
              activityProjectionIdentities.manualFoldPresentation.set(
                foldKey,
                next,
              )
            }
            deferredRanges={run.deferredRanges}
            telemetry={run.telemetry}
            onMaterializeRanges={onMaterializeActivityRanges}
            onPreserveAnchor={preserveActivityAnchor}
          >
            {run.nodes.map(({ key, node }) => (
              <Fragment key={key}>{node}</Fragment>
            ))}
          </ResponseActivityFold>
        ),
        searchText: "",
        searchScope: null,
        turnOrdinal: run.turnOrdinal,
        turnId: run.turnId,
        turnStart: false,
      });
      activityRun = null;
    };

    const hasLaterAssistant = new Array<boolean>(
      projectionMessages.length + 1,
    ).fill(false);
    for (let index = projectionMessages.length - 1; index >= 0; index -= 1) {
      hasLaterAssistant[index] =
        hasLaterAssistant[index + 1]! ||
        asMessage(projectionMessages[index]).role === "assistant";
    }

    for (let index = 0; index < projectionMessages.length; ) {
      const message = asMessage(projectionMessages[index]);

      if (isTranscriptGapMarker(message)) {
        flushActivity(true);
        built.push({
          key: `transcript-gap:${message.__inspireGapAfterTurn}:${message.__inspireGapBeforeTurn}`,
          node: (
            <div className="transcript-gap" role="separator">
              <span>Conversation segment not loaded</span>
            </div>
          ),
          searchText: "",
          searchScope: null,
          turnOrdinal: null,
          turnId: null,
          turnStart: false,
        });
        currentTurnOrdinal = null;
        currentTurnId = null;
        index += 1;
        continue;
      }

      adoptTurnOwner(message);
      if (isDeferredActivityMarker(message)) {
        const range = message.__inspireActivityRange;
        const visible =
          (range.kinds.includes("thinking") &&
            thinkingVisibility !== "hidden") ||
          (range.kinds.includes("tool") && toolVisibility !== "hidden");
        if (visible) {
          const memberKey = `deferred:${range.cursor}`;
          const deferredTelemetry: ActivityTelemetryItem[] = range.kinds.map(
            (k) => ({
              id: `${memberKey}:${k}`,
              kind: k === "thinking" ? "thinking" : "tool",
              label: k === "thinking" ? "Thinking" : "Tool call",
              deferred: true,
            }),
          );
          appendActivity(memberKey, null, false, [], range, deferredTelemetry);
        }
        index += 1;
        continue;
      }

      if (message.role === "custom") {
        const customMessages: ChatMessage[] = [];
        const customProjectionKeys: string[] = [];
        while (index < projectionMessages.length) {
          const candidateIndex = index;
          const candidate = asMessage(projectionMessages[index]);
          if (candidate.role !== "custom") break;
          // display:false remains in Pi/model context but is absent from the
          // browser activity run and does not split adjacent visible messages.
          if (candidate.display !== false) {
            customMessages.push(candidate);
            customProjectionKeys.push(
              projectionKey(
                candidate,
                messageKey(candidate) ?? `custom:${candidateIndex}`,
              ),
            );
          }
          index += 1;
        }
        if (toolVisibility !== "hidden" && customMessages.length > 0) {
          const projectedCustomKey = customProjectionKeys[0]!;
          const customKey = claimProjectionIdentity(
            activityProjectionIdentities.customBatches,
            claimedCustomBatchKeys,
            customBatchIdentityClaims,
            customProjectionKeys,
          );
          const customLive = customMessages.some(
            (custom) =>
              typeof custom.__inspireLiveId === "string" &&
              custom.__inspireSettled !== true,
          );
          const customActivityIds = customProjectionKeys.map(
            (projectionKey) => `${projectionKey}:custom`,
          );
          const customTelemetry: ActivityTelemetryItem[] = customMessages.map(
            (c, customIndex) => ({
              id: customActivityIds[customIndex]!,
              kind: "custom",
              label:
                (c as { customType?: string }).customType ?? "Custom activity",
              live:
                typeof c.__inspireLiveId === "string" &&
                c.__inspireSettled !== true,
            }),
          );
          appendActivity(
            projectedCustomKey,
            <ActivitySegmentBoundary ids={customActivityIds}>
              <CustomActivityBatch
                key={customKey}
                messages={customMessages}
                activityItemIds={customActivityIds}
                toolVisibility={toolVisibility}
                collapseRequested={!runBusy || hasLaterAssistant[index]!}
              />
            </ActivitySegmentBoundary>,
            customLive,
            [
              ...customProjectionKeys.slice(1),
              ...customMessages.flatMap(deferredRangeAlias),
            ],
            undefined,
            customTelemetry,
          );
        }
        continue;
      }

      const key = messageKey(message) ?? `${message.role}:${index}`;
      const projectedKey = projectionKey(message, key);
      const settled =
        typeof message.__inspireLiveId !== "string" ||
        message.__inspireSettled === true;
      if (message.role === "user") {
        flushActivity(true);
        built.push({
          key,
          node: (
            <UserBubble
              message={message}
              sessionId={sessionId}
              viewId={viewId}
              projectionKey={projectionViewKey}
            />
          ),
          searchText: settled ? messageText(message) : "",
          searchScope: "user",
          turnOrdinal: currentTurnOrdinal,
          turnId: currentTurnId,
          turnStart: true,
        });
        index += 1;
        continue;
      }

      if (message.role === "assistant") {
        let activityEnd = index + 1;
        const trailingCustomMessages: ChatMessage[] = [];
        const trailingActivityKeys: string[] = [];
        if (assistantEndsWithToolRun(message)) {
          const ownToolCallIds = new Set(
            contentItems(message).flatMap((item) =>
              item.type === "toolCall" &&
              typeof (item as ToolCallContent).id === "string"
                ? [(item as ToolCallContent).id]
                : [],
            ),
          );
          while (activityEnd < projectionMessages.length) {
            const candidate = asMessage(projectionMessages[activityEnd]);
            if (
              candidate.role === "toolResult" &&
              typeof candidate.toolCallId === "string" &&
              ownToolCallIds.has(candidate.toolCallId)
            ) {
              trailingActivityKeys.push(
                projectionKey(
                  candidate,
                  messageKey(candidate) ?? `toolResult:${activityEnd}`,
                ),
                ...deferredRangeAlias(candidate),
              );
              activityEnd += 1;
              continue;
            }
            if (candidate.role === "custom") {
              if (candidate.display !== false) {
                trailingCustomMessages.push(candidate);
                trailingActivityKeys.push(
                  projectionKey(
                    candidate,
                    messageKey(candidate) ?? `custom:${activityEnd}`,
                  ),
                  ...deferredRangeAlias(candidate),
                );
              }
              activityEnd += 1;
              continue;
            }
            break;
          }
        }

        const assistantStreaming = message === activeStreamingMessage;
        const assistantDynamicActive =
          runBusy && key === activeAssistantMessageKey;
        const segments: AssistantSegment[] = [];
        const appendSegmentItem = (
          kind: AssistantSegment["kind"],
          item: ReturnType<typeof contentItems>[number],
          itemIndex: number,
        ) => {
          const previous = segments.at(-1);
          if (
            previous?.kind === kind &&
            Array.isArray(previous.content) &&
            previous.customMessages.length === 0
          ) {
            previous.content.push(item);
            return;
          }
          segments.push({
            kind,
            start: itemIndex,
            content: [item],
            customMessages: [],
          });
        };

        if (typeof message.content === "string") {
          if (message.content.length > 0) {
            segments.push({
              kind: "response",
              start: 0,
              content: message.content,
              customMessages: [],
            });
          }
        } else {
          contentItems(message).forEach((item, itemIndex) => {
            if (item.type === "text") {
              if (
                typeof (item as { text?: unknown }).text === "string" &&
                (item as { text: string }).text.length > 0
              ) {
                appendSegmentItem("response", item, itemIndex);
              }
              return;
            }
            const visible =
              item.type === "thinking"
                ? thinkingVisibility !== "hidden"
                : item.type === "toolCall"
                  ? toolVisibility !== "hidden"
                  : toolVisibility !== "hidden" &&
                    genericContentTitle(item) !== null;
            if (visible) appendSegmentItem("activity", item, itemIndex);
          });
        }

        if (toolVisibility !== "hidden" && trailingCustomMessages.length > 0) {
          const previous = segments.at(-1);
          if (previous?.kind === "activity") {
            previous.customMessages = trailingCustomMessages;
          } else {
            segments.push({
              kind: "activity",
              start: contentItems(message).length,
              content: [],
              customMessages: trailingCustomMessages,
            });
          }
        }

        // Pi may persist an empty error response before retrying. Only the
        // currently active empty assistant becomes a real Working activity.
        if (segments.length === 0 && assistantStreaming) {
          segments.push({
            kind: "activity",
            start: 0,
            content: [],
            customMessages: [],
          });
        }

        let firstResponse = -1;
        let lastResponse = -1;
        let lastActivity = -1;
        segments.forEach((segment, segmentIndex) => {
          if (segment.kind === "response") {
            if (firstResponse < 0) firstResponse = segmentIndex;
            lastResponse = segmentIndex;
          } else lastActivity = segmentIndex;
        });
        // Attribution belongs with this call's first response when one exists.
        // Otherwise a collapsed leading activity band would swallow the round
        // marker and make equivalent responses look inconsistently unowned.
        const leadSegment = firstResponse >= 0 ? firstResponse : 0;
        const fullResponseText = messageText(message);

        segments.forEach((segment, segmentIndex) => {
          const segmentKey = `${projectedKey}:${segment.kind}:${segment.start}`;
          const fragmentMessage: ChatMessage = {
            ...message,
            content: segment.content,
          };
          const fragmentItems = contentItems(fragmentMessage);
          const activityItemIds = fragmentItems.map(
            (_, itemIndex) => `${segmentKey}:item:${itemIndex}`,
          );
          const customActivityIds = customActivityItems(
            segment.customMessages,
          ).map((activity) => `${segmentKey}:${activity.key}`);
          const segmentStreaming =
            assistantStreaming && segmentIndex === segments.length - 1;
          const node = (
            <AssistantTurn
              key={segmentKey}
              message={fragmentMessage}
              toolResults={toolResults}
              toolActivity={toolActivity}
              customMessages={segment.customMessages}
              activityItemIds={activityItemIds}
              customActivityIds={customActivityIds}
              customCollapseRequested={
                !runBusy || hasLaterAssistant[activityEnd]!
              }
              streaming={segmentStreaming}
              dynamicActive={assistantDynamicActive}
              thinkingVisibility={thinkingVisibility}
              toolVisibility={toolVisibility}
              assistantRoundDisplay={assistantRoundDisplay}
              showLead={segmentIndex === leadSegment}
              roundActivityItemId={
                segment.kind === "activity"
                  ? (activityItemIds[0] ?? customActivityIds[0])
                  : undefined
              }
              responseCopyText={
                segment.kind === "response" && segmentIndex === lastResponse
                  ? fullResponseText
                  : ""
              }
            />
          );

          if (segment.kind === "response") {
            flushActivity(true);
            built.push({
              key: `response:${segmentKey}`,
              node,
              searchText:
                settled && !assistantStreaming
                  ? messageText(fragmentMessage)
                  : "",
              searchScope: "model",
              turnOrdinal: currentTurnOrdinal,
              turnId: currentTurnId,
              turnStart: false,
            });
            return;
          }

          const customLive = segment.customMessages.some(
            (custom) =>
              typeof custom.__inspireLiveId === "string" &&
              custom.__inspireSettled !== true,
          );
          const segmentTelemetry: ActivityTelemetryItem[] = [];
          fragmentItems.forEach((item, itemIndex) => {
            if (item.type === "thinking") {
              segmentTelemetry.push({
                id: activityItemIds[itemIndex]!,
                kind: "thinking",
                label: "Thinking",
              });
            } else if (item.type === "toolCall") {
              segmentTelemetry.push({
                id: activityItemIds[itemIndex]!,
                kind: "tool",
                label: (item as ToolCallContent).name
                  ? `Tool: ${(item as ToolCallContent).name}`
                  : "Tool call",
              });
            } else if (genericContentTitle(item) !== null) {
              segmentTelemetry.push({
                id: activityItemIds[itemIndex]!,
                kind: "tool",
                label: genericContentTitle(item) ?? "Activity",
              });
            }
          });
          if (
            (assistantDynamicActive || segmentStreaming) &&
            segmentTelemetry.length > 0
          ) {
            segmentTelemetry[segmentTelemetry.length - 1] = {
              ...segmentTelemetry[segmentTelemetry.length - 1]!,
              live: true,
            };
          }
          segment.customMessages.forEach((c, customIndex) => {
            segmentTelemetry.push({
              id: customActivityIds[customIndex]!,
              kind: "custom",
              label:
                (c as { customType?: string }).customType ?? "Custom activity",
              live:
                typeof c.__inspireLiveId === "string" &&
                c.__inspireSettled !== true,
            });
          });
          appendActivity(
            segmentKey,
            <ActivitySegmentBoundary
              ids={segmentTelemetry.map((item) => item.id)}
            >
              {node}
            </ActivitySegmentBoundary>,
            assistantDynamicActive || segmentStreaming || customLive,
            segmentIndex === lastActivity
              ? [...trailingActivityKeys, ...deferredRangeAlias(message)]
              : deferredRangeAlias(message),
            undefined,
            segmentTelemetry,
          );
        });

        index = activityEnd;
        continue;
      }

      if (message.role === "toolResult") {
        const paired =
          typeof message.toolCallId === "string" &&
          toolCallIds.has(message.toolCallId);
        if (!paired && toolVisibility !== "hidden") {
          const activityItemId = `${projectedKey}:tool-result`;
          const toolTelemetry: ActivityTelemetryItem[] = [
            {
              id: activityItemId,
              kind: "tool",
              label: message.toolName
                ? `Tool: ${message.toolName}`
                : "Tool result",
            },
          ];
          appendActivity(
            projectedKey,
            <UnpairedToolResultRow
              key={key}
              activityItemId={activityItemId}
              toolName={message.toolName}
              visibility={
                toolVisibility === "compact" ||
                toolVisibility === "collapsed" ||
                toolVisibility === "dynamic"
                  ? "collapsed"
                  : toolVisibility
              }
            />,
            false,
            deferredRangeAlias(message),
            undefined,
            toolTelemetry,
          );
        }
      } else if (toolVisibility !== "hidden") {
        const activityItemId = `${projectedKey}:unknown`;
        const unknownTelemetry: ActivityTelemetryItem[] = [
          { id: activityItemId, kind: "tool", label: "Activity" },
        ];
        appendActivity(
          projectedKey,
          <UnknownRoleRow
            key={key}
            activityItemId={activityItemId}
            message={message}
            visibility={
              toolVisibility === "compact" ||
              toolVisibility === "collapsed" ||
              toolVisibility === "dynamic"
                ? "collapsed"
                : toolVisibility
            }
          />,
          false,
          deferredRangeAlias(message),
          undefined,
          unknownTelemetry,
        );
      }
      index += 1;
    }

    flushActivity(false, true);
    return { rows: built, foldIdentityClaims, customBatchIdentityClaims };
  }, [
    projectionMessages,
    activeAssistantMessageKey,
    activeStreamingMessage,
    streaming,
    runBusy,
    activityFoldVisibility,
    activityProjectionIdentities,
    thinkingVisibility,
    toolVisibility,
    assistantRoundDisplay,
    toolResults,
    toolCallIds,
    toolActivity,
    onMaterializeActivityRanges,
    preserveActivityAnchor,
    sessionId,
    viewId,
    projectionViewKey,
  ]);
  const { rows, foldIdentityClaims, customBatchIdentityClaims } = rowProjection;
  useLayoutEffect(() => {
    const commit = (
      registry: ProjectionIdentityRegistry,
      claims: ProjectionIdentityClaim[],
    ) => {
      for (const claim of claims) {
        for (const memberKey of claim.members)
          registry.byMember.set(memberKey, claim.key);
      }
    };
    commit(activityProjectionIdentities.folds, foldIdentityClaims);
    commit(
      activityProjectionIdentities.customBatches,
      customBatchIdentityClaims,
    );
  }, [
    activityProjectionIdentities,
    customBatchIdentityClaims,
    foldIdentityClaims,
  ]);

  return rows;
}
