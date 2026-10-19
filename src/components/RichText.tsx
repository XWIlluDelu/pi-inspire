import "katex/dist/katex.min.css";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Check, Copy, SquareTerminal } from "lucide-react";
import {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  memo,
  type ReactNode,
  startTransition,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import type { Components } from "react-markdown";
import {
  diagnosticResourceReference,
  isLocalResourceReference,
} from "../../shared/resource-references";
import { isDocumentFileReference } from "../document-resources";
import { parseRichText } from "../rich-text-parser";
import {
  type RichTextSnapshot,
  richTextParser,
} from "../rich-text-parser-client";
import { store } from "../store";
import { highlightSource } from "../syntax-highlighting";
import { queueTerminalInsertion } from "../terminal-actions";
import { useCopied } from "../use-copied";
import { DocumentImage, DocumentResourceContext } from "./DocumentPreview";
import { ImageLinkContext } from "./ImagePreview";
import { RichTextMath } from "./RichTextMath";

export type RichTextVariant = "assistant" | "user" | "thinking" | "extension";
const ASYNC_MARKDOWN_MIN_CHARS = 32_000;

const CodeBlock = memo(function CodeBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const { copied, copy } = useCopied({
    scope: code,
    onError: store.reportCopyError,
  });
  const highlighted = useMemo(
    () => highlightSource(code, language),
    [code, language],
  );
  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span className="code-block__lang">{language}</span>
        <div className="code-block__actions">
          <button
            type="button"
            className="code-block__terminal"
            onClick={() => {
              queueTerminalInsertion(code, store.getState().cwd);
              store.setContextMode("terminal");
              store.setResourcesOpen(true);
            }}
            aria-label="Insert code in terminal"
            title="Insert in terminal for review"
          >
            <SquareTerminal size={13} aria-hidden />
          </button>
          <button
            type="button"
            className="code-block__copy"
            onClick={() => void copy(code)}
            aria-label={copied ? "Copied" : "Copy code"}
            title={copied ? "Copied" : "Copy code"}
          >
            {copied ? (
              <Check size={13} aria-hidden />
            ) : (
              <Copy size={13} aria-hidden />
            )}
          </button>
        </div>
      </div>
      <pre className="code-block__pre" tabIndex={0}>
        {/* highlight.js escapes its input; generated markup contains only span tags. */}
        <code
          className={language ? `hljs language-${language}` : "hljs"}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
});

function TaskCheckbox({ checked }: { checked?: boolean }) {
  return (
    <input
      type="checkbox"
      className="choice-input"
      checked={checked}
      disabled
    />
  );
}

// These renderers consume only sanitized HAST. Local references stay delegated
// to the owning session/document; external images never load automatically.
const components: Components = {
  input: TaskCheckbox,
  li: ({ node, children, ...props }) => {
    if (!node || !props.className?.split(/\s+/).includes("task-list-item"))
      return <li {...props}>{children}</li>;
    const content = Children.toArray(children);
    const firstIndex = content.findIndex(isValidElement);
    const first = content[firstIndex];
    const firstNode = node.children.find((child) => child.type === "element");
    // Loose tasks keep their paragraph; inline readers may render it as a fragment.
    const paragraph =
      firstNode?.type === "element" &&
      firstNode.tagName === "p" &&
      isValidElement<{ children?: ReactNode }>(first)
        ? first
        : null;
    const line = paragraph
      ? Children.toArray(paragraph.props.children)
      : content;
    const markerIndex = line.findIndex(
      (child) => isValidElement(child) && child.type === TaskCheckbox,
    );
    if (markerIndex < 0) return <li {...props}>{children}</li>;
    const marker = line[markerIndex];
    line[markerIndex] = (
      <span className="rich-text__task-marker" key="task-marker">
        {marker}
      </span>
    );
    // GFM inserts one separator after the checkbox. The column gap replaces it;
    // preserve all other text whitespace and the existing child elements.
    const separator = line[markerIndex + 1];
    if (typeof separator === "string")
      line[markerIndex + 1] = separator.replace(/^ /, "");
    if (paragraph) content[firstIndex] = cloneElement(paragraph, {}, line);
    return (
      <li {...props}>
        <div className="rich-text__task-content">{content}</div>
      </li>
    );
  },
  pre: ({ node, children }) => {
    const code = node?.children[0];
    if (code?.type !== "element" || code.tagName !== "code")
      return <pre>{children}</pre>;
    const classes = code.properties.className;
    const classNames = Array.isArray(classes) ? classes.map(String) : [];
    const value = code.children
      .map((child) => (child.type === "text" ? child.value : ""))
      .join("");
    if (
      classNames.includes("language-math") ||
      classNames.includes("math-display")
    )
      return <RichTextMath value={value} display />;
    const language =
      classNames.find((name) => name.startsWith("language-"))?.slice(9) ?? "";
    // mdast-to-hast adds one terminator; source blank lines before it remain.
    return <CodeBlock language={language} code={value.replace(/\n$/, "")} />;
  },
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const classes = className?.split(/\s+/) ?? [];
    if (
      classes.some((name) =>
        ["language-math", "math-inline", "math-display"].includes(name),
      )
    )
      return (
        <RichTextMath value={text} display={classes.includes("math-display")} />
      );
    if (isLocalResourceReference(text))
      return (
        <button
          type="button"
          className="file-ref file-ref--code"
          data-file-path={diagnosticResourceReference(text)}
        >
          <code className="inline-code">{text}</code>
        </button>
      );
    return <code className="inline-code">{text}</code>;
  },
  a: function ResourceLink({
    href,
    children,
  }: {
    href?: string;
    children?: ReactNode;
  }) {
    const document = useContext(DocumentResourceContext);
    const content = (
      <ImageLinkContext.Provider value={true}>
        {children}
      </ImageLinkContext.Provider>
    );
    if (document && href?.startsWith("#")) return <a href={href}>{content}</a>;
    if (
      href &&
      !/^[\\/]{2}/.test(href) &&
      (document
        ? isDocumentFileReference(href)
        : isLocalResourceReference(href))
    )
      return (
        <a href={href} className="file-ref" data-file-path={href}>
          {content}
        </a>
      );
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {content}
      </a>
    );
  },
  img: function ResourceImage({
    src,
    alt,
    title,
  }: {
    src?: string;
    alt?: string;
    title?: string;
  }) {
    const document = useContext(DocumentResourceContext);
    if (
      src &&
      ((document && isDocumentFileReference(src)) ||
        src.startsWith("attachment:"))
    )
      return (
        <DocumentImage
          key={`${document?.descriptor.id ?? ""}:${src}`}
          src={src}
          alt={alt ?? ""}
          title={title}
        />
      );
    if (src && !/^[\\/]{2}/.test(src) && isLocalResourceReference(src))
      return (
        <button
          type="button"
          className="file-ref file-ref--image"
          data-file-path={src}
          aria-label={`Preview ${alt || src}`}
        >
          <span aria-hidden>▧</span>
          <span>{alt || src}</span>
        </button>
      );
    if (src && /^(?:https?:|\/\/)/i.test(src))
      return (
        <a href={src} target="_blank" rel="noreferrer noopener" title={src}>
          <span aria-hidden>▧ </span>
          {alt || src}
        </a>
      );
    return <span title="Image unavailable">{alt || "Image unavailable"}</span>;
  },
};
const inlineComponents: Components = {
  ...components,
  p: ({ children }: { children?: ReactNode }) => <>{children}</>,
};

