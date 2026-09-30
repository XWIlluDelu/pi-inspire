import GithubSlugger from "github-slugger";
import type { Root as HastRoot } from "hast";
import type { Root } from "mdast";
import { decodeString } from "micromark-util-decode-string";
import { defaultUrlTransform } from "react-markdown";
import rehypeSanitize, {
  defaultSchema,
  type Options as SanitizeSchema,
} from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math-extended";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type Plugin } from "unified";

// Shared sanitize schema for every variant. Raw HTML from model content is
// never interpreted (there is no rehype-raw), and the remaining
// untrusted Markdown tree is sanitized before KaTeX runs. The math marker
// classes survive that boundary so RichTextMath can run rehype-katex with
// trust:false in a memoized leaf. This follows rehype-katex's documented
// ordering and avoids maintaining an incomplete parallel allowlist of KaTeX's
// MathML, HTML, SVG, and accessibility attributes.
const schema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  // file: links survive sanitization so the link renderer can convert them
  // into data-file-path references; they never navigate (clicks are
  // intercepted, and the rendered anchor has no target/rel).
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", "vscode"],
    src: [
      ...(defaultSchema.protocols?.src ?? []),
      "file",
      "vscode",
      "attachment",
    ],
  },
};

function sourceSlice(
  node: { position?: { start: { offset?: number }; end: { offset?: number } } },
  source: string,
): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start == null || end == null ? null : source.slice(start, end);
}

interface BackslashMathScan {
  firstUnclosed: number;
  hasOpeningDisplayClose: boolean;
}

/** One forward scan. Odd backslash-run parity means the final slash is an
 * unescaped TeX delimiter; an active opener ignores different delimiters just
 * like the Markdown tokenizer. */
function scanBackslashMath(raw: string): BackslashMathScan {
  let slashRun = 0;
  let opener = -1;
  let close = "";
  let hasOpeningDisplayClose = false;
  for (let index = 0; index < raw.length; index += 1) {
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
  return { firstUnclosed: opener, hasOpeningDisplayClose };
}

function firstUnclosedBackslashMath(raw: string): number {
  return scanBackslashMath(raw).firstUnclosed;
}

function hasRealDisplayClose(raw: string): boolean {
  return (
    !raw.startsWith("\\[") || scanBackslashMath(raw).hasOpeningDisplayClose
  );
}

/** Parse only a complete sequence of unescaped `$$…$$` displays separated by
 * line whitespace. This is deliberately narrower than TeX parsing: it repairs
 * Markdown's paragraph/block classification without looking inside formula
 * syntax beyond escaped delimiter parity. */
function dollarDisplaySegments(raw: string): string[] | null {
  const segments: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    if (!raw.startsWith("$$", cursor)) return null;
    const bodyStart = cursor + 2;
    let slashRun = 0;
    let close = -1;
    for (cursor = bodyStart; cursor < raw.length - 1; cursor += 1) {
      const character = raw[cursor]!;
      if (character === "\\") {
        slashRun += 1;
        continue;
      }
      const escaped = slashRun % 2 === 1;
      slashRun = 0;
      if (!escaped && character === "$" && raw[cursor + 1] === "$") {
        close = cursor;
        break;
      }
    }
    if (close < 0) return null;
    cursor = close + 2;
    segments.push(raw.slice(bodyStart, close));
    if (cursor === raw.length) return segments;

    const separatorStart = cursor;
    while (cursor < raw.length && /\s/.test(raw[cursor]!)) cursor += 1;
    const separator = raw.slice(separatorStart, cursor);
    if (!separator.includes("\n") || cursor === raw.length) return null;
  }
  return null;
}

function displayMathNode(
  value: string,
  position?: unknown,
): Record<string, unknown> {
  return {
    type: "math",
    value,
    position,
    data: {
      hName: "code",
      hProperties: { className: ["language-math", "math-display"] },
      hChildren: [{ type: "text", value }],
    },
  };
}

/** Recover source only where the math tokenizer consumed an opener without a
 * real close. Text-node recovery starts at the unmatched TeX opener, keeping
 * ordinary Markdown decoding before it. Code nodes are never visited. The
 * same pass promotes complete line-separated `$$…$$` tokens to display math
 * and restores first-line formula text that the block tokenizer called meta. */
