import {
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Copy,
  FilePen,
  FilePlus2,
  FileSearch,
  FileText,
  GitFork,
  List,
  Loader2,
  Package,
  Search,
  SquareTerminal,
  Wrench,
  XCircle,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AssistantRoundDisplayPreference,
  GenericExtensionDisplay,
  PendingQueues,
  ToolVisibilityPreference,
  VisibilityPreference,
} from "../../shared/contracts";
import {
  isLocalResourceReference,
  isToolResourceArgumentKey,
} from "../../shared/resource-references";
import {
  asMessage,
  contentItems,
  messageKey,
  messageText,
  store,
  toolResultText,
  type ActivityTool,
  type ChatMessage,
  type ToolCallContent,
} from "../store";
import { Dropdown } from "./Dropdown";
import { EarlierBranchBanner } from "./EarlierBranchBanner";
import {
  CARD_TRANSITION_MS,
  DYNAMIC_THINKING_EXPANDED_MIN_MS,
  DYNAMIC_TOOL_EXPANDED_MIN_MS,
  prefersReducedMotion,
  useDynamicActivityGroup,
  useDynamicCardOpen,
} from "./transcript-activity";
import { handleRichTextCopy, RichText } from "./RichText";
import { ImagePreview, PersistedImage } from "./ImagePreview";
import { ScrollRail } from "./ScrollRail";
import { stripTerminalSequences } from "../ansi";
import { parseUnifiedDiff, type DiffLine } from "../diff";
import { useCopied } from "../use-copied";

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

type StaticVisibility = Exclude<VisibilityPreference, "dynamic">;

interface CopyActionProps {
  text: string;
  label: string;
  className: string;
}

function CopyAction({ text, label, className }: CopyActionProps) {
  const { copied, copy } = useCopied();
  if (!text) return null;
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
      title={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
      onClick={() => void copy(text)}
    >
      {copied ? (
        <Check size={13} aria-hidden />
      ) : (
        <Copy size={13} aria-hidden />
      )}
    </button>
  );
}

interface CardHeaderProps {
  expanded: boolean;
  icon: React.ReactNode;
  label: React.ReactNode;
  toggleLabel: string;
  onToggle: () => void;
  summary?: React.ReactNode;
  status?: React.ReactNode;
  copyText?: string;
  copyLabel?: string;
  controlsId?: string;
}

/** Activity headers retain one semantic disclosure button while the remaining
 * non-interactive header area shares its toggle. Nested controls keep their
 * own actions without also changing disclosure state. */
function CardHeader({
  expanded,
  icon,
  label,
  toggleLabel,
  onToggle,
  summary,
  status,
  copyText,
  copyLabel = `${toggleLabel} block`,
  controlsId,
}: CardHeaderProps) {
  const action = expanded ? "Collapse" : "Expand";
  return (
    <div
      className="card__header"
      onClick={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(
            "a, button, input, select, textarea, [role='button'], [role='link']",
          )
        )
          return;
        onToggle();
      }}
    >
      <button
        type="button"
        className="card__disclosure"
        aria-label={`${action} ${toggleLabel}`}
        aria-expanded={expanded}
        aria-controls={controlsId}
        title={`${action} ${toggleLabel}`}
        onClick={onToggle}
      >
        <span className="card__chevron">
          <ChevronRight
            size={14}
            className={`chev ${expanded ? "chev--open" : ""}`}
            aria-hidden
          />
        </span>
        <span className="card__icon">{icon}</span>
        <span className="card__label">{label}</span>
      </button>
      {summary}
      <span className="card__header-spacer" aria-hidden />
      <span className="card__status">{status}</span>
      {copyText ? (
        <CopyAction text={copyText} label={copyLabel} className="card__copy" />
      ) : null}
    </div>
  );
}

interface CardProps {
  defaultVisibility: StaticVisibility;
  className: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  toggleLabel: string;
  summary?: React.ReactNode;
  status?: React.ReactNode;
  copyText?: string;
  copyLabel?: string;
  children: React.ReactNode;
  forceClosed?: boolean;
  onManualOpenChange?: (open: boolean) => void;
}

