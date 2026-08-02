import hljs from "highlight.js/lib/common";
import "katex/dist/katex.min.css";
import { Check, Copy } from "lucide-react";
import { memo, type ClipboardEvent as ReactClipboardEvent, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math-extended";
import { decodeString } from "micromark-util-decode-string";
import type { Root } from "mdast";
import type { Plugin } from "unified";
import { isLocalResourceReference } from "../../shared/resource-references";
import { useCopied } from "../use-copied";

export type RichTextVariant = "assistant" | "user" | "thinking" | "extension";

// Shared sanitize schema for every variant. Raw HTML from model content is
// never parsed (react-markdown drops it without rehype-raw); KaTeX runs with
// trust disabled, and the sanitizer allows only the markup KaTeX and the
// Markdown pipeline themselves produce.
const schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "math",
    "semantics",
    "annotation",
    "mrow",
    "mi",
    "mo",
    "mn",
    "ms",
    "mtext",
    "mspace",
    "msup",
    "msub",
    "msubsup",
    "mfrac",
    "msqrt",
    "mroot",
    "mtable",
    "mtr",
    "mtd",
    "mlabeledtr",
    "munder",
    "mover",
    "munderover",
    "mpadded",
    "mphantom",
    "menclose",
    "mstyle",
    "merror",
  ],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "style", "ariaHidden"],
    annotation: [...(defaultSchema.attributes?.annotation ?? []), "encoding"],
  },
  // file: links survive sanitization so the link renderer can convert them
  // into data-file-path references; they never navigate (clicks are
  // intercepted, and the rendered anchor has no target/rel).
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
};

function sourceSlice(node: { position?: { start: { offset?: number }; end: { offset?: number } } }, source: string): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start == null || end == null ? null : source.slice(start, end);
}

export interface BackslashMathScan {
  firstUnclosed: number;
  hasOpeningDisplayClose: boolean;
  operations: number;
}

/** One forward scan. Odd backslash-run parity means the final slash is an
 * unescaped TeX delimiter; an active opener ignores different delimiters just
 * like the Markdown tokenizer. `operations` is a deterministic linear-work witness. */
export function scanBackslashMath(raw: string): BackslashMathScan {
  let slashRun = 0;
  let opener = -1;
  let close = "";
  let hasOpeningDisplayClose = false;
  let operations = 0;
  for (let index = 0; index < raw.length; index += 1) {
    operations += 1;
    const character = raw[index]!;
    if (character === "\\") {
      slashRun += 1;
      continue;
    }
    const delimiterSlash = index - 1;
    const unescapedDelimiter = slashRun % 2 === 1;
    slashRun = 0;
    if (!unescapedDelimiter) continue;
    if (opener < 0 && (character === "(" || character === "[")) {
      opener = delimiterSlash;
      close = character === "(" ? ")" : "]";
    } else if (opener >= 0 && character === close) {
      if (opener === 0 && close === "]") hasOpeningDisplayClose = true;
      opener = -1;
      close = "";
    }
  }
  return { firstUnclosed: opener, hasOpeningDisplayClose, operations };
}

function firstUnclosedBackslashMath(raw: string): number {
  return scanBackslashMath(raw).firstUnclosed;
}

function hasRealDisplayClose(raw: string): boolean {
  if (raw.startsWith("$$")) return raw.length >= 4 && raw.endsWith("$$");
  return !raw.startsWith("\\[") || scanBackslashMath(raw).hasOpeningDisplayClose;
}

/** Recover source only where the math tokenizer consumed an opener without a
 * real close. Text-node recovery starts at the unmatched TeX opener, keeping
 * ordinary Markdown decoding before it. Code nodes are never visited. The
 * same pass promotes a complete paragraph-only `$$…$$` token to display math. */
const remarkMathSourceSafety: Plugin<[], Root> = function remarkMathSourceSafety() {
  return (tree, file) => {
    const source = String(file.value);
    const visit = (parent: { children?: Array<Record<string, unknown>> }) => {
      if (!Array.isArray(parent.children)) return;
      for (let index = 0; index < parent.children.length; index += 1) {
        const node = parent.children[index]!;
        const raw = sourceSlice(node, source);
        if (node.type === "math" && raw !== null && !hasRealDisplayClose(raw)) {
          parent.children[index] = {
            type: "paragraph",
            children: [{ type: "text", value: raw, position: node.position }],
            position: node.position,
          };
          continue;
        }
        if (node.type === "text" && raw !== null) {
          const opener = firstUnclosedBackslashMath(raw);
          if (opener >= 0) node.value = `${decodeString(raw.slice(0, opener))}${raw.slice(opener)}`;
          continue;
        }
        if (node.type === "paragraph") {
          const children = node.children as Array<Record<string, unknown>> | undefined;
          if (children?.length === 1 && children[0]?.type === "inlineMath" && raw?.startsWith("$$") && raw.endsWith("$$") && raw.length >= 4) {
            const value = children[0].value as string;
            parent.children[index] = {
              type: "math",
              value,
              position: node.position,
              data: {
                hName: "code",
                hProperties: { className: ["language-math", "math-display"] },
                hChildren: [{ type: "text", value }],
              },
            };
            continue;
          }
        }
        visit(node as { children?: Array<Record<string, unknown>> });
      }
    };
    visit(tree as unknown as { children: Array<Record<string, unknown>> });
  };
};

