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
  ActivityCode,
  ActivityDetails,
  ActivityHeader,
  ActivityReader,
  ActivityReadingBlock,
  ActivityText,
  useActivityReaderExpanded,
} from "./transcript-activity-visibility";
import { TranscriptSearchReveal } from "./transcript-search";

type StaticVisibility = Exclude<VisibilityPreference, "dynamic">;

const CardInspectionContext = createContext<(() => void) | undefined>(
  undefined,
);

interface CardProps {
  accessibleLabel?: string;
  describedBy?: string;
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
  copyLabel = `${toggleLabel} block`,
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
  const disclosureLabel = `${open ? "Collapse" : "Expand"} ${toggleLabel}`;
  return (
    <section className={`card ${className}`}>
      <ActivityHeader
        className="card__header"
        copy={
          open
            ? {
                text: copyText,
                getContent: getCopyContent,
                label: copyLabel,
                className: "card__copy",
              }
            : undefined
        }
      >
        <button
          type="button"
          className="disclosure-row card__disclosure"
          aria-label={accessibleLabel ?? disclosureLabel}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-describedby={describedBy}
          title={disclosureLabel}
          onClick={() => setOverride(!open)}
        >
          <span className="card__chevron">
            <ChevronRight
              size={14}
              className={open ? "chev chev--open" : "chev"}
              aria-hidden
            />
          </span>
          <span className="card__icon">{icon}</span>
          <span className="card__label">{label}</span>
          {status && <span className="card__status">{status}</span>}
        </button>
        {(!open || summaryVisibleWhenOpen) && summary}
      </ActivityHeader>
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
  | (Extract<ToolPresentationBlock, { type: "diff" }> & { lines: DiffLine[] })
  | { type: "result"; text: string; error?: boolean }
  | { type: "live"; label: string; text: string; truncated: boolean }
  | { type: "inspection"; data: object }
  | { type: "empty" };

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

function fallbackSummary(call: ToolCallContent): ToolPresentationSummary {
  const reference = toolFileArguments(call)[0]?.value;
  if (reference)
    return { parts: [{ kind: "resource", text: reference, reference }] };
  const text = toolSummary(call);
  return { parts: text ? [{ kind: "text", text: text.slice(0, 90) }] : [] };
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
  return (
    <ActivityCode
      className="diff"
      reader="diff-scroll"
      label="Changes"
      following={preview?.phase === "streaming"}
    >
      <CodeRows rows={lines} />
    </ActivityCode>
  );
}

function hasResultData(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
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
  return <ToolActivityText label={label} text={text} />;
}

function rawResultBlocks(result: ChatMessage): ContentBlock[] {
  const output = toolResultText(result);
  const diff = !result.isError ? parseUnifiedDiff(output) : null;
  const blocks: ContentBlock[] = [];
  if (diff) blocks.push({ type: "diff", text: output, lines: diff });
  else if (output)
    blocks.push({
      type: "result",
      text: output,
      error: result.isError,
    });
  let imageNumber = 0;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const [index, part] of content.entries())
    if (part?.type === "image")
      blocks.push(
        toolResultImage(result, index, `Tool result image ${++imageNumber}`) ??
          unavailableToolImage,
      );
  const data = rawResultData(result);
  if (Object.keys(data).length) blocks.push({ type: "inspection", data });
  return blocks.length ? blocks : [{ type: "empty" }];
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
  const { lines: visible, disclosure } = useToolLinePreview(
    "code-all",
    text.split("\n"),
  );
  return (
    <>
      <ActivityCode
        className="tool-code"
        reader="code-scroll"
        label="Code"
        following={partial?.phase === "streaming"}
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
      </ActivityCode>
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

function renderToolBlock(block: ContentBlock) {
  switch (block.type) {
    case "codemode-result":
      return (
        <CodeModeResult result={block.result} renderImage={renderToolImage} />
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
          {block.action && (
            <FileRefButton
              reference={block.action.reference}
              accessibleLabel={block.action.label}
              className="tool-notice__action"
            >
              {block.action.label}
            </FileRefButton>
          )}
        </div>
      );
    case "markdown":
      return (
        <ActivityReader
          className="tool-markdown"
          reader="markdown"
          data-error={block.error || undefined}
          label={block.label ?? "Formatted output"}
        >
          <RichText text={block.text} variant="extension" />
        </ActivityReader>
      );
    case "empty":
      return <div className="tool-empty">No output</div>;
    case "inspection":
      return (
        <ActivityDetails reader="result-data" label="Result details">
          {() => <JsonReader label="Result data" value={block.data} />}
        </ActivityDetails>
      );
    case "live":
      return (
        <>
          {block.truncated && (
            <div className="card__pending">
              Showing latest output · preview truncated
            </div>
          )}
          <ToolActivityText
            text={stripTerminalSequences(block.text)}
            label="Live output"
            live
          />
        </>
      );
    case "result":
    case "text":
    case "terminal":
      return (
        <ToolActivityText
          text={
            block.type === "terminal"
              ? stripTerminalSequences(block.text)
              : block.text
          }
          label={
            block.type === "result"
              ? "Result text"
              : (block.label ??
                (block.type === "text" ? "Output text" : "Output"))
          }
          error={block.error}
          preview={block.type === "result" ? 600 : undefined}
        />
      );
  }
}

function renderToolImage(
  block: Extract<ToolPresentationBlock, { type: "image" }> | null,
) {
  return renderToolBlock(block ?? unavailableToolImage);
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
  const counts = new Map<string, number>();
  return blocks.map((block) => {
    const label =
      block.type === "codemode-result"
        ? "Output"
        : "label" in block &&
            block.type !== "image" &&
            block.type !== "properties"
          ? block.label
          : undefined;
    const path = "path" in block ? block.path : undefined;
    const count = counts.get(block.type) ?? 0;
    counts.set(block.type, count + 1);
    const key = `${block.type}:${count}`;
    return (
      <ActivityReadingBlock key={key} name={key}>
        {label || path ? (
          <div className="tool-block">
            <ToolBlockHeading label={label} path={path} />
            {renderToolBlock(block)}
          </div>
        ) : (
          renderToolBlock(block)
        )}
      </ActivityReadingBlock>
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

function ToolActivityText(props: React.ComponentProps<typeof ActivityText>) {
  const preview = useContext(ToolArgumentPreviewContext);
  return <ActivityText {...props} following={preview?.phase === "streaming"} />;
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
    <ActivityDetails
      reader="script"
      label={call.__inspireToolCall ? "Script (partial)" : "Script"}
    >
      {() => <StructuredCode text={args.code} language="javascript" />}
    </ActivityDetails>
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
  const formatted = presentation
    ? presentationBlocks(presentation)
    : codemode && !call && result
      ? codeModeResultBlocks(result)
      : null;
  const blocks = formatted ?? (result ? rawResultBlocks(result) : []);
  if (preview)
    blocks.push({ type: "live", label: "Output (live preview)", ...preview });
  const hasCalls = calls && (calls.calls.length > 0 || !calls.complete);
  const inspect = useContext(CardInspectionContext);
  const inlineArgs = !result && !codemode && !calls;
  const pending = !result && !calls?.calls.length && (
    <div className="card__pending">{pendingToolText[status]}</div>
  );
  const body = (
    <>
      {(blocks.length > 0 || pending) && (
        <div
          className="tool-presentation"
          data-tool-rule={formatted ? presentation?.ruleId : undefined}
        >
          {pending}
          <PresentationBlocks blocks={blocks} />
        </div>
      )}
      {call &&
        !formatted &&
        (!inlineArgs ||
          !call.__inspireToolCall ||
          Object.keys(call.arguments ?? {}).length > 0) && (
          <ActivityDetails
            reader="arguments"
            label={call.__inspireToolCall ? "Arguments (partial)" : "Arguments"}
            inline={inlineArgs}
          >
            {() => <ArgumentReader call={call} />}
          </ActivityDetails>
        )}
    </>
  );
  return (
    <ImageGallery>
      {call?.__inspireToolCall?.truncated ? (
        <div className="card__pending">Argument preview truncated</div>
      ) : null}
      <div
        className="tool-call-layout"
        onFocusCapture={inspect}
        onClickCapture={inspect}
        onPointerDownCapture={inspect}
      >
        {hasCalls && (
          <div>
            {!codemode && (
              <div className="card__section-label">
                {childCallsSummary(calls) || "Calls"}
              </div>
            )}
            <ChildCalls
              list={calls}
              running={status === "running"}
              unbounded={codemode}
            />
          </div>
        )}
        {body}
        {codemode && call && <ToolScript call={call} />}
      </div>
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
          ) : call ? (
            <PresentedSummary
              summary={presentation?.summary ?? fallbackSummary(call)}
            />
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
