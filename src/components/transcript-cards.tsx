import {
  Brain,
  ChevronRight,
  FilePen,
  FilePlus2,
  FileSearch,
  FileText,
  Folder,
  List,
  Package,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
} from "react";
import type { VisibilityPreference } from "../../shared/contracts";
import {
  fileResourceReference,
  isLocalResourceReference,
  isResourceReferenceText,
  isToolResourceArgumentKey,
} from "../../shared/resource-references";
import { type ChildCallList } from "../../shared/tool-activity";
import { stripTerminalSequences } from "../ansi";
import type { CopyLoader } from "../content-copy";
import { type DiffLine, parseUnifiedDiff } from "../diff";
import {
  type ActivityTool,
  type ChatMessage,
  type ToolCallContent,
  toolResultText,
} from "../events";
import { formatCount } from "../format";
import { messageCopyLoader } from "../message-copy";
import { usePresentationAdapters } from "../presentation-adapters";
import { store } from "../store";
import type {
  ResolvedToolPresentation,
  ToolPresentation,
  ToolPresentationBlock,
  ToolPresentationSummary,
} from "../tool-presentations/model";
import { toolResultImage } from "../tool-presentations/model";
import { codeModeResultBlocks } from "../tool-presentations/pi-native";
import { ChildCalls, childCallsSummary } from "./ChildCalls";
import { CodeModeResult, codeModeDuration } from "./CodeModeResult";
import { CodeRows, CodeView } from "./CodeView";
import { CopyAction } from "./CopyAction";
import { DetailSummary } from "./DetailSummary";
import { ImageGallery } from "./ImageGallery";
import {
  ImagePreview,
  TranscriptImage,
  TranscriptImageOwnerContext,
} from "./ImagePreview";
import { PiLoader } from "./PiLoader";
import { PiStatus } from "./PiStatus";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";
import { ResourcePathLabel } from "./ResourcePathLabel";
import {
  ActivityReadingBlock,
  useActivityReaderExpanded,
  useActivityReaderScroll,
} from "./transcript-activity-visibility";
import { TranscriptSearchReveal } from "./transcript-search";

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
  getCopyContent?: CopyLoader;
  controlsId: string;
  accessibleLabel?: string;
  describedBy?: string;
}

/** A stretched native disclosure owns the header row. Independent copy and
 * resource controls are siblings above its hit area, never nested buttons. */
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
  getCopyContent,
  controlsId,
  accessibleLabel,
  describedBy,
}: CardHeaderProps) {
  const action = expanded ? "Collapse" : "Expand";
  return (
    <div className="card__header">
      <button
        type="button"
        className="disclosure-row card__disclosure"
        aria-label={accessibleLabel ?? `${action} ${toggleLabel}`}
        aria-expanded={expanded}
        aria-controls={controlsId}
        aria-describedby={describedBy}
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
        {status ? <span className="card__status">{status}</span> : null}
      </button>
      {summary}
      {expanded && (copyText || getCopyContent) ? (
        <CopyAction
          text={copyText}
          getContent={getCopyContent}
          label={copyLabel}
          className="activity-copy card__copy"
        />
      ) : null}
    </div>
  );
}

const CardInspectionContext = createContext<(() => void) | undefined>(
  undefined,
);

interface CardProps
  extends Pick<CardHeaderProps, "accessibleLabel" | "describedBy"> {
  defaultVisibility: StaticVisibility;
  className: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  toggleLabel: string;
  summary?: React.ReactNode;
  summaryVisibleWhenOpen?: boolean;
  status?: React.ReactNode;
  copyText?: string;
  copyLabel?: string;
  getCopyContent?: CopyLoader;
  id?: string;
  revealOnSearch?: boolean;
  children: React.ReactNode;
}

