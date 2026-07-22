import hljs from "highlight.js/lib/common";
import "katex/dist/katex.min.css";
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

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

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const highlighted = hljs.getLanguage(language)
    ? hljs.highlight(code, { language }).value
    : escapeHtml(code);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // clipboard unavailable (permissions); leave state unchanged
    }
  };

  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span className="code-block__lang">{language}</span>
        <button type="button" className="code-block__copy" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code-block__pre">
        {/* highlight.js escapes its input; the generated markup contains only span tags */}
        <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

const components: Components = {
  // Our CodeBlock renders its own <pre>; unwrap react-markdown's wrapper.
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
  code: ({ className, children }: { className?: string; children?: ReactNode }) => {
    const text = String(children ?? "").replace(/\n$/, "");
    const match = /language-([\w+-]+)/.exec(className ?? "");
    if (!match) return <code className="inline-code">{text}</code>;
    return <CodeBlock language={match[1]!} code={text} />;
  },
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

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
      >
        {normalizeDisplayMath(text)}
      </ReactMarkdown>
    </div>
  );
});
