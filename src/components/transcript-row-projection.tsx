import {
  Fragment,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
} from "react";
import { assistantOutcome } from "../../shared/assistant-outcome";
import {
  type ActivityFoldVisibilityPreference,
  isBusyRunState,
  type RunState,
  type ToolVisibilityPreference,
  type VisibilityPreference,
} from "../../shared/contracts";
import { messageFallbackCorrelation } from "../../shared/message-identity";
import { stripTerminalSequences } from "../ansi";
import {
  type ActivityTool,
  asMessage,
  type ChatMessage,
  contentItems,
  messageKey,
  messageText,
  type ToolCallContent,
  userMessageSearchText,
} from "../events";
import { messageCopyLoader } from "../message-copy";
import {
  checkpointPresentation,
  usePresentationAdapters,
} from "../presentation-adapters";
import type {
  ActivityMaterializationMode,
  TranscriptActivityRangeState,
} from "../store";
import { AssistantError, AssistantStopped } from "./AssistantError";
import { BashExecution } from "./BashExecution";
import { CustomMessage } from "./CustomMessage";
import {
  type ActivityReadingChoices,
  ActivitySegmentBoundary,
} from "./transcript-activity-visibility";
import { genericContentTitle } from "./transcript-cards";
import {
  type ActivityFoldPresentation,
  type ActivityTelemetryItem,
  ResponseActivityFold,
} from "./transcript-fold";
import {
  AssistantActivity,
  type AssistantActivityContent,
  AssistantResponse,
  ContextCheckpointRow,
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
  onMaterializeActivityRanges,
  preserveActivityAnchorRef,
}: TranscriptRowProjectionOptions) {
  const { configuration: presentationConfiguration } =
    usePresentationAdapters();
  // Activity runs are semantic groups even while
  // older pages extend them from the left or live events extend them from the
  // right. Member aliases retain the already-mounted disclosure owners.
  const activityProjectionIdentities = useMemo(
    () => ({
      folds: {
        prefix: `activity-fold:${sessionId}\u0000${projectionViewKey}`,
        byMember: new Map<string, string>(),
      },
      manualFoldPresentation: new Map<string, ActivityFoldPresentation>(),
      readingChoices: new Map() as ActivityReadingChoices,
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
    type AssistantSegment =
      | { kind: "response"; start: number; passages: string[] }
      | { kind: "activity"; start: number; items: AssistantActivityContent[] };

    const built: Row[] = [];
    const activityItemKeys = new Set<string>();
    const foldIdentityClaims: ProjectionIdentityClaim[] = [];
    const claimedFoldKeys = new Set<string>();
    // Outer disclosure state must survive live-overlay adoption. Ordinary Pi
    // messages keep their timestamp correlation; displayed custom messages can
    // change timestamps and instead carry their host-paired durable entry ids.
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
      const base = `${viewId}:${customEntryId ?? messageFallbackCorrelation(message) ?? fallback}`;
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
      if (telemetryItems.length > 0) {
        activityRun.telemetry.push(...telemetryItems);
        for (const item of telemetryItems) activityItemKeys.add(item.id);
      }
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
            readingChoices={activityProjectionIdentities.readingChoices}
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
          const deferredTelemetry: ActivityTelemetryItem[] = range.kinds
            .filter((kind) =>
              kind === "thinking"
                ? thinkingVisibility !== "hidden"
                : toolVisibility !== "hidden",
            )
            .map((k, index) => ({
              id: `${memberKey}:${k}:${index}`,
              kind: k === "thinking" ? "thinking" : "tool",
              label: k === "thinking" ? "Thinking" : "Tool call",
              deferred: true,
            }));
          appendActivity(memberKey, null, false, [], range, deferredTelemetry);
        }
        index += 1;
        continue;
      }

      if (message.role === "custom") {
        if (message.display !== false) {
          flushActivity(true);
          const customKey = projectionKey(
            message,
            messageKey(message) ?? `custom:${index}`,
          );
          built.push({
            key: `custom:${customKey}`,
            node: (
              <CustomMessage
                message={message}
                sessionId={sessionId}
                viewId={viewId}
                projectionKey={projectionViewKey}
              />
            ),
            searchText:
              typeof message.__inspireLiveId !== "string" ||
              message.__inspireSettled === true
                ? messageText(message)
                : "",
            // Searchable in All, without pretending the extension is the user or model.
            searchScope: null,
            turnOrdinal: currentTurnOrdinal,
            turnId: currentTurnId,
            turnStart: false,
          });
        }
        index += 1;
        continue;
      }

      const key = messageKey(message) ?? `${message.role}:${index}`;
      const projectedKey = projectionKey(message, key);
      const settled =
        typeof message.__inspireLiveId !== "string" ||
        message.__inspireSettled === true;
      if (message.role === "bashExecution") {
        flushActivity(true);
        built.push({
          key,
          node: <BashExecution message={message} />,
          searchText: settled
            ? `${message.command ?? ""}\n${stripTerminalSequences(message.output ?? "")}`
            : "",
          searchScope: null,
          turnOrdinal: currentTurnOrdinal,
          turnId: currentTurnId,
          turnStart: false,
        });
        index += 1;
        continue;
      }
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
          searchText: settled ? userMessageSearchText(message) : "",
          searchScope: "user",
          turnOrdinal: currentTurnOrdinal,
          turnId: currentTurnId,
          turnStart: true,
        });
        index += 1;
        continue;
      }

      if (
        message.role === "compactionSummary" ||
        message.role === "branchSummary"
      ) {
        flushActivity(true);
        const { displaySummary } = checkpointPresentation(message);
        built.push({
          key,
          node: <ContextCheckpointRow message={message} />,
          searchText: settled ? displaySummary : "",
          searchScope: "model",
          turnOrdinal: currentTurnOrdinal,
          turnId: currentTurnId,
          turnStart: false,
        });
        index += 1;
        continue;
      }

      if (message.role === "assistant") {
        const items = contentItems(message);
        let activityEnd = index + 1;
        const trailingActivityKeys: string[] = [];
        if (items.at(-1)?.type === "toolCall") {
          const ownToolCallIds = new Set(
            items.flatMap((item) =>
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
            if (candidate.role === "custom" && candidate.display === false) {
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
        if (typeof message.content === "string" && message.content) {
          segments.push({
            kind: "response",
            start: 0,
            passages: [message.content],
          });
        }
        items.forEach((item, index) => {
          const previous = segments.at(-1);
          if (item.type === "text") {
            if (typeof item.text !== "string" || !item.text) return;
            if (previous?.kind === "response")
              previous.passages.push(item.text);
            else
              segments.push({
                kind: "response",
                start: index,
                passages: [item.text],
              });
            return;
          }

          let activity: AssistantActivityContent;
          if (item.type === "thinking") {
            if (thinkingVisibility === "hidden") return;
            activity = {
              kind: "thinking",
              text: (item as { thinking?: string }).thinking ?? "",
            };
          } else {
            if (toolVisibility === "hidden") return;
            if (item.type === "toolCall") {
              const call = item as ToolCallContent;
              activity = {
                kind: "tool",
                call,
                result: toolResults.get(call.id),
                activity: toolActivity[call.id],
              };
            } else {
              const title = genericContentTitle(item);
              if (!title) return;
              activity = { kind: "generic", item, title };
            }
          }
          if (previous?.kind === "activity") previous.items.push(activity);
          else
            segments.push({
              kind: "activity",
              start: index,
              items: [activity],
            });
        });

        const outcome = assistantOutcome(message);
        // Empty failed messages show their outcome, while an active empty row shows Working.
        if (segments.length === 0 && assistantStreaming && !outcome)
          segments.push({ kind: "activity", start: 0, items: [] });

        let lastResponse = -1;
        let lastActivity = -1;
        segments.forEach((segment, index) => {
          if (segment.kind === "response") lastResponse = index;
          else lastActivity = index;
        });

        segments.forEach((segment, segmentIndex) => {
          const segmentKey = `${projectedKey}:${segment.kind}:${segment.start}`;
          const segmentStreaming =
            assistantStreaming && segmentIndex === segments.length - 1;

          if (segment.kind === "response") {
            const copyText =
              segmentIndex === lastResponse ? messageText(message) : "";
            flushActivity(true);
            built.push({
              key: `response:${segmentKey}`,
              node: (
                <AssistantResponse
                  key={segmentKey}
                  passages={segment.passages}
                  streaming={segmentStreaming}
                  copyText={copyText}
                  copyContent={
                    copyText
                      ? messageCopyLoader(message, copyText, {
                          sessionId,
                          viewId,
                          projectionKey: projectionViewKey,
                        })
                      : undefined
                  }
                />
              ),
              searchText:
                settled && !assistantStreaming
                  ? segment.passages.join("\n\n")
                  : "",
              searchScope: "model",
              turnOrdinal: currentTurnOrdinal,
              turnId: currentTurnId,
              turnStart: false,
            });
            return;
          }

          const activityItems = segment.items.map((item, index) => ({
            ...item,
            key: `${segmentKey}:item:${index}`,
          }));
          const telemetry = activityItems.map<ActivityTelemetryItem>(
            (item, index) => {
              if (item.kind === "thinking") {
                return {
                  id: item.key,
                  kind: "thinking",
                  label: "Thinking",
                  // Only the trailing Thinking part is streaming.
                  live: segmentStreaming && index === activityItems.length - 1,
                };
              }
              if (item.kind === "generic")
                return { id: item.key, kind: "tool", label: item.title };
              const { call, result } = item;
              const phase = item.activity?.phase;
              return {
                id: item.key,
                kind: "tool",
                label: call.name ? `Tool: ${call.name}` : "Tool call",
                name: call.name || undefined,
                failed: result?.isError === true || phase === "error",
                live:
                  runBusy &&
                  !result &&
                  phase !== "done" &&
                  phase !== "error" &&
                  (phase === "running" ||
                    phase === "queued" ||
                    (assistantDynamicActive &&
                      call.__inspireToolCall?.phase !== "interrupted")),
              };
            },
          );
          appendActivity(
            segmentKey,
            <ActivitySegmentBoundary
              ids={activityItems.map((item) => item.key)}
            >
              <AssistantActivity
                key={segmentKey}
                items={activityItems}
                streaming={segmentStreaming}
                dynamicActive={assistantDynamicActive}
                thinkingVisibility={thinkingVisibility}
                toolVisibility={toolVisibility}
              />
            </ActivitySegmentBoundary>,
            assistantDynamicActive || segmentStreaming,
            segmentIndex === lastActivity
              ? [...trailingActivityKeys, ...deferredRangeAlias(message)]
              : deferredRangeAlias(message),
            undefined,
            telemetry,
          );
        });

        if (outcome) {
          // Outcomes remain after partial content and outside activity folding,
          // including a cancellation with no response body.
          flushActivity(true);
          const detail =
            typeof message.errorMessage === "string" &&
            message.errorMessage.trim()
              ? message.errorMessage
              : outcome === "error"
                ? "Pi did not provide error details."
                : "";
          built.push({
            key: `${outcome}:${projectedKey}`,
            node:
              outcome === "stopped" ? (
                <AssistantStopped />
              ) : (
                <AssistantError text={detail} />
              ),
            searchText: outcome === "stopped" ? "Stopped" : detail,
            searchScope: "model",
            turnOrdinal: currentTurnOrdinal,
            turnId: currentTurnId,
            turnStart: false,
          });
        }

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
              name:
                typeof message.toolName === "string"
                  ? message.toolName
                  : undefined,
              failed: message.isError === true,
            },
          ];
          appendActivity(
            projectedKey,
            <ActivitySegmentBoundary ids={[activityItemId]}>
              <UnpairedToolResultRow
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
              />
            </ActivitySegmentBoundary>,
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
          <ActivitySegmentBoundary ids={[activityItemId]}>
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
            />
          </ActivitySegmentBoundary>,
          false,
          deferredRangeAlias(message),
          undefined,
          unknownTelemetry,
        );
      }
      index += 1;
    }

    flushActivity(false, true);
    return { rows: built, foldIdentityClaims, activityItemKeys };
  }, [
    presentationConfiguration,
    projectionMessages,
    activeAssistantMessageKey,
    activeStreamingMessage,
    streaming,
    runBusy,
    activityFoldVisibility,
    activityProjectionIdentities,
    thinkingVisibility,
    toolVisibility,
    toolResults,
    toolCallIds,
    toolActivity,
    onMaterializeActivityRanges,
    preserveActivityAnchor,
    sessionId,
    viewId,
    projectionViewKey,
  ]);
  const { rows, foldIdentityClaims, activityItemKeys } = rowProjection;
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
    for (const id of activityProjectionIdentities.readingChoices.keys())
      if (!activityItemKeys.has(id))
        activityProjectionIdentities.readingChoices.delete(id);
  }, [activityItemKeys, activityProjectionIdentities, foldIdentityClaims]);

  return rows;
}
