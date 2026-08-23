import {
  ChevronDown,
  ChevronUp,
  GalleryHorizontalEnd,
  Loader2,
  Search,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ActivityFoldVisibilityPreference,
  type AssistantRoundDisplayPreference,
  emptyPendingQueues,
  type GenericExtensionDisplay,
  isBusyRunState,
  type PendingQueues,
  type RunState,
  type ToolVisibilityPreference,
  type UserTurnAnchor,
  type VisibilityPreference,
} from "../../shared/contracts";
import { messageFallbackCorrelation } from "../../shared/message-identity";
import type { PendingManagementIntent } from "../api";
import {
  type ActivityTool,
  asMessage,
  type ChatMessage,
  contentItems,
  messageKey,
  messageText,
  type ToolCallContent,
} from "../events";
import {
  type ActivityMaterializationMode,
  store,
  type TranscriptActivityRangeState,
} from "../store";
import { Dropdown } from "./Dropdown";
import { EarlierBranchBanner } from "./EarlierBranchBanner";
import { PromptMap } from "./PromptMap";
import { handleRichTextCopy } from "./RichText";
import { ScrollRail } from "./ScrollRail";
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
  ExtensionDisplaySurface,
  PendingQueueGroups,
  UnknownRoleRow,
  UnpairedToolResultRow,
  UserBubble,
} from "./transcript-rows";
import {
  TRANSCRIPT_SEARCH_SCOPES,
  type TranscriptSearchScope,
  useTranscriptSearch,
} from "./transcript-search";
import { useTranscriptViewport } from "./transcript-viewport";

// --- Transcript with pinned auto-scroll ---

const EMPTY_TOOL_ACTIVITY: Record<string, ActivityTool> = {};

type MobileTranscriptTool = "search" | "prompt" | null;

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

