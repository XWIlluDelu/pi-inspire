import {
  Brain,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Package,
  Search,
  Wrench,
  XCircle,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { GenericExtensionDisplay, PendingQueues, VisibilityPreference } from "../../shared/contracts";
import { isLocalResourceReference, isToolResourceArgumentKey } from "../../shared/resource-references";
import {
  asMessage,
  contentItems,
  messageKey,
  messageText,
  store,
  toolResultText,
  type AssistantContent,
  type ChatMessage,
  type ToolCallContent,
} from "../store";
import { Dropdown } from "./Dropdown";
import { handleRichTextCopy, RichText } from "./RichText";
import { ScrollRail } from "./ScrollRail";
import { stripTerminalSequences } from "../ansi";
import { parseUnifiedDiff, type DiffLine } from "../diff";

export function relativeTime(timestamp: number | string): string {
  const time = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
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
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// --- Collapsible cards (thinking / tool / generic) ---

interface CardProps {
  defaultVisibility: VisibilityPreference;
  className: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  summary?: React.ReactNode;
  status?: React.ReactNode;
  children: React.ReactNode;
}

function CollapsibleCard({ defaultVisibility, className, icon, label, summary, status, children }: CardProps) {
  // Per-card override is view-local only; it never mutates saved preferences.
  const [override, setOverride] = useState<"open" | "closed" | null>(null);
  if (defaultVisibility === "hidden") return null;
  const open = override !== null ? override === "open" : defaultVisibility === "expanded";
  return (
    <section className={`card ${className}`}>
      <button
        type="button"
        className="card__header"
        onClick={() => setOverride(open ? "closed" : "open")}
        aria-expanded={open}
      >
        <span className="card__icon">{icon}</span>
        <span className="card__label">{label}</span>
        {/* The one-line summary only earns its place while collapsed. */}
        {!open && summary ? (typeof summary === "string" ? <span className="card__summary">{summary}</span> : summary) : null}
        <span className="card__status">{status}</span>
        <span className="card__chevron">
          <ChevronRight size={14} className={`chev ${open ? "chev--open" : ""}`} aria-hidden />
        </span>
      </button>
      {open ? <div className="card__body">{children}</div> : null}
    </section>
  );
}

function ThinkingCard({ text, visibility }: { text: string; visibility: VisibilityPreference }) {
  // Stored thinking can carry terminal color sequences; clean only here, at
  // the display boundary, for both the summary line and the card body.
  const clean = stripTerminalSequences(text);
  const firstLine = clean.split("\n").find((line) => line.trim()) ?? "";
  return (
    <CollapsibleCard
      defaultVisibility={visibility}
      className="card--thinking"
      icon={<Brain size={14} aria-hidden />}
      label="Thinking"
      summary={<span className="card__summary card__summary--prose">{firstLine.slice(0, 90)}</span>}
    >
      <RichText text={clean} variant="thinking" />
    </CollapsibleCard>
  );
}

type ToolStatus = "running" | "success" | "failure" | "unknown";

function toolSummary(call: ToolCallContent): string {
  const args = call.arguments;
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    for (const key of ["path", "file", "command", "query", "url"]) {
      if (typeof record[key] === "string") return String(record[key]).slice(0, 90);
    }
    const first = Object.values(record).find((value) => typeof value === "string");
    if (typeof first === "string") return first.slice(0, 90);
  }
  return "";
}

/** String tool arguments that carry a local file reference, in argument order. */
export function toolFileArguments(call: ToolCallContent): Array<{ key: string; value: string }> {
  const args = call.arguments;
  if (!args || typeof args !== "object") return [];
  const found: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (!isToolResourceArgumentKey(key)) continue;
    const values = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    for (const candidate of values) {
      if (isLocalResourceReference(candidate)) found.push({ key, value: candidate });
    }
  }
  return found;
}

/** A file reference rendered as a real button (used in card bodies, where no
 * interactive ancestor exists). */