function CollapsibleCard({
  defaultVisibility,
  className,
  icon,
  label,
  toggleLabel,
  summary,
  status,
  copyText,
  copyLabel,
  children,
  forceClosed = false,
  onManualOpenChange,
}: CardProps) {
  // Per-card override is view-local only; it never mutates saved preferences.
  const [override, setOverride] = useState<"open" | "closed" | null>(null);
  const bodyId = useId();
  const hidden = defaultVisibility === "hidden";
  const open =
    !hidden &&
    !forceClosed &&
    (override !== null
      ? override === "open"
      : defaultVisibility === "expanded");
  // Closing content stays mounted only for the height transition. Collapsed
  // history therefore does not retain every tool payload in the DOM.
  const [bodyMounted, setBodyMounted] = useState(open);
  const [bodyOpen, setBodyOpen] = useState(open);

  useEffect(() => {
    if (open) {
      if (!bodyMounted) setBodyMounted(true);
      if (prefersReducedMotion()) {
        setBodyOpen(true);
        return;
      }
      let openFrame = 0;
      const mountFrame = window.requestAnimationFrame(() => {
        openFrame = window.requestAnimationFrame(() => setBodyOpen(true));
      });
      return () => {
        window.cancelAnimationFrame(mountFrame);
        if (openFrame) window.cancelAnimationFrame(openFrame);
      };
    }
    setBodyOpen(false);
    if (!bodyMounted) return;
    const timer = window.setTimeout(
      () => setBodyMounted(false),
      prefersReducedMotion() ? 0 : CARD_TRANSITION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [bodyMounted, open]);

  if (hidden) return null;
  return (
    <section className={`card ${className}`}>
      <CardHeader
        expanded={open}
        icon={icon}
        label={label}
        toggleLabel={toggleLabel}
        onToggle={() => {
          const nextOpen = !open;
          setOverride(nextOpen ? "open" : "closed");
          onManualOpenChange?.(nextOpen);
        }}
        summary={
          !open && summary ? (
            typeof summary === "string" ? (
              <span className="card__summary">{summary}</span>
            ) : (
              summary
            )
          ) : undefined
        }
        status={status}
        copyText={copyText}
        copyLabel={copyLabel}
        controlsId={bodyId}
      />
      {bodyMounted ? (
        <div
          id={bodyId}
          className={`card__reveal ${bodyOpen ? "card__reveal--open" : ""}`}
          aria-hidden={!bodyOpen}
          inert={!bodyOpen}
        >
          <div className="card__reveal-inner">
            <div className="card__body">{children}</div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ThinkingCard({
  text,
  visibility,
  dynamicActive,
}: {
  text: string;
  visibility: VisibilityPreference;
  dynamicActive: boolean;
}) {
  // Stored thinking can carry terminal color sequences; clean only here, at
  // the display boundary, for both the summary line and the card body.
  const clean = stripTerminalSequences(text);
  const firstLine = clean.split("\n").find((line) => line.trim()) ?? "";
  const dynamicOpen = useDynamicCardOpen(
    visibility === "dynamic",
    dynamicActive,
    !dynamicActive,
    DYNAMIC_THINKING_EXPANDED_MIN_MS,
  );
  const resolvedVisibility: StaticVisibility =
    visibility === "dynamic"
      ? dynamicOpen
        ? "expanded"
        : "collapsed"
      : visibility;
  return (
    <CollapsibleCard
      defaultVisibility={resolvedVisibility}
      className="card--thinking"
      icon={<Brain size={14} aria-hidden />}
      label="Thinking"
      toggleLabel="Thinking"
      summary={
        <span className="card__summary card__summary--prose">
          <RichText text={firstLine.slice(0, 90)} variant="thinking" inline />
        </span>
      }
      copyText={clean}
      copyLabel="Thinking block"
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
      if (typeof record[key] === "string")
        return String(record[key]).slice(0, 90);
    }
    const first = Object.values(record).find(
      (value) => typeof value === "string",
    );
    if (typeof first === "string") return first.slice(0, 90);
  }
  return "";
}

/** String tool arguments that carry a local file reference, in argument order. */
export function toolFileArguments(
  call: ToolCallContent,
): Array<{ key: string; value: string }> {
  const args = call.arguments;
  if (!args || typeof args !== "object") return [];
  const found: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (!isToolResourceArgumentKey(key)) continue;
    const values =
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [];
    for (const candidate of values) {
      if (isLocalResourceReference(candidate))
        found.push({ key, value: candidate });
    }
  }
  return found;
}

/** A file reference rendered as a real button (used in card bodies, where no
 * interactive ancestor exists). */
function FileRefButton({
  reference,
  className,
  children,
}: {
  reference: string;
  className: string;
  children?: React.ReactNode;
}) {
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
  if (!isLocalResourceReference(summary))
    return <span className="card__summary">{summary}</span>;
  return (
    <FileRefButton
      reference={summary}
      className="card__summary card__summary--file"
    >
      {summary}
    </FileRefButton>
  );
}

function toolComplete(
  result: ChatMessage | undefined,
  activity: ActivityTool | undefined,
): boolean {
  return (
    Boolean(result) || activity?.phase === "done" || activity?.phase === "error"
  );
}

function toolStatus(
  result: ChatMessage | undefined,
  activity: ActivityTool | undefined,
  liveFallback: boolean,
): ToolStatus {
  if (result) return result.isError ? "failure" : "success";
  if (activity?.phase === "error") return "failure";
  if (activity?.phase === "done") return "success";
  if (activity?.phase === "running" || liveFallback) return "running";
  return "unknown";
}

function statusIcon(status: ToolStatus) {
  switch (status) {
    case "running":
      return <Loader2 size={14} className="spin" aria-label="running" />;
    case "success":
      return (
        <CheckCircle2
          size={14}
          className="status-success"
          aria-label="finished"
        />
      );
    case "failure":
      return <XCircle size={14} className="status-error" aria-label="failed" />;
    default:
      return (
        <Circle size={12} className="status-unknown" aria-label="no result" />
      );
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

function ToolDetails({
  call,
  result,
  status,
}: {
  call: ToolCallContent;
  result: ChatMessage | undefined;
  status: ToolStatus;
}) {
  const [showAll, setShowAll] = useState(false);
  const output = result ? toolResultText(result) : "";
  const diff = result && !result.isError ? parseUnifiedDiff(output) : null;
  const truncated = !diff && output.length > 600;
  return (
    <>
      <div className="card__section-label">Arguments</div>
      {toolFileArguments(call).map((arg) => (
        <FileRefButton
          key={`${arg.key}:${arg.value}`}
          reference={arg.value}
          className="card__file-arg"
        >
          <span className="card__file-arg-key">{arg.key}</span>
          {arg.value}
        </FileRefButton>
      ))}
      <pre className="card__mono">
        {JSON.stringify(call.arguments ?? {}, null, 2)}
      </pre>
      {result ? (
        <>
          <div className="card__section-label">Result</div>
          {diff ? (
            <DiffView lines={diff} />
          ) : (
            <pre
              className={`card__mono ${result.isError ? "card__mono--error" : ""}`}
            >
              {showAll || !truncated ? output : `${output.slice(0, 600)}…`}
            </pre>
          )}
          {truncated ? (
            <button
              type="button"
              className="card__show-all"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? "Show less" : "Show all"}
            </button>
          ) : null}
        </>
      ) : (
        <div className="card__pending">
          {status === "running"
            ? "Running…"
            : status === "success" || status === "failure"
              ? "Finalizing result…"
              : "No result recorded"}
        </div>
      )}
    </>
  );
}

function toolClipboardText(
  call: ToolCallContent,
  result: ChatMessage | undefined,
): string {
  const sections = [
    call.name,
    "Arguments",
    JSON.stringify(call.arguments ?? {}, null, 2),
  ];
  if (result) sections.push("Result", toolResultText(result));
  return sections.join("\n\n");
}

function ToolCard({
  call,
  result,
  activity,
  live,
  visibility,
  dynamic,
  dynamicActive,
  forceClosed = false,
  onDynamicClosed,
  onManualOpenChange,
}: {
  call: ToolCallContent;
  result: ChatMessage | undefined;
  activity: ActivityTool | undefined;
  live: boolean;
  visibility: StaticVisibility;
  dynamic?: boolean;
  dynamicActive?: boolean;
  forceClosed?: boolean;
  onDynamicClosed?: () => void;
  onManualOpenChange?: (open: boolean) => void;
}) {
  const status = toolStatus(result, activity, live);
  const complete = toolComplete(result, activity) || dynamicActive === false;
  const dynamicOpen = useDynamicCardOpen(
    Boolean(dynamic),
    Boolean(dynamicActive),
    complete,
    DYNAMIC_TOOL_EXPANDED_MIN_MS,
    onDynamicClosed,
  );
  return (
    <CollapsibleCard
      defaultVisibility={
        dynamic ? (dynamicOpen ? "expanded" : "collapsed") : visibility
      }
      forceClosed={forceClosed}
      onManualOpenChange={onManualOpenChange}
      className={`card--tool ${status === "failure" ? "card--failed" : ""}`}
      icon={toolIcon(call.name)}
      label={<code className="card__tool-name">{call.name}</code>}
      toggleLabel={`${call.name} tool`}
      summary={<ToolSummary call={call} />}
      status={statusIcon(status)}
      copyText={toolClipboardText(call, result)}
      copyLabel={`${call.name} tool block`}
    >
      <ToolDetails call={call} result={result} status={status} />
    </CollapsibleCard>
  );
}

interface CompactToolActivity {
  kind: "tool";
  key: string;
  call: ToolCallContent;
  result: ChatMessage | undefined;
  activity?: ActivityTool;
}

interface CompactCustomActivity {
  kind: "custom";
  key: string;
  message: ChatMessage;
  title: string;
  customType: string;
}

type CompactActivity = CompactToolActivity | CompactCustomActivity;

const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  running: "running",
  success: "finished",
  failure: "failed",
  unknown: "no result",
};

function inspectableValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

function CustomMessageDetails({ message }: { message: ChatMessage }) {
  return (
    <div className="card__sections">
      <div>
        <div className="card__section-label">Content</div>
        <pre className="card__mono">
          {inspectableValue(message.content ?? [])}
        </pre>
      </div>
      {message.details !== undefined ? (
        <div>
          <div className="card__section-label">Details</div>
          <pre className="card__mono">{inspectableValue(message.details)}</pre>
        </div>
      ) : null}
    </div>
  );
}

function compactActivityPresentation(activity: CompactActivity, live: boolean) {
  if (activity.kind === "custom") {
    return {
      custom: true,
      failed: false,
      label: `${activity.title}: custom activity`,
      title: `${activity.title} · ${activity.customType}`,
      content: (
        <>
          <Package size={14} aria-hidden />
          <code className="activity-strip__kind">{activity.customType}</code>
        </>
      ),
    };
  }

  const status = toolStatus(activity.result, activity.activity, live);
  const summary = toolSummary(activity.call);
  return {
    custom: false,
    failed: status === "failure",
    label: `${activity.call.name}: ${TOOL_STATUS_LABEL[status]}${summary ? ` — ${summary}` : ""}`,
    title: `${activity.call.name}${summary ? ` — ${summary}` : ""} · ${TOOL_STATUS_LABEL[status]}`,
    content: (
      <>
        {toolIcon(activity.call.name)}
        {statusIcon(status)}
      </>
    ),
  };
}

/** Compact mode changes only the geometry of an adjacent activity run. Items
 * wrap horizontally, while one selection reveals its ordinary details below
 * the strip without reordering transcript content. */
function CompactActivityStrip({
  activities,
  live,
}: {
  activities: CompactActivity[];
  live: boolean;
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [renderedIndex, setRenderedIndex] = useState<number | null>(null);
  const [origin, setOrigin] = useState(22);
  const panelId = useId();
  const itemsRef = useRef<HTMLDivElement>(null);
  const rendered =
    renderedIndex == null ? null : (activities[renderedIndex] ?? null);

  // Keep the last detail mounted for the brief grid-collapse transition; it is
  // inert throughout closing and is removed once no pixels remain visible.
  useEffect(() => {
    if (selectedIndex != null || renderedIndex == null) return;
    const timer = window.setTimeout(
      () => setRenderedIndex(null),
      CARD_TRANSITION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [selectedIndex, renderedIndex]);

  return (
    <div
      className="activity-strip"
      style={
        { "--activity-detail-origin": `${origin}px` } as React.CSSProperties
      }
    >
      <div
        ref={itemsRef}
        className="activity-strip__items"
        role="group"
        aria-label="Activity"
      >
        {activities.map((activity, index) => {
          const active = selectedIndex === index;
          const presentation = compactActivityPresentation(activity, live);
          return (
            <button
              key={activity.key}
              type="button"
              className={`activity-strip__item ${presentation.custom ? "activity-strip__item--custom" : ""} ${active ? "activity-strip__item--active" : ""} ${presentation.failed ? "activity-strip__item--failed" : ""}`}
              aria-label={presentation.label}
              aria-expanded={active}
              aria-controls={active ? panelId : undefined}
              title={presentation.title}
              onClick={(event) => {
                const itemsBounds = itemsRef.current?.getBoundingClientRect();
                const itemBounds = event.currentTarget.getBoundingClientRect();
                if (itemsBounds)
                  setOrigin(
                    itemBounds.left - itemsBounds.left + itemBounds.width / 2,
                  );
                if (active) {
                  setSelectedIndex(null);
                } else {
                  setRenderedIndex(index);
                  setSelectedIndex(index);
                }
              }}
            >
              {presentation.content}
            </button>
          );
        })}
      </div>
      <div
        className={`activity-strip__reveal ${selectedIndex != null ? "activity-strip__reveal--open" : ""}`}
        aria-hidden={selectedIndex == null}
        inert={selectedIndex == null}
      >
        <div className="activity-strip__reveal-inner">
          {rendered?.kind === "tool" ? (
            <section
              key={rendered.key}
              id={panelId}
              className={`card card--tool activity-strip__detail ${toolStatus(rendered.result, rendered.activity, live) === "failure" ? "card--failed" : ""}`}
            >
              <CardHeader
                expanded
                icon={toolIcon(rendered.call.name)}
                label={
                  <code className="card__tool-name">{rendered.call.name}</code>
                }
                toggleLabel={`${rendered.call.name} tool details`}
                onToggle={() => setSelectedIndex(null)}
                summary={<ToolSummary call={rendered.call} />}
                status={statusIcon(
                  toolStatus(rendered.result, rendered.activity, live),
                )}
                copyText={toolClipboardText(rendered.call, rendered.result)}
                copyLabel={`${rendered.call.name} tool block`}
              />
              <div className="card__body">
                <ToolDetails
                  call={rendered.call}
                  result={rendered.result}
                  status={toolStatus(rendered.result, rendered.activity, live)}
                />
              </div>
            </section>
          ) : rendered?.kind === "custom" ? (
            <section
              key={rendered.key}
              id={panelId}
              className="card card--custom activity-strip__detail"
            >
              <CardHeader
                expanded
                icon={<Package size={14} aria-hidden />}
                label={
                  <code className="card__tool-name">{rendered.title}</code>
                }
                toggleLabel={`${rendered.title} custom activity details`}
                onToggle={() => setSelectedIndex(null)}
                summary={
                  <code className="card__custom-kind">
                    {rendered.customType}
                  </code>
                }
                copyText={customClipboardText(rendered.message)}
                copyLabel={`${rendered.title} block`}
              />
              <div className="card__body">
                <CustomMessageDetails message={rendered.message} />
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function humanizeGenericType(value: string): string {
  const label = value
    .trim()
    .slice(0, 80)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_:]+/g, " ")
    .trim();
  return label
    ? label.replace(/^./, (character) => character.toUpperCase())
    : "Content";
}

function genericContentTitle(item: object): string | null {
  const record = item as Record<string, unknown>;
  const value = [
    record.extensionName,
    record.attribution,
    record.name,
    record.title,
    record.customType,
    record.method,
  ].find((candidate) => {
    if (typeof candidate !== "string" || candidate.trim().length === 0)
      return false;
    return !/^(?:custom|custom content|extension content)$/i.test(
      candidate.trim(),
    );
  });
  // A bare custom part has no user-facing identity. Rendering one generic
  // "Extension" card per part exposes plumbing and can flood a transcript
  // without conveying any information.
  if (typeof value !== "string") {
    const type = typeof record.type === "string" ? record.type.trim() : "";
    return !type || type.toLowerCase() === "custom"
      ? null
      : humanizeGenericType(type);
  }
  const bounded = value.trim().slice(0, 80);
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(bounded)
    ? bounded
        .replace(/[-_]+/g, " ")
        .replace(/^./, (character) => character.toUpperCase())
    : bounded;
}

function customMessageType(message: ChatMessage): string {
  const value =
    typeof message.customType === "string"
      ? message.customType.trim().slice(0, 80)
      : "";
  return value || "custom";
}

function customMessageTitle(message: ChatMessage): string {
  return humanizeGenericType(customMessageType(message));
}

function customClipboardText(message: ChatMessage): string {
  const sections = [
    customMessageTitle(message),
    `Type: ${customMessageType(message)}`,
    "Content",
    inspectableValue(message.content ?? []),
  ];
  if (message.details !== undefined)
    sections.push("Details", inspectableValue(message.details));
  return sections.join("\n\n");
}

function customActivityIdentity(
  message: ChatMessage,
  fallbackIndex: number,
): string {
  if (message.__inspireEntryId) return `entry:${message.__inspireEntryId}`;
  if (message.__inspireLiveId) return `live:${message.__inspireLiveId}`;
  if (message.timestamp != null) {
    return `${customMessageType(message)}:${String(message.timestamp)}`;
  }
  return (
    messageKey(message) ?? `${customMessageType(message)}:${fallbackIndex}`
  );
}

function customActivityKeys(messages: ChatMessage[]): string[] {
  const occurrences = new Map<string, number>();
  return messages.map((message, index) => {
    const identity = customActivityIdentity(message, index);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return `custom:${identity}:${occurrence}`;
  });
}

function compactCustomActivities(
  messages: ChatMessage[],
): CompactCustomActivity[] {
  const keys = customActivityKeys(messages);
  return messages.map((message, index) => ({
    kind: "custom",
    key: keys[index]!,
    message,
    title: customMessageTitle(message),
    customType: customMessageType(message),
  }));
}

function assistantEndsWithToolRun(message: ChatMessage): boolean {
  const items = contentItems(message);
  return items.length > 0 && items[items.length - 1]?.type === "toolCall";
}

function hasRenderableAssistantContent(
  message: ChatMessage,
  thinkingVisibility: VisibilityPreference,
  toolVisibility: ToolVisibilityPreference,
): boolean {
  if (typeof message.content === "string") return message.content.length > 0;
  return contentItems(message).some((item) => {
    if (item.type === "text")
      return typeof item.text === "string" && item.text.length > 0;
    if (item.type === "thinking") return thinkingVisibility !== "hidden";
    if (item.type === "toolCall") return toolVisibility !== "hidden";
    return toolVisibility !== "hidden" && genericContentTitle(item) !== null;
  });
}

function GenericCard({
  item,
  visibility,
  title: suppliedTitle,
}: {
  item: object;
  visibility: StaticVisibility;
  title?: string;
}) {
  const title = suppliedTitle ?? genericContentTitle(item);
  if (!title) return null;
  const record = item as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  return (
    <CollapsibleCard
      defaultVisibility={visibility}
      className="card--generic"
      icon={<Package size={14} aria-hidden />}
      label={<span className="card__generic-title">{title}</span>}
      toggleLabel={title}
      summary={
        type && type !== "custom" && type !== title ? (
          <code className="card__generic-kind">{type}</code>
        ) : undefined
      }
      copyText={JSON.stringify(item, null, 2)}
      copyLabel={`${title} block`}
    >
      <pre className="card__mono">{JSON.stringify(item, null, 2)}</pre>
    </CollapsibleCard>
  );
}

// --- Turns ---

/** Tool identity is part of the annotation grammar: the glyph carries the
 * tool type so a settled batch of cards or tiles scans without reading. */
function toolIcon(name: string): React.ReactNode {
  switch (name.toLowerCase()) {
    case "read":
      return <FileText size={14} aria-hidden />;
    case "edit":
      return <FilePen size={14} aria-hidden />;
    case "write":
      return <FilePlus2 size={14} aria-hidden />;
    case "bash":
      return <SquareTerminal size={14} aria-hidden />;
    case "grep":
      return <Search size={14} aria-hidden />;
    case "find":
      return <FileSearch size={14} aria-hidden />;
    case "ls":
      return <List size={14} aria-hidden />;
    default:
      return <Wrench size={14} aria-hidden />;
  }
}

function CustomMessageCard({
  message,
  visibility,
  dynamic,
  forceClosed = false,
  onDynamicClosed,
  onManualOpenChange,
}: {
  message: ChatMessage;
  visibility: StaticVisibility;
  dynamic: boolean;
  forceClosed?: boolean;
  onDynamicClosed?: () => void;
  onManualOpenChange?: (open: boolean) => void;
}) {
  const lifecycleObserved = typeof message.__inspireLiveId === "string";
  const complete = message.__inspireSettled === true || !lifecycleObserved;
  const dynamicOpen = useDynamicCardOpen(
    dynamic,
    lifecycleObserved,
    complete,
    DYNAMIC_TOOL_EXPANDED_MIN_MS,
    onDynamicClosed,
  );
  return (
    <CollapsibleCard
      defaultVisibility={
        dynamic ? (dynamicOpen ? "expanded" : "collapsed") : visibility
      }
      forceClosed={forceClosed}
      onManualOpenChange={onManualOpenChange}
      className="card--custom"
      icon={<Package size={14} aria-hidden />}
      label={
        <code className="card__tool-name">{customMessageTitle(message)}</code>
      }
      toggleLabel={`${customMessageTitle(message)} custom activity`}
      copyText={customClipboardText(message)}
      copyLabel={`${customMessageTitle(message)} block`}
    >
      <CustomMessageDetails message={message} />
    </CollapsibleCard>
  );
}

function CustomActivityBatch({
  messages,
  toolVisibility,
  compactRequested,
}: {
  messages: ChatMessage[];
  toolVisibility: ToolVisibilityPreference;
  compactRequested: boolean;
}) {
  const dynamic = toolVisibility === "dynamic";
  const activities = compactCustomActivities(messages);
  const activityKeys = activities.map((activity) => activity.key);
  const lifecycleObserved = messages.some(
    (message) => typeof message.__inspireLiveId === "string",
  );
  const dynamicBatch = useDynamicActivityGroup(
    dynamic,
    lifecycleObserved,
    compactRequested,
    activityKeys,
  );
  const ordinaryVisibility: StaticVisibility =
    toolVisibility === "compact" || dynamic ? "collapsed" : toolVisibility;
  const compact =
    toolVisibility === "compact" || (dynamic && dynamicBatch.compact);

  if (toolVisibility === "hidden" || activities.length === 0) return null;
  return (
    <div className="turn turn--custom">
      <div
        className={`custom-activity-batch ${dynamic ? `dynamic-activity-batch dynamic-activity-batch--${dynamicBatch.phase}` : ""}`}
      >
        {compact ? (
          <CompactActivityStrip activities={activities} live={false} />
        ) : (
          messages.map((message, index) => {
            const activityKey = activityKeys[index]!;
            return (
              <CustomMessageCard
                key={activityKey}
                message={message}
                visibility={ordinaryVisibility}
                dynamic={dynamic}
                forceClosed={dynamic && dynamicBatch.closing}
                onDynamicClosed={
                  dynamic
                    ? () => dynamicBatch.markClosed(activityKey)
                    : undefined
                }
                onManualOpenChange={
                  dynamic
                    ? (open) =>
                        dynamicBatch.setInspectionHeld(activityKey, open)
                    : undefined
                }
              />
            );
          })
        )}
      </div>
    </div>
  );
}

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

const UserBubble = memo(function UserBubble({
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

const AssistantTurn = memo(function AssistantTurn({
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
  );
  const renderedItems: React.ReactNode[] =
    typeof message.content === "string" && message.content.length > 0
      ? [<RichText key="text" text={message.content} variant="assistant" />]
      : [];
  const ordinaryToolVisibility: StaticVisibility =
    toolVisibility === "compact" || dynamicTools ? "collapsed" : toolVisibility;
  const compactActivities =
    toolVisibility === "compact" || (dynamicTools && dynamicBatch.compact);
  let customActivitiesRendered = false;
  // Execution events, not membership in the current batch, own the running
  // status. After reconnect an unobserved call stays expanded but unknown.
  const live = streaming;

  for (let index = 0; index < items.length; ) {
    const item = items[index]!;
    if (item.type === "toolCall" && compactActivities) {
      const activities: CompactActivity[] = [];
      const start = index;
      while (index < items.length && items[index]?.type === "toolCall") {
        const call = items[index] as ToolCallContent;
        activities.push({
          kind: "tool",
          key: call.id || `tool:${index}`,
          call,
          result: toolResults.get(call.id),
          activity: toolActivity[call.id],
        });
        index += 1;
      }
      if (index === items.length && customActivities.length > 0) {
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
    if (compactActivities) {
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

const UnpairedToolResultRow = memo(function UnpairedToolResultRow({
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

const UnknownRoleRow = memo(function UnknownRoleRow({
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

function PendingQueueGroups({ queue }: { queue: PendingQueues }) {
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

function ExtensionDisplaySurface({
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
export function findLiteralMatches(
  text: string,
  query: string,
  rowIndex: number,
): TranscriptSearchMatch[] {
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
const OLDER_PRELOAD_PX = 320;
const EMPTY_TOOL_ACTIVITY: Record<string, ActivityTool> = {};

interface TranscriptScrollAnchor {
  key: string;
  offset: number;
}

function captureScrollAnchor(root: HTMLElement): TranscriptScrollAnchor | null {
  const rootBounds = root.getBoundingClientRect();
  if (rootBounds.height <= 0) return null;
  const rootTop = rootBounds.top;
  const visible = [
    ...root.querySelectorAll<HTMLElement>("[data-transcript-key]"),
  ]
    .map((element) => ({ element, bounds: element.getBoundingClientRect() }))
    .filter(({ bounds }) => bounds.bottom > rootTop)
    .sort((left, right) => left.bounds.top - right.bounds.top)[0];
  const key = visible?.element.dataset.transcriptKey;
  return key ? { key, offset: visible.bounds.top - rootTop } : null;
}

function restoreScrollAnchor(
  root: HTMLElement,
  anchor: TranscriptScrollAnchor,
): boolean {
  const element = [
    ...root.querySelectorAll<HTMLElement>("[data-transcript-key]"),
  ].find((candidate) => candidate.dataset.transcriptKey === anchor.key);
  if (!element) return false;
  root.scrollTop +=
    element.getBoundingClientRect().top -
    root.getBoundingClientRect().top -
    anchor.offset;
  return true;
}

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const latestRowIndexRef = useRef(-1);
  const virtualizedFollowRef = useRef<((index: number) => void) | null>(null);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const olderLoadInFlightRef = useRef(false);
  const onLoadOlderRef = useRef(onLoadOlder);
  const sessionIdRef = useRef(sessionId);
  const hasOlderRef = useRef(hasOlder);
  const olderErrorRef = useRef(olderError);
  onLoadOlderRef.current = onLoadOlder;
  sessionIdRef.current = sessionId;
  hasOlderRef.current = hasOlder;
  olderErrorRef.current = olderError;
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState<TranscriptSearchScope>("all");
  const [currentMatch, setCurrentMatch] = useState(-1);

  useEffect(() => {
    setSearchQuery("");
    setCurrentMatch(-1);
    pinnedRef.current = true;
    userScrollIntentRef.current = false;
    lastScrollTopRef.current = 0;
    olderLoadInFlightRef.current = false;
    setPinned(true);
  }, [sessionId]);

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

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
    if (userScrollIntentTimerRef.current !== null)
      window.clearTimeout(userScrollIntentTimerRef.current);
    userScrollIntentTimerRef.current = window.setTimeout(() => {
      userScrollIntentTimerRef.current = null;
      userScrollIntentRef.current = false;
    }, 400);
  }, []);

  const followLatest = useCallback(() => {
    const element = scrollRef.current;
    // Input arrives before the browser's corresponding scroll event. Do not let
    // a stream delta win that race and pull the viewport back to latest.
    if (!element || !pinnedRef.current || userScrollIntentRef.current) return;
    const virtualizedFollow = virtualizedFollowRef.current;
    if (virtualizedFollow && latestRowIndexRef.current >= 0) {
      virtualizedFollow(latestRowIndexRef.current);
      return;
    }
    element.scrollTop = Math.max(
      0,
      element.scrollHeight - element.clientHeight,
    );
  }, []);

  useEffect(
    () => () => {
      if (userScrollIntentTimerRef.current !== null)
        window.clearTimeout(userScrollIntentTimerRef.current);
    },
    [],
  );

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const previousScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = element.scrollTop;
    const searchOwnsViewport = searchQuery.length > 0 && currentMatch >= 0;
    const remaining =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (searchOwnsViewport) {
      pinnedRef.current = false;
      setPinned(false);
      if (element.scrollTop <= OLDER_PRELOAD_PX) requestOlder();
      return;
    }
    // Virtual-row measurement, Markdown reflow, and browser scroll anchoring
    // also emit scroll events. They may maintain latest-follow while latest owns
    // the viewport, but they may never take ownership back from a user.
    if (!userScrollIntentRef.current) {
      if (pinnedRef.current) {
        setPinned(true);
        if (remaining >= 80) followLatest();
      }
      return;
    }
    // Any deliberate movement toward earlier content releases latest-follow,
    // even inside the former 80px proximity band. A user moving downward may
    // reacquire it only by actually reaching the latest boundary.
    const movedTowardHistory = element.scrollTop < previousScrollTop;
    const nextPinned = !movedTowardHistory && remaining < 80;
    pinnedRef.current = nextPinned;
    if (nextPinned) userScrollIntentRef.current = false;
    setPinned(nextPinned);
    if (element.scrollTop <= OLDER_PRELOAD_PX) requestOlder();
  };

  const restoreGeometricFollow = () => {
    const element = scrollRef.current;
    const isPinned = element
      ? element.scrollHeight - element.scrollTop - element.clientHeight < 80
      : true;
    pinnedRef.current = isPinned;
    setPinned(isPinned);
  };

  const clearSearch = () => {
    setSearchQuery("");
    setCurrentMatch(-1);
    restoreGeometricFollow();
  };

  const jumpToLatest = () => {
    setCurrentMatch(-1);
    userScrollIntentRef.current = false;
    pinnedRef.current = true;
    setPinned(true);
    followLatest();
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

  const virtualize = rows.length >= VIRTUALIZE_AT;
  const getRowKey = useCallback(
    (index: number) => rows[index]?.key ?? index,
    [rows],
  );
  const virtualizer = useVirtualizer({
    enabled: virtualize,
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    getItemKey: getRowKey,
    estimateSize: () => 180,
    overscan: 6,
  });
  latestRowIndexRef.current = rows.length - 1;
  virtualizedFollowRef.current = virtualize
    ? (index) => virtualizer.scrollToIndex(index, { align: "end" })
    : null;
  const rowsRef = useRef(rows);
  const virtualizeRef = useRef(virtualize);
  const virtualizerRef = useRef(virtualizer);
  rowsRef.current = rows;
  virtualizeRef.current = virtualize;
  virtualizerRef.current = virtualizer;

  async function loadOlder() {
    const element = scrollRef.current;
    if (!element || olderLoadInFlightRef.current) return;
    olderLoadInFlightRef.current = true;
    const loadingSessionId = sessionIdRef.current;
    const oldHeight = element.scrollHeight;
    const oldTop = element.scrollTop;
    const anchor = captureScrollAnchor(element);
    pinnedRef.current = false;
    setPinned(false);
    const prepended = await onLoadOlderRef.current();
    if (sessionIdRef.current !== loadingSessionId) return;
    if (!prepended) {
      olderLoadInFlightRef.current = false;
      return;
    }

    const restore = () => {
      const current = scrollRef.current;
      if (current && (!anchor || !restoreScrollAnchor(current, anchor))) {
        current.scrollTop =
          oldTop + Math.max(0, current.scrollHeight - oldHeight);
      }
      olderLoadInFlightRef.current = false;
      // If one short page still leaves the viewport inside the preload zone,
      // continue filling it. Otherwise the next upward scroll owns the trigger.
      if (current && current.scrollTop <= OLDER_PRELOAD_PX) {
        requestAnimationFrame(requestOlder);
      }
    };
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const anchorIndex = anchor
          ? rowsRef.current.findIndex((row) => row.key === anchor.key)
          : -1;
        if (anchorIndex >= 0 && virtualizeRef.current) {
          virtualizerRef.current.scrollToIndex(anchorIndex, { align: "start" });
          requestAnimationFrame(() => requestAnimationFrame(restore));
        } else {
          restore();
        }
      }),
    );
  }

  function requestOlder() {
    if (hasOlderRef.current && !olderErrorRef.current) void loadOlder();
  }

  const searchMatches = useMemo(
    () =>
      rows.flatMap((row, rowIndex) =>
        searchScope === "all" || row.searchScope === searchScope
          ? findLiteralMatches(row.searchText, searchQuery, rowIndex)
          : [],
      ),
    [rows, searchQuery, searchScope],
  );

  useEffect(() => {
    setCurrentMatch((current) =>
      searchMatches.length === 0
        ? -1
        : Math.min(current, searchMatches.length - 1),
    );
  }, [searchMatches.length]);

  const navigateSearch = (direction: -1 | 1) => {
    if (searchMatches.length === 0) return;
    const next =
      currentMatch < 0
        ? direction === 1
          ? 0
          : searchMatches.length - 1
        : (currentMatch + direction + searchMatches.length) %
          searchMatches.length;
    const rowIndex = searchMatches[next]!.rowIndex;
    setCurrentMatch(next);
    pinnedRef.current = false;
    setPinned(false);
    if (virtualize) {
      virtualizer.scrollToIndex(rowIndex, { align: "center" });
    } else {
      requestAnimationFrame(() => {
        const row = scrollRef.current?.querySelector<HTMLElement>(
          `[data-transcript-row="${rowIndex}"]`,
        );
        row?.scrollIntoView?.({ block: "center" });
      });
    }
  };

  // A Pi stream mutates one assistant message in place semantically: thinking
  // and tool-call updates often change neither message count nor ordinary text.
  // Follow every new message projection while latest is still user-owned.
  useEffect(() => {
    followLatest();
  }, [messages, followLatest]);

  // Markdown layout, card animation, font loading, and virtualizer measurement
  // can increase the transcript after React's message effect. Preserve latest
  // through those real geometry changes without moving a user-owned viewport.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => followLatest());
    observer.observe(content);
    return () => observer.disconnect();
  }, [followLatest, sessionId]);

  // The existing scroll handler is the single proximity authority. This runs
  // after initial latest-follow so a short transcript can fill its viewport,
  // while a normal long transcript stays at the latest message until scrolled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these projection boundaries deliberately drive the initial near-top fill; requestOlder reads their current refs.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && element.scrollTop <= OLDER_PRELOAD_PX) requestOlder();
  }, [hasOlder, olderError, sessionId, rows.length]);

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
      onKeyDownCapture={(event) => {
        if (
          scrollRef.current?.contains(event.target as Node) &&
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
          markUserScrollIntent();
        }
      }}
    >
      <EarlierBranchBanner />
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
            else {
              setSearchQuery(event.target.value);
              setCurrentMatch(-1);
            }
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
          {searchQuery
            ? searchMatches.length > 0
              ? currentMatch >= 0
                ? `${currentMatch + 1} of ${searchMatches.length}`
                : `${searchMatches.length} ${searchMatches.length === 1 ? "match" : "matches"}`
              : "No matches"
            : ""}
        </output>
        <button
          type="button"
          aria-label="Previous transcript match"
          disabled={searchMatches.length === 0}
          onClick={() => navigateSearch(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Next transcript match"
          disabled={searchMatches.length === 0}
          onClick={() => navigateSearch(1)}
        >
          ↓
        </button>
      </div>
      <div
        className="transcript"
        role="log"
        aria-live="polite"
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={markUserScrollIntent}
        onTouchStart={markUserScrollIntent}
        onTouchMove={markUserScrollIntent}
        onClick={onClick}
        onCopy={handleRichTextCopy}
      >
        <div className="transcript__content" ref={contentRef}>
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
                  onClick={() => void loadOlder()}
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
                  data-transcript-key={rows[item.index]!.key}
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
        container={scrollRef}
        variant="reading"
        onUserScroll={markUserScrollIntent}
      />
      {!pinned ? (
        <button type="button" className="jump-to-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
