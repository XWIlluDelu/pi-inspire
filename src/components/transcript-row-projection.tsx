import { type ReactNode, useLayoutEffect, useMemo } from "react";
import { assistantOutcome } from "../../shared/assistant-outcome";
import {
  type ActivityFoldVisibilityPreference,
  isBusyRunState,
  type RunState,
  type ToolVisibilityPreference,
  type VisibilityPreference,
} from "../../shared/contracts";
import { stripTerminalSequences } from "../ansi";
import {
  type ActivityTool,
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
import { PiLoader } from "./PiLoader";
import type { ActivityReadingChoices } from "./transcript-activity-visibility";
import { genericContentTitle } from "./transcript-cards";
import { type ActivityItem, ResponseActivityFold } from "./transcript-fold";
import {
  AssistantActivityCard,
  type AssistantActivityContent,
  AssistantResponse,
  ContextCheckpointRow,
  UnpairedToolResultRow,
  UserBubble,
} from "./transcript-rows";
import type { TranscriptSearchScope } from "./transcript-search";

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

type Row = {
  key: string;
  node: ReactNode;
  searchText: string;
  searchScope: Exclude<TranscriptSearchScope, "all"> | null;
};

type ResponsePart = { start: number; passages: string[] };
type AssistantPart =
  | ResponsePart
  | { start: number; activity: AssistantActivityContent };

function messageParts(
  message: ChatMessage,
  toolResults: ReadonlyMap<string, ChatMessage>,
  toolActivity: Record<string, ActivityTool>,
  showThinking: boolean,
  showTools: boolean,
): AssistantPart[] {
  if (typeof message.content === "string")
    return message.content ? [{ start: 0, passages: [message.content] }] : [];
  const parts: AssistantPart[] = [];
  contentItems(message).forEach((item, start) => {
    if (item.type === "text") {
      if (typeof item.text !== "string" || !item.text) return;
      const previous = parts.at(-1);
      if (previous && "passages" in previous) previous.passages.push(item.text);
      else parts.push({ start, passages: [item.text] });
    } else if (item.type === "thinking") {
      if (showThinking)
        parts.push({
          start,
          activity: {
            kind: "thinking",
            text: typeof item.thinking === "string" ? item.thinking : "",
          },
        });
    } else if (showTools) {
      if (item.type === "toolCall") {
        const call = item as ToolCallContent;
        parts.push({
          start,
          activity: {
            kind: "tool",
            call,
            result: toolResults.get(call.id),
            activity: toolActivity[call.id],
          },
        });
      } else {
        const title = genericContentTitle(item);
        if (title)
          parts.push({ start, activity: { kind: "generic", item, title } });
      }
    }
  });
  return parts;
}

export function useTranscriptRows(options: TranscriptRowProjectionOptions) {
  const { configuration } = usePresentationAdapters();
  const {
    sessionId,
    viewId,
    projectionViewKey,
    messages,
    streaming,
    runState,
    activeAssistantMessageKey,
    toolActivity,
    thinkingVisibility,
    toolVisibility,
    activityFoldVisibility,
  } = options;
  const choices = useMemo<ActivityReadingChoices>(
    () => new Map(),
    [sessionId, projectionViewKey],
  );

  const projection = useMemo(() => {
    const toolResults = new Map<string, ChatMessage>();
    const toolCalls = new Set<string>();
    const rowIdentities = new Map<string, number>();
    for (const message of messages) {
      if (
        message.role === "toolResult" &&
        typeof message.toolCallId === "string"
      )
        toolResults.set(message.toolCallId, message);
      if (message.role === "assistant") {
        for (const item of contentItems(message))
          if (item.type === "toolCall" && typeof item.id === "string")
            toolCalls.add(item.id);
      }
    }

    const rows: Row[] = [];
    const busy = runState === undefined ? streaming : isBusyRunState(runState);
    const last = messages.at(-1);
    let activity: ActivityItem[] = [];
    let group = "start";
    let band = 0;
    const owner = { sessionId, viewId, projectionKey: projectionViewKey };
    const cardVisibility =
      toolVisibility === "expanded" ? "expanded" : "collapsed";

    function flushActivity(live = false) {
      if (!activity.length) return;
      rows.push({
        key: `${group}:activity:${band++}`,
        node: (
          <ResponseActivityFold
            visibility={activityFoldVisibility}
            live={live}
            items={activity}
            choices={choices}
          />
        ),
        searchText: "",
        searchScope: null,
      });
      activity = [];
    }

    function addRow(
      key: string,
      node: ReactNode,
      searchText = "",
      searchScope: Row["searchScope"] = null,
    ) {
      flushActivity();
      rows.push({ key, node, searchText, searchScope });
    }

    for (const [index, message] of messages.entries()) {
      // Host rows use their assigned IDs. Keyless rows have local position only.
      const base = message.__inspireMessageId
        ? `persisted:${message.__inspireMessageId}`
        : message.__inspireLiveId
          ? `live:${message.__inspireLiveId}`
          : `${message.role}:${index}`;
      const occurrence = rowIdentities.get(base) ?? 0;
      rowIdentities.set(base, occurrence + 1);
      const key = `${base}:${occurrence}`;
      const settled =
        !message.__inspireLiveId || message.__inspireSettled === true;
      const turn = message.__inspireTurnId ?? message.__inspireUserTurnId;
      if (
        turn &&
        group !== turn &&
        (message.__inspireTurnId || group === "start")
      ) {
        flushActivity();
        group = turn;
        band = 0;
      }
      switch (message.role) {
        case "user":
          addRow(
            key,
            <UserBubble message={message} {...owner} />,
            settled ? userMessageSearchText(message) : "",
            "user",
          );
          group = turn ?? key;
          band = 0;
          break;
        case "custom":
          if (message.display !== false)
            addRow(
              key,
              <CustomMessage message={message} {...owner} />,
              settled ? messageText(message) : "",
            );
          break;
        case "bashExecution":
          addRow(
            key,
            <BashExecution message={message} />,
            settled
              ? `${message.command ?? ""}\n${stripTerminalSequences(message.output ?? "")}`
              : "",
          );
          break;
        case "compactionSummary":
        case "branchSummary":
          addRow(
            key,
            <ContextCheckpointRow message={message} />,
            settled
              ? checkpointPresentation(message, configuration).displaySummary
              : "",
            "model",
          );
          break;
        case "assistant": {
          const active =
            busy &&
            messageKey(message) === activeAssistantMessageKey &&
            activeAssistantMessageKey !== null;
          const live =
            streaming &&
            busy &&
            !message.__inspireSettled &&
            (active ||
              (activeAssistantMessageKey === null && message === last));
          const parts = messageParts(
            message,
            toolResults,
            toolActivity,
            thinkingVisibility !== "hidden",
            toolVisibility !== "hidden",
          );
          let lastResponse: ResponsePart | undefined;
          for (const part of parts) if ("passages" in part) lastResponse = part;
          const outcome = assistantOutcome(message);
          if (!parts.length && live && !outcome) {
            activity.push({
              key: `${key}:working`,
              node: (
                <div className="assistant-activity" role="status">
                  <PiLoader size={14} aria-hidden />
                  <span>Working…</span>
                </div>
              ),
            });
          }
          parts.forEach((part, partIndex) => {
            const partKey = `${key}:${part.start}`;
            const trailing = live && partIndex === parts.length - 1;
            if ("passages" in part) {
              const copyText =
                part === lastResponse ? messageText(message) : "";
              addRow(
                `${partKey}:response`,
                <AssistantResponse
                  passages={part.passages}
                  streaming={trailing}
                  copyText={copyText}
                  copyContent={
                    copyText
                      ? messageCopyLoader(message, copyText, owner)
                      : undefined
                  }
                />,
                settled && !live ? part.passages.join("\n\n") : "",
                "model",
              );
              return;
            }
            const item = part.activity;
            const tool = item.kind === "tool" ? item : undefined;
            activity.push({
              key: tool?.call.id
                ? `call:${tool.call.id}`
                : `${partKey}:activity`,
              kind: item.kind === "thinking" ? "thinking" : "tool",
              toolCallId: tool?.call.id,
              name: tool?.call.name,
              failed:
                tool?.result?.isError === true ||
                tool?.activity?.phase === "error",
              node: (
                <AssistantActivityCard
                  item={item}
                  live={trailing}
                  dynamicActive={active}
                  thinkingVisibility={thinkingVisibility}
                  toolVisibility={toolVisibility}
                />
              ),
            });
          });

          if (outcome === "stopped")
            addRow(`${key}:stopped`, <AssistantStopped />, "Stopped", "model");
          else if (outcome === "error") {
            const text =
              typeof message.errorMessage === "string" &&
              message.errorMessage.trim()
                ? message.errorMessage
                : "Pi did not provide error details.";
            addRow(
              `${key}:error`,
              <AssistantError text={text} />,
              text,
              "model",
            );
          }
          break;
        }
        case "toolResult":
          if (
            toolVisibility !== "hidden" &&
            !toolCalls.has(message.toolCallId ?? "")
          )
            activity.push({
              key,
              kind: "tool",
              toolCallId: message.toolCallId,
              name: message.toolName,
              failed: message.isError === true,
              node: (
                <UnpairedToolResultRow
                  message={message}
                  visibility={cardVisibility}
                />
              ),
            });
          break;
        default:
          if (toolVisibility !== "hidden") {
            const item = { ...message, type: message.role };
            const title = genericContentTitle(item);
            if (title)
              activity.push({
                key,
                kind: "tool",
                node: (
                  <AssistantActivityCard
                    item={{ kind: "generic", item, title }}
                    live={false}
                    dynamicActive={false}
                    thinkingVisibility={thinkingVisibility}
                    toolVisibility={toolVisibility}
                  />
                ),
              });
          }
      }
    }
    flushActivity(busy);
    return { rows, toolCalls, toolResults };
  }, [
    sessionId,
    viewId,
    projectionViewKey,
    messages,
    streaming,
    runState,
    activeAssistantMessageKey,
    toolActivity,
    thinkingVisibility,
    toolVisibility,
    activityFoldVisibility,
    configuration,
    choices,
  ]);

  useLayoutEffect(() => {
    for (const id of choices.keys())
      if (!projection.toolCalls.has(id) && !projection.toolResults.has(id))
        choices.delete(id);
  }, [choices, projection]);
  return projection.rows;
}