export function CollapsibleCard({
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
  getCopyContent,
  accessibleLabel,
  describedBy,
  id,
  revealOnSearch = false,
  children,
}: CardProps) {
  // Per-card override is view-local only; it never mutates saved preferences.
  const [override, setOverride] = useActivityReaderExpanded("card", null);
  const generatedId = useId();
  const search = useContext(TranscriptSearchReveal);
  useLayoutEffect(() => {
    if (revealOnSearch && search !== null) setOverride(true);
  }, [revealOnSearch, search, setOverride]);
  if (defaultVisibility === "hidden") return null;
  const open = override ?? defaultVisibility === "expanded";
  const bodyId = id ?? generatedId;
  return (
    <section className={`card ${className}`}>
      <CardHeader
        expanded={open}
        icon={icon}
        label={label}
        toggleLabel={toggleLabel}
        accessibleLabel={accessibleLabel}
        describedBy={describedBy}
        onToggle={() => setOverride(!open)}
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
        getCopyContent={getCopyContent}
        controlsId={bodyId}
      />
      {open && (
        <div id={bodyId} className="card__body">
          <CardInspectionContext value={() => setOverride(true)}>
            {children}
          </CardInspectionContext>
        </div>
      )}
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
  const { thinking } = usePresentationAdapters();
  const clean = stripTerminalSequences(text);
  const firstLine = clean.split("\n").find((line) => line.trim()) ?? "";
  const presentation = useMemo(
    () => thinking.resolve(clean),
    [clean, thinking],
  );
  const hasContent = Boolean(clean.trim()) || presentation !== null;
  const resolvedVisibility: StaticVisibility =
    !hasContent && visibility !== "hidden"
      ? "collapsed"
      : visibility === "dynamic"
        ? dynamicActive
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

const unavailableToolImage = {
  type: "notice",
  tone: "warning",
  text: "Image unavailable (unsupported or invalid image data)",
} as const;

const pendingToolText: Record<ToolStatus, string> = {
  generating: "Generating arguments…",
  waiting: "Waiting to execute…",
  interrupted: "Not executed",
  running: "Running…",
  success: "Finalizing result…",
  failure: "Finalizing result…",
  unknown: "No result recorded",
};

type ContentBlock =
  | Exclude<ToolPresentationBlock, { type: "diff" }>
  | (Extract<ToolPresentationBlock, { type: "diff" }> & { lines: DiffLine[] });

// Partial paths are readable text, not usable resource identities yet.
const ToolArgumentPreviewContext =
  createContext<ToolCallContent["__inspireToolCall"]>(undefined);

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
  className?: string;
  accessibleLabel: string;
  children?: React.ReactNode;
}) {
  const preview = useContext(ToolArgumentPreviewContext);
  const style = className ? `tool-resource ${className}` : "tool-resource";
  if (preview || !isResourceReferenceText(reference))
    return <span className={style}>{children ?? reference}</span>;
  return (
    <button
      type="button"
      className={style}
      data-file-path={fileResourceReference(reference)}
      aria-label={accessibleLabel}
      title={`Preview ${reference}\nCtrl+click: Show in file manager`}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        if (event.ctrlKey || event.metaKey)
          void store.showInFileManager(fileResourceReference(reference));
        else void store.openResource(fileResourceReference(reference));
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
      className="card__summary card__summary--tool"
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
          className="tool-summary__part"
          data-resource={part.kind === "resource" || undefined}
          data-subdued={(part.kind !== "resource" && part.subdued) || undefined}
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
              accessibleLabel={part.reference}
            >
              <ResourcePathLabel path={part.text} />
            </FileRefButton>
          ) : (
            <span>{part.text}</span>
          )}
        </span>
      ))}
    </span>
  );
}

function toolStatus(
  result: ChatMessage | undefined,
  activity: ActivityTool | undefined,
  liveFallback: boolean,
  call?: ToolCallContent,
): ToolStatus {
  if (result) return result.isError ? "failure" : "success";
  if (activity?.phase === "error") return "failure";
  if (activity?.phase === "done") return "success";
  if (activity?.phase === "running") return "running";
  if (activity?.phase === "queued") return "waiting";
  if (call?.__inspireToolCall?.phase === "interrupted") return "interrupted";
  if (call?.__inspireToolCall?.phase === "streaming")
    return liveFallback ? "generating" : "interrupted";
  return liveFallback ? "waiting" : "unknown";
}

function statusIcon(status: ToolStatus) {
  switch (status) {
    case "generating":
      return <PiLoader size={14} aria-label="generating arguments" />;
    case "waiting":
      return <PiLoader size={14} aria-label="waiting to execute" />;
    case "interrupted":
      return <PiStatus status="neutral" size={14} aria-label="not executed" />;
    case "running":
      return <PiLoader size={14} aria-label="running" />;
    case "success":
      return <PiStatus status="success" aria-label="finished" />;
    case "failure":
      return <PiStatus status="error" aria-label="failed" />;
    default:
      return <PiStatus status="neutral" size={14} aria-label="no result" />;
  }
}