/** Keep whole-document semantics without running large parses on the input
 * thread. While parsing, retain a compatible rich prefix and show the exact
 * new tail as safe text. Only the latest source remains queued per reader. */
export const RichText = memo(function RichText({
  text,
  variant = "assistant",
  inline = false,
}: {
  text: string;
  variant?: RichTextVariant;
  inline?: boolean;
}) {
  const document = useContext(DocumentResourceContext);
  const headings = Boolean(document);
  const asynchronous =
    text.length >= ASYNC_MARKDOWN_MIN_CHARS && typeof Worker !== "undefined";
  const owner = useRef({}).current;
  const [parsed, setParsed] = useState<RichTextSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const synchronous = useMemo(
    () =>
      asynchronous
        ? null
        : {
            text,
            headings,
            tree: parseRichText(text, headings),
          },
    [asynchronous, text, headings],
  );
  const lastSynchronous = useRef<RichTextSnapshot | null>(null);
  if (synchronous) lastSynchronous.current = synchronous;

  useEffect(() => {
    if (!asynchronous) return;
    return () => richTextParser.release(owner);
  }, [asynchronous, owner]);
  useEffect(() => {
    if (!asynchronous) return;
    richTextParser.parse(
      owner,
      text,
      headings,
      (snapshot) => startTransition(() => setParsed(snapshot)),
      setError,
    );
  }, [asynchronous, owner, text, headings]);

  const compatible = (snapshot: RichTextSnapshot | null) =>
    snapshot?.headings === headings && text.startsWith(snapshot.text)
      ? snapshot
      : null;
  const workerPreview = compatible(parsed);
  const syncPreview = compatible(lastSynchronous.current);
  const preview =
    synchronous ??
    (workerPreview &&
    (!syncPreview || workerPreview.text.length >= syncPreview.text.length)
      ? workerPreview
      : syncPreview);
  if (asynchronous && workerPreview) lastSynchronous.current = null;
  const content = useMemo(
    () =>
      preview
        ? toJsxRuntime(preview.tree, {
            Fragment,
            jsx,
            jsxs,
            components: inline ? inlineComponents : components,
            ignoreInvalidStyle: true,
            passKeys: true,
            passNode: true,
          })
        : null,
    [preview, inline],
  );
  if (error) throw error;
  const pending = asynchronous && preview?.text !== text;
  const tail = pending ? text.slice(preview?.text.length ?? 0) : "";
  return (
    <div
      className={`rich-text rich-text--${variant} ${inline ? "rich-text--inline" : ""}`}
      aria-busy={pending || undefined}
    >
      {content}
      {tail && <span style={{ whiteSpace: "pre-wrap" }}>{tail}</span>}
    </div>
  );
});
