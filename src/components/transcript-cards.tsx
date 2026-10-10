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
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ToolVisibilityPreference,
  VisibilityPreference,
} from "../../shared/contracts";
import {
  isLocalResourceReference,
  isToolResourceArgumentKey,
} from "../../shared/resource-references";
import {
  type ChildCallList,
  resultChildCalls,
} from "../../shared/tool-activity";
import { stripTerminalSequences } from "../ansi";
import { type DiffLine, parseUnifiedDiff } from "../diff";
import {
  type ActivityTool,
  type ChatMessage,
  contentItems,
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
import {
  toolPresentationSummaryText,
  toolResultImage,
} from "../tool-presentations/model";
import { codeModeResultBlocks } from "../tool-presentations/pi-native";
import {
  thinkingPresentationRegistry,
  toolPresentationRegistry,
} from "../tool-presentations/registry";
import { ChildCalls, childCallsSummary } from "./ChildCalls";
import { CodeModeResult, codeModeDuration } from "./CodeModeResult";
import { CopyAction } from "./CopyAction";
import {
  EmbeddedImageOwnerContext,
  ImagePreview,
  PersistedImage,
} from "./ImagePreview";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";
import { ResourcePathLabel } from "./ResourcePathLabel";
import {
  CARD_TRANSITION_MS,
  DYNAMIC_THINKING_CLOSE_DELAY_MS,
  DYNAMIC_THINKING_EXPANDED_MIN_MS,
  DYNAMIC_TOOL_CLOSE_DELAY_MS,
  DYNAMIC_TOOL_EXPANDED_MIN_MS,
  prefersReducedMotion,
  useDynamicCardOpen,
} from "./transcript-activity";
import { useVisibleActivityItemIds } from "./transcript-activity-visibility";

export type StaticVisibility = Exclude<VisibilityPreference, "dynamic">;

interface CardHeaderProps {
  expanded: boolean;
  icon: React.ReactNode;
  label: React.ReactNode;
  toggleLabel: string;
  onToggle: () => void;
  summary?: React.ReactNode;
  status?: React.ReactNode;
  copyText?: string | (() => string);
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
        <CopyAction
          text={typeof copyText === "string" ? copyText : undefined}
          getText={
            typeof copyText === "function" ? async () => copyText() : undefined
          }
          label={copyLabel}
          className="card__copy"
        />
      ) : null}
    </div>
  );
}

const CardInspectionContext = createContext<(() => void) | undefined>(
  undefined,
);

interface CardProps {
  defaultVisibility: StaticVisibility;
  className: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  toggleLabel: string;
  summary?: React.ReactNode;
  summaryVisibleWhenOpen?: boolean;
  status?: React.ReactNode;
  copyText?: string | (() => string);
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
  summaryVisibleWhenOpen = false,
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
          (!open || summaryVisibleWhenOpen) && summary ? (
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
            <div className="card__body">
              <CardInspectionContext
                value={() => {
                  if (override !== "open") {
                    setOverride("open");
                    onManualOpenChange?.(true);
                  }
                }}
              >
                {children}
              </CardInspectionContext>
            </div>
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

type ToolStatus =
  | "generating"
  | "waiting"
  | "interrupted"
  | "running"
  | "success"
  | "failure"
  | "unknown";

// Partial paths are readable text, not usable resource identities yet.
const ToolArgumentPreviewContext =
  createContext<ToolCallContent["__inspireToolCall"]>(undefined);

function useToolOutputScroll(content: unknown, followUpdates: boolean) {
  const ref = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (followUpdates && following.current && ref.current)
      ref.current.scrollTop = ref.current.scrollHeight;
  }, [content, followUpdates]);
  return {
    ref,
    onScroll(event: React.UIEvent<HTMLPreElement>) {
      const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
      following.current = scrollHeight - scrollTop - clientHeight < 24;
    },
  };
}