function FileRefButton({ reference, className, children }: { reference: string; className: string; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      className={className}
      data-file-path={reference}
      title={`Preview ${reference}`}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        void store.openResource(reference);
      }}
    >
      {children ?? reference}
    </button>
  );
}

function ToolSummary({ call }: { call: ToolCallContent }) {
  const summary = toolSummary(call);
  if (!summary) return null;
  if (!isLocalResourceReference(summary)) return <span className="card__summary">{summary}</span>;
  // The summary sits inside the collapsible header's own <button>, so a real
  // nested button would be invalid HTML; this behaves like one without nesting.
  return (
    <span
      className="card__summary card__summary--file"
      data-file-path={summary}
      title={`Preview ${summary}`}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        void store.openResource(summary);
      }}
    >
      {summary}
    </span>
  );
}

function statusIcon(status: ToolStatus) {
  switch (status) {
    case "running":
      return <Loader2 size={14} className="spin" aria-label="running" />;
    case "success":
      return <CheckCircle2 size={14} className="status-success" aria-label="finished" />;
    case "failure":
      return <XCircle size={14} className="status-error" aria-label="failed" />;
    default:
      return null;
  }
}

/** A tool result recognized as a unified diff renders as colored lines; the
 * diff is the whole point of an edit result, so it is never truncated. */