const remarkMathSourceSafety: Plugin<[], Root> =
  function remarkMathSourceSafety() {
    return (tree, file) => {
      const source = String(file.value);
      const visit = (parent: { children?: Array<Record<string, unknown>> }) => {
        if (!Array.isArray(parent.children)) return;
        for (let index = 0; index < parent.children.length; index += 1) {
          const node = parent.children[index]!;
          const raw = sourceSlice(node, source);
          if (node.type === "math" && raw !== null) {
            if (raw.startsWith("$$")) {
              const segments = dollarDisplaySegments(raw);
              if (!segments) {
                parent.children[index] = {
                  type: "paragraph",
                  children: [
                    { type: "text", value: raw, position: node.position },
                  ],
                  position: node.position,
                };
              } else if (segments.length > 1 || node.meta != null) {
                parent.children.splice(
                  index,
                  1,
                  ...segments.map((value) => displayMathNode(value)),
                );
                index += segments.length - 1;
              }
              continue;
            }
            if (!hasRealDisplayClose(raw)) {
              parent.children[index] = {
                type: "paragraph",
                children: [
                  { type: "text", value: raw, position: node.position },
                ],
                position: node.position,
              };
              continue;
            }
          }
          if (node.type === "text" && raw !== null) {
            const opener = firstUnclosedBackslashMath(raw);
            if (opener >= 0)
              node.value = `${decodeString(raw.slice(0, opener))}${raw.slice(opener)}`;
            continue;
          }
          if (node.type === "paragraph") {
            const children = node.children as
              | Array<Record<string, unknown>>
              | undefined;
            const inlineDisplays: Array<Record<string, unknown>> = [];
            let hasLineSeparator = false;
            let promotable = Boolean(children?.length);
            for (const child of children ?? []) {
              if (child.type === "text") {
                const value = String(child.value ?? "");
                if (!/^\s+$/.test(value)) promotable = false;
                if (value.includes("\n")) hasLineSeparator = true;
                continue;
              }
              const childRaw = sourceSlice(child, source);
              const segments =
                child.type === "inlineMath" && childRaw !== null
                  ? dollarDisplaySegments(childRaw)
                  : null;
              if (!segments || segments.length !== 1) {
                promotable = false;
                continue;
              }
              inlineDisplays.push(
                displayMathNode(segments[0]!, child.position),
              );
            }
            if (
              promotable &&
              inlineDisplays.length > 0 &&
              (inlineDisplays.length === 1 || hasLineSeparator)
            ) {
              parent.children.splice(index, 1, ...inlineDisplays);
              index += inlineDisplays.length - 1;
              continue;
            }
          }
          visit(node as { children?: Array<Record<string, unknown>> });
        }
      };
      visit(tree as unknown as { children: Array<Record<string, unknown>> });
    };
  };

const remarkDocumentHeadings: Plugin<[], Root> = () => (tree) => {
  const slugger = new GithubSlugger();
  const textOf = (node: {
    type: string;
    value?: string;
    alt?: string;
    children?: unknown[];
  }): string =>
    node.children
      ? node.children.map((child) => textOf(child as typeof node)).join("")
      : node.type === "image"
        ? (node.alt ?? "")
        : (node.value ?? "");
  const visit = (node: Root | Root["children"][number]) => {
    if (node.type === "heading") {
      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          id: slugger.slug(textOf(node)),
        },
      };
    }
    if ("children" in node)
      for (const child of node.children)
        visit(child as Root["children"][number]);
  };
  visit(tree);
};

const processor = (headings: boolean) =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkMathSourceSafety)
    .use(headings ? [remarkDocumentHeadings] : [])
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSanitize, schema)
    .freeze();
const processors = [processor(false), processor(true)];

/** The same whole-document pipeline runs synchronously for small content and
 * in the parser worker for large content. Only sanitized HAST crosses back. */
export function parseRichText(text: string, headings = false): HastRoot {
  const parser = processors[headings ? 1 : 0]!;
  const tree = parser.runSync(parser.parse(text), text);
  const visit = (node: HastRoot | HastRoot["children"][number]) => {
    // Rendering uses values/properties, not Markdown source coordinates.
    // Dropping them substantially reduces worker structured-clone work.
    delete node.position;
    if (node.type === "element") {
      for (const property of ["href", "src"] as const) {
        const value = node.properties[property];
        if (typeof value === "string")
          node.properties[property] =
            /^(?:file:\/\/|vscode:\/\/file\/|attachment:)/i.test(value)
              ? value
              : defaultUrlTransform(value);
      }
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return tree;
}

export interface RichTextParseRequest {
  id: number;
  text: string;
  headings: boolean;
}
export type RichTextParseResponse =
  | { id: number; tree: HastRoot }
  | { id: number; error: string };
