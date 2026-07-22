import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Package,
  Wrench,
  XCircle,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { VisibilityPreference } from "../../shared/contracts";
import {
  asMessage,
  contentItems,
  messageKey,
  messageText,
  toolResultText,
  type AssistantContent,
  type ChatMessage,
  type ToolCallContent,
} from "../store";
import { RichText } from "./RichText";

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
  summary?: string;
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
        {summary ? <span className="card__summary">{summary}</span> : null}
        <span className="card__status">{status}</span>
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
      </button>
      {open ? <div className="card__body">{children}</div> : null}
    </section>
  );
}

function ThinkingCard({ text, visibility }: { text: string; visibility: VisibilityPreference }) {
  const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
  return (
    <CollapsibleCard
      defaultVisibility={visibility}
      className="card--thinking"
      icon={<Brain size={14} aria-hidden />}
      label="Thinking"
      summary={firstLine.slice(0, 90)}
    >
      <RichText text={text} variant="thinking" />
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
  const truncated = output.length > 600;
  return (
    <CollapsibleCard
      defaultVisibility={visibility}
      className="card--tool"
      icon={<Wrench size={14} aria-hidden />}
      label={<code className="card__tool-name">{call.name}</code>}
      summary={toolSummary(call)}
      status={statusIcon(status)}
    >
      <div className="card__section-label">Arguments</div>
      <pre className="card__mono">{JSON.stringify(call.arguments ?? {}, null, 2)}</pre>
      {result ? (
        <>
          <div className="card__section-label">Result</div>
          <pre className={`card__mono ${result.isError ? "card__mono--error" : ""}`}>
            {showAll || !truncated ? output : `${output.slice(0, 600)}…`}
          </pre>
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
  return (
    <div className="turn turn--user">
      <div className="turn__label">You · {clockTime(message.timestamp)}</div>
      <div className="user-bubble">
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
    <div className="turn turn--assistant">
      <div className="turn__label">Pi{message.model ? ` · ${message.model}` : ""}</div>
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
      <div className="turn__meta">
        {message.model ? <span>{message.model}</span> : null}
        <span>{clockTime(message.timestamp)}</span>
        {message.stopReason ? <span>{message.stopReason}</span> : null}
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
}: {
  messages: ChatMessage[];
  streaming: boolean;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: VisibilityPreference;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

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

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const isPinned = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    pinnedRef.current = isPinned;
    setPinned(isPinned);
  };

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  };

  // Row descriptors rebuild only when a dependency changes; memoized row
  // components keep settled turns from re-rendering on stream deltas.
  const rows = useMemo(() => {
    const built: Array<{ key: string; node: React.ReactNode }> = [];
    messages.forEach((raw, index) => {
      const message = asMessage(raw);
      const key = messageKey(message) ?? `${message.role}:${index}`;
      if (message.role === "user") {
        built.push({ key, node: <UserBubble message={message} /> });
      } else if (message.role === "assistant") {
        built.push({
          key,
          node: (
            <AssistantTurn
              message={message}
              toolResults={toolResults}
              streaming={streaming && index === messages.length - 1}
              thinkingVisibility={thinkingVisibility}
              toolVisibility={toolVisibility}
            />
          ),
        });
      } else if (message.role === "toolResult") {
        const paired = typeof message.toolCallId === "string" && toolCallIds.has(message.toolCallId);
        if (!paired) {
          built.push({
            key,
            node: <UnpairedToolResultRow toolName={message.toolName} visibility={toolVisibility} />,
          });
        }
      } else {
        built.push({ key, node: <UnknownRoleRow message={message} visibility={toolVisibility} /> });
      }
    });
    return built;
  }, [messages, streaming, thinkingVisibility, toolVisibility, toolResults, toolCallIds]);

  const virtualize = rows.length >= VIRTUALIZE_AT;
  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    overscan: 6,
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !pinnedRef.current) return;
    if (virtualize) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    else element.scrollTop = element.scrollHeight;
  }, [messages.length, lastText, virtualize, rows.length, virtualizer]);

  return (
    <div className="transcript-wrap">
      <div className="transcript" role="log" aria-live="polite" ref={scrollRef} onScroll={onScroll}>
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
            {rows.map((row) => (
              <Fragment key={row.key}>{row.node}</Fragment>
            ))}
          </div>
        )}
      </div>
      {!pinned ? (
        <button type="button" className="jump-to-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