function toolSummary(call: ToolCallContent): string {
  const args = call.arguments;
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    for (const key of ["path", "file", "command", "query", "url"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
    const first = Object.values(record).find(
      (value) => typeof value === "string",
    );
    if (typeof first === "string") return first;
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
  const preview = useContext(ToolArgumentPreviewContext);
  if (preview)
    return <span className={className}>{children ?? reference}</span>;
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
  const reference = toolFileArguments(call)[0]?.value;
  const summary = reference ?? toolSummary(call);
  if (!summary) return null;
  if (!reference)
    return <span className="card__summary">{summary.slice(0, 90)}</span>;
  return (
    <FileRefButton
      reference={reference}
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
  call: ToolCallContent,
): ToolStatus {
  if (result) return result.isError ? "failure" : "success";
  if (activity?.phase === "error") return "failure";
  if (activity?.phase === "done") return "success";
  if (activity?.phase === "running") return "running";
  if (activity?.phase === "queued") return "waiting";
  if (call.__inspireToolCall?.phase === "interrupted") return "interrupted";
  if (call.__inspireToolCall?.phase === "streaming")
    return liveFallback ? "generating" : "interrupted";
  return liveFallback ? "waiting" : "unknown";
}

function statusIcon(status: ToolStatus) {
  switch (status) {
    case "generating":
      return (
        <Loader2 size={14} className="spin" aria-label="generating arguments" />
      );
    case "waiting":
      return <Circle size={12} aria-label="waiting to execute" />;
    case "interrupted":
      return <Circle size={12} aria-label="not executed" />;
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
  const preview = useContext(ToolArgumentPreviewContext);
  const scroll = useToolOutputScroll(lines, preview?.phase === "streaming");
  return (
    <pre
      className="card__mono diff"
      {...scroll}
      tabIndex={0}
      role="group"
      aria-label="Changes"
    >
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
      {status === "generating"
        ? "Generating arguments…"
        : status === "waiting"
          ? "Waiting to execute…"
          : status === "interrupted"
            ? "Not executed"
            : status === "running"
              ? "Running…"
              : status === "success" || status === "failure"
                ? "Finalizing result…"
                : "No result recorded"}
    </div>
  );
}

function hasResultData(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Keep structured payloads inspectable without printing transport metadata or
 * large JSON by default. Serialization is deferred until disclosure. */
function RawResultData({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="tool-result-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Result details</summary>
      {open ? (
        <pre
          className="card__mono"
          tabIndex={0}
          role="group"
          aria-label="Result data"
        >
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : null}
    </details>
  );
}

function RawResultExtras({
  result,
  hasText,
}: {
  result: ChatMessage;
  hasText: boolean;
}) {
  const images = Array.isArray(result.content)
    ? result.content.flatMap((part, partIndex) =>
        part && typeof part === "object" && part.type === "image"
          ? [partIndex]
          : [],
      )
    : [];
  const otherContent = Array.isArray(result.content)
    ? result.content.filter(
        (part) =>
          part != null &&
          !(
            typeof part === "object" &&
            (part.type === "image" || typeof part.text === "string")
          ),
      )
    : typeof result.content === "string"
      ? undefined
      : result.content;
  const data = {
    ...(hasResultData(result.details) ? { details: result.details } : {}),
    ...(hasResultData(result.nestedCalls)
      ? { nestedCalls: result.nestedCalls }
      : {}),
    ...(hasResultData(otherContent) ? { content: otherContent } : {}),
  };
  return (
    <>
      {images.map((partIndex, index) => {
        const image = toolResultImage(
          result,
          partIndex,
          `Tool result image ${index + 1}`,
        );
        return image ? (
          <ToolPresentationBlockView key={partIndex} block={image} />
        ) : (
          <div className="tool-notice tool-notice--warning" key={partIndex}>
            Image unavailable (unsupported or invalid image data)
          </div>
        );
      })}
      {hasResultData(data) ? <RawResultData value={data} /> : null}
      {!hasText && images.length === 0 && !hasResultData(data) ? (
        <div className="tool-empty">No output</div>
      ) : null}
    </>
  );
}

function RawArguments({ call }: { call: ToolCallContent }) {
  const argumentsText = useMemo(
    () => JSON.stringify(call.arguments ?? {}, null, 2),
    [call.arguments],
  );
  const scroll = useToolOutputScroll(
    argumentsText,
    call.__inspireToolCall?.phase === "streaming",
  );
  return (
    <>
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
      <pre
        className="card__mono"
        {...scroll}
        tabIndex={0}
        role="group"
        aria-label="Arguments"
      >
        {argumentsText}
      </pre>
    </>
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
  if (
    !result &&
    call.__inspireToolCall &&
    Object.keys(call.arguments ?? {}).length === 0
  )
    return <PendingToolResult status={status} />;
  return (
    <>
      <div className="card__section-label">
        {call.__inspireToolCall ? "Arguments (partial)" : "Arguments"}
      </div>
      <RawArguments call={call} />
      {result ? (
        <>
          <div className="card__section-label">Result</div>
          <RawToolResult result={result} />
        </>
      ) : (
        <PendingToolResult status={status} />
      )}
    </>
  );
}

function RawToolResult({ result }: { result: ChatMessage }) {
  const [showAll, setShowAll] = useState(false);
  const output = toolResultText(result);
  const diff = !result.isError ? parseUnifiedDiff(output) : null;
  const truncated = !diff && output.length > 600;
  return (
    <>
      {diff ? (
        <DiffView lines={diff} />
      ) : output ? (
        <pre
          className={`card__mono ${result.isError ? "card__mono--error" : ""}`}
          tabIndex={0}
          role="group"
          aria-label="Result text"
        >
          {showAll || !truncated ? output : `${output.slice(0, 600)}…`}
        </pre>
      ) : null}
      <RawResultExtras result={result} hasText={Boolean(output)} />
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
  );
}

/** Historical/imported projections can contain a result without its call.
 * Show its actual payload without inventing missing input arguments. */
export function ToolResultCard({
  result,
  visibility,
}: {
  result: ChatMessage;
  visibility: StaticVisibility;
}) {
  const name = typeof result.toolName === "string" ? result.toolName : "Tool";
  const calls = result.__inspireCalls ?? resultChildCalls(result);
  const output =
    name === "codemode" ? (
      codeModeResultBlocks(result).map((block, index) => (
        <ToolPresentationBlockView key={index} block={block} />
      ))
    ) : (
      <RawToolResult result={result} />
    );
  return (
    <CollapsibleCard
      defaultVisibility={visibility}
      className={`card--tool ${name === "codemode" ? "card--codemode" : ""} ${result.isError ? "card--failed" : ""}`}
      icon={toolIcon(name)}
      label={
        <code className="card__tool-name">{toolDisplayName(name)} result</code>
      }
      toggleLabel={`${toolDisplayName(name)} result details`}
      summary={
        name === "codemode" ? (
          <CodeModeSummary result={result} calls={calls} />
        ) : undefined
      }
      summaryVisibleWhenOpen={name === "codemode"}
      status={statusIcon(result.isError ? "failure" : "success")}
      copyText={() => JSON.stringify(result, null, 2)}
      copyLabel={`${name} result`}
    >
      {calls ? (
        <PhaseToolDetails
          calls={calls}
          running={false}
          settled
          codemode={name === "codemode"}
        >
          {output}
        </PhaseToolDetails>
      ) : (
        output
      )}
    </CollapsibleCard>
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
  lineNumbers = true,
  language,
}: {
  text: string;
  startLine?: number;
  lineNumbers?: boolean;
  language?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const partial = useContext(ToolArgumentPreviewContext);
  const scroll = useToolOutputScroll(text, partial?.phase === "streaming");
  const lines = text.split("\n");
  const clipped = lines.length > STRUCTURED_CODE_PREVIEW_LINES;
  const visible =
    clipped && (!showAll || partial)
      ? lines.slice(0, STRUCTURED_CODE_PREVIEW_LINES)
      : lines;
  return (
    <>
      <pre
        className="tool-code"
        {...scroll}
        tabIndex={0}
        role="group"
        aria-label="Code"
        data-language={language}
        style={
          {
            "--tool-line-number-width": `${Math.max(3, String(startLine + visible.length - 1).length) + 1.5}ch`,
          } as React.CSSProperties
        }
      >
        {lineNumbers ? (
          <span className="tool-code__lines">
            {visible.map((line, index) => (
              <span className="tool-code__line" key={index}>
                <span className="tool-code__number" aria-hidden>
                  {startLine + index}
                </span>
                <code className={language ? `language-${language}` : undefined}>
                  {line || " "}
                </code>
              </span>
            ))}
          </span>
        ) : (
          <code className={language ? `language-${language}` : undefined}>
            {visible.join("\n")}
          </code>
        )}
      </pre>
      {clipped ? (
        partial ? (
          <div className="card__pending">
            Showing first {STRUCTURED_CODE_PREVIEW_LINES} lines
          </div>
        ) : (
          <button
            type="button"
            className="card__show-all"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll
              ? "Show fewer lines"
              : `Show all ${lines.length.toLocaleString()} lines`}
          </button>
        )
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
  const partial = useContext(ToolArgumentPreviewContext);
  const lines: DiffLine[] = [
    ...(block.oldText === undefined ? [] : block.oldText.split("\n")).map(
      (text) => ({ type: "del" as const, text: `-${text}` }),
    ),
    ...(block.newText === undefined ? [] : block.newText.split("\n")).map(
      (text) => ({ type: "add" as const, text: `+${text}` }),
    ),
  ];
  const clipped = lines.length > STRUCTURED_CODE_PREVIEW_LINES;
  return (
    <div className="tool-block">
      <ToolBlockHeading label={block.label} path={block.path} />
      <DiffView
        lines={
          clipped && (!showAll || partial)
            ? lines.slice(0, STRUCTURED_CODE_PREVIEW_LINES)
            : lines
        }
      />
      {clipped ? (
        partial ? (
          <div className="card__pending">
            Showing first {STRUCTURED_CODE_PREVIEW_LINES} lines
          </div>
        ) : (
          <button
            type="button"
            className="card__show-all"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll
              ? "Show fewer lines"
              : `Show all ${lines.length.toLocaleString()} lines`}
          </button>
        )
      ) : null}
    </div>
  );
}

function ToolImage({
  block,
}: {
  block: Extract<ToolPresentationBlock, { type: "image" }>;
}) {
  const owner = useContext(EmbeddedImageOwnerContext);
  return (
    <figure className="tool-image-block">
      <ToolBlockHeading label={block.label} />
      {block.reference ? (
        owner ? (
          <PersistedImage
            {...owner}
            reference={block.reference}
            alt={block.alt}
            className="tool-image-block__image"
          />
        ) : (
          <div className="tool-notice tool-notice--warning">
            Image unavailable
          </div>
        )
      ) : (
        <ImagePreview
          src={`data:${block.mimeType};base64,${block.data}`}
          alt={block.alt}
          className="tool-image-block__image"
        />
      )}
    </figure>
  );
}

function ToolPresentationBlockView({
  block,
}: {
  block: ToolPresentationBlock;
}) {
  switch (block.type) {
    case "codemode-result":
      return (
        <div className="tool-block">
          <ToolBlockHeading label="Output" />
          <CodeModeResult
            result={block.result}
            renderImage={(image) => <ToolImage block={image} />}
          />
        </div>
      );
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
    case "code": {
      return (
        <div className="tool-block">
          <ToolBlockHeading label={block.label} path={block.path} />
          <StructuredCode
            text={block.text}
            startLine={block.startLine}
            lineNumbers={block.lineNumbers}
            language={block.language}
          />
        </div>
      );
    }
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
          <ToolTerminal
            text={block.text}
            label={block.label}
            error={block.error}
          />
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
                    <span className="tool-list__detail" title={item.detail}>
                      {item.detail}
                    </span>
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
                  <div
                    className="tool-search-group__lines"
                    tabIndex={0}
                    role="group"
                    aria-label={`${group.path} matches`}
                  >
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
      return <ToolImage block={block} />;
    case "notice":
      return (
        <div className={`tool-notice tool-notice--${block.tone ?? "muted"}`}>
          {block.text}
          {block.action ? (
            <FileRefButton
              reference={block.action.reference}
              accessibleLabel={block.action.label}
              className="tool-notice__action"
            >
              {block.action.label}
            </FileRefButton>
          ) : null}
        </div>
      );
    case "markdown":
      return (
        <div className="tool-block">
          <ToolBlockHeading label={block.label} />
          <div
            className={`tool-markdown ${block.error ? "tool-markdown--error" : ""}`}
            role="group"
            aria-label={block.label ?? "Formatted output"}
            tabIndex={0}
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

function ToolTerminal({
  text,
  label = "Output",
  error = false,
  live = false,
}: {
  text: string;
  label?: string;
  error?: boolean;
  live?: boolean;
}) {
  const preview = useContext(ToolArgumentPreviewContext);
  const scroll = useToolOutputScroll(
    text,
    live || preview?.phase === "streaming",
  );
  return (
    <pre
      {...scroll}
      className={`tool-terminal ${error ? "tool-terminal--error" : ""} ${live ? "tool-terminal--live" : ""}`}
      tabIndex={0}
      role="group"
      aria-label={label}
    >
      {stripTerminalSequences(text)}
    </pre>
  );
}

function LiveToolOutput({
  preview,
}: {
  preview: NonNullable<ActivityTool["outputPreview"]>;
}) {
  return (
    <div className="tool-block">
      <ToolBlockHeading label="Output (live preview)" />
      {preview.truncated ? (
        <div className="card__pending">
          Showing latest output · preview truncated
        </div>
      ) : null}
      <ToolTerminal text={preview.text} label="Live output" live />
    </div>
  );
}

function PhaseToolDetails({
  calls,
  running,
  settled,
  children,
  script,
  codemode = false,
}: {
  calls?: ChildCallList;
  running: boolean;
  settled: boolean;
  children: React.ReactNode;
  script?: React.ReactNode;
  codemode?: boolean;
}) {
  const [readingCalls, setReadingCalls] = useState(false);
  const inspect = useContext(CardInspectionContext);
  const failed =
    calls?.calls.filter((call) => call.status === "error").length ?? 0;
  const resultBody = (
    <div key="result" className="tool-call-result">
      {children}
    </div>
  );
  const callsBody =
    calls && (calls.calls.length > 0 || !calls.complete) ? (
      <div key="calls" className="tool-call-list">
        {!codemode ? (
          <div className="tool-call-list__heading">
            Calls{" "}
            <span className="tool-call-list__count">{calls.calls.length}</span>
            {failed ? (
              <span className="child-call__status--error">
                · {failed} failed
              </span>
            ) : null}
          </div>
        ) : null}
        <ChildCalls
          list={calls}
          running={running}
          onRead={() => {
            inspect?.();
            if (!settled) setReadingCalls(true);
          }}
        />
      </div>
    ) : null;
  return (
    <div
      className={`tool-call-layout ${codemode ? "tool-call-layout--codemode" : ""}`}
      onFocusCapture={inspect}
      onClickCapture={inspect}
      onPointerDownCapture={inspect}
    >
      {codemode || !settled || readingCalls
        ? [callsBody, resultBody]
        : [resultBody, callsBody]}
      {script ? <div className="tool-call-script">{script}</div> : null}
    </div>
  );
}

function ToolArguments({ call }: { call: ToolCallContent }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="tool-result-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {call.__inspireToolCall ? "Arguments (partial)" : "Arguments"}
      </summary>
      {open ? <RawArguments call={call} /> : null}
    </details>
  );
}

function ToolScript({ call }: { call: ToolCallContent }) {
  const [open, setOpen] = useState(false);
  const args = call.arguments as { code: string };
  return (
    <details
      className="tool-result-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Script{call.__inspireToolCall ? " (partial)" : ""}</summary>
      {open ? (
        <ToolPresentationBlockView
          block={{
            type: "code",
            text: args.code,
            language: "javascript",
          }}
        />
      ) : null}
    </details>
  );
}

function ToolDetails({
  call,
  result,
  status,
  presentation,
  activity,
}: {
  call: ToolCallContent;
  result: ChatMessage | undefined;
  status: ToolStatus;
  presentation: ResolvedToolPresentation | null;
  activity?: ActivityTool;
}) {
  const preview =
    !result && status === "running" ? activity?.outputPreview : undefined;
  const calls = result
    ? (result.__inspireCalls ?? resultChildCalls(result))
    : activity?.calls;
  const codemode = presentation?.ruleId === "inspire.pi.codemode";
  if (codemode || calls)
    return (
      <>
        {call.__inspireToolCall?.truncated ? (
          <div className="card__pending">Argument preview truncated</div>
        ) : null}
        <PhaseToolDetails
          calls={calls}
          running={status === "running"}
          settled={Boolean(result)}
          script={codemode ? <ToolScript call={call} /> : undefined}
          codemode={codemode}
        >
          {presentation ? (
            <ToolDetailsContent
              call={call}
              result={result}
              status={status}
              presentation={presentation}
              showPending={!calls?.calls.length}
            />
          ) : result ? (
            <RawToolResult result={result} />
          ) : !calls?.calls.length ? (
            <PendingToolResult status={status} />
          ) : null}
          {preview ? <LiveToolOutput preview={preview} /> : null}
          {!presentation ? <ToolArguments call={call} /> : null}
        </PhaseToolDetails>
      </>
    );
  return (
    <>
      {call.__inspireToolCall?.truncated ? (
        <div className="card__pending">Argument preview truncated</div>
      ) : null}
      <ToolDetailsContent
        call={call}
        result={result}
        status={status}
        presentation={presentation}
      />
      {preview ? <LiveToolOutput preview={preview} /> : null}
    </>
  );
}

function ToolDetailsContent({
  call,
  result,
  status,
  presentation,
  showPending = true,
}: {
  call: ToolCallContent;
  result: ChatMessage | undefined;
  status: ToolStatus;
  presentation: ResolvedToolPresentation | null;
  showPending?: boolean;
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
      {!result && showPending ? <PendingToolResult status={status} /> : null}
    </div>
  );
}

function toolClipboardLabel(
  call: ToolCallContent,
  result: ChatMessage | undefined,
  activity?: ActivityTool,
): string {
  return `${call.name} ${call.__inspireToolCall ? "argument preview" : !result && activity?.phase === "running" && activity.outputPreview ? "live output preview" : "tool block"}`;
}

function toolClipboardText(
  call: ToolCallContent,
  result: ChatMessage | undefined,
  activity?: ActivityTool,
): string {
  const sections = [
    call.name,
    call.__inspireToolCall ? "Arguments (partial preview)" : "Arguments",
    JSON.stringify(call.arguments ?? {}, null, 2),
  ];
  if (result) {
    sections.push("Result", toolResultText(result));
    if (hasResultData(result.details))
      sections.push("Result details", JSON.stringify(result.details, null, 2));
  } else if (activity?.phase === "running" && activity.outputPreview) {
    sections.push(
      activity.outputPreview.truncated
        ? "Output (live preview, truncated)"
        : "Output (live preview)",
      stripTerminalSequences(activity.outputPreview.text),
    );
  }
  return sections.join("\n\n");
}

function toolDisplayName(name: string): string {
  return name === "codemode" ? "CodeMode" : name;
}

function CodeModeSummary({
  result,
  calls,
}: {
  result?: ChatMessage;
  calls?: ChildCallList;
}) {
  const duration = codeModeDuration(result);
  const summary = childCallsSummary(calls);
  return (
    <>
      {duration ? (
        <span className="card__summary codemode-duration">{duration}</span>
      ) : null}
      {summary ? (
        <span className="card__summary" title={summary}>
          {summary}
        </span>
      ) : null}
    </>
  );
}

function ToolCardSummary({
  call,
  result,
  activity,
  presentation,
}: {
  call: ToolCallContent;
  result: ChatMessage | undefined;
  activity?: ActivityTool;
  presentation: ResolvedToolPresentation | null;
}) {
  if (presentation?.ruleId === "inspire.pi.codemode") {
    const calls = result
      ? (result.__inspireCalls ?? resultChildCalls(result))
      : activity?.calls;
    return <CodeModeSummary result={result} calls={calls} />;
  }
  return presentation ? (
    <PresentedSummary summary={presentation.summary} />
  ) : (
    <ToolSummary call={call} />
  );
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
  const status = toolStatus(result, activity, live, call);
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
    <ToolArgumentPreviewContext value={call.__inspireToolCall}>
      <CollapsibleCard
        defaultVisibility={
          dynamic ? (dynamicOpen ? "expanded" : "collapsed") : visibility
        }
        forceClosed={forceClosed}
        onManualOpenChange={onManualOpenChange}
        className={`card--tool ${call.name === "codemode" ? "card--codemode" : ""} ${status === "failure" ? "card--failed" : ""}`}
        icon={toolIcon(call.name)}
        label={
          <code className="card__tool-name">{toolDisplayName(call.name)}</code>
        }
        toggleLabel={`${toolDisplayName(call.name)} tool`}
        summary={
          <ToolCardSummary
            call={call}
            result={result}
            activity={activity}
            presentation={presentation}
          />
        }
        summaryVisibleWhenOpen={presentation?.ruleId === "inspire.pi.codemode"}
        status={statusIcon(status)}
        copyText={() => toolClipboardText(call, result, activity)}
        copyLabel={toolClipboardLabel(call, result, activity)}
      >
        <ToolDetails
          call={call}
          result={result}
          status={status}
          presentation={presentation}
          activity={activity}
        />
      </CollapsibleCard>
    </ToolArgumentPreviewContext>
  );
}

interface CollapsedToolActivity {
  kind: "tool";
  key: string;
  call: ToolCallContent;
  result: ChatMessage | undefined;
  activity?: ActivityTool;
}

export type CollapsedActivity = CollapsedToolActivity;

const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  generating: "generating arguments",
  waiting: "waiting to execute",
  interrupted: "not executed",
  running: "running",
  success: "finished",
  failure: "failed",
  unknown: "no result",
};

function collapsedActivityPresentation(
  activity: CollapsedActivity,
  live: boolean,
) {
  const status = toolStatus(
    activity.result,
    activity.activity,
    live,
    activity.call,
  );
  const resolved = toolPresentationRegistry.resolve({
    call: activity.call,
    result: activity.result,
  });
  const summary =
    resolved?.ruleId === "inspire.pi.codemode"
      ? childCallsSummary(
          activity.result
            ? (activity.result.__inspireCalls ??
                resultChildCalls(activity.result))
            : activity.activity?.calls,
        )
      : resolved
        ? toolPresentationSummaryText(resolved.summary)
        : toolSummary(activity.call).slice(0, 90);
  const name = toolDisplayName(activity.call.name);
  return {
    failed: status === "failure",
    label: `${name}: ${TOOL_STATUS_LABEL[status]}${summary ? ` — ${summary}` : ""}`,
    title: `${name}${summary ? ` — ${summary}` : ""} · ${TOOL_STATUS_LABEL[status]}`,
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
              className={`activity-strip__item ${active ? "activity-strip__item--active" : ""} ${presentation.failed ? "activity-strip__item--failed" : ""}`}
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
            <ToolArgumentPreviewContext value={rendered.call.__inspireToolCall}>
              <section
                key={rendered.key}
                id={panelId}
                className={`card card--tool activity-strip__detail ${toolStatus(rendered.result, rendered.activity, live, rendered.call) === "failure" ? "card--failed" : ""}`}
              >
                <CardHeader
                  expanded
                  icon={toolIcon(rendered.call.name)}
                  label={
                    <code className="card__tool-name">
                      {toolDisplayName(rendered.call.name)}
                    </code>
                  }
                  toggleLabel={`${toolDisplayName(rendered.call.name)} tool details`}
                  onToggle={() => setSelectedIndex(null)}
                  summary={
                    <ToolCardSummary
                      call={rendered.call}
                      result={rendered.result}
                      activity={rendered.activity}
                      presentation={renderedPresentation}
                    />
                  }
                  status={statusIcon(
                    toolStatus(
                      rendered.result,
                      rendered.activity,
                      live,
                      rendered.call,
                    ),
                  )}
                  copyText={() =>
                    toolClipboardText(
                      rendered.call,
                      rendered.result,
                      rendered.activity,
                    )
                  }
                  copyLabel={toolClipboardLabel(
                    rendered.call,
                    rendered.result,
                    rendered.activity,
                  )}
                />
                <div className="card__body">
                  <ToolDetails
                    call={rendered.call}
                    result={rendered.result}
                    status={toolStatus(
                      rendered.result,
                      rendered.activity,
                      live,
                      rendered.call,
                    )}
                    presentation={renderedPresentation}
                    activity={rendered.activity}
                  />
                </div>
              </section>
            </ToolArgumentPreviewContext>
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
    case "powershell":
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