/** A tool result recognized as a unified diff renders as colored lines; the
 * diff is the whole point of an edit result, so it is never truncated. */
function DiffView({ lines }: { lines: DiffLine[] }) {
  const preview = useContext(ToolArgumentPreviewContext);
  const scroll = useActivityReaderScroll<HTMLPreElement>(
    "diff-scroll",
    lines,
    preview?.phase === "streaming",
  );
  return (
    <CodeView
      className="activity-reader diff"
      {...scroll.props}
      tabIndex={0}
      role="group"
      aria-label="Changes"
    >
      <CodeRows rows={lines} />
    </CodeView>
  );
}

function hasResultData(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Mount reader bodies only after disclosure. */
function ToolDisclosure({
  reader,
  label,
  children,
  inline = false,
}: {
  reader: string;
  label: string;
  children: React.ReactNode;
  inline?: boolean;
}) {
  const [open, setOpen] = useActivityReaderExpanded(reader);
  if (inline) return children;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <DetailSummary>{label}</DetailSummary>
      {open ? children : null}
    </details>
  );
}

function rawResultData(result: ChatMessage) {
  const { content } = result;
  const unrendered = Array.isArray(content)
    ? content.filter(
        (part) =>
          part != null &&
          part.type !== "image" &&
          typeof part.text !== "string",
      )
    : typeof content === "string"
      ? undefined
      : content;
  return {
    ...(hasResultData(result.details) ? { details: result.details } : {}),
    ...(hasResultData(result.nestedCalls)
      ? { nestedCalls: result.nestedCalls }
      : {}),
    ...(hasResultData(unrendered) ? { content: unrendered } : {}),
  };
}

function JsonReader({ label, value }: { label: string; value: unknown }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? "", [value]);
  return <ToolTextReader label={label} text={text} />;
}

