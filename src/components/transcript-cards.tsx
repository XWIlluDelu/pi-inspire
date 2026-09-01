import {
  Brain,
  CheckCircle2,
  ChevronRight,
  Circle,
  FilePen,
  FilePlus2,
  FileSearch,
  FileText,
  Folder,
  List,
  Loader2,
  Package,
  Search,
  SquareTerminal,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  ToolVisibilityPreference,
  VisibilityPreference,
} from "../../shared/contracts";
import {
  isLocalResourceReference,
  isToolResourceArgumentKey,
} from "../../shared/resource-references";
import { stripTerminalSequences } from "../ansi";
import { type DiffLine, parseUnifiedDiff } from "../diff";
import {
  type ActivityTool,
  type ChatMessage,
  contentItems,
  messageKey,
  type ToolCallContent,
  toolResultText,
} from "../events";
import { store } from "../store";
import type {
  ResolvedToolPresentation,
  ToolPresentation,
  ToolPresentationBlock,
  ToolPresentationSummary,
} from "../tool-presentations/model";
import { toolPresentationSummaryText } from "../tool-presentations/model";
import {
  thinkingPresentationRegistry,
  toolPresentationRegistry,
} from "../tool-presentations/registry";
import { CopyAction } from "./CopyAction";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";
import { ResourcePathLabel } from "./ResourcePathLabel";
import {
  CARD_TRANSITION_MS,
  DYNAMIC_CUSTOM_CLOSE_DELAY_MS,
  DYNAMIC_CUSTOM_EXPANDED_MIN_MS,
  DYNAMIC_THINKING_CLOSE_DELAY_MS,
  DYNAMIC_THINKING_EXPANDED_MIN_MS,
  DYNAMIC_TOOL_CLOSE_DELAY_MS,
  DYNAMIC_TOOL_EXPANDED_MIN_MS,
  prefersReducedMotion,
  useDynamicActivityGroup,
  useDynamicCardOpen,
} from "./transcript-activity";
import {
  ActivityItemBoundary,
  useVisibleActivityItemIds,
} from "./transcript-activity-visibility";

export type StaticVisibility = Exclude<VisibilityPreference, "dynamic">;

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
        <span className="card__status">{status}</span>
      </button>
      {summary}
      <span className="card__header-spacer" aria-hidden />
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

export function ThinkingCard({
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
  const presentation = useMemo(
    () => thinkingPresentationRegistry.resolve(clean),
    [clean, thinkingPresentationRegistry],
  );
  const dynamicOpen = useDynamicCardOpen(
    visibility === "dynamic",
    dynamicActive,
    !dynamicActive,
    DYNAMIC_THINKING_EXPANDED_MIN_MS,
    undefined,
    DYNAMIC_THINKING_CLOSE_DELAY_MS,
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
        presentation ? (
          <PresentedSummary summary={presentation.summary} />
        ) : (
          <span className="card__summary card__summary--prose">
            <RichText text={firstLine.slice(0, 90)} variant="thinking" inline />
          </span>
        )
      }
      copyText={clean}
      copyLabel="Thinking block"
    >
      <ThinkingDetails text={clean} presentation={presentation} />
    </CollapsibleCard>
  );
}

type ToolStatus = "running" | "success" | "failure" | "unknown";

function toolSummary(call: ToolCallContent): string {
  const args = call.arguments;
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    for (const key of ["path", "file", "command", "query", "url"]) {
      const value = record[key];
      if (typeof value === "string") return value.slice(0, 90);
    }
    const first = Object.values(record).find(
      (value) => typeof value === "string",
    );
    if (typeof first === "string") return first.slice(0, 90);
  }
  return "";
}