function closestKatexBoundary(node: Node, root: HTMLElement): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  const katex = element?.closest(".katex") ?? null;
  if (!katex || !root.contains(katex)) return null;
  const display = katex.closest(".katex-display");
  return display && root.contains(display) ? display : katex;
}

function fragmentHtml(fragment: DocumentFragment): string {
  const wrapper = document.createElement("div");
  wrapper.append(fragment.cloneNode(true));
  return wrapper.innerHTML;
}

/** Build the clipboard projection used by the transcript's delegated copy
 * boundary. The supplied range is cloned, so neither selection nor Pi source
 * text is modified. */
export function projectKatexSelection(range: Range, root: HTMLElement): { plain: string; html: string } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const selected = range.cloneRange();
  // Determine display identity in the original DOM. A cloned partial KaTeX
  // fragment no longer has its .katex-display ancestor, so expand endpoints
  // to the original formula boundary before cloning.
  const startKatex = closestKatexBoundary(selected.startContainer, root);
  const endKatex = closestKatexBoundary(selected.endContainer, root);
  if (startKatex) selected.setStartBefore(startKatex);
  if (endKatex) selected.setEndAfter(endKatex);

  const fragment = selected.cloneContents();
  if (!fragment.querySelector(".katex-mathml")) return null;
  const html = fragmentHtml(fragment);

  for (const mathml of [...fragment.querySelectorAll(".katex-mathml")]) {
    const source = mathml.querySelector("annotation")?.textContent;
    if (source == null) continue;
    const display = Boolean(mathml.closest(".katex-display"));
    const rendered = mathml.nextElementSibling;
    if (rendered?.classList.contains("katex-html")) rendered.remove();
    mathml.replaceWith(document.createTextNode(display ? `$$${source}$$` : `$${source}$`));
  }
  return { plain: fragment.textContent ?? "", html };
}

export function handleRichTextCopy(event: ReactClipboardEvent<HTMLElement>): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !event.clipboardData) return;
  const projection = projectKatexSelection(selection.getRangeAt(0), event.currentTarget);
  if (!projection) return;
  event.clipboardData.setData("text/plain", projection.plain);
  event.clipboardData.setData("text/html", projection.html);
  event.preventDefault();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function CodeBlock({ language, code }: { language: string; code: string }) {
  const { copied, copy } = useCopied();
  const highlighted = hljs.getLanguage(language)
    ? hljs.highlight(code, { language }).value
    : escapeHtml(code);

  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span className="code-block__lang">{language}</span>
        <button
          type="button"
          className="code-block__copy"
          onClick={() => void copy(code)}
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        </button>
      </div>
      <pre className="code-block__pre">
        {/* highlight.js escapes its input; the generated markup contains only span tags */}
        <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

// Local file references carry data-file-path instead of navigation semantics;
// the transcript's delegated click handler opens them in the resources pane.
// Remote http(s)/mailto links keep ordinary safe external-link behavior.
const components: Components = {
  // Our CodeBlock renders its own <pre>; unwrap react-markdown's wrapper.
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
  code: ({ className, children }: { className?: string; children?: ReactNode }) => {
    const text = String(children ?? "").replace(/\n$/, "");
    const match = /language-([\w+-]+)/.exec(className ?? "");
    if (!match) {
      // A credible inline-code path (known file extension or explicit relative
      // prefix) opens the resource pane rather than sitting inert.
      if (isLocalResourceReference(text)) {
        return (
          <button type="button" className="file-ref file-ref--code" data-file-path={text}>
            <code className="inline-code">{text}</code>
          </button>
        );
      }
      return <code className="inline-code">{text}</code>;
    }
    return <CodeBlock language={match[1]!} code={text} />;
  },
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    if (href && isLocalResourceReference(href)) {
      return (
        <a href={href} className="file-ref" data-file-path={href}>
          {children}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  img: ({ src, alt }: { src?: string; alt?: string }) => {
    if (src && isLocalResourceReference(src)) {
      return (
        <button type="button" className="file-ref file-ref--image" data-file-path={src} aria-label={`Preview ${alt || src}`}>
          <span aria-hidden>▧</span>
          <span>{alt || src}</span>
        </button>
      );
    }
    // A remote image must not load on render: merely reading a message would
    // fire a GET to an attacker-chosen host. The reference stays reachable as
    // an explicit link the user chooses to open.
    if (src && /^https?:/i.test(src)) {
      return (
        <a href={src} target="_blank" rel="noreferrer noopener" title={src}>
          <span aria-hidden>▧ </span>
          {alt || src}
        </a>
      );
    }
    return <img src={src} alt={alt ?? ""} />;
  },
};

// react-markdown's default URL transform blanks unknown protocols; keep file:
// URLs so the link renderer can route them to the resource pane (they never
// navigate). Everything else defers to the default transform.
function urlTransform(url: string): string {
  if (/^file:\/\//i.test(url)) return url;
  return defaultUrlTransform(url);
}

// Memoized: settled Markdown/KaTeX/highlighting is expensive to reparse, and
// stream deltas only change the trailing message's props.
export const RichText = memo(function RichText({ text, variant = "assistant" }: { text: string; variant?: RichTextVariant }) {
  return (
    <div className={`rich-text rich-text--${variant}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkMathSourceSafety]}
        rehypePlugins={[
          [rehypeKatex, { trust: false, strict: false, throwOnError: false }],
          [rehypeSanitize, schema],
        ]}
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
