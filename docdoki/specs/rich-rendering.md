---
purpose: Shared streaming Markdown, mathematics, code, tables, and links for Pi content.
covers:
  - src/components/RichText.tsx
  - src/{rich-text-parser,rich-text-parser-client,rich-text-worker}.ts
  - vite.config.ts
  - package.json
  - src/components/RichTextMath.tsx
  - src/components/ProgressiveRichText.tsx
  - src/components/Transcript.tsx
  - src/components/transcript-row-projection.tsx
  - src/components/transcript-rows.tsx
  - src/styles.css
  - src/styles/*.css
  - tests/web/rich-text.test.tsx
  - tests/web/rich-text-streaming.test.tsx
  - tests/web/rich-text-worker.test.tsx
  - tests/browser/{rich-text-delimiters,filesystem-files,custom-message,rich-text-layout}.spec.ts
  - tests/fixtures/rich-text-benchmark.tsx
  - scripts/benchmark-rich-text.mjs
---

# Rich rendering

## Goal

Render Pi content accurately during streaming and after completion. User messages, assistant messages,
thinking, documents, and extension Markdown share one rendering authority with deliberate variants.

### Content semantics

- Support CommonMark-style Markdown, GFM tables and task lists, links, images, inline mathematics,
  and display mathematics. Streaming keeps incomplete fences, links, tables, and math readable.
  Read-only task markers hang beside a dedicated text column: wrapped lines, additional paragraphs,
  and nested lists keep their text alignment and hierarchy. Original Markdown and read-only
  checkbox semantics remain intact. Ordinary entries in mixed lists keep their bullets or
  ordered numbers and share the content column with task entries.
  Table columns preserve whole-word minimum widths and wrap ordinary prose at word boundaries;
  wide tables and unbroken cell tokens scroll within the table, not the reading column.
  Inline mathematics keeps its natural text baseline and visible script/fraction extents, without
  becoming an independent scroll container. Display mathematics scrolls locally only when the
  expression exceeds the available reading width. Chat and Markdown file previews share this rule.
- Mathematics accepts `$…$`, `$$…$$`, `\\(…\\)`, and `\\[…\\]` through token-aware parsing.
  Inline/fenced code and escapes stay code/text. Valid same-line, multiline, and newline-adjacent
  displays remain distinct math blocks, and first-line display content is never misclassified as
  metadata. While a response streams, an unclosed opener remains exact readable source. Dollar
  delimiters use lexical boundaries, so ordinary amounts, whitespace- or
  path-separated Shell variables, quoted Shell variable/array expansions and command substitutions,
  and bare or quoted regex endings do not consume intervening prose as math. Escaped dollars within
  formulas are preserved, including backslash-run parity; genuine closers, including formulas followed
  by a slash and ordinal suffixes, remain valid.
- Raw HTML-shaped source, including generic types such as `Array<T>`, renders as inert text; it is
  never interpreted as elements or silently discarded.
- Code blocks preserve whitespace, identify their language when available, highlight syntax, and
  copy the original source. Parsed `pre` structure determines block identity: unlabeled, indented,
  and incomplete fences keep block/copy behavior. Only inline code can become a file-reference button.
- Final rendering equals a fresh render of the complete source. Parse the whole document so later
  reference definitions, footnotes, and open fence/list/math structure can update earlier content.
- Reuse unchanged math and code subtrees without delaying source updates. Reuse stays bounded by
  mounted content; source-safety and sanitization precede math interpretation and memoization.

### Safety and navigation

- Disable raw HTML by default. Any interpreted HTML requires an explicit allowlist; reject unsafe
  URLs and active inline content. Untrusted Markdown is sanitized before trust-disabled KaTeX
  (`trust:false`) generates its complete HTML, MathML and SVG output; extensible glyph geometry and
  accessibility metadata are preserved, and trust-only commands stay disabled.
- External links open safely in a new tab. Explicit local conversation links open the session-bound
  resource preview. Standalone local Markdown images in the transcript display authorized thumbnails
  and open the original in the image inspector. The thumbnail fits the entire image. Unavailable
  thumbnails keep a file preview button with the complete caption and target. Its mark shares the
  caption's first-line baseline, and wrapped caption lines keep a common leading edge.
  Document readers resolve file targets from the document directory,
  render independently authorized local images, and keep heading fragments within the reader under
  [[resource-preview]]. External image URLs appear as links; unrecognized conversation image paths
  remain unavailable. Arbitrary data URLs stay disabled.
  An authored Markdown link owns navigation for all of its label content; inline code filenames
  and image placeholders inside it are presentation, not nested actions. Independent file
  references and images keep their normal preview or external-link behavior.
- A rendering failure stays within the affected block and leaves its source readable.

## Parsing and update ownership

`rich-text-parser.ts` owns the whole-document remark/rehype pipeline: Markdown, GFM/math,
source-safety, conversion, and sanitization. Sources below 8,000 characters parse synchronously;
at or above that threshold, one shared worker returns sanitized HAST without unused source positions.
Both paths use the same DOM-independent named-entity decoder. `RichText` converts their HAST to React
on the main thread.

The parser client runs one active job overall and keeps only the latest pending source per mounted
reader. A compatible completed prefix stays formatted while the appended tail appears immediately as
safe text. A replacement source displays its own text while awaiting parsing. Unmounting retires that
reader's work. Releasing the active job terminates that worker and immediately admits the next valid
pending reader, even if other readers keep completed trees. The last reader also terminates the
worker. Valid streaming updates coalesce instead of restarting active parsing on every update.

Sanitized `code`/`pre` renderers pass primitive source and mode/language props to memoized leaves.
`RichTextMath` runs trust-disabled rehype-katex and HAST-to-React conversion when an expression changes;
`CodeBlock` keeps highlighting through unrelated updates and clipboard feedback.

`ProgressiveRichText` owns lazy loading and readable failure fallback. Parsing and reuse belong to
`RichText`, independent of transport streaming state.

## Checks

Web tests compare streamed and fresh DOM, exercise delimiter boundaries and late references, and count
math/highlighting work for unchanged leaves. Task-list checks preserve tight/loose paragraphs, inline
formatting and mixed-list numbering; browser flows check first-line markers, shared text columns,
nesting and source copying across reader variants and reading sizes. Parser-client tests cover
coalescing, reader retirement, and worker failure. Chromium flows exercise composer typing during
large-response updates and scoped document navigation. Reproducible component measurements: [[performance]].

## Boundaries

TeX document compilation and active HTML artifacts are outside the conversation renderer.
