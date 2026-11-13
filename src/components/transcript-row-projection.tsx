import { Fragment, type ReactNode, useLayoutEffect, useMemo } from "react";
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

interface TranscriptRowProjectionOptions {
  messages: ChatMessage[];
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
}

export function useTranscriptRows({
  messages,
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
      node: ReactNode;
      searchText: string;
      searchScope: Exclude<TranscriptSearchScope, "all"> | null;
    };
    type ActivityRun = {
      memberKeys: string[];
      nodes: { key: string; node: ReactNode }[];
      telemetry: ActivityTelemetryItem[];
      live: boolean;
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
    let activityRun: ActivityRun | null = null;
    const appendActivity = (
      key: string,
      node: ReactNode,
      live: boolean,
      aliases: string[] = [],
      telemetryItems: ActivityTelemetryItem[] = [],
    ) => {
      if (!activityRun)
        activityRun = {
          memberKeys: [],
          nodes: [],
          telemetry: [],
          live: false,
        };
      activityRun.memberKeys.push(key, ...aliases);
      activityRun.nodes.push({ key, node });
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
            telemetry={run.telemetry}
          >
            {run.nodes.map(({ key, node }) => (
              <Fragment key={key}>{node}</Fragment>
            ))}
          </ResponseActivityFold>
        ),
        searchText: "",
        searchScope: null,
      });
      activityRun = null;
    };

    for (let index = 0; index < messages.length; ) {
      const message = asMessage(messages[index]);

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
        });
        index += 1;
        continue;
      }

      if (
        message.role === "compactionSummary" ||
        message.role === "branchSummary"
      ) {
        flushActivity(true);
        const { displaySummary } = checkpointPresentation(
          message,
          presentationConfiguration,
        );
        built.push({
          key,
          node: <ContextCheckpointRow message={message} />,
          searchText: settled ? displaySummary : "",
          searchScope: "model",
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
          while (activityEnd < messages.length) {
            const candidate = asMessage(messages[activityEnd]);
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
            segmentIndex === lastActivity ? trailingActivityKeys : [],
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
            [],
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
          [],
          unknownTelemetry,
        );
      }
      index += 1;
    }

    flushActivity(false, true);
    return { rows: built, foldIdentityClaims, activityItemKeys };
  }, [
    presentationConfiguration,
    messages,
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
