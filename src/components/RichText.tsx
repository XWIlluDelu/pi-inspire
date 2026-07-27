import hljs from "highlight.js/lib/common";
import "katex/dist/katex.min.css";
import { Check, Copy } from "lucide-react";
import { memo, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
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

// micromark only recognizes $$…$$ as display math when the fences sit on
// their own lines, but models routinely emit a lone one-line $$…$$ paragraph
// for display formulas. Expand exactly those lines into fenced form so
// remark-math produces display math; inline $…$ and mid-line $$…$$ are
// untouched and stay inline.
const SINGLE_LINE_DISPLAY = /^\$\$(?!\$)([^\n]*[^\n$])\$\$$/gm;

function normalizeDisplayMath(text: string): string {
  return text.replace(SINGLE_LINE_DISPLAY, (_line, body: string) => `$$\n${body}\n$$`);
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
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { trust: false, strict: false, throwOnError: false }],
          [rehypeSanitize, schema],
        ]}
        components={components}
        urlTransform={urlTransform}
      >
        {normalizeDisplayMath(text)}
      </ReactMarkdown>
    </div>
  );
});