/** String tool arguments that carry a local file reference, in argument order. */
function toolFileArguments(
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

/** A file reference retains its complete action and accessible name while its
 * visual label may use a responsive path projection. */
function FileRefButton({
  reference,
  className,
  accessibleLabel,
  children,
}: {
  reference: string;
  className: string;
  accessibleLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      data-file-path={reference}
      aria-label={accessibleLabel}
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
      accessibleLabel={summary}
    >
      <ResourcePathLabel path={summary} />
    </FileRefButton>
  );
}

function PresentedSummary({ summary }: { summary: ToolPresentationSummary }) {
  if (summary.parts.length === 0) return null;
  return (
    <span className="card__summary card__summary--tool">
      {summary.parts.map((part, index) => (
        <span
          className={`tool-summary__part${part.kind === "resource" ? " tool-summary__part--resource" : part.subdued ? " tool-summary__part--subdued" : ""}`}
          key={`${part.kind}:${index}`}
        >
          {index > 0 ? (
            <span className="tool-summary__separator" aria-hidden>
              {part.separator === "space" ? " " : " · "}
            </span>
          ) : null}
          {part.kind === "resource" ? (
            <FileRefButton
              reference={part.reference}
              className="tool-summary__resource"
              accessibleLabel={part.reference}
            >
              <ResourcePathLabel path={part.text} />
            </FileRefButton>
          ) : (
            <span
              className={part.subdued ? "tool-summary__subdued" : undefined}
            >
              {part.text}
            </span>
          )}
        </span>
      ))}
    </span>
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
      <code className="diff__lines">
        {lines.map((line, index) => (
          <span key={index} className={`diff__line diff__line--${line.type}`}>
            {line.text}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

function PendingToolResult({ status }: { status: ToolStatus }) {
  return (
    <div className="card__pending">
      {status === "running"
        ? "Running…"
        : status === "success" || status === "failure"
          ? "Finalizing result…"
          : "No result recorded"}
    </div>
  );
}

function RawToolDetails({
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
          accessibleLabel={arg.value}
        >
          <span className="card__file-arg-key">{arg.key}</span>
          <ResourcePathLabel path={arg.value} />
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
        <PendingToolResult status={status} />
      )}
    </>
  );
}

function ToolBlockHeading({ label, path }: { label?: string; path?: string }) {
  if (!label && !path) return null;
  return (
    <div className="card__section-label tool-block__heading">
      {label ? <span>{label}</span> : null}
      {path ? (
        <FileRefButton
          reference={path}
          className="tool-block__path"
          accessibleLabel={path}
        >
          <ResourcePathLabel path={path} />
        </FileRefButton>
      ) : null}
    </div>
  );
}

const STRUCTURED_CODE_PREVIEW_LINES = 400;

function StructuredCode({
  text,
  startLine = 1,
}: {
  text: string;
  startLine?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines = text.split("\n");
  const clipped = lines.length > STRUCTURED_CODE_PREVIEW_LINES;
  const visible =
    clipped && !showAll ? lines.slice(0, STRUCTURED_CODE_PREVIEW_LINES) : lines;
  return (
    <>
      <pre className="tool-code">
        {visible.map((line, index) => (
          <span className="tool-code__line" key={index}>
            <span className="tool-code__number" aria-hidden>
              {startLine + index}
            </span>
            <code>{line || " "}</code>
          </span>
        ))}
      </pre>
      {clipped ? (
        <button
          type="button"
          className="card__show-all"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? "Show fewer lines"
            : `Show all ${lines.length.toLocaleString()} lines`}
        </button>
      ) : null}
    </>
  );
}

function ReplacementDiff({
  block,
}: {
  block: Extract<ToolPresentationBlock, { type: "replacement" }>;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines: DiffLine[] = [
    ...block.oldText
      .split("\n")
      .map((text) => ({ type: "del" as const, text: `-${text}` })),
    ...block.newText
      .split("\n")
      .map((text) => ({ type: "add" as const, text: `+${text}` })),
  ];
  const clipped = lines.length > STRUCTURED_CODE_PREVIEW_LINES;
  return (
    <div className="tool-block">
      <ToolBlockHeading label={block.label} path={block.path} />
      <DiffView
        lines={
          clipped && !showAll
            ? lines.slice(0, STRUCTURED_CODE_PREVIEW_LINES)
            : lines
        }
      />
      {clipped ? (
        <button
          type="button"
          className="card__show-all"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? "Show fewer lines"
            : `Show all ${lines.length.toLocaleString()} lines`}
        </button>
      ) : null}
    </div>
  );
}

function ToolPresentationBlockView({
  block,
}: {
  block: ToolPresentationBlock;
}) {
  switch (block.type) {
    case "properties":
      return (
        <div
          className="tool-properties"
          role="group"
          aria-label={block.label ?? "Properties"}
        >
          {block.label ? (
            <div className="card__section-label">{block.label}</div>
          ) : null}
          <dl>
            {block.items.map((item, index) => (
              <div
                className="tool-properties__item"
                key={`${item.label}:${index}`}
              >
                <dt>{item.label}</dt>
                <dd>
                  {item.resourceRef ? (
                    <FileRefButton
                      reference={item.resourceRef}
                      className="tool-properties__resource"
                      accessibleLabel={item.resourceRef}
                    >
                      <ResourcePathLabel path={item.value} />
                    </FileRefButton>
                  ) : (
                    <code>{item.value}</code>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      );
    case "code":
      return (
        <div className="tool-block">
          <ToolBlockHeading label={block.label} path={block.path} />
          <StructuredCode text={block.text} startLine={block.startLine} />
        </div>
      );
    case "diff": {
      const lines = parseUnifiedDiff(block.text);
      if (!lines) return null;
      return (
        <div className="tool-block">
          <ToolBlockHeading label={block.label} path={block.path} />
          <DiffView lines={lines} />
        </div>
      );
    }
    case "terminal":
      return (
        <div className="tool-block">
          <ToolBlockHeading label={block.label} />
          <pre
            className={`tool-terminal ${block.error ? "tool-terminal--error" : ""}`}
          >
            {block.text}
          </pre>
        </div>
      );
    case "list":
      return (
        <div className="tool-block">
          <ToolBlockHeading label={block.label} path={block.path} />
          {block.items.length > 0 ? (
            <ul className="tool-list">
              {block.items.map((item, index) => (
                <li key={`${item.label}:${index}`}>
                  {item.kind === "directory" ? (
                    <Folder size={14} aria-hidden />
                  ) : (
                    <FileText size={14} aria-hidden />
                  )}
                  {item.resourceRef ? (
                    <FileRefButton
                      reference={item.resourceRef}
                      className="tool-list__resource"
                      accessibleLabel={item.resourceRef}
                    >
                      <ResourcePathLabel path={item.label} />
                    </FileRefButton>
                  ) : (
                    <code>{item.label}</code>
                  )}
                  {item.detail ? (
                    <span className="tool-list__detail">{item.detail}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="tool-empty">{block.emptyText ?? "No results"}</div>
          )}
        </div>
      );
    case "search":
      return (
        <div className="tool-block">
          <ToolBlockHeading label={block.label} />
          {block.groups.length > 0 ? (
            <div className="tool-search-results">
              {block.groups.map((group) => (
                <section className="tool-search-group" key={group.path}>
                  <header>
                    <FileSearch size={14} aria-hidden />
                    <code title={group.path}>
                      <ResourcePathLabel path={group.path} />
                    </code>
                    <span>{formatCount(group.matches.length, "line")}</span>
                  </header>
                  <div className="tool-search-group__lines">
                    <div className="tool-search-group__line-plane">
                      {group.matches.map((match, index) => (
                        <div
                          className={`tool-search-line ${match.match ? "tool-search-line--match" : "tool-search-line--context"}`}
                          key={`${match.line}:${index}`}
                        >
                          <span className="tool-search-line__number">
                            {match.line}
                          </span>
                          <code>{match.text || " "}</code>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="tool-empty">{block.emptyText ?? "No matches"}</div>
          )}
        </div>
      );
    case "replacement":
      return <ReplacementDiff block={block} />;
    case "image":
      return (
        <figure className="tool-image-block">
          <ToolBlockHeading label={block.label} />
          <img
            className="tool-image-block__image"
            src={`data:${block.mimeType};base64,${block.data}`}
            alt={block.alt}
            loading="lazy"
            decoding="async"
          />
        </figure>
      );
    case "notice":
      return (
        <div className={`tool-notice tool-notice--${block.tone ?? "muted"}`}>
          {block.text}
        </div>
      );
    case "markdown":
      return (
        <div className="tool-block">
          <ToolBlockHeading label={block.label} />
          <div
            className={`tool-markdown ${block.error ? "tool-markdown--error" : ""}`}
          >
            <RichText text={block.text} variant="extension" />
          </div>
        </div>
      );
    case "text":
      return (
        <div className="tool-block">
          <ToolBlockHeading label={block.label} />
          <pre className={`tool-text ${block.error ? "tool-text--error" : ""}`}>
            {block.text}
          </pre>
        </div>
      );
  }
}

function formatCount(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

function presentationBlocks(
  presentation: ToolPresentation,
): ToolPresentationBlock[] | null {
  let blocks: ToolPresentationBlock[] | null;
  try {
    blocks = presentation.blocks();
  } catch {
    return null;
  }
  if (
    !blocks ||
    blocks.some(
      (block) => block.type === "diff" && !parseUnifiedDiff(block.text),
    )
  )
    return null;
  return blocks;
}

function ThinkingDetails({
  text,
  presentation,
}: {
  text: string;
  presentation: ToolPresentation | null;
}) {
  const blocks = presentation ? presentationBlocks(presentation) : null;
  if (!blocks) return <RichText text={text} variant="thinking" />;
  return (
    <div
      className="tool-presentation thinking-presentation"
      data-thinking-presentation="configured"
    >
      {blocks.map((block, index) => (
        <ToolPresentationBlockView
          block={block}
          key={`${block.type}:${index}`}
        />
      ))}
    </div>
  );
}

function ToolDetails({
  call,
  result,
  status,
  presentation,
}: {
  call: ToolCallContent;
  result: ChatMessage | undefined;
  status: ToolStatus;
  presentation: ResolvedToolPresentation | null;
}) {
  if (!presentation)
    return <RawToolDetails call={call} result={result} status={status} />;
  const blocks = presentationBlocks(presentation);
  if (!blocks)
    return <RawToolDetails call={call} result={result} status={status} />;
  return (
    <div className="tool-presentation" data-tool-rule={presentation.ruleId}>
      {blocks.map((block, index) => (
        <ToolPresentationBlockView
          block={block}
          key={`${block.type}:${index}`}
        />
      ))}
      {!result ? <PendingToolResult status={status} /> : null}
    </div>
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

export function ToolCard({
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
    DYNAMIC_TOOL_CLOSE_DELAY_MS,
  );
  const presentation = useMemo(
    () => toolPresentationRegistry.resolve({ call, result }),
    [call, result, toolPresentationRegistry],
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
      summary={
        presentation ? (
          <PresentedSummary summary={presentation.summary} />
        ) : (
          <ToolSummary call={call} />
        )
      }
      status={statusIcon(status)}
      copyText={toolClipboardText(call, result)}
      copyLabel={`${call.name} tool block`}
    >
      <ToolDetails
        call={call}
        result={result}
        status={status}
        presentation={presentation}
      />
    </CollapsibleCard>
  );
}

interface CollapsedToolActivity {
  kind: "tool";
  key: string;
  call: ToolCallContent;
  result: ChatMessage | undefined;
  activity?: ActivityTool;
}

interface CollapsedCustomActivity {
  kind: "custom";
  key: string;
  message: ChatMessage;
  title: string;
  customType: string;
}

export type CollapsedActivity = CollapsedToolActivity | CollapsedCustomActivity;

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

function collapsedActivityPresentation(
  activity: CollapsedActivity,
  live: boolean,
) {
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
  const resolved = toolPresentationRegistry.resolve({
    call: activity.call,
    result: activity.result,
  });
  const summary = resolved
    ? toolPresentationSummaryText(resolved.summary)
    : toolSummary(activity.call);
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

/** Collapsed mode reduces an adjacent multi-activity run to status tiles.
 * Items wrap horizontally, while one selection reveals its ordinary details
 * below the strip without reordering transcript content. */
export function CollapsedActivityStrip({
  activities,
  live,
}: {
  activities: CollapsedActivity[];
  live: boolean;
}) {
  const visibleActivityIds = useVisibleActivityItemIds();
  const visibleActivityCount =
    visibleActivityIds === null
      ? activities.length
      : activities.filter((activity) => visibleActivityIds.has(activity.key))
          .length;
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [renderedIndex, setRenderedIndex] = useState<number | null>(null);
  const [origin, setOrigin] = useState(22);
  const panelId = useId();
  const itemsRef = useRef<HTMLDivElement>(null);
  const rendered =
    renderedIndex == null ? null : (activities[renderedIndex] ?? null);
  const selectionVisible =
    selectedIndex !== null &&
    (visibleActivityIds === null ||
      visibleActivityIds.has(activities[selectedIndex]?.key ?? ""));
  const activityPresentations = useMemo(
    () =>
      activities.map((activity) =>
        collapsedActivityPresentation(activity, live),
      ),
    [activities, live],
  );
  const renderedPresentation = useMemo(
    () =>
      rendered?.kind === "tool"
        ? toolPresentationRegistry.resolve({
            call: rendered.call,
            result: rendered.result,
          })
        : null,
    [rendered],
  );

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

  if (visibleActivityCount === 0) return null;

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
          if (
            visibleActivityIds !== null &&
            !visibleActivityIds.has(activity.key)
          )
            return null;
          const active = selectedIndex === index;
          const presentation = activityPresentations[index];
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
        className={`activity-strip__reveal ${selectionVisible ? "activity-strip__reveal--open" : ""}`}
        aria-hidden={!selectionVisible}
        inert={!selectionVisible}
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
                summary={
                  renderedPresentation ? (
                    <PresentedSummary summary={renderedPresentation.summary} />
                  ) : (
                    <ToolSummary call={rendered.call} />
                  )
                }
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
                  presentation={renderedPresentation}
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

export function genericContentTitle(item: object): string | null {
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

export function customActivityItems(
  messages: ChatMessage[],
): CollapsedCustomActivity[] {
  const keys = customActivityKeys(messages);
  return messages.map((message, index) => ({
    kind: "custom",
    key: keys[index]!,
    message,
    title: customMessageTitle(message),
    customType: customMessageType(message),
  }));
}

export function assistantEndsWithToolRun(message: ChatMessage): boolean {
  const items = contentItems(message);
  return items.length > 0 && items[items.length - 1]?.type === "toolCall";
}

export function hasRenderableAssistantContent(
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

export function GenericCard({
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

export function CustomMessageCard({
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
    DYNAMIC_CUSTOM_EXPANDED_MIN_MS,
    onDynamicClosed,
    DYNAMIC_CUSTOM_CLOSE_DELAY_MS,
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

export function CustomActivityBatch({
  messages,
  activityItemIds = [],
  toolVisibility,
  collapseRequested,
}: {
  messages: ChatMessage[];
  activityItemIds?: string[];
  toolVisibility: ToolVisibilityPreference;
  collapseRequested: boolean;
}) {
  const dynamic = toolVisibility === "dynamic";
  const activities = customActivityItems(messages).map((activity, index) => ({
    ...activity,
    key: activityItemIds[index] ?? activity.key,
  }));
  const activityKeys = activities.map((activity) => activity.key);
  const lifecycleObserved = messages.some(
    (message) => typeof message.__inspireLiveId === "string",
  );
  const collapseEligible = activities.length > 1;
  const dynamicBatch = useDynamicActivityGroup(
    dynamic,
    lifecycleObserved,
    collapseRequested,
    activityKeys,
    collapseEligible,
  );
  const ordinaryVisibility: StaticVisibility =
    toolVisibility === "compact" || toolVisibility === "collapsed" || dynamic
      ? "collapsed"
      : toolVisibility;
  const collapsed =
    collapseEligible &&
    (toolVisibility === "collapsed" || (dynamic && dynamicBatch.collapsed));

  if (toolVisibility === "hidden" || activities.length === 0) return null;
  return (
    <div className="turn turn--custom">
      <div
        className={`custom-activity-batch ${dynamic ? `dynamic-activity-batch dynamic-activity-batch--${dynamicBatch.phase}` : ""}`}
      >
        {collapsed ? (
          <CollapsedActivityStrip activities={activities} live={false} />
        ) : (
          messages.map((message, index) => {
            const activityKey = activityKeys[index]!;
            return (
              <ActivityItemBoundary key={activityKey} id={activityKey}>
                <CustomMessageCard
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
              </ActivityItemBoundary>
            );
          })
        )}
      </div>
    </div>
  );
}