export function Transcript({
  messages,
  activityRanges = [],
  promptMapTurns = [],
  promptMapTotal = 0,
  promptMapLoadedStarts = [],
  promptMapLoadingStarts = [],
  promptMapError = null,
  promptMapNavigatingOrdinal = null,
  streaming,
  runState,
  activeAssistantMessageKey = null,
  toolActivity = EMPTY_TOOL_ACTIVITY,
  thinkingVisibility,
  toolVisibility,
  activityFoldVisibility = "expanded",
  assistantRoundDisplay = "details",
  hasOlder = false,
  loadingOlder = false,
  olderError = null,
  onLoadOlder = store.loadOlderMessages,
  onMaterializeActivityRanges = store.materializeActivityRanges,
  onLoadPromptMapTurns = store.loadPromptMapTurns,
  onNavigatePromptMapTurn = store.navigatePromptMapTurn,
  sessionId = "",
  viewId = "",
  projectionIncarnation = "",
  queue = emptyPendingQueues(),
  pendingAction = null,
  onManagePending = store.managePending,
  onPendingMessageTexts = store.pendingMessageTexts,
  extensionDisplays = [],
  viewingEarlierBranch = false,
}: {
  messages: ChatMessage[];
  activityRanges?: TranscriptActivityRangeState[];
  promptMapTurns?: UserTurnAnchor[];
  promptMapTotal?: number;
  promptMapLoadedStarts?: number[];
  promptMapLoadingStarts?: number[];
  promptMapError?: string | null;
  promptMapNavigatingOrdinal?: number | null;
  streaming: boolean;
  runState?: RunState;
  activeAssistantMessageKey?: string | null;
  toolActivity?: Record<string, ActivityTool>;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: ToolVisibilityPreference;
  activityFoldVisibility?: ActivityFoldVisibilityPreference;
  assistantRoundDisplay?: AssistantRoundDisplayPreference;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  olderError?: string | null;
  onLoadOlder?: () => Promise<boolean>;
  onMaterializeActivityRanges?: (
    cursors: readonly string[],
    beforeCommit?: () => void,
    mode?: ActivityMaterializationMode,
  ) => Promise<void>;
  onLoadPromptMapTurns?: (start?: number) => Promise<readonly UserTurnAnchor[]>;
  onNavigatePromptMapTurn?: (ordinal: number) => Promise<boolean>;
  sessionId?: string;
  viewId?: string;
  projectionIncarnation?: string;
  queue?: PendingQueues;
  pendingAction?: PendingManagementIntent["action"] | null;
  onManagePending?: (action: PendingManagementIntent) => Promise<boolean>;
  onPendingMessageTexts?: (
    messageIds: readonly string[],
  ) => Promise<string[] | null>;
  extensionDisplays?: GenericExtensionDisplay[];
  viewingEarlierBranch?: boolean;
}) {
  const searchOwnsViewportRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [mobileTranscriptTool, setMobileTranscriptTool] =
    useState<MobileTranscriptTool>(null);
  const projectionViewKey = `${viewId}\u0000${projectionIncarnation}`;
  const preserveActivityAnchorRef = useRef<
    (element: HTMLElement, alignment: "start" | "center" | "end") => void
  >(() => undefined);
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

  // Project visible response passages and the maximal activity between them
  // into separate rows. Activity cards keep their existing renderers and local
  // state; only the outer band changes their collective visibility.
  const rowProjection = useMemo(() => {
    type Row = {
      key: string;
      node: React.ReactNode;
      searchText: string;
      searchScope: Exclude<TranscriptSearchScope, "all"> | null;
      turnOrdinal: number | null;
      turnId: string | null;
      turnStart: boolean;
    };
    type ActivityRun = {
      memberKeys: string[];
      nodes: React.ReactNode[];
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
      node: React.ReactNode,
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
      activityRun.nodes.push(node);
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
            onPreserveAnchor={(element, alignment) =>
              preserveActivityAnchorRef.current(element, alignment)
            }
          >
            {run.nodes}
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
    sessionId,
    viewId,
  ]);
  const { rows, foldIdentityClaims, customBatchIdentityClaims } = rowProjection;
  const loadedPromptTurns = useMemo(() => {
    const byOrdinal = new Map<number, UserTurnAnchor>();
    let inferredOrdinal = -1;
    for (const message of messages) {
      if (Number.isSafeInteger(message.__inspireUserTurnIndex))
        inferredOrdinal = message.__inspireUserTurnIndex as number;
      if (message.role !== "user") continue;
      if (!Number.isSafeInteger(message.__inspireUserTurnIndex))
        inferredOrdinal += 1;
      const id =
        message.__inspireMessageId ??
        messageKey(message) ??
        `loaded-user:${inferredOrdinal}`;
      const attachmentCount = contentItems(message).filter(
        (item) => item.type === "image",
      ).length;
      byOrdinal.set(inferredOrdinal, {
        id,
        ordinal: inferredOrdinal,
        snippet:
          Array.from(
            messageText(message).replace(/\s+/g, " ").trim().slice(0, 360),
          )
            .slice(0, 180)
            .join("") ||
          (attachmentCount > 0 ? "Image attachment" : "User message"),
        attachmentCount,
      });
    }
    return [...byOrdinal.values()];
  }, [messages]);
  const effectivePromptTurns = useMemo(() => {
    const byOrdinal = new Map(
      promptMapTurns.map((turn) => [turn.ordinal, turn]),
    );
    for (const turn of loadedPromptTurns) byOrdinal.set(turn.ordinal, turn);
    return [...byOrdinal.values()].sort(
      (left, right) => left.ordinal - right.ordinal,
    );
  }, [loadedPromptTurns, promptMapTurns]);
  const effectivePromptTotal = Math.max(
    promptMapTotal,
    (effectivePromptTurns.at(-1)?.ordinal ?? -1) + 1,
  );
  const [activePromptOrdinal, setActivePromptOrdinal] = useState<number | null>(
    null,
  );
  const [pendingPromptOrdinal, setPendingPromptOrdinal] = useState<
    number | null
  >(null);
  const promptNavigationOverrideRef = useRef<number | null>(null);
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

  const viewport = useTranscriptViewport({
    rows,
    sessionId,
    viewId: projectionViewKey,
    hasOlder,
    olderError,
    onLoadOlder,
    followSignal: messages,
    searchOwnsViewportRef,
  });
  useLayoutEffect(() => {
    preserveActivityAnchorRef.current = viewport.preserveAnchorThroughLayout;
  }, [viewport.preserveAnchorThroughLayout]);
  const search = useTranscriptSearch({
    rows,
    sessionId,
    viewId: projectionViewKey,
    searchOwnsViewportRef,
    onClear: viewport.restoreGeometricFollow,
    onNavigate: (rowIndex) => {
      promptNavigationOverrideRef.current = null;
      viewport.releaseLatestFollow();
      if (viewport.virtualize) {
        viewport.virtualizer.scrollToIndex(rowIndex, { align: "center" });
        return;
      }
      requestAnimationFrame(() => {
        const row = viewport.scrollRef.current?.querySelector<HTMLElement>(
          `[data-transcript-row="${rowIndex}"]`,
        );
        row?.scrollIntoView?.({ block: "center" });
      });
    },
  });

  const closeMobileTranscriptTool = useCallback(() => {
    if (mobileTranscriptTool === "search") search.clear();
    setMobileTranscriptTool(null);
  }, [mobileTranscriptTool, search]);
  const searchQueryRef = useRef(search.query);
  searchQueryRef.current = search.query;

  useLayoutEffect(() => {
    if (mobileTranscriptTool !== "search") return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [mobileTranscriptTool]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const narrow = window.matchMedia("(max-width: 900px)");
    const syncLayout = () => {
      if (!narrow.matches) setMobileTranscriptTool(null);
      else if (searchQueryRef.current) setMobileTranscriptTool("search");
    };
    syncLayout();
    narrow.addEventListener("change", syncLayout);
    return () => narrow.removeEventListener("change", syncLayout);
  }, []);

  useEffect(() => {
    if (mobileTranscriptTool === null) return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          ".transcript-mobile-toolbar, .transcript-search, [data-prompt-map]",
        )
      )
        return;
      closeMobileTranscriptTool();
    };
    const timer = window.setTimeout(
      () => document.addEventListener("pointerdown", closeFromOutside, true),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", closeFromOutside, true);
    };
  }, [closeMobileTranscriptTool, mobileTranscriptTool]);

  const scrollToPromptOrdinal = useCallback(
    (ordinal: number): boolean => {
      const rowIndex = rows.findIndex(
        (row) => row.turnOrdinal === ordinal && row.turnStart,
      );
      if (rowIndex < 0) return false;
      promptNavigationOverrideRef.current = ordinal;
      viewport.markUserScrollIntent();
      viewport.releaseLatestFollow();
      if (viewport.virtualize) {
        viewport.virtualizer.scrollToIndex(rowIndex, { align: "start" });
      } else {
        requestAnimationFrame(() => {
          viewport.scrollRef.current
            ?.querySelector<HTMLElement>(`[data-transcript-row="${rowIndex}"]`)
            ?.scrollIntoView({ block: "start" });
        });
      }
      setActivePromptOrdinal(ordinal);
      return true;
    },
    [rows, viewport],
  );

  const navigatePromptOrdinal = useCallback(
    async (ordinal: number) => {
      search.clearCurrentMatch();
      if (scrollToPromptOrdinal(ordinal)) return true;
      if (ordinal >= promptMapTotal) await onLoadPromptMapTurns();
      setPendingPromptOrdinal(ordinal);
      const loaded = await onNavigatePromptMapTurn(ordinal);
      if (!loaded) setPendingPromptOrdinal(null);
      return loaded;
    },
    [
      onLoadPromptMapTurns,
      onNavigatePromptMapTurn,
      promptMapTotal,
      scrollToPromptOrdinal,
      search,
    ],
  );

  useEffect(() => {
    promptNavigationOverrideRef.current = null;
    setActivePromptOrdinal(null);
    setPendingPromptOrdinal(null);
    setMobileTranscriptTool(null);
  }, [sessionId, projectionViewKey]);

  useLayoutEffect(() => {
    if (pendingPromptOrdinal === null) return;
    if (scrollToPromptOrdinal(pendingPromptOrdinal))
      setPendingPromptOrdinal(null);
  }, [pendingPromptOrdinal, rows, scrollToPromptOrdinal]);

  useEffect(() => {
    const scroller = viewport.scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = scroller.getBoundingClientRect();
        const readingLine = bounds.top + Math.min(bounds.height * 0.32, 220);
        const candidates = [
          ...scroller.querySelectorAll<HTMLElement>("[data-user-turn-index]"),
        ];
        let selected: HTMLElement | null = null;
        const overrideOrdinal = promptNavigationOverrideRef.current;
        if (overrideOrdinal !== null) {
          selected =
            candidates.find((candidate) => {
              if (Number(candidate.dataset.userTurnIndex) !== overrideOrdinal)
                return false;
              const rect = candidate.getBoundingClientRect();
              return rect.bottom > bounds.top && rect.top < bounds.bottom;
            }) ?? null;
          if (selected) {
            setActivePromptOrdinal(overrideOrdinal);
            return;
          }
          promptNavigationOverrideRef.current = null;
        }
        const latestOrdinal = effectivePromptTotal - 1;
        const remaining =
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (
          latestOrdinal >= 0 &&
          scroller.scrollHeight - scroller.clientHeight > 1 &&
          remaining <= 1 &&
          candidates.some(
            (candidate) =>
              Number(candidate.dataset.userTurnIndex) === latestOrdinal,
          )
        ) {
          setActivePromptOrdinal(latestOrdinal);
          return;
        }
        for (const candidate of candidates) {
          const rect = candidate.getBoundingClientRect();
          if (rect.top <= readingLine) selected = candidate;
          else if (!selected) {
            selected = candidate;
            break;
          } else break;
        }
        if (!selected) {
          setActivePromptOrdinal(null);
          return;
        }
        const ordinal = Number(selected.dataset.userTurnIndex);
        if (Number.isSafeInteger(ordinal)) setActivePromptOrdinal(ordinal);
      });
    };
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    if (viewport.contentRef.current)
      observer.observe(viewport.contentRef.current);
    update();
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [
    effectivePromptTotal,
    rows,
    sessionId,
    projectionViewKey,
    viewport.contentRef,
    viewport.scrollRef,
  ]);

  const jumpToLatest = () => {
    promptNavigationOverrideRef.current = null;
    search.clearCurrentMatch();
    viewport.jumpToLatest();
  };

  const onActivityFoldClickCapture = (event: React.MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>(
      "[data-activity-fold-anchor]",
    );
    const fold = control?.closest<HTMLElement>("[data-activity-fold]");
    const alignment = control?.dataset.activityFoldAnchor;
    if (
      !fold ||
      (alignment !== "start" && alignment !== "center" && alignment !== "end")
    )
      return;
    viewport.preserveAnchorThroughLayout(fold, alignment);
  };

  // One delegated handler serves every data-file-path element (Markdown
  // links/images, inline-code paths) regardless of virtualization or memoized
  // rows. Elements that must not bubble (tool-card summaries) stop propagation
  // and call store.openResource themselves.
  const onClick = (event: React.MouseEvent) => {
    const origin =
      event.target instanceof Element
        ? event.target.closest("[data-file-path]")
        : null;
    const reference = origin?.getAttribute("data-file-path");
    if (!reference) return;
    event.preventDefault();
    void store.openResource(reference);
  };

  return (
    <div
      className={`transcript-wrap transcript-wrap--mobile-${mobileTranscriptTool ?? "idle"} ${viewingEarlierBranch ? "transcript-wrap--earlier-branch" : ""}`}
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        if (event.key === "f" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (
            typeof window.matchMedia === "function" &&
            window.matchMedia("(max-width: 900px)").matches
          ) {
            setMobileTranscriptTool("search");
          }
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        } else if (
          viewport.scrollRef.current?.contains(event.target as Node) &&
          [
            "ArrowUp",
            "ArrowDown",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            " ",
          ].includes(event.key)
        ) {
          promptNavigationOverrideRef.current = null;
          viewport.markUserScrollIntent();
        }
      }}
    >
      <EarlierBranchBanner />
      <div className="transcript-mobile-toolbar">
        {mobileTranscriptTool === null ? (
          <div
            className="transcript-mobile-toolbar__launchers"
            role="toolbar"
            aria-label="Transcript tools"
          >
            <button
              type="button"
              className="transcript-mobile-toolbar__button"
              aria-label="Open prompt navigation"
              title="Open prompt navigation"
              onClick={() => setMobileTranscriptTool("prompt")}
            >
              <GalleryHorizontalEnd size={18} aria-hidden />
            </button>
            <button
              type="button"
              className="transcript-mobile-toolbar__button"
              aria-label="Open conversation search"
              title="Search conversation"
              onClick={() => setMobileTranscriptTool("search")}
            >
              <Search size={18} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>
      <div
        className={`transcript-search ${search.query ? "transcript-search--active" : ""} ${mobileTranscriptTool === "search" ? "transcript-search--mobile-open" : ""}`}
        role="search"
        aria-label="Search settled transcript"
        onClick={(event) => {
          if (
            event.target === event.currentTarget ||
            (event.target instanceof Element &&
              event.target.closest(".transcript-search__icon"))
          ) {
            searchInputRef.current?.focus();
          }
        }}
      >
        <Search size={14} className="transcript-search__icon" aria-hidden />
        <Dropdown
          label="Search scope"
          value={search.scope}
          options={TRANSCRIPT_SEARCH_SCOPES}
          onChange={(value) => search.setScope(value as TranscriptSearchScope)}
          className="transcript-search__scope"
        />
        <input
          ref={searchInputRef}
          type="search"
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              search.navigate(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              closeMobileTranscriptTool();
              searchInputRef.current?.blur();
            }
          }}
          placeholder="Search conversation"
          aria-label="Search conversation"
        />
        <output aria-live="polite" aria-label="Transcript search matches">
          {search.query
            ? search.matches.length > 0
              ? search.currentMatch >= 0
                ? `${search.currentMatch + 1} of ${search.matches.length}`
                : `${search.matches.length} ${search.matches.length === 1 ? "match" : "matches"}`
              : "No matches"
            : ""}
        </output>
        <button
          type="button"
          aria-label="Previous transcript match"
          disabled={search.matches.length === 0}
          onClick={() => search.navigate(-1)}
        >
          <ChevronUp size={13} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Next transcript match"
          disabled={search.matches.length === 0}
          onClick={() => search.navigate(1)}
        >
          <ChevronDown size={13} aria-hidden />
        </button>
        <button
          type="button"
          className="transcript-search__close"
          aria-label="Close conversation search"
          title="Close search"
          onClick={closeMobileTranscriptTool}
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <div
        className="transcript"
        role="log"
        aria-live="polite"
        ref={viewport.scrollRef}
        onScroll={viewport.onScroll}
        onPointerDown={() => {
          promptNavigationOverrideRef.current = null;
        }}
        onWheel={() => {
          promptNavigationOverrideRef.current = null;
          viewport.markUserScrollIntent();
        }}
        onTouchStart={() => {
          promptNavigationOverrideRef.current = null;
          viewport.markUserScrollIntent();
        }}
        onTouchMove={viewport.markUserScrollIntent}
        onClickCapture={onActivityFoldClickCapture}
        onClick={onClick}
        onCopy={handleRichTextCopy}
      >
        <div className="transcript__content" ref={viewport.contentRef}>
          {hasOlder ? (
            <div className="transcript__older-sentinel">
              {loadingOlder || viewport.loadingEarlier ? (
                <span className="transcript__older-status" role="status">
                  <Loader2 size={13} className="spin" aria-hidden />
                  Loading earlier messages…
                </span>
              ) : olderError ? (
                <button
                  type="button"
                  className="transcript__older-retry"
                  title={olderError}
                  onClick={() => void viewport.loadOlder()}
                >
                  Retry loading earlier messages
                </button>
              ) : null}
            </div>
          ) : null}
          {rows.length === 0 ? (
            <div className="transcript__column">
              <div className="empty-state">
                <p className="empty-state__title">Empty session</p>
                <p className="empty-state__hint">
                  Send a message below to start working with Pi.
                </p>
              </div>
            </div>
          ) : viewport.virtualize ? (
            <div
              className="transcript__column transcript__column--virtual"
              style={{ height: viewport.virtualizer.getTotalSize() }}
            >
              {viewport.virtualizer.getVirtualItems().map((item) => (
                <div
                  key={rows[item.index]!.key}
                  data-index={item.index}
                  data-transcript-row={item.index}
                  data-transcript-key={rows[item.index]!.key}
                  data-user-turn-index={
                    rows[item.index]!.turnOrdinal ?? undefined
                  }
                  data-user-turn-id={rows[item.index]!.turnId ?? undefined}
                  ref={viewport.virtualizer.measureElement}
                  className="transcript__virtual-row"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {rows[item.index]!.node}
                </div>
              ))}
            </div>
          ) : (
            <div className="transcript__column">
              {rows.map((row, index) => (
                <div
                  key={row.key}
                  data-transcript-row={index}
                  data-transcript-key={row.key}
                  data-user-turn-index={row.turnOrdinal ?? undefined}
                  data-user-turn-id={row.turnId ?? undefined}
                >
                  {row.node}
                </div>
              ))}
            </div>
          )}
          {queue.paused ||
          queue.steering.length > 0 ||
          queue.followUp.length > 0 ||
          extensionDisplays.length > 0 ? (
            <div className="transcript__column transcript__pending">
              <PendingQueueGroups
                queue={queue}
                pendingAction={pendingAction}
                onManage={onManagePending}
                onReadTexts={onPendingMessageTexts}
              />
              <ExtensionDisplaySurface displays={extensionDisplays} />
            </div>
          ) : null}
        </div>
      </div>
      <PromptMap
        key={`prompt-map:${sessionId}\u0000${projectionViewKey}`}
        container={viewport.scrollRef}
        mobileActive={mobileTranscriptTool === "prompt"}
        turns={effectivePromptTurns}
        total={effectivePromptTotal}
        activeOrdinal={activePromptOrdinal}
        loadedStarts={promptMapLoadedStarts}
        loadingStarts={promptMapLoadingStarts}
        navigatingOrdinal={promptMapNavigatingOrdinal}
        error={promptMapError}
        onLoad={onLoadPromptMapTurns}
        onNavigate={navigatePromptOrdinal}
      />
      <ScrollRail
        container={viewport.scrollRef}
        variant="reading"
        onUserScroll={viewport.markUserScrollIntent}
      />
      {!viewport.pinned ? (
        <button type="button" className="jump-to-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