function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="card__mono diff">
      {lines.map((line, index) => (
        <span key={index} className={`diff__line diff__line--${line.type}`}>
          {line.text}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function ToolCard({
  call,
  result,
  streaming,
  visibility,
}: {
  call: ToolCallContent;
  result: ChatMessage | undefined;
  streaming: boolean;
  visibility: VisibilityPreference;
}) {
  const [showAll, setShowAll] = useState(false);
  const status: ToolStatus = result ? (result.isError ? "failure" : "success") : streaming ? "running" : "unknown";
  const output = result ? toolResultText(result) : "";
  const diff = result && !result.isError ? parseUnifiedDiff(output) : null;
  const truncated = !diff && output.length > 600;
  return (
    <CollapsibleCard
      defaultVisibility={visibility}
      className={`card--tool ${status === "failure" ? "card--failed" : ""}`}
      icon={<Wrench size={14} aria-hidden />}
      label={<code className="card__tool-name">{call.name}</code>}
      summary={<ToolSummary call={call} />}
      status={statusIcon(status)}
    >
      <div className="card__section-label">Arguments</div>
      {toolFileArguments(call).map((arg) => (
        <FileRefButton key={`${arg.key}:${arg.value}`} reference={arg.value} className="card__file-arg">
          <span className="card__file-arg-key">{arg.key}</span>
          {arg.value}
        </FileRefButton>
      ))}
      <pre className="card__mono">{JSON.stringify(call.arguments ?? {}, null, 2)}</pre>
      {result ? (
        <>
          <div className="card__section-label">Result</div>
          {diff ? (
            <DiffView lines={diff} />
          ) : (
            <pre className={`card__mono ${result.isError ? "card__mono--error" : ""}`}>
              {showAll || !truncated ? output : `${output.slice(0, 600)}…`}
            </pre>
          )}
          {truncated ? (
            <button type="button" className="card__show-all" onClick={() => setShowAll((value) => !value)}>
              {showAll ? "Show less" : "Show all"}
            </button>
          ) : null}
        </>
      ) : (
        <div className="card__pending">{streaming ? "Running…" : "No result recorded"}</div>
      )}
    </CollapsibleCard>
  );
}

function GenericCard({ item, visibility }: { item: AssistantContent & { type: string }; visibility: VisibilityPreference }) {
  return (
    <CollapsibleCard
      defaultVisibility={visibility}
      className="card--generic"
      icon={<Package size={14} aria-hidden />}
      label={<code className="card__tool-name">{item.type}</code>}
      summary="Extension content"
    >
      <pre className="card__mono">{JSON.stringify(item, null, 2)}</pre>
    </CollapsibleCard>
  );
}

// --- Turns ---

const UserBubble = memo(function UserBubble({ message }: { message: ChatMessage }) {
  const timestamp = message.timestamp;
  return (
    <div className="turn turn--user">
      <div
        className="user-bubble"
        title={timestamp != null ? new Date(timestamp).toLocaleString() : undefined}
      >
        <RichText text={messageText(message)} variant="user" />
      </div>
    </div>
  );
});

const AssistantTurn = memo(function AssistantTurn({
  message,
  toolResults,
  streaming,
  thinkingVisibility,
  toolVisibility,
}: {
  message: ChatMessage;
  toolResults: Map<string, ChatMessage>;
  streaming: boolean;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: VisibilityPreference;
}) {
  const items = contentItems(message);
  return (
    <div className={`turn turn--assistant ${streaming ? "turn--streaming" : ""}`}>
      {/* One attribution line: who, model (exactly once), time, and any
          unusual end reason. Routine "stop" is noise and stays hidden. */}
      <div className="turn__head">
        <span className="turn__who">Pi</span>
        {message.model ? <span className="turn__detail">{message.model}</span> : null}
        {message.timestamp != null ? <span className="turn__detail">{clockTime(message.timestamp)}</span> : null}
        {message.stopReason && message.stopReason !== "stop" ? (
          <span className="turn__flag">{message.stopReason}</span>
        ) : null}
      </div>
      <div className="assistant-doc">
        {items.map((item, index) => {
          if (item.type === "text") {
            const text = (item as { text?: string }).text ?? "";
            return text ? <RichText key={index} text={text} variant="assistant" /> : null;
          }
          if (item.type === "thinking") {
            return (
              <ThinkingCard key={index} text={(item as { thinking?: string }).thinking ?? ""} visibility={thinkingVisibility} />
            );
          }
          if (item.type === "toolCall") {
            const call = item as ToolCallContent;
            return (
              <ToolCard
                key={call.id ?? index}
                call={call}
                result={toolResults.get(call.id)}
                streaming={streaming}
                visibility={toolVisibility}
              />
            );
          }
          return <GenericCard key={index} item={item as AssistantContent & { type: string }} visibility={toolVisibility} />;
        })}
      </div>
    </div>
  );
});

const UnpairedToolResultRow = memo(function UnpairedToolResultRow({
  toolName,
  visibility,
}: {
  toolName?: string;
  visibility: VisibilityPreference;
}) {
  return (
    <div className="turn">
      <GenericCard item={{ type: `toolResult:${toolName ?? "unknown"}` }} visibility={visibility} />
    </div>
  );
});

const UnknownRoleRow = memo(function UnknownRoleRow({
  message,
  visibility,
}: {
  message: ChatMessage;
  visibility: VisibilityPreference;
}) {
  return (
    <div className="turn">
      <GenericCard item={{ type: message.role, ...message }} visibility={visibility} />
    </div>
  );
});

function PendingQueueGroups({ queue }: { queue: PendingQueues }) {
  const groups = [
    { key: "steering", label: "Pending steering", items: queue.steering },
    { key: "follow-up", label: "Pending follow-up", items: queue.followUp },
  ];
  return (
    <div className="pending-groups" aria-label="Pending input queues">
      {groups.filter((group) => group.items.length > 0).map((group) => (
        <section key={group.key} className="pending-group" aria-label={group.label}>
          <div className="pending-group__head">
            <span>{group.label}</span>
            <span aria-label={`${group.items.length} items`}>{group.items.length}</span>
          </div>
          <ol className="pending-group__list">
            {group.items.map((text, index) => (
              <li key={index} className="pending-group__item"><pre>{text}</pre></li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function ExtensionDisplaySurface({ displays }: { displays: GenericExtensionDisplay[] }) {
  if (displays.length === 0) return null;
  return (
    <section className="extension-surface" aria-label="Extension display content">
      <div className="extension-surface__head"><Package size={14} aria-hidden /> Extension display</div>
      {displays.map((display) => (
        <details key={display.id} className="extension-surface__item">
          <summary>
            <code>{display.method}</code>
            <span>{display.attribution}</span>
          </summary>
          <pre className="card__mono">{JSON.stringify(display.payload, null, 2)}</pre>
        </details>
      ))}
    </section>
  );
}

export interface TranscriptSearchMatch {
  rowIndex: number;
  offset: number;
}

export type TranscriptSearchScope = "all" | "user" | "model";

const TRANSCRIPT_SEARCH_SCOPES = [
  { value: "all", label: "All" },
  { value: "user", label: "User" },
  { value: "model", label: "Model" },
];

/** Case-insensitive literal, non-overlapping matches over already-selected
 * transcript text. This is intentionally not a Markdown/DOM search index. */
export function findLiteralMatches(text: string, query: string, rowIndex: number): TranscriptSearchMatch[] {
  if (!query) return [];
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const matches: TranscriptSearchMatch[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const offset = haystack.indexOf(needle, from);
    if (offset < 0) break;
    matches.push({ rowIndex, offset });
    from = offset + needle.length;
  }
  return matches;
}

// --- Transcript with pinned auto-scroll ---

// Above this many turns the transcript mounts only the visible window via
// @tanstack/react-virtual; smaller histories render plainly (also keeps jsdom
// tests and screen-reader browsing straightforward).
const VIRTUALIZE_AT = 60;

export function Transcript({
  messages,
  streaming,
  thinkingVisibility,
  toolVisibility,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder = store.loadOlderMessages,
  sessionId = "",
  queue = { steering: [], followUp: [] },
  extensionDisplays = [],
}: {
  messages: ChatMessage[];
  streaming: boolean;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: VisibilityPreference;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<void>;
  sessionId?: string;
  queue?: PendingQueues;
  extensionDisplays?: GenericExtensionDisplay[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState<TranscriptSearchScope>("all");
  const [currentMatch, setCurrentMatch] = useState(-1);

  useEffect(() => {
    setSearchQuery("");
    setCurrentMatch(-1);
    pinnedRef.current = true;
    setPinned(true);
  }, [sessionId]);

  // Tool-call pairing is derived data: recompute only when the message list changes.
  const { toolResults, toolCallIds } = useMemo(() => {
    const results = new Map<string, ChatMessage>();
    const callIds = new Set<string>();
    for (const raw of messages) {
      if (raw.role === "toolResult" && typeof raw.toolCallId === "string") results.set(raw.toolCallId, raw);
      if (raw.role === "assistant") {
        for (const item of contentItems(raw)) {
          if (item.type === "toolCall" && typeof (item as ToolCallContent).id === "string") {
            callIds.add((item as ToolCallContent).id);
          }
        }
      }
    }
    return { toolResults: results, toolCallIds: callIds };
  }, [messages]);

  const lastMessage = messages[messages.length - 1];
  const lastText = lastMessage ? messageText(lastMessage) : "";
  let activeStreamingIndex = -1;
  if (streaming) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index] as ChatMessage & { __inspireLiveId?: unknown; __inspireSettled?: unknown };
      if (candidate.role === "assistant" && typeof candidate.__inspireLiveId === "string" && candidate.__inspireSettled !== true) {
        activeStreamingIndex = index;
        break;
      }
    }
    // Preview/mock projections may not carry host lifecycle metadata. Only the
    // literal tail is a safe fallback; never hide an earlier settled answer
    // merely because a newer user turn has started.
    if (activeStreamingIndex < 0 && messages.at(-1)?.role === "assistant") activeStreamingIndex = messages.length - 1;
  }

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const isPinned = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    // A search jump owns the viewport until the user explicitly clears it or
    // chooses latest. Virtualizer geometry near the bottom must not silently
    // reinstate live-follow and pull the selected match away on append.
    const nextPinned = searchQuery.length > 0 && currentMatch >= 0 ? false : isPinned;
    pinnedRef.current = nextPinned;
    setPinned(nextPinned);
  };

  const loadOlder = async () => {
    const element = scrollRef.current;
    if (!element || loadingOlder) return;
    const oldHeight = element.scrollHeight;
    const oldTop = element.scrollTop;
    pinnedRef.current = false;
    setPinned(false);
    await onLoadOlder();
    requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current) return;
      current.scrollTop = oldTop + Math.max(0, current.scrollHeight - oldHeight);
    });
  };

  const restoreGeometricFollow = () => {
    const element = scrollRef.current;
    const isPinned = element ? element.scrollHeight - element.scrollTop - element.clientHeight < 80 : true;
    pinnedRef.current = isPinned;
    setPinned(isPinned);
  };

  const clearSearch = () => {
    setSearchQuery("");
    setCurrentMatch(-1);
    restoreGeometricFollow();
  };

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setCurrentMatch(-1);
    pinnedRef.current = true;
    setPinned(true);
  };

  // Row descriptors rebuild only when a dependency changes; memoized row
  // components keep settled turns from re-rendering on stream deltas.
  const rows = useMemo(() => {
    const built: Array<{
      key: string;
      node: React.ReactNode;
      searchText: string;
      searchScope: Exclude<TranscriptSearchScope, "all"> | null;
    }> = [];
    messages.forEach((raw, index) => {
      const message = asMessage(raw);
      const key = messageKey(message) ?? `${message.role}:${index}`;
      const projection = message as ChatMessage & { __inspireLiveId?: unknown; __inspireSettled?: unknown };
      const settled = typeof projection.__inspireLiveId !== "string" || projection.__inspireSettled === true;
      if (message.role === "user") {
        built.push({
          key,
          node: <UserBubble message={message} />,
          searchText: settled ? messageText(message) : "",
          searchScope: "user",
        });
      } else if (message.role === "assistant") {
        built.push({
          key,
          node: (
            <AssistantTurn
              message={message}
              toolResults={toolResults}
              streaming={index === activeStreamingIndex}
              thinkingVisibility={thinkingVisibility}
              toolVisibility={toolVisibility}
            />
          ),
          searchText: settled && index !== activeStreamingIndex ? messageText(message) : "",
          searchScope: "model",
        });
      } else if (message.role === "toolResult") {
        const paired = typeof message.toolCallId === "string" && toolCallIds.has(message.toolCallId);
        if (!paired) {
          built.push({
            key,
            node: <UnpairedToolResultRow toolName={message.toolName} visibility={toolVisibility} />,
            searchText: "",
            searchScope: null,
          });
        }
      } else {
        built.push({
          key,
          node: <UnknownRoleRow message={message} visibility={toolVisibility} />,
          searchText: "",
          searchScope: null,
        });
      }
    });
    return built;
  }, [messages, activeStreamingIndex, thinkingVisibility, toolVisibility, toolResults, toolCallIds]);

  const virtualize = rows.length >= VIRTUALIZE_AT;
  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    overscan: 6,
  });

  const searchMatches = useMemo(
    () => rows.flatMap((row, rowIndex) => (
      searchScope === "all" || row.searchScope === searchScope
        ? findLiteralMatches(row.searchText, searchQuery, rowIndex)
        : []
    )),
    [rows, searchQuery, searchScope],
  );

  useEffect(() => {
    setCurrentMatch((current) => searchMatches.length === 0 ? -1 : Math.min(current, searchMatches.length - 1));
  }, [searchMatches.length]);

  const navigateSearch = (direction: -1 | 1) => {
    if (searchMatches.length === 0) return;
    const next = currentMatch < 0
      ? (direction === 1 ? 0 : searchMatches.length - 1)
      : (currentMatch + direction + searchMatches.length) % searchMatches.length;
    const rowIndex = searchMatches[next]!.rowIndex;
    setCurrentMatch(next);
    pinnedRef.current = false;
    setPinned(false);
    if (virtualize) {
      virtualizer.scrollToIndex(rowIndex, { align: "center" });
    } else {
      requestAnimationFrame(() => {
        const row = scrollRef.current?.querySelector<HTMLElement>(`[data-transcript-row="${rowIndex}"]`);
        row?.scrollIntoView?.({ block: "center" });
      });
    }
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !pinnedRef.current) return;
    if (virtualize) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    else element.scrollTop = element.scrollHeight;
  }, [messages.length, lastText, virtualize, rows.length, virtualizer]);

  // One delegated handler serves every data-file-path element (Markdown
  // links/images, inline-code paths) regardless of virtualization or memoized
  // rows. Elements that must not bubble (tool-card summaries) stop propagation
  // and call store.openResource themselves.
  const onClick = (event: React.MouseEvent) => {
    const origin = event.target instanceof Element ? event.target.closest("[data-file-path]") : null;
    const reference = origin?.getAttribute("data-file-path");
    if (!reference) return;
    event.preventDefault();
    void store.openResource(reference);
  };

  return (
    <div className="transcript-wrap">
      <div
        className={`transcript-search ${searchQuery ? "transcript-search--active" : ""}`}
        role="search"
        aria-label="Search settled transcript"
      >
        <Search size={14} aria-hidden />
        <Dropdown
          label="Search scope"
          value={searchScope}
          options={TRANSCRIPT_SEARCH_SCOPES}
          onChange={(value) => {
            setSearchScope(value as TranscriptSearchScope);
            setCurrentMatch(-1);
          }}
          className="transcript-search__scope"
        />
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => {
            if (!event.target.value) clearSearch();
            else { setSearchQuery(event.target.value); setCurrentMatch(-1); }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              navigateSearch(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              clearSearch();
            }
          }}
          placeholder="Search conversation"
          aria-label="Search conversation"
        />
        <output aria-live="polite" aria-label="Transcript search matches">
          {searchQuery ? (searchMatches.length > 0
            ? (currentMatch >= 0
              ? `${currentMatch + 1} of ${searchMatches.length}`
              : `${searchMatches.length} ${searchMatches.length === 1 ? "match" : "matches"}`)
            : "No matches") : ""}
        </output>
        <button type="button" aria-label="Previous transcript match" disabled={searchMatches.length === 0} onClick={() => navigateSearch(-1)}>↑</button>
        <button type="button" aria-label="Next transcript match" disabled={searchMatches.length === 0} onClick={() => navigateSearch(1)}>↓</button>
      </div>
      <div className="transcript" role="log" aria-live="polite" ref={scrollRef} onScroll={onScroll} onClick={onClick} onCopy={handleRichTextCopy}>
        {hasOlder ? (
          <div className="transcript__column">
            <button type="button" className="transcript__load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? "Loading…" : "Load older messages"}
            </button>
          </div>
        ) : null}
        {rows.length === 0 ? (
          <div className="transcript__column">
            <div className="empty-state">
              <p className="empty-state__title">Empty session</p>
              <p className="empty-state__hint">Send a message below to start working with Pi.</p>
            </div>
          </div>
        ) : virtualize ? (
          <div
            className="transcript__column transcript__column--virtual"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={rows[item.index]!.key}
                data-index={item.index}
                data-transcript-row={item.index}
                ref={virtualizer.measureElement}
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
              <div key={row.key} data-transcript-row={index}>{row.node}</div>
            ))}
          </div>
        )}
        {queue.steering.length > 0 || queue.followUp.length > 0 || extensionDisplays.length > 0 ? (
          <div className="transcript__column transcript__pending">
            <PendingQueueGroups queue={queue} />
            <ExtensionDisplaySurface displays={extensionDisplays} />
          </div>
        ) : null}
      </div>
      <ScrollRail container={scrollRef} variant="reading" />
      {!pinned ? (
        <button type="button" className="jump-to-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