function RawToolResult({ result }: { result: ChatMessage }) {
  const output = toolResultText(result);
  const diff = !result.isError ? parseUnifiedDiff(output) : null;
  const images: ContentBlock[] = [];
  if (Array.isArray(result.content))
    for (const [index, part] of result.content.entries()) {
      if (part?.type === "image") {
        images.push(
          toolResultImage(
            result,
            index,
            `Tool result image ${images.length + 1}`,
          ) ?? unavailableToolImage,
        );
      }
    }
  const data = rawResultData(result);
  const hasData = Object.keys(data).length > 0;
  return (
    <>
      {diff ? (
        <DiffView lines={diff} />
      ) : output ? (
        <ToolTextReader
          text={output}
          label="Result text"
          error={result.isError}
          resultPreview
        />
      ) : null}
      <PresentationBlocks blocks={images} />
      {hasData && (
        <ToolDisclosure reader="result-data" label="Result details">
          <JsonReader label="Result data" value={data} />
        </ToolDisclosure>
      )}
      {!output && !images.length && !hasData && (
        <div className="tool-empty">No output</div>
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

function useToolLinePreview<T>(reader: string, lines: T[]) {
  const [showAll, setShowAll] = useActivityReaderExpanded(reader);
  const partial = useContext(ToolArgumentPreviewContext);
  if (lines.length <= STRUCTURED_CODE_PREVIEW_LINES) return { lines };
  return {
    lines:
      showAll && !partial
        ? lines
        : lines.slice(0, STRUCTURED_CODE_PREVIEW_LINES),
    disclosure: partial ? (
      <div className="card__pending">
        Showing first {STRUCTURED_CODE_PREVIEW_LINES} lines
      </div>
    ) : (
      <button
        type="button"
        className="card__show-all"
        onClick={() => setShowAll(!showAll)}
      >
        {showAll
          ? "Show fewer lines"
          : `Show all ${lines.length.toLocaleString()} lines`}
      </button>
    ),
  };
}

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
  const partial = useContext(ToolArgumentPreviewContext);
  const scroll = useActivityReaderScroll<HTMLPreElement>(
    "code-scroll",
    text,
    partial?.phase === "streaming",
  );
  const { lines: visible, disclosure } = useToolLinePreview(
    "code-all",
    text.split("\n"),
  );
  return (
    <>
      <CodeView
        {...scroll.props}
        className="activity-reader tool-code"
        tabIndex={0}
        role="group"
        aria-label="Code"
        data-language={language}
      >
        {lineNumbers ? (
          <CodeRows
            rows={visible.map((line, index) => ({
              text: line,
              newLine: startLine + index,
            }))}
            gutter="numbered"
          />
        ) : (
          <code className={language ? `language-${language}` : undefined}>
            {visible.join("\n")}
          </code>
        )}
      </CodeView>
      {disclosure}
    </>
  );
}

function ReplacementDiff({
  block,
}: {
  block: Extract<ToolPresentationBlock, { type: "replacement" }>;
}) {
  const { lines, disclosure } = useToolLinePreview<DiffLine>(
    "replacement-all",
    [
      ...(block.oldText === undefined ? [] : block.oldText.split("\n")).map(
        (text) => ({ kind: "delete" as const, text: `-${text}` }),
      ),
      ...(block.newText === undefined ? [] : block.newText.split("\n")).map(
        (text) => ({ kind: "add" as const, text: `+${text}` }),
      ),
    ],
  );
  return (
    <>
      <DiffView lines={lines} />
      {disclosure}
    </>
  );
}

function ToolImage({
  block,
}: {
  block: Extract<ToolPresentationBlock, { type: "image" }>;
}) {
  const owner = useContext(TranscriptImageOwnerContext);
  return (
    <figure className="tool-image-block">
      <ToolBlockHeading label={block.label} />
      {block.reference ? (
        owner ? (
          <TranscriptImage
            {...owner}
            reference={block.reference}
            alt={block.alt}
            className="tool-image-block__image"
          />
        ) : (
          renderToolBlock(unavailableToolImage)
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
  readingKey = block.type,
}: {
  block: ContentBlock;
  readingKey?: string;
}) {
  const body = renderToolBlock(block);
  return (
    <ActivityReadingBlock name={readingKey}>
      {block.type === "image" ||
      block.type === "notice" ||
      block.type === "properties" ? (
        body
      ) : (
        <div className="tool-block">
          <ToolBlockHeading
            label={block.type === "codemode-result" ? "Output" : block.label}
            path={"path" in block ? block.path : undefined}
          />
          {body}
        </div>
      )}
    </ActivityReadingBlock>
  );
}

function renderToolBlock(block: ContentBlock) {
  switch (block.type) {
    case "codemode-result":
      return (
        <CodeModeResult
          result={block.result}
          renderImage={(image) =>
            renderToolBlock(image ?? unavailableToolImage)
          }
        />
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
        <StructuredCode
          text={block.text}
          startLine={block.startLine}
          lineNumbers={block.lineNumbers}
          language={block.language}
        />
      );
    }
    case "diff":
      return <DiffView lines={block.lines} />;
    case "terminal":
      return (
        <ToolTextReader
          text={stripTerminalSequences(block.text)}
          label={block.label}
          error={block.error}
        />
      );
    case "list":
      return block.items.length > 0 ? (
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
      );
    case "search":
      return block.groups.length > 0 ? (
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
              <CodeView
                className="tool-search-group__lines"
                tabIndex={0}
                role="group"
                aria-label={`${group.path} matches`}
              >
                <CodeRows
                  rows={group.matches.map((match) => ({
                    text: match.text || " ",
                    newLine: match.line,
                    kind: match.match ? "match" : "context",
                  }))}
                  gutter="numbered"
                />
              </CodeView>
            </section>
          ))}
        </div>
      ) : (
        <div className="tool-empty">{block.emptyText ?? "No matches"}</div>
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
        <div
          className="activity-reader tool-markdown"
          data-error={block.error || undefined}
          role="group"
          aria-label={block.label ?? "Formatted output"}
          tabIndex={0}
        >
          <RichText text={block.text} variant="extension" />
        </div>
      );
    case "text":
      return (
        <ToolTextReader
          text={block.text}
          label={block.label ?? "Output text"}
          error={block.error}
        />
      );
  }
}

function presentationBlocks(
  presentation: ToolPresentation,
): ContentBlock[] | null {
  try {
    const source = presentation.blocks();
    if (!source) return null;
    const result: ContentBlock[] = [];
    for (const block of source) {
      if (block.type !== "diff") result.push(block);
      else {
        const lines = parseUnifiedDiff(block.text);
        if (!lines) return null;
        result.push({ ...block, lines });
      }
    }
    return result;
  } catch {
    return null;
  }
}

function PresentationBlocks({ blocks }: { blocks: ContentBlock[] }) {
  return blocks.map((block, index) => {
    const key = `${block.type}:${index}`;
    return (
      <ToolPresentationBlockView key={key} readingKey={key} block={block} />
    );
  });
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
    <div className="tool-presentation" data-thinking-presentation="configured">
      <PresentationBlocks blocks={blocks} />
    </div>
  );
}

function ToolTextReader({
  text,
  label = "Output",
  error = false,
  live = false,
  resultPreview = false,
}: {
  text: string;
  label?: string;
  error?: boolean;
  live?: boolean;
  resultPreview?: boolean;
}) {
  const preview = useContext(ToolArgumentPreviewContext);
  const [expanded, setExpanded] = useActivityReaderExpanded(`${label}-all`);
  const scroll = useActivityReaderScroll<HTMLPreElement>(
    `${label}-scroll`,
    text,
    live || preview?.phase === "streaming",
  );
  const truncated = resultPreview && text.length > 600;
  return (
    <>
      <CodeView
        {...scroll.props}
        className={
          live ? "activity-reader tool-terminal--live" : "activity-reader"
        }
        tabIndex={0}
        role="group"
        aria-label={label}
        data-error={error || undefined}
        text={!expanded && truncated ? `${text.slice(0, 600)}…` : text}
      />
      {truncated && (
        <button
          type="button"
          className="card__show-all"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </>
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
      <ToolTextReader
        text={stripTerminalSequences(preview.text)}
        label="Live output"
        live
      />
    </div>
  );
}

function PhaseToolDetails({
  calls,
  running,
  settled,
  children,
  script,
  codemode,
}: {
  calls?: ChildCallList;
  running: boolean;
  settled: boolean;
  children: React.ReactNode;
  script?: React.ReactNode;
  codemode: boolean;
}) {
  const [readingCalls, setReadingCalls] =
    useActivityReaderExpanded("reading-calls");
  const inspect = useContext(CardInspectionContext);
  const resultBody = (
    <div key="result" className="tool-call-result">
      {children}
    </div>
  );
  const callsBody =
    calls && (calls.calls.length > 0 || !calls.complete) ? (
      <div key="calls">
        {!codemode && (
          <div className="card__section-label">
            {childCallsSummary(calls) || "Calls"}
          </div>
        )}
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
      {script}
    </div>
  );
}

function ArgumentReader({ call }: { call: ToolCallContent }) {
  const items = toolFileArguments(call).map(({ key, value }) => ({
    label: key,
    value,
    resourceRef: value,
  }));
  return (
    <>
      {items.length > 0 && renderToolBlock({ type: "properties", items })}
      <JsonReader label="Arguments" value={call.arguments ?? {}} />
    </>
  );
}

function ToolScript({ call }: { call: ToolCallContent }) {
  const args = call.arguments as { code: string };
  return (
    <ToolDisclosure
      reader="script"
      label={call.__inspireToolCall ? "Script (partial)" : "Script"}
    >
      <StructuredCode text={args.code} language="javascript" />
    </ToolDisclosure>
  );
}

function ToolDetails({
  call,
  result,
  status,
  presentation,
  activity,
  codemode,
}: {
  call?: ToolCallContent;
  result: ChatMessage | undefined;
  status: ToolStatus;
  presentation: ResolvedToolPresentation | null;
  activity?: ActivityTool;
  codemode: boolean;
}) {
  const preview =
    !result && status === "running" ? activity?.outputPreview : undefined;
  const calls = result ? result.__inspireCalls : activity?.calls;
  const blocks = presentation
    ? presentationBlocks(presentation)
    : codemode && !call && result
      ? codeModeResultBlocks(result)
      : null;
  const phaseDetails = codemode || calls;
  const inlineArgs = !result && !phaseDetails;
  const pending = !result && !calls?.calls.length && (
    <div className="card__pending">{pendingToolText[status]}</div>
  );
  const body = (
    <>
      {blocks ? (
        <div
          className="tool-presentation"
          data-tool-rule={presentation?.ruleId}
        >
          <PresentationBlocks blocks={blocks} />
          {pending}
        </div>
      ) : result ? (
        <RawToolResult result={result} />
      ) : (
        pending
      )}
      {preview ? <LiveToolOutput preview={preview} /> : null}
      {call &&
        !blocks &&
        (!inlineArgs ||
          !call.__inspireToolCall ||
          Object.keys(call.arguments ?? {}).length > 0) && (
          <ToolDisclosure
            reader="arguments"
            label={call.__inspireToolCall ? "Arguments (partial)" : "Arguments"}
            inline={inlineArgs}
          >
            <ArgumentReader call={call} />
          </ToolDisclosure>
        )}
    </>
  );
  return (
    <ImageGallery>
      {call?.__inspireToolCall?.truncated ? (
        <div className="card__pending">Argument preview truncated</div>
      ) : null}
      {phaseDetails ? (
        <PhaseToolDetails
          calls={calls}
          running={status === "running"}
          settled={Boolean(result)}
          script={codemode && call ? <ToolScript call={call} /> : undefined}
          codemode={codemode}
        >
          {body}
        </PhaseToolDetails>
      ) : (
        body
      )}
    </ImageGallery>
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
    const { details, ...rest } = rawResultData(result);
    if (details !== undefined)
      sections.push("Result details", JSON.stringify(details, null, 2));
    if (Object.keys(rest).length)
      sections.push("Additional result data", JSON.stringify(rest, null, 2));
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
  if (!duration && !summary) return null;
  return (
    <span className="card__summary" title={summary || undefined}>
      {[duration, summary].filter(Boolean).join(" · ")}
    </span>
  );
}

export function ToolCard({
  call,
  result,
  activity,
  live = false,
  visibility,
  dynamic,
  dynamicActive,
}: {
  activity?: ActivityTool;
  live?: boolean;
  visibility: StaticVisibility;
  dynamic?: boolean;
  dynamicActive?: boolean;
} & (
  | { call: ToolCallContent; result?: ChatMessage }
  | { call?: undefined; result: ChatMessage }
)) {
  const { tools } = usePresentationAdapters();
  const owner = useContext(TranscriptImageOwnerContext);
  const status = toolStatus(result, activity, live, call);
  const presentation = useMemo(
    () => (call ? tools.resolve({ call, result }) : null),
    [call, result, tools],
  );
  // Imports can retain a result without the call. Only a retained call
  // supplies arguments, a presentation rule, or a Script disclosure.
  const name =
    call?.name ??
    (typeof result?.toolName === "string" ? result.toolName : "Tool");
  const title = toolDisplayName(name);
  const codemode = call
    ? presentation?.ruleId === "inspire.pi.codemode"
    : name === "codemode";
  return (
    <ToolArgumentPreviewContext value={call?.__inspireToolCall}>
      <CollapsibleCard
        defaultVisibility={
          dynamic
            ? dynamicActive && status !== "success" && status !== "failure"
              ? "expanded"
              : "collapsed"
            : visibility
        }
        className="card--tool"
        icon={toolIcon(name)}
        label={
          <code className="card__tool-name">
            {call ? title : `${title} result`}
          </code>
        }
        toggleLabel={`${title} ${call ? "tool" : "result details"}`}
        summary={
          codemode ? (
            <CodeModeSummary
              result={result}
              calls={result ? result.__inspireCalls : activity?.calls}
            />
          ) : presentation ? (
            <PresentedSummary summary={presentation.summary} />
          ) : call ? (
            <ToolSummary call={call} />
          ) : undefined
        }
        summaryVisibleWhenOpen={codemode}
        status={statusIcon(status)}
        getCopyContent={messageCopyLoader(
          result,
          () =>
            call
              ? toolClipboardText(call, result, activity)
              : JSON.stringify(result, null, 2),
          owner,
        )}
        copyLabel={
          call ? toolClipboardLabel(call, result, activity) : `${name} result`
        }
      >
        <ToolDetails
          call={call}
          result={result}
          status={status}
          presentation={presentation}
          activity={activity}
          codemode={codemode}
        />
      </CollapsibleCard>
    </ToolArgumentPreviewContext>
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
          <code className="card__summary">{type}</code>
        ) : undefined
      }
      copyText={JSON.stringify(item, null, 2)}
      copyLabel={`${title} block`}
    >
      <JsonReader label="Content details" value={item} />
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
