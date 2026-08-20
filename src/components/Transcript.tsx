import { Loader2, Search } from "lucide-react";
import { useMemo, useRef } from "react";
import type {
  AssistantRoundDisplayPreference,
  GenericExtensionDisplay,
  PendingQueues,
  ToolVisibilityPreference,
  VisibilityPreference,
} from "../../shared/contracts";
import {
  asMessage,
  contentItems,
  messageKey,
  messageText,
  type ActivityTool,
  type ChatMessage,
  type ToolCallContent,
} from "../events";
import { store } from "../store";
import { Dropdown } from "./Dropdown";
import { EarlierBranchBanner } from "./EarlierBranchBanner";
import { handleRichTextCopy } from "./RichText";
import { ScrollRail } from "./ScrollRail";
import {
  assistantEndsWithToolRun,
  CustomActivityBatch,
  customActivityIdentity,
  hasRenderableAssistantContent,
} from "./transcript-cards";
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
  useTranscriptSearch,
  type TranscriptSearchScope,
} from "./transcript-search";
import { useTranscriptViewport } from "./transcript-viewport";

// --- Transcript with pinned auto-scroll ---

const EMPTY_TOOL_ACTIVITY: Record<string, ActivityTool> = {};

export function Transcript({
  messages,
  streaming,
  activeAssistantMessageKey = null,
  toolActivity = EMPTY_TOOL_ACTIVITY,
  thinkingVisibility,
  toolVisibility,
  assistantRoundDisplay = "details",
  hasOlder = false,
  loadingOlder = false,
  olderError = null,
  onLoadOlder = store.loadOlderMessages,
  sessionId = "",
  viewId = "",
  queue = { steering: [], followUp: [] },
  extensionDisplays = [],
  viewingEarlierBranch = false,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  activeAssistantMessageKey?: string | null;
  toolActivity?: Record<string, ActivityTool>;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: ToolVisibilityPreference;
  assistantRoundDisplay?: AssistantRoundDisplayPreference;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  olderError?: string | null;
  onLoadOlder?: () => Promise<boolean>;
  sessionId?: string;
  viewId?: string;
  queue?: PendingQueues;
  extensionDisplays?: GenericExtensionDisplay[];
  viewingEarlierBranch?: boolean;
}) {
  const searchOwnsViewportRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  let activeStreamingIndex = -1;
  if (streaming && activeAssistantMessageKey) {
    const index = messages.findIndex(
      (message) => messageKey(message) === activeAssistantMessageKey,
    );
    const candidate =
      index >= 0
        ? (messages[index] as ChatMessage & { __inspireSettled?: unknown })
        : null;
    if (candidate?.role === "assistant" && candidate.__inspireSettled !== true)
      activeStreamingIndex = index;
  }
  // Preview/mock projections may not carry an active lifecycle identity. Only
  // their literal unsettled tail is safe; never reinterpret settled history as
  // the current retry merely because the host run is busy.
  if (streaming && !activeAssistantMessageKey) {
    const tail = messages.at(-1) as
      | (ChatMessage & { __inspireSettled?: unknown })
      | undefined;
    if (tail?.role === "assistant" && tail.__inspireSettled !== true)
      activeStreamingIndex = messages.length - 1;
  }

  // Row descriptors rebuild only when a dependency changes; memoized row
  // components keep settled turns from re-rendering on stream deltas.
  const rows = useMemo(() => {
    const built: Array<{
      key: string;
      node: React.ReactNode;
      searchText: string;
      searchScope: Exclude<TranscriptSearchScope, "all"> | null;
    }> = [];
    const hasLaterAssistant = new Array<boolean>(messages.length + 1).fill(
      false,
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      hasLaterAssistant[index] =
        hasLaterAssistant[index + 1]! ||
        asMessage(messages[index]).role === "assistant";
    }

    for (let index = 0; index < messages.length; ) {
      const message = asMessage(messages[index]);

      if (message.role === "custom") {
        const batchStart = index;
        const customMessages: ChatMessage[] = [];
        while (index < messages.length) {
          const candidate = asMessage(messages[index]);
          if (candidate.role !== "custom") break;
          // display:false remains in Pi/model context but is absent from the
          // browser activity run and does not split adjacent visible messages.
          if (candidate.display !== false) customMessages.push(candidate);
          index += 1;
        }
        if (toolVisibility !== "hidden" && customMessages.length > 0) {
          built.push({
            key: `custom-batch:${customActivityIdentity(customMessages[0]!, batchStart)}`,
            node: (
              <CustomActivityBatch
                messages={customMessages}
                toolVisibility={toolVisibility}
                compactRequested={!streaming || hasLaterAssistant[index]!}
              />
            ),
            searchText: "",
            searchScope: null,
          });
        }
        continue;
      }

      const key = messageKey(message) ?? `${message.role}:${index}`;
      const settled =
        typeof message.__inspireLiveId !== "string" ||
        message.__inspireSettled === true;
      if (message.role === "user") {
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
        });
      } else if (message.role === "assistant") {
        let activityEnd = index + 1;
        const trailingCustomMessages: ChatMessage[] = [];
        if (assistantEndsWithToolRun(message)) {
          const ownToolCallIds = new Set(
            contentItems(message).flatMap((item) =>
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
              activityEnd += 1;
              continue;
            }
            if (candidate.role === "custom") {
              if (candidate.display !== false)
                trailingCustomMessages.push(candidate);
              activityEnd += 1;
              continue;
            }
            break;
          }
        }

        const assistantStreaming = index === activeStreamingIndex;
        // Pi can persist an empty error response before automatically retrying.
        // It remains authoritative history, but must not become a phantom
        // Divider-only transcript row with an estimated virtual-list height.
        if (
          assistantStreaming ||
          hasRenderableAssistantContent(
            message,
            thinkingVisibility,
            toolVisibility,
          ) ||
          (toolVisibility !== "hidden" && trailingCustomMessages.length > 0)
        ) {
          built.push({
            key,
            node: (
              <AssistantTurn
                message={message}
                toolResults={toolResults}
                toolActivity={toolActivity}
                customMessages={trailingCustomMessages}
                customCompactRequested={
                  !streaming || hasLaterAssistant[activityEnd]!
                }
                streaming={assistantStreaming}
                dynamicActive={key === activeAssistantMessageKey}
                thinkingVisibility={thinkingVisibility}
                toolVisibility={toolVisibility}
                assistantRoundDisplay={assistantRoundDisplay}
              />
            ),
            searchText:
              settled && index !== activeStreamingIndex
                ? messageText(message)
                : "",
            searchScope: "model",
          });
        }
        index = activityEnd;
        continue;
      } else if (message.role === "toolResult") {
        const paired =
          typeof message.toolCallId === "string" &&
          toolCallIds.has(message.toolCallId);
        if (!paired) {
          built.push({
            key,
            node: (
              <UnpairedToolResultRow
                toolName={message.toolName}
                visibility={
                  toolVisibility === "compact" || toolVisibility === "dynamic"
                    ? "collapsed"
                    : toolVisibility
                }
              />
            ),
            searchText: "",
            searchScope: null,
          });
        }
      } else {
        built.push({
          key,
          node: (
            <UnknownRoleRow
              message={message}
              visibility={
                toolVisibility === "compact" || toolVisibility === "dynamic"
                  ? "collapsed"
                  : toolVisibility
              }
            />
          ),
          searchText: "",
          searchScope: null,
        });
      }
      index += 1;
    }
    return built;
  }, [
    messages,
    activeAssistantMessageKey,
    activeStreamingIndex,
    streaming,
    thinkingVisibility,
    toolVisibility,
    assistantRoundDisplay,
    toolResults,
    toolCallIds,
    toolActivity,
    sessionId,
    viewId,
  ]);

  const viewport = useTranscriptViewport({
    rows,
    sessionId,
    hasOlder,
    olderError,
    onLoadOlder,
    followSignal: messages,
    searchOwnsViewportRef,
  });
  const search = useTranscriptSearch({
    rows,
    sessionId,
    searchOwnsViewportRef,
    onClear: viewport.restoreGeometricFollow,
    onNavigate: (rowIndex) => {
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

  const jumpToLatest = () => {
    search.clearCurrentMatch();
    viewport.jumpToLatest();
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
      className={`transcript-wrap ${viewingEarlierBranch ? "transcript-wrap--earlier-branch" : ""}`}
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        if (event.key === "f" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
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
          viewport.markUserScrollIntent();
        }
      }}
    >
      <EarlierBranchBanner />
      <div
        className={`transcript-search ${search.query ? "transcript-search--active" : ""}`}
        role="search"
        aria-label="Search settled transcript"
        onClick={(event) => {
          if (
            event.target === event.currentTarget ||
            (event.target instanceof HTMLElement &&
              (event.target.tagName === "svg" ||
                event.target.closest(".transcript-search__icon")))
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
              search.clear();
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
          ↑
        </button>
        <button
          type="button"
          aria-label="Next transcript match"
          disabled={search.matches.length === 0}
          onClick={() => search.navigate(1)}
        >
          ↓
        </button>
      </div>
      <div
        className="transcript"
        role="log"
        aria-live="polite"
        ref={viewport.scrollRef}
        onScroll={viewport.onScroll}
        onWheel={viewport.markUserScrollIntent}
        onTouchStart={viewport.markUserScrollIntent}
        onTouchMove={viewport.markUserScrollIntent}
        onClick={onClick}
        onCopy={handleRichTextCopy}
      >
        <div className="transcript__content" ref={viewport.contentRef}>
          {hasOlder ? (
            <div className="transcript__older-sentinel">
              {loadingOlder ? (
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
                >
                  {row.node}
                </div>
              ))}
            </div>
          )}
          {queue.steering.length > 0 ||
          queue.followUp.length > 0 ||
          extensionDisplays.length > 0 ? (
            <div className="transcript__column transcript__pending">
              <PendingQueueGroups queue={queue} />
              <ExtensionDisplaySurface displays={extensionDisplays} />
            </div>
          ) : null}
        </div>
      </div>
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
